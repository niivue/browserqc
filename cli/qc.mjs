#!/usr/bin/env node
/**
 * BrowserQC CLI — run the real app headlessly and write the QC metrics as JSON.
 *
 *   npm run build                                    # once, produces dist/
 *   node cli/qc.mjs --in T1.nii.gz --out results.json
 *
 * This drives the actual BrowserQC page in headless Chrome rather than
 * re-implementing the pipeline in Node, so the numbers are the browser's by
 * construction. That is not just convenience: segmentation needs WebGPU, which Node
 * has no implementation of. The wasm module's only backend is `webgpu` and it
 * refuses rather than silently falling back to its (validation-only, minutes-per-
 * volume) CPU engine.
 *
 * The input is injected by intercepting the page's request for its bundled default
 * image, so the app's normal auto-run does all the work and no app code is special-
 * cased for the CLI. The one seam is `window.browserqcMetrics` (see computeQc in
 * src/main.ts), which exposes full-precision values the panel would round to 3 s.f.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { readFile, writeFile, access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Deploy base from vite.config, so the CLI targets the right path whether the app is
// served at a /repo/ subpath or a custom-domain root (base: '/').
const BASE = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8').match(/base:\s*'([^']*)'/)?.[1] ?? '/'
const log = (m) => process.stderr.write(`${m}\n`)

function parseArgs(argv) {
  const a = { in: null, out: null, bids: null, port: 4199, timeout: 300000 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') a.in = argv[++i]
    else if (argv[i] === '--out') a.out = argv[++i]
    else if (argv[i] === '--bids') a.bids = argv[++i]
    else if (argv[i] === '--port') a.port = Number(argv[++i])
    else if (argv[i] === '--timeout') a.timeout = Number(argv[++i]) * 1000
    else if (argv[i] === '--help' || argv[i] === '-h') a.help = true
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.in || !args.out) {
  process.stdout.write(
    'Usage: node cli/qc.mjs --in <T1.nii[.gz]> --out <results.json> [--bids sidecar.json]\n' +
      '                       [--port N] [--timeout SEC]\n' +
      '\nRequires a production build (npm run build) and Google Chrome.\n',
  )
  process.exit(args.help ? 0 : 1)
}

try {
  await access(join(ROOT, 'dist', 'index.html'))
} catch {
  log('error      no dist/ — run `npm run build` first')
  process.exit(1)
}

const inputBytes = await readFile(args.in)
const URL_BASE = `http://localhost:${args.port}${BASE}`

// --- boot vite preview on the production build --------------------------
// detached so we can kill the whole process group (vite + esbuild children).
const preview = spawn('npx', ['vite', 'preview', '--port', String(args.port), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: true,
})
let previewExited = false
preview.on('exit', () => { previewExited = true })
const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { /* gone */ } }
process.on('exit', killPreview)
process.on('SIGINT', () => { killPreview(); process.exit(130) })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForServer(deadlineMs = 20000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (previewExited) throw new Error(`vite preview exited — is port ${args.port} in use?`)
    try { if ((await fetch(URL_BASE)).ok) return } catch { /* not up yet */ }
    await wait(250)
  }
  throw new Error('vite preview did not come up')
}

let browser
try {
  await waitForServer()
  log(`input      ${basename(args.in)}`)

  // System Chrome for full WebGPU (NiiVue needs it). The angle/swiftshader flags are
  // the same software-rendering fallback the e2e smoke uses, so this works on a
  // headless machine with no GPU; on a real GPU Chrome uses it and runs faster.
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1280,960'],
  })
  const page = await browser.newPage()

  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()) })

  // Serve OUR file wherever the app asks for its bundled default image, so the
  // standard startup auto-run (segment → overlay → --qc) processes it.
  await page.route('**/t1_crop.nii.gz', (route) =>
    route.fulfill({ status: 200, contentType: 'application/gzip', body: inputBytes }),
  )
  // The injected image is not the default subject, so suppress the default subject's
  // BIDS sidecar (resolve it to JSON null — a 404 would trip the error gate below).
  // --bids (below) supplies its own via window.__browserqcBids.
  await page.route('**/t1_crop.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
  )

  if (args.bids) {
    // Same seam the drag-drop sidecar uses: metadata only, never affects metrics.
    const meta = JSON.parse(await readFile(args.bids, 'utf8'))
    await page.addInitScript((m) => { window.__browserqcBids = m }, meta)
  }
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' })
  log('running    segmentation → niimath --qc (headless Chrome)…')

  // NB: waitForFunction(fn, arg, options) — the options object must be the THIRD
  // argument; passing it second silently falls back to Playwright's 30 s default.
  await page.waitForFunction(() => window.browserqcMetrics !== undefined, null, {
    timeout: args.timeout,
  })
  const report = await page.evaluate(() => window.browserqcMetrics)
  const status = await page.$eval('#statusMsg', (el) => el.textContent || '').catch(() => '')

  // The app is expected to run clean (the smoke gates on the same signal); a page/console
  // error means the result may be wrong, so fail rather than bless it.
  if (pageErrors.length) throw new Error(`page reported ${pageErrors.length} error(s):\n  ${pageErrors.join('\n  ')}`)

  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`)
  log(`done       ${args.out}  (${status.trim()})`)
} catch (err) {
  log(`error      ${err.message}`)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  killPreview()
}
