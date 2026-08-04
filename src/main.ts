/**
 * BrowserQC — browser-only MRI quality control. No data leaves the machine.
 *
 * Drop a NIfTI (or a DICOM folder → dcm2niix) and it runs automatically: run the
 * brainchop "Subcortical + GWM" parcellation via @niivue/brainchop (which does
 * conform, inference and back-projection inside its wasm module), overlay the
 * native-grid labels, then compute niimath MRIQC-style quality metrics into the
 * side panel. Everything runs in WebAssembly + WebGPU locally.
 */

import NiiVueGPU, {
  type ColorMap,
  type ImageFromUrlOptions,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import { runDcm2niix, traverseDataTransferItems } from './dcm2niix/index'
import { Niimath } from '@niivue/niimath'
import { CSF_LABELS, WM_LABELS, bindSidecar, buildQcReport, parseQcTsv, renderQc } from './qc'
import type { QcReport } from './qc'

const T1_URL = `${import.meta.env.BASE_URL}t1_crop.nii.gz`

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

// --- DOM handles ---
const locationEl = $('location')
const loadingCircle = $('loadingCircle')
const statusMsg = $<HTMLLabelElement>('statusMsg')
const aboutBtn = $<HTMLButtonElement>('aboutBtn')
const aboutDialog = $<HTMLDialogElement>('aboutDialog')
const dicomPick = $<HTMLSelectElement>('dicomPick')
const ovlSlider = $<HTMLInputElement>('ovlSlider')
const hatToggle = $<HTMLInputElement>('hatToggle')
const saveBtn = $<HTMLButtonElement>('saveBtn')
const qcBody = $('qcBody')

// Overlay indices into nv.volumes (reset each run; loadVolumes replaces the scene).
// 0 = native T1, segIndex = label overlay, hatIndex = air-mask overlay (on top).
let segIndex = -1
let hatIndex = -1
const HAT_OPACITY = 0.35

// Last computed MRIQC-style report + the BIDS sidecar it carries. `bidsMeta` is bound
// to the CURRENT image: it's the sidecar dropped alongside it (or a `stagedSidecar`
// dropped just before), and is cleared for any image that arrives without one — so a
// prior scan's metadata can never leak onto a later one. Pre-seeded by cli/qc.mjs --bids.
let lastReport: QcReport | null = null
let bidsMeta: unknown = (window as unknown as { __browserqcBids?: unknown }).__browserqcBids ?? null
let stagedSidecar: unknown = null // a .json dropped alone, applied to the next image only
let lastName = 'image'

// --- NiiVue setup ---
// The NiiVue constructor is GPU-free; attachTo() acquires the WebGPU device and
// throws on a browser without it. So construct here but defer attachTo to init(),
// AFTER the navigator.gpu guard, or a no-WebGPU browser gets an unhandled
// top-level rejection instead of the friendly "needs WebGPU" message.
const nv = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })
type ExtCtx = ReturnType<typeof nv.createExtensionContext>
let ctx: ExtCtx | null = null

async function attachNiiVue(): Promise<void> {
  await nv.attachTo('gl1')
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  nv.showRender = SHOW_RENDER.ALWAYS
  nv.crosshairGap = 5
  nv.meshXRay = 0.05 // let the crosshairs show through the volume in the render view
  nv.isLegendVisible = false
  ctx = nv.createExtensionContext()
  ctx.on('locationChange', (e) => {
    locationEl.textContent = e.detail.string
  })
}

// --- App state ---
let isCleanedUp = false
// True while runSegment is mid-flight mutating the NiiVue scene (loadVolumes →
// addVolume → setColormapLabel). The opacity slider must not re-enter NiiVue during
// that window, so its handler no-ops while busy — see the #ovlSlider listener.
let busy = false

// niimath is used only for the QC metrics (`--qc`); lazily initialised on first QC.
const niimath = new Niimath()
let niimathReady: Promise<void> | null = null
niimath.setOutputDataType('input')

const listeners = new AbortController()
const ac = { signal: listeners.signal }

