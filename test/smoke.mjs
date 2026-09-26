// Headless-WebGPU smoke for BrowserQC (npm run test:e2e builds first). Drives the
// production build: NiiVue attach, Vite worker URLs, the default image's auto run
// (segmentation → overlay → niimath --qc → panel), the PVE model, the Opacity slider and
// About. Wiring only: it asserts the runs complete clean, not segmentation/QC values.
import { finish, startPreview } from './preview.mjs'

const preview = await startPreview(4173)
const failures = []
const check = (ok, msg) => { if (!ok) failures.push(msg) }
try {
  const page = await preview.newPage()
  await page.goto(preview.url, { waitUntil: 'domcontentloaded' })
  const qcText = () => page.$eval('#qcBody', (el) => el.textContent || '')
  check((await qcText()).includes('No QC values'), 'QC panel not empty on load')

  await page.waitForFunction(() => window.browserqcMetrics, undefined, { timeout: 240000 })
  check(/CJV/.test(await qcText()), 'QC panel did not populate after segmentation')
  // The SNRd label always renders; niimath nulls snrd_* when the air mask is too small.
  check(Number.isFinite(await page.evaluate(() => window.browserqcMetrics.snrd_total)), 'snrd_total missing')
  console.log('✓ auto segmentation + niimath QC ran, panel populated')

  await page.selectOption('#modelPick', 'mindmap-pve')
  await page.waitForFunction(() => window.browserqcMetrics?.provenance?.pve === true, undefined, { timeout: 240000 })
  check(/CJV/.test(await qcText()), 'QC panel did not populate after PVE')
  console.log('✓ PVE fractions + niimath --qc --pve ran')

  await page.$eval('#ovlSlider', (el) => {
    for (const value of ['255', '64']) {
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await page.click('#aboutBtn')
  check(await page.isVisible('#aboutDialog'), 'About dialog did not open')
  await page.click('#closeAboutBtn')
  console.log('✓ Opacity slider driven, About dialog opens')
} catch (err) {
  failures.push(err.stack ?? String(err))
}
await finish('SMOKE', preview, failures)
