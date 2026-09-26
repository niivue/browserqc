// Boot `vite preview` on the production build and launch headless Chrome with software
// WebGPU (--use-gl=angle --enable-unsafe-swiftshader, niivue's own e2e recipe).
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export const root = join(import.meta.dirname, '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// `errors` collects every page console.error and uncaught error: the app should run clean.
export async function startPreview(port) {
  // detached: its own process group, so killing -pid reaps vite AND its esbuild children.
  const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore', detached: true })
  let exited = false
  preview.on('exit', () => { exited = true })
  const stop = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { /* gone */ } }
  process.on('exit', stop)
  process.on('SIGINT', () => { stop(); process.exit(130) })
  const url = `http://localhost:${port}/`
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await wait(300)) {
    if (exited) throw new Error(`vite preview exited — port ${port} in use?`)
    if (await fetch(url).then((r) => r.ok, () => false)) {
      // A stale server holding the port makes our --strictPort child exit within a few
      // hundred ms; settle and re-check rather than test someone else's build.
      await wait(500)
      if (exited) throw new Error(`port ${port} is served by another process — refusing a stale build`)
      const browser = await chromium.launch({ headless: true, channel: 'chrome',
        args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1280,960'] })
      const errors = []
      const newPage = async () => {
        const page = await browser.newPage()
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
        page.on('pageerror', (e) => errors.push(`page error: ${e.message}`))
        return page
      }
      return { url, errors, newPage, stop: async () => { await browser.close().catch(() => {}); stop() } }
    }
  }
  throw new Error('vite preview did not come up')
}

// Print the verdict, stop the preview and exit non-zero on any failure.
export async function finish(name, preview, failures) {
  await preview.stop()
  const all = [...failures, ...preview.errors]
  if (all.length) {
    console.error(`\n❌ ${name} FAIL\n  ${all.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`\n✅ ${name} PASS`)
}