// Bound every long WASM/WebGPU step (brainchop segmentation — a main-thread WebGPU
// call — plus niimath init + run in its worker). If one never settles (a hung worker,
// a lost GPU device), the single-flight `pending` chain never advances and the app
// wedges (spinner stuck) until reload. A timeout rejects instead so the queue moves
// on. Generous — these finish in seconds; this only fires on a genuine stall.
const WORKER_TIMEOUT_MS = 60_000
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// The vendored niimath wrapper exposes no public accessor for its Web Worker, so we
// reach the private field (verified named `worker`, @niivue/niimath core) for the raw
// --qc post, worker recovery, and teardown. Centralised here so a wrapper rename
// fails in ONE place — ensureNiimath() asserts the handle is real after init(), so a
// bump fails loudly at the seam instead of silently disabling QC + leaking the worker.
function niimathWorker(): Worker | null {
  return (niimath as unknown as { worker?: Worker | null }).worker ?? null
}
function killNiimathWorker(): void {
  try {
    niimathWorker()?.terminate()
    ;(niimath as unknown as { worker: Worker | null }).worker = null
  } catch {
    // worker may already be gone
  }
}

// --- Status helpers ---
function setStatus(msg: string): void {
  statusMsg.textContent = msg
  // The footer cell ellipsizes; expose the full text (esp. long failures) on hover.
  statusMsg.title = msg
  statusMsg.classList.toggle('hidden', msg === '')
}
function spin(on: boolean): void {
  // Toggle visibility (not display) so the spinner's box stays reserved and the
  // status bar height never changes — see .loading-circle in style.css.
  loadingCircle.style.visibility = on ? 'visible' : 'hidden'
}

// --- Serial task queue (load / drop / segment must not overlap) ---
let pending: Promise<unknown> = Promise.resolve()
function enqueue(fn: () => Promise<unknown>): void {
  if (isCleanedUp) return
  pending = pending
    // Re-check at execution time, not just enqueue time: a job queued before
    // cleanup() (HMR/tab-close) must not run on the destroyed NiiVue afterwards.
    .then(() => (isCleanedUp ? undefined : fn()))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus(`Failed: ${msg}`)
      console.error('task failed', err)
    })
}

async function ensureNiimath(): Promise<void> {
  if (!niimathReady)
    niimathReady = niimath.init().then(() => {
      if (!(niimathWorker() instanceof Worker))
        throw new Error('niimath worker handle missing after init (vendored wrapper changed?)')
    })
  await withTimeout(niimathReady, WORKER_TIMEOUT_MS, 'niimath init')
}

// If a niimath run fails, its worker + init promise may be in a bad state; tear both
// down so the next QC spins up a fresh worker. (The vendored wrapper exposes no public
// terminate — killNiimathWorker reaches the private field for us.)
function resetNiimathWorker(): void {
  killNiimathWorker()
  niimathReady = null
}

async function fetchFile(url: string, name: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}

// --- Segmentation ("Subcortical + GWM", @niivue/brainchop on WebGPU) ---
// Runs automatically on every loaded image, and is now a single call: the wasm
// module owns conform → parcellation → back-projection, and hands back a label
// NIfTI already on the input's own grid. The module is import()ed on first use.
//
// The colormap stays a served asset rather than coming from the package: it is
// 608 bytes and NiiVue wants it in its own ColorMap shape anyway.
const SEG_COLORMAP = 'models/model16chan18cls/colormap.json'

// colormap.json ({R,G,B,labels}) → NiiVue ColorMap. rc.9 also needs I (label value
// per entry) and A (alpha) — background label 0 transparent, the rest opaque.
function toColorMap(c: { R: number[]; G: number[]; B: number[]; labels?: string[] }): ColorMap {
  const n = c.R.length
  return {
    R: c.R,
    G: c.G,
    B: c.B,
    I: Array.from({ length: n }, (_, i) => i),
    A: Array.from({ length: n }, (_, i) => (i === 0 ? 0 : 255)),
    labels: c.labels,
  }
}

