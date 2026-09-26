// Web ⇄ native parity, per model on the bundled t1_crop (needs `npm run build`, Chrome, and
// the native brainchop-* + niimath on PATH or in $BROWSERQC_BIN):
//  1. niimath: the page's own T1 + segmentation through native `niimath --qc` must match the
//     page's report within 0.1 %. Not bit for bit: niimath is built -ffast-math, so arm64/x86
//     and wasm round differently (~1e-13 in tissue stats), and the registration behind the air
//     mask amplifies that (~0.04 % of air voxels, so summary_bg_* move by < 0.1 %).
//  2. segmentation: native brainchop on the page's T1 vs the page's result — Dice ≥ 0.99 per
//     tissue for labels, mean |Δ| ≤ 0.01 for PVE fractions (GPU kernels differ in precision).
//  3. end to end: `cli/qc.py` on the original file vs the page — air metrics within 0.1 %,
//     median relative Δ of the rest ≤ 1 %.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { finish, root, startPreview } from './preview.mjs'

const models = JSON.parse(readFileSync(join(root, 'src', 'models.json'), 'utf8'))
const template = join(root, 'public', 'avg152T1.nii.gz')
const t1Original = join(root, 'public', 't1_crop.nii.gz')
const { BROWSERQC_BIN: bin, PATH } = process.env
const env = bin ? { ...process.env, PATH: `${bin}${delimiter}${PATH}` } : process.env
const run = (exe, argv) => execFileSync(exe, argv, { env, stdio: ['ignore', 'ignore', 'inherit'] })
const AIR = /^(fber|efc_brain|qi_1|summary_bg_)/
const numeric = (report) => Object.entries(report).filter(([, v]) => typeof v === 'number')
const relDelta = (a, b) => numeric(a).map(([k, v]) => [k, Math.abs(b[k] - v) / Math.max(Math.abs(v), 1e-12)])
const TOL = 1e-3

// Voxels of a NIfTI-1 as floats, scl_slope applied (uint8, int16 and float32 cover our outputs).
function voxels(bytes) {
  const b = bytes[0] === 0x1f ? gunzipSync(bytes) : bytes
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const offset = dv.getFloat32(108, true)
  const slope = dv.getFloat32(112, true) || 1
  const inter = dv.getFloat32(116, true)
  const Type = { 2: Uint8Array, 4: Int16Array, 16: Float32Array }[dv.getInt16(70, true)]
  const n = [1, 2, 3].reduce((p, i) => p * dv.getInt16(40 + 2 * i, true), 1)
  const raw = new Type(b.buffer.slice(b.byteOffset + offset, b.byteOffset + offset + n * Type.BYTES_PER_ELEMENT))
  return Float32Array.from(raw, (v) => v * slope + inter)
}

function dice(a, b, labels) {
  const inA = (v) => labels.includes(v)
  let both = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = inA(a[i]), y = inA(b[i])
    both += x && y
    na += x
    nb += y
  }
  return (2 * both) / (na + nb)
}

