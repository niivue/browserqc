// DICOM drops (needs `npm run build` and Chrome): a folder of many series opens the picker with
// the T1w suggested; one series skips it. Each run gets the series' own dcm2niix sidecar as
// bids_meta. A real OS drag cannot be scripted, so the drop carries mock FileSystemEntry trees.
// Data: $BROWSERQC_DICOM, default the reproin XA60 sample beside this repo; skipped if absent.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { finish, startPreview } from './preview.mjs'

const dir = process.env.BROWSERQC_DICOM ?? join(import.meta.dirname, '../../bidsui/datasets/reproinXA60e_DICOM_small/20260508120410_RO')
if (!existsSync(dir)) {
  console.log(`skipped: no DICOM sample at ${dir}`)
  process.exit(0)
}
const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const tree = folders.map((name) => ({ name, files: readdirSync(join(dir, name)) }))

const preview = await startPreview(4175)
const failures = []
try {
  const page = await preview.newPage()
  await page.route('**/__dicom/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.split('/__dicom/')[1])
    route.fulfill({ body: readFileSync(join(dir, path)) })
  })
  await page.goto(preview.url)
  await page.waitForFunction(() => window.browserqcMetrics, undefined, { timeout: 300000 }) // default image done

  // Drop `folders` as directory entries and wait for either the picker or a finished run.
  const drop = (subset) => page.evaluate(async (subset) => {
    window.browserqcMetrics = undefined
    const dirEntry = async ({ name, files }) => {
      const children = await Promise.all(files.map(async (f) => {
        const file = new File([await (await fetch(`__dicom/${encodeURIComponent(`${name}/${f}`)}`)).blob()], f)
        return { isFile: true, isDirectory: false, name: f, file: (ok) => ok(file) }
      }))
      return { isFile: false, isDirectory: true, name, createReader: () => {
        let read = false
        return { readEntries: (ok) => { ok(read ? [] : children); read = true } }
      } }
    }
    const entries = await Promise.all(subset.map(dirEntry))
    const drop = new Event('drop', { cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { items: entries.map((e) => ({ webkitGetAsEntry: () => e })) } })
    document.dispatchEvent(drop)
  }, subset)

  // 1. The whole session: a picker, T1w suggested (focused), choosing it runs QC with its sidecar.
  await drop(tree)
  await page.waitForSelector('#seriesDialog[open]', { timeout: 120000 })
  const tiles = await page.$$eval('#seriesList button', (bs) => bs.map((b) => b.textContent))
  const suggested = await page.evaluate(() => document.activeElement?.textContent ?? '')
  if (tiles.length < 2) failures.push(`picker shows ${tiles.length} series`)
  if (!/anat-T1w/.test(suggested)) failures.push(`suggested "${suggested}", not the T1w`)
  console.log(`✓ ${folders.length} folders → picker with ${tiles.length} series, suggested "${suggested}"`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.browserqcMetrics, undefined, { timeout: 300000 })
  let meta = await page.evaluate(() => window.browserqcMetrics.bids_meta)
  if (meta?.SeriesNumber !== 5) failures.push(`picked series bids_meta.SeriesNumber = ${meta?.SeriesNumber}`)
  console.log('✓ picked series ran, bids_meta from its own sidecar')

  // 2. One series: no picker, straight to QC.
  await drop(tree.filter((t) => t.name === '5_anat-T1w'))
  await page.waitForFunction(() => window.browserqcMetrics, undefined, { timeout: 300000 })
  if (await page.$('#seriesDialog[open]')) failures.push('picker opened for a single series')
  meta = await page.evaluate(() => window.browserqcMetrics.bids_meta)
  if (meta?.SeriesNumber !== 5) failures.push(`single series bids_meta.SeriesNumber = ${meta?.SeriesNumber}`)
  console.log('✓ single series ran without the picker')
} catch (err) {
  failures.push(err.stack ?? String(err))
}
await finish('DICOM', preview, failures)