// Post a raw `--qc` job straight to the niimath worker. The wrapper's chain run()
// only models image→ops→image; --qc takes its own argv and writes a TSV, so we drive
// the worker directly (it stages `blob`+`extraFiles` into MEMFS, runs `cmd`, reads
// `outName` back). The app's single-flight queue guarantees no niimath run overlaps
// this one-shot handler swap.
// Generic form of the same raw-post trick: run any argv and read `outName` back as
// bytes. Used for the air-mask chain (-ras / -allineate / -otsu / -edt).
function runNiimathRaw(cmd: string[], files: File[], outName: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = niimathWorker()
    if (!worker) {
      reject(new Error('niimath worker unavailable'))
      return
    }
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data
      if (d?.type === 'error') {
        reject(new Error(d.message))
        return
      }
      if (d && 'blob' in d)
        void (d.blob as Blob).arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject)
    }
    worker.postMessage({
      blob: files[0],
      extraFiles: files.slice(1).map((f) => ({ name: f.name, data: f })),
      cmd,
      outName,
    })
  })
}

function runNiimathQc(t1: File, seg: File): Promise<string> {
  const cmd = [
    '--qc', t1.name, '--seg', seg.name,
    '--csf', CSF_LABELS.join(','), '--wm', WM_LABELS.join(','),
    '--out', 'qc.tsv',
  ]
  return runNiimathRaw(cmd, [t1, seg], 'qc.tsv').then((b) => new TextDecoder().decode(b))
}

// Air ("hat") mask IQMs. Four niimath passes give the pieces MRIQC uses: an RAS
// volume (== nibabel as_closest_canonical, so the slice fills hit the right axes), an
// affine to the template (transform only — we need just two landmark heights), a head
// mask, and a distance field from the head boundary into the air.
const TEMPLATE_URL = `${import.meta.env.BASE_URL}avg152T1.nii.gz`
// The registration template is static — fetch it once, reuse across runs. Only a
// SUCCESSFUL fetch is memoized; a transient failure clears the cache so the next scan
// retries instead of permanently losing air metrics.
let templatePromise: Promise<File> | null = null
const getTemplate = (): Promise<File> =>
  (templatePromise ??= fetchFile(TEMPLATE_URL, 'tmpl.nii.gz').catch((e) => {
    templatePromise = null
    throw e
  }))

async function computeAirQc(
  t1: File,
  tissue: Record<string, number>,
  worker: Worker,
): Promise<{ metrics: Record<string, number>; hatFile: File }> {
  const { readNii, mul4, computeAirMetrics } = await import('./qc-air')
  const { writeNifti } = await import('./nifti')
  // The outer timeout resets the shared worker. If it fired while these imports were
  // loading, this abandoned continuation must not acquire the replacement worker.
  if (worker !== niimathWorker()) throw new Error('air metrics cancelled')

  const rasBytes = await runNiimathRaw(['qc_t1.nii', '-ras', '-gz', '0', 'ras.nii'], [t1], 'ras.nii')
  const ras = readNii(rasBytes)
  const rasFile = new File([rasBytes], 'ras.nii')

  const tmpl = await getTemplate()
  // A fetch can resolve after the outer timeout released the queue. Stop here rather
  // than overwriting the replacement worker's one onmessage handler.
  if (worker !== niimathWorker()) throw new Error('air metrics cancelled')
  const xfBytes = await runNiimathRaw(
    ['ras.nii', '-allineate', 'tmpl.nii.gz', '-savemat', 'xf.json', '-gz', '0', 'junk.nii'],
    [rasFile, tmpl],
    'xf.json',
  )
  // moving_to_fixed maps subject world-mm → template mm; compose with the RAS affine
  // (voxel → world) to get voxel → template mm, whose z row is the landmark plane.
  const xf = JSON.parse(new TextDecoder().decode(xfBytes)) as { moving_to_fixed: number[][] }
  const voxToTemplate = mul4(xf.moving_to_fixed, ras.affine)

  const headBytes = await runNiimathRaw(
    ['ras.nii', '-otsu', '5', '-fillh', '-close', '0.5', '3', '3', '-gz', '0', 'head.nii'],
    [rasFile],
    'head.nii',
  )
  const distBytes = await runNiimathRaw(
    ['head.nii', '-binv', '-edt', '-gz', '0', 'dist.nii'],
    [new File([headBytes], 'head.nii')],
    'dist.nii',
  )

  const { metrics, hat } = computeAirMetrics(ras, readNii(headBytes).img, readNii(distBytes).img, voxToTemplate, tissue)
  // Ship the hat as an overlay on the RAS grid — same world frame as the native T1, so
  // NiiVue places it correctly without reslicing.
  const hatBytes = writeNifti({ dims: ras.dims, pixDims: ras.pixDims, affine: ras.affine }, hat)
  return { metrics, hatFile: new File([hatBytes], 'airmask.nii') }
}