const tmp = mkdtempSync(join(tmpdir(), 'browserqc-parity-'))
const preview = await startPreview(4174)
const failures = []
const check = (ok, msg) => { if (!ok) failures.push(msg) }
try {
  const page = await preview.newPage()
  for (const [model, { csf, wm, pve }] of Object.entries(models)) {
    await page.goto(`${preview.url}?model=${model}`)
    await page.waitForFunction(() => window.browserqcMetrics, undefined, { timeout: 300000 })
    const web = await page.evaluate(() => window.browserqcMetrics)
    // The exact QC inputs, as base64 (a data: URL is the cheap way out of the page).
    const inputs = await page.evaluate(async () => {
      const b64 = (bytes) => new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result.split(',')[1])
        reader.readAsDataURL(new Blob([bytes]))
      })
      const { t1, seg, pve } = window.browserqcInputs
      return { t1: await b64(t1), seg: seg && await b64(seg), pve: pve && await Promise.all(pve.map(b64)) }
    })
    const file = (name, b64) => { writeFileSync(join(tmp, name), Buffer.from(b64, 'base64')); return join(tmp, name) }
    const t1 = file('t1.nii', inputs.t1)
    const webMaps = pve ? inputs.pve.map((b, i) => file(`web_${i}.nii`, b)) : [file('web_seg.nii', inputs.seg)]
    const tissueArgs = pve ? ['--pve', ...webMaps] : ['--seg', webMaps[0], '--csf', csf.join(), '--wm', wm.join()]

    // 1. niimath wasm ≡ native
    run('niimath', ['--qc', t1, ...tissueArgs, '--air', template, '--json', join(tmp, 'native.json')])
    const native = JSON.parse(readFileSync(join(tmp, 'native.json'), 'utf8'))
    const niimathMax = Math.max(...relDelta(web, native).map(([, d]) => d))
    check(niimathMax <= TOL, `${model}: niimath wasm vs native differ by ${(100 * niimathMax).toFixed(3)} %`)

    // 2. segmentation agreement
    let agreement
    if (pve) {
      run(`brainchop-${pve}`, [t1, '--pve', '-o', join(tmp, 'nat.nii')])
      const deltas = ['csf', 'gm', 'wm'].map((t, i) => {
        const a = voxels(readFileSync(webMaps[i])), b = voxels(readFileSync(join(tmp, `nat_${t}.nii`)))
        let sum = 0, n = 0
        for (let j = 0; j < a.length; j++) if (a[j] || b[j]) { sum += Math.abs(a[j] - b[j]); n++ }
        return sum / n
      })
      agreement = `mean |Δfraction| ${deltas.map((d) => d.toFixed(4)).join('/')}`
      check(deltas.every((d) => d <= 0.01), `${model}: fractions ${agreement} > 0.01`)
    } else {
      run(`brainchop-${model}`, [t1, '-o', join(tmp, 'nat_seg.nii')])
      const a = voxels(readFileSync(webMaps[0])), b = voxels(readFileSync(join(tmp, 'nat_seg.nii')))
      const all = [...new Set(a)].filter((v) => v > 0)
      const groups = { csf, wm, gm: all.filter((v) => !csf.includes(v) && !wm.includes(v)) }
      const d = Object.values(groups).map((labels) => dice(a, b, labels))
      agreement = `Dice csf/wm/gm ${d.map((x) => x.toFixed(4)).join('/')}`
      check(d.every((x) => x >= 0.99), `${model}: ${agreement} < 0.99`)
    }

    // 3. end to end: the CLI on the original file
    execFileSync('python3', [join(root, 'cli', 'qc.py'), '--in', t1Original, '--out', join(tmp, 'cli.json'), '--model', model],
      { env, stdio: ['ignore', 'ignore', 'inherit'] })
    const cli = JSON.parse(readFileSync(join(tmp, 'cli.json'), 'utf8'))
    const rel = relDelta(web, cli)
    const air = rel.filter(([k]) => AIR.test(k))
    const rest = rel.filter(([k]) => !AIR.test(k)).map(([, d]) => d).sort((x, y) => x - y)
    const median = rest[rest.length >> 1]
    const worst = rel.reduce((w, r) => (r[1] > w[1] ? r : w))
    check(air.every(([, d]) => d <= TOL), `${model}: air metrics differ ${air.filter(([, d]) => d > TOL).map(([k]) => k)}`)
    check(median <= 0.01, `${model}: median metric Δ ${(100 * median).toFixed(2)} % > 1 %`)
    console.log(`${model.padEnd(12)} niimath max Δ ${(100 * niimathMax).toFixed(3)} % · ${agreement} · CLI median Δ ${(100 * median).toFixed(2)} %, max ${(100 * worst[1]).toFixed(1)} % (${worst[0]})`)
  }
} catch (err) {
  failures.push(err.stack ?? String(err))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
await finish('PARITY', preview, failures)