// Draw the hat as a translucent blue layer showing which voxels feed the air metrics.
// Off by default; the #hatToggle checkbox sets its opacity.
async function addHatOverlay(hatFile: File): Promise<void> {
  if (isCleanedUp) return
  await nv.addVolume({ url: hatFile, name: 'airmask.nii', colormap: 'blue', opacity: 0 } as ImageFromUrlOptions)
  hatIndex = nv.volumes.length - 1
  hatToggle.disabled = false
  if (hatToggle.checked) nv.setVolume(hatIndex, { opacity: HAT_OPACITY })
}

// MRIQC-style QC on the native input + the native-space segmentation. `t1` is the
// SAME serialization runSegment fed to the segmenter, passed in rather than taken
// again — that is what makes the identical geometry `--qc` requires true by
// construction rather than by two call sites agreeing.
async function computeQc(segBytes: Uint8Array, t1: Uint8Array): Promise<void> {
  await ensureNiimath()
  // Both inputs are uncompressed .nii (saveVolume with an empty filename does not gzip;
  // writeNifti emits raw) — no gunzip cost, and `--qc` writes a TSV so output gz never
  // applies. Name matches content so niimath doesn't attempt a gunzip.
  const t1File = new File([t1], 'qc_t1.nii')
  const tsv = await withTimeout(
    runNiimathQc(t1File, new File([segBytes], 'qc_seg.nii')),
    WORKER_TIMEOUT_MS,
    'niimath --qc',
  )
  const metrics = parseQcTsv(tsv)
  // niimath's --qc has no air term, so the background IQMs are computed here from an
  // MRIQC-style "hat" mask. Non-fatal: a failure just omits those keys. The aggregate
  // pipeline is bounded; a timeout/error may leave the worker mid-WASM-call, so reset
  // it (as the QC catch does).
  try {
    setStatus('Computing background (air) metrics…')
    const worker = niimathWorker()
    if (!worker) throw new Error('niimath worker unavailable')
    const air = await withTimeout(computeAirQc(t1File, metrics, worker), WORKER_TIMEOUT_MS, 'air metrics')
    Object.assign(metrics, air.metrics)
    // `cnr` (with the air term) supersedes niimath's air-free estimate.
    if ('cnr' in metrics) delete metrics.cnr_noair
    await addHatOverlay(air.hatFile)
  } catch (err) {
    console.warn('air metrics unavailable', err)
    resetNiimathWorker()
  }
  const vol0 = nv.volumes[0]
  lastReport = buildQcReport(metrics, { dims: vol0.hdr.dims, pixDims: vol0.hdr.pixDims }, bidsMeta)
  // Automation seam: the panel renders 3 significant figures, so expose the full
  // report at full precision for cli/qc.mjs, which drives this page headlessly.
  ;(window as unknown as { browserqcMetrics?: unknown }).browserqcMetrics = lastReport
  saveBtn.disabled = false
  renderQc(qcBody, metrics)
}

// Load `file` as the displayed volume, segment it, and QC the result.
async function runSegment(file: File): Promise<void> {
  if (isCleanedUp) return // a job queued before cleanup() (HMR) must not touch a dead nv
  spin(true)
  busy = true
  lastReport = null
  // Clear the automation seam too, so a headless client waiting on `browserqcMetrics`
  // after a second load can't read the previous scan's report.
  ;(window as unknown as { browserqcMetrics?: unknown }).browserqcMetrics = undefined
  lastName = file.name
  segIndex = -1
  hatIndex = -1
  saveBtn.disabled = true
  hatToggle.disabled = true
  renderQc(qcBody, null) // clear any prior QC while we recompute
  const t0 = performance.now()
  try {
    setStatus(`Loading ${file.name}…`)
    await nv.loadVolumes([{ url: file, name: file.name } as ImageFromUrlOptions])
    if (isCleanedUp) return

    setStatus('Segmenting (Subcortical + GWM)… first run downloads the model')
    const { segment } = await import('./brainchop/index.js')
    /*
     * `?backend=webgl2` forces the fallback, and without it the fallback is
     * effectively untestable here. brainchop picks WebGPU wherever it exists,
     * so on any machine that can run BrowserQC at all the WebGL2 path would
     * never execute -- a test that passes while testing nothing. `?backend=`
     * accepts only the two known names; anything else falls through to auto.
     */
    const wanted = new URLSearchParams(location.search).get('backend')
    const backend = wanted === 'webgl2' || wanted === 'webgpu' ? wanted : undefined
    if (isCleanedUp) return // teardown may have run during the dynamic import
    // Segment the bytes NiiVue is DISPLAYING, not the dropped file. NiiVue may
    // reorient on load, and the module returns labels on whatever grid it was
    // given — so this is what keeps the pair geometry-identical for `--qc`,
    // which is the same argument the old hand-rolled reslice made by copying
    // volumes[0]'s header. computeQc serializes volumes[0] the same way.
    const t1 = await nv.saveVolume({ volumeByIndex: 0, filename: '' })
    if (!(t1 instanceof Uint8Array)) throw new Error('could not serialize the input volume')
    const seg = await withTimeout(
      segment(t1, {
        model: '16chan18cls',
        // The glue and its .wasm are served from public/brainchop/, committed
        // there because a bundler cannot carry them: the glue finds its own
        // .wasm through its own import.meta.url, so the pair must stay adjacent
        // and unhashed. scripts/sync-brainchop.mjs refreshes both.
        assetPath: `${import.meta.env.BASE_URL}brainchop/`,
        backend,
        // In a Worker, which is what keeps this page usable while it runs.
        // Measured with a rAF ticker: in-thread the WebGL2 fallback draws 3
        // frames and stalls for 2171 ms of a 2196 ms run, and even WebGPU
        // stalls 258 ms on the CPU stages (conform, bwlabel, gzip) that no
        // amount of ASYNCIFY moves. In a worker both are 0 ms. It also makes
        // the timeout a real cancellation: terminate() stops the work, where
        // an in-thread timeout can only stop waiting for it.
        worker: true,
        // Bound the module on the SAME clock as our withTimeout (its own default is
        // 120 s). On a GPU-loss stall both fire together, so the abandoned run tears
        // itself down instead of holding a GPUDevice while a new drop starts a second.
        timeoutMs: WORKER_TIMEOUT_MS,
        onLog: (l) => console.debug('brainchop:', l),
      }),
      WORKER_TIMEOUT_MS,
      'segmentation',
    )
    // Which backend ran, in the UI and not only in the console: the point of
    // `?backend=webgl2` is to confirm the fallback executed, and a silent
    // fall-through to WebGPU would look exactly like success.
    console.info(`brainchop: ${seg.backend}, ${Math.round(seg.elapsedMs)} ms` +
      `${seg.ranInWorker ? ' (worker)' : ''}`)
    if (backend) setStatus(`Segmented on ${seg.backend}…`)
    // Already a label NIfTI (uint8, intent 1002) on the input grid: no reslice,
    // no header to write. The module did both.
    const bytes = new Uint8Array(seg.image)
    if (isCleanedUp) return // teardown may have run during the segmentation
    await nv.addVolume({
      url: new File([bytes], 'segmentation.nii'),
      name: 'segmentation.nii',
      opacity: Number(ovlSlider.value) / 255,
    } as ImageFromUrlOptions)
    if (isCleanedUp) return
    segIndex = nv.volumes.length - 1 // fixed handle: the air overlay is added on top later

    const cmapRes = await fetch(`${import.meta.env.BASE_URL}${SEG_COLORMAP}`)
    if (!cmapRes.ok) throw new Error(`fetch colormap failed: ${cmapRes.status}`)
    const cmap = await cmapRes.json()
    await nv.setColormapLabel(segIndex, toColorMap(cmap))
    // Scene mutation is done. Apply the latest slider value first — a drag during the
    // locked window updated the control but the handler dropped it, so `addVolume`'s
    // sampled opacity may be stale — then release the lock so subsequent drags land
    // during the (scene-untouching) QC run below. `finally` still clears it if we
    // bailed earlier.
    void nv.setVolume(segIndex, { opacity: Number(ovlSlider.value) / 255 })
    busy = false

    // QC on the result. Non-fatal: a QC failure must not discard the segmentation
    // display — reset the worker, surface it in the status bar, leave the panel empty.
    try {
      setStatus('Computing image-quality metrics (niimath)…')
      await computeQc(bytes, t1)
      if (isCleanedUp) return
      setStatus(`Segmentation + QC complete (${Math.round(performance.now() - t0)} ms)`)
    } catch (err) {
      console.warn('QC failed', err)
      resetNiimathWorker()
      renderQc(qcBody, null)
      setStatus(`Segmented — QC unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  } finally {
    busy = false
    spin(false)
  }
}

// --- DICOM / file drag-drop ---
let dcmConverted: File[] = []
const DIRECT_VOLUME_RE = /\.(nii|nii\.gz|mgh|mgz|nrrd|mha|mhd|nhdr|head|v)$/i

async function handleDrop(filesPromise: Promise<File[]>): Promise<void> {
  if (isCleanedUp) return
  spin(true)
  try {
    setStatus('Reading dropped files…')
    const all = await filesPromise
    // A dropped BIDS sidecar (.json) rides along as bids_meta in the saved report; it is
    // metadata only and never affects the metrics.
    const sidecar = all.find((f) => /\.json$/i.test(f.name))
    let dropMeta: unknown = null
    if (sidecar) {
      try { dropMeta = JSON.parse(await sidecar.text()) } catch { dropMeta = null }
    }
    const files = all.filter((f) => !/\.json$/i.test(f.name))
    const t = bindSidecar(dropMeta, stagedSidecar, files.length > 0)
    stagedSidecar = t.staged
    if (files.length === 0) {
      setStatus(dropMeta ? 'Sidecar stored — now drop the image.' : 'Drop contained no readable files.')
      return
    }
    bidsMeta = t.bind // this image's own sidecar, else a staged one, else null
    // Fast-path a single obvious volume file straight to segmentation.
    if (files.length === 1 && DIRECT_VOLUME_RE.test(files[0].name)) {
      await runSegment(files[0])
      return
    }
    setStatus(`Converting ${files.length} file(s) with dcm2niix…`)
    const t0 = performance.now()
    const niftiFiles = await runDcm2niix(files)
    const ms = Math.round(performance.now() - t0)
    if (niftiFiles.length === 0) {
      setStatus('No NIfTI output produced. Are these DICOM images?')
      return
    }
    if (niftiFiles.length > 1) {
      bidsMeta = null // one dropped sidecar cannot be associated safely across series
      dcmConverted = niftiFiles
      dicomPick.replaceChildren()
      niftiFiles.forEach((f, i) => {
        const opt = document.createElement('option')
        opt.value = String(i)
        opt.text = f.name
        dicomPick.appendChild(opt)
      })
      dicomPick.value = '0'
      dicomPick.classList.remove('hidden')
      setStatus(`dcm2niix: ${niftiFiles.length} NIfTI in ${ms} ms — pick one.`)
    }
    await runSegment(niftiFiles[0])
  } finally {
    spin(false)
  }
}

// --- Init ---
async function init(): Promise<void> {
  // NiiVue's attachTo() acquires a WebGPU device and throws without one. But
  // navigator.gpu can exist while requestAdapter() returns null, device creation
  // fails, or the GPU is blocklisted — so guard the fast case AND catch attachTo()
  // failures, giving a friendly message instead of an unhandled console.error in
  // every WebGPU-unavailable path.
  const noWebGpu =
    'This browser/GPU can’t initialize WebGPU — BrowserQC needs a recent desktop Chrome, Edge, or Safari.'
  if (!navigator.gpu) {
    setStatus(noWebGpu)
    return
  }
  try {
    await attachNiiVue()
  } catch (err) {
    // Almost always genuine WebGPU unavailability; warn (not error, so the smoke's
    // console.error gate stays meaningful) so a non-WebGPU init bug isn't silently
    // mislabeled.
    console.warn('BrowserQC: WebGPU init failed', err)
    setStatus(noWebGpu)
    return
  }
  // Load + segment the bundled default subject, with its BIDS sidecar as bids_meta.
  // (Skipped under the CLI, which pre-seeds __browserqcBids and 404s this fetch so a
  // CLI-injected image never inherits the default subject's metadata.)
  if (!bidsMeta) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}t1_crop.json`)
      if (res.ok) bidsMeta = await res.json()
    } catch { /* no sidecar — fine */ }
  }
  const t1 = await fetchFile(T1_URL, 't1_crop.nii.gz')
  await runSegment(t1)
}

// --- Wiring ---
document.addEventListener('dragover', (e) => e.preventDefault(), ac)
document.addEventListener(
  'drop',
  (e) => {
    e.preventDefault()
    const items = e.dataTransfer?.items
    if (!items || items.length === 0) return
    // Invalidate the previous DICOM selection synchronously. If the queue is busy,
    // leaving it active until handleDrop() starts lets an old selection enqueue after
    // this newer drop and replace the image the user just requested.
    dcmConverted = []
    dicomPick.classList.add('hidden')
    // A DataTransferItemList is only valid during this event; start traversal now.
    const filesPromise = traverseDataTransferItems(items)
    filesPromise.catch(() => {})
    enqueue(() => handleDrop(filesPromise))
  },
  ac,
)
dicomPick.addEventListener(
  'change',
  () => {
    const file = dcmConverted[Number(dicomPick.value)]
    if (file) enqueue(() => runSegment(file))
  },
  ac,
)
aboutBtn.addEventListener('click', () => aboutDialog.showModal(), ac)
// Save the MRIQC-style report next to nothing — a plain client-side download.
saveBtn.addEventListener(
  'click',
  () => {
    if (!lastReport) return
    const url = window.URL.createObjectURL(
      new Blob([`${JSON.stringify(lastReport, null, 2)}\n`], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `${lastName.replace(/\.(nii|nii\.gz|mgz|mgh)$/i, '')}_qc.json`
    a.click()
    setTimeout(() => window.URL.revokeObjectURL(url), 0)
  },
  ac,
)
// Overlay opacity — drives the segmentation overlay (last volume) when present.
ovlSlider.addEventListener(
  'input',
  () => {
    // Skip while a segmentation is mid-flight — mutating the scene between its
    // loadVolumes/addVolume awaits can hit the wrong volume or throw. The final
    // opacity is applied via addVolume's `opacity` when the overlay lands.
    if (!busy && segIndex >= 0)
      void nv.setVolume(segIndex, { opacity: Number(ovlSlider.value) / 255 })
  },
  ac,
)
// Air-mask overlay toggle (the translucent blue "hat").
hatToggle.addEventListener(
  'change',
  () => {
    if (!busy && hatIndex >= 0)
      void nv.setVolume(hatIndex, { opacity: hatToggle.checked ? HAT_OPACITY : 0 })
  },
  ac,
)

// --- Cleanup (HMR / tab close) ---
async function cleanup(): Promise<void> {
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  // Terminate the niimath worker FIRST (don't await `pending`): a WASM run is one
  // uninterruptible call, so awaiting the queue would stall teardown. The terminated
  // run never resolves; any run that already resolved hits `if (isCleanedUp) return`
  // before touching nv/ctx.
  killNiimathWorker()
  try {
    ctx?.dispose() // null if WebGPU was unavailable (attachNiiVue never ran)
  } catch {
    // best-effort — must not skip nv.destroy() below
  }
  nv.destroy()
}
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return
  void cleanup()
}, { once: true, signal: listeners.signal })
if (import.meta.hot) import.meta.hot.dispose(cleanup)

enqueue(init)
