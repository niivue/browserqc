/**
 * BrowserQC — browser-only MRI quality control. No data leaves the machine.
 *
 * Drop a NIfTI (or a DICOM folder → dcm2niix) and it runs automatically: run the
 * brainchop "Subcortical + GWM" parcellation via @brainchop/mindgrab (which does
 * conform, inference and back-projection inside its wasm module), overlay the
 * native-grid labels, then compute niimath MRIQC-style quality metrics into the
 * side panel. Everything runs locally in WebAssembly + WebGPU (WebGL2 fallback).
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
import { CSF_LABELS, WM_LABELS, bindSidecar, renderQc } from './qc'
import type { QcMetrics, QcReport } from './qc'

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
const saveBtn = $<HTMLButtonElement>('saveBtn')
const qcBody = $('qcBody')

// Overlay indices into nv.volumes (reset each run; loadVolumes replaces the scene).
// 0 = native T1, segIndex = label overlay.
let segIndex = -1

// Last computed MRIQC-style report + the BIDS sidecar it carries. `bidsMeta` is bound
// to the CURRENT image: it's the sidecar dropped alongside it (or a `stagedSidecar`
// dropped just before), and is cleared for any image that arrives without one — so a
// prior scan's metadata can never leak onto a later one. Pre-seeded by cli/qc.mjs --bids.
let lastReport: QcReport | null = null
let bidsMeta: unknown = (window as unknown as { __browserqcBids?: unknown }).__browserqcBids ?? null
let stagedSidecar: unknown = null // a .json dropped alone, applied to the next image only
let lastName = 'image'

// --- NiiVue setup ---
// The NiiVue constructor is GPU-free; attachTo() acquires the device (WebGPU, else
// WebGL2) and throws when neither is available. So construct here but defer attachTo
// to init(), where it is try/caught — otherwise such a browser gets an unhandled
// top-level rejection instead of the friendly message.
const nv = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })

async function attachNiiVue(): Promise<void> {
  await nv.attachTo('gl1')
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  nv.showRender = SHOW_RENDER.ALWAYS
  nv.crosshairGap = 5
  nv.meshXRay = 0.05 // let the crosshairs show through the volume in the render view
  nv.isLegendVisible = false
  nv.addEventListener('locationChange', (e) => {
    locationEl.textContent = e.detail.string
  }, ac)
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

const listeners = new AbortController()
const ac = { signal: listeners.signal }

// Bound every long WASM/GPU step (brainchop segmentation in its worker, plus
// niimath init + run in its worker). If one never settles (a hung worker,
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

// The @niivue/niimath wrapper exposes no public accessor for its Web Worker, so we
// reach the private field (verified named `worker`) to post raw jobs to it.
// Centralised here so a wrapper rename fails in ONE place — ensureNiimath() asserts
// the handle is real after init(), so a bump fails loudly at the seam instead of
// silently disabling QC.
function niimathWorker(): Worker | null {
  return (niimath as unknown as { worker?: Worker | null }).worker ?? null
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
        throw new Error('niimath worker handle missing after init (wrapper changed?)')
    })
  await withTimeout(niimathReady, WORKER_TIMEOUT_MS, 'niimath init')
}

// If a niimath run fails, its worker + init promise may be in a bad state; tear both
// down so the next QC spins up a fresh worker. dispose() is the wrapper's own teardown
// (terminates, clears its ready flag, rejects an in-flight init/run). It does NOT
// settle our raw posts — the wrapper never sees those — so those stay covered by
// withTimeout.
function resetNiimathWorker(): void {
  niimath.dispose('niimath worker reset')
  niimathReady = null
}

async function fetchFile(url: string, name: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}

// --- Segmentation ("Subcortical + GWM", @brainchop/mindgrab on WebGPU/WebGL2) ---
// Runs automatically on every loaded image, and is now a single call: the wasm
// module owns conform → parcellation → back-projection, and hands back a label
// NIfTI already on the input's own grid. The module is import()ed on first use.

// The "Subcortical + GWM" (16chan18cls) label colormap — 18 FreeSurfer-style labels
// (background + the 17 regions). App config, not shipped by the package; inlined
// (it's tiny) so there's no served asset.
// rc.9 wants I (label value per entry) and A (alpha) alongside R/G/B — label 0 is
// background, hence transparent.
const SEG_COLORMAP: ColorMap = {
  R: [0, 245, 205, 120, 196, 220, 230, 0, 122, 236, 12, 204, 42, 119, 220, 103, 255, 165],
  G: [0, 245, 62, 18, 58, 248, 148, 118, 186, 13, 48, 182, 204, 159, 216, 255, 165, 42],
  B: [0, 245, 78, 134, 250, 164, 34, 14, 220, 176, 255, 142, 164, 176, 20, 255, 0, 42],
  I: [...Array(18).keys()],
  A: [0, ...Array(17).fill(255)],
  labels: ['Unknown', 'Cerebral-White-Matter', 'Cerebral-Cortex', 'Lateral-Ventricle', 'Inferior-Lateral-Ventricle', 'Cerebellum-White-Matter', 'Cerebellum-Cortex', 'Thalamus', 'Caudate', 'Putamen', 'Pallidum', '3rd-Ventricle', '4th-Ventricle', 'Brain-Stem', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'VentralDC'],
}

// Post a raw job straight to the niimath worker: run any argv and read `outName`
// back as bytes. The wrapper's chain run() only models image→ops→image, but --qc
// takes its own argv and writes a JSON report. The worker stages `blob`+`extraFiles`
// into MEMFS, runs `cmd`, reads `outName` back. The app's single-flight queue guarantees no
// niimath run overlaps this one-shot handler swap.
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

const TEMPLATE_URL = `${import.meta.env.BASE_URL}avg152T1.nii.gz`

async function runNiimathQc(t1: File, seg: File): Promise<QcReport> {
  const worker = niimathWorker()
  if (!worker) throw new Error('niimath worker unavailable')
  const template = await fetchFile(TEMPLATE_URL, 'avg152T1.nii.gz')
  // The template fetch may finish after a QC timeout reset the worker.
  if (worker !== niimathWorker()) throw new Error('QC cancelled')
  const cmd = [
    '--qc', t1.name, '--seg', seg.name,
    '--csf', CSF_LABELS.join(','), '--wm', WM_LABELS.join(','),
    '--air', template.name, '--json', 'qc.json',
  ]
  const bytes = await runNiimathRaw(cmd, [t1, seg, template], 'qc.json')
  return JSON.parse(new TextDecoder().decode(bytes)) as QcReport
}

// MRIQC-style QC on the native input + the native-space segmentation. `t1` is the
// SAME serialization runSegment fed to the segmenter, passed in rather than taken
// again — that is what makes the identical geometry `--qc` requires true by
// construction rather than by two call sites agreeing.
async function computeQc(segBytes: Uint8Array, t1: Uint8Array): Promise<void> {
  await ensureNiimath()
  // Both inputs are uncompressed .nii (saveVolume with an empty filename does not gzip),
  // so niimath avoids a gunzip before writing its JSON report.
  const t1File = new File([t1], 'qc_t1.nii')
  const report = await withTimeout(
    runNiimathQc(t1File, new File([segBytes], 'qc_seg.nii')),
    WORKER_TIMEOUT_MS,
    'niimath --qc --air',
  )
  if (bidsMeta) report.bids_meta = bidsMeta
  // niimath records only itself; name the model that produced the labels it scored.
  Object.assign(report.provenance as object, { segmentation: 'brainchop model16chan18cls (Subcortical + GWM)' })
  lastReport = report
  // Automation seam: the panel renders 3 significant figures, so expose the full
  // report at full precision for cli/qc.mjs, which drives this page headlessly.
  ;(window as unknown as { browserqcMetrics?: unknown }).browserqcMetrics = lastReport
  saveBtn.disabled = false
  renderQc(qcBody, report as QcMetrics)
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
  saveBtn.disabled = true
  renderQc(qcBody, null) // clear any prior QC while we recompute
  const t0 = performance.now()
  try {
    setStatus(`Loading ${file.name}…`)
    await nv.loadVolumes([{ url: file, name: file.name } as ImageFromUrlOptions])
    if (isCleanedUp) return

    setStatus('Segmenting (Subcortical + GWM)… first run downloads the model')
    const { segment } = await import('@brainchop/mindgrab')
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
        // Staged into public/brainchop/ by scripts/copy-brainchop.mjs (dev+build):
        // the glue finds its own .wasm via its own import.meta.url, so the pair
        // must stay adjacent and unhashed — public/ preserves names, a bundler
        // would rewrite one and hash the other.
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
    segIndex = nv.volumes.length - 1

    await nv.setColormapLabel(segIndex, SEG_COLORMAP)
    // Scene mutation is done. Apply the latest slider value first — a drag during the
    // locked window updated the control but the handler dropped it, so `addVolume`'s
    // sampled opacity may be stale — then release the lock so subsequent drags land
    // during the (scene-untouching) QC run below. `finally` still clears it if we
    // bailed earlier.
    void nv.setVolume(segIndex, { opacity: Number(ovlSlider.value) / 255 })
    busy = false
    // Teardown may have run during the awaits above. Without this, computeQc would
    // call ensureNiimath() with a cleared `niimathReady` and spin up a fresh worker
    // after cleanup(), which then reads nv.volumes on a destroyed NiiVue.
    if (isCleanedUp) return

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
  /*
   * NO navigator.gpu GUARD. The default `@niivue/niivue` build carries BOTH
   * renderers and falls back to WebGL2 when WebGPU is unavailable, and
   * @brainchop/mindgrab does the same for the segmentation — so a browser without
   * WebGPU can run this page end to end. An early return on !navigator.gpu
   * refused it before either fallback was ever consulted, which is what made
   * Linux Firefox show a "needs WebGPU" message on a machine that can render
   * and segment perfectly well.
   *
   * The try/catch stays: navigator.gpu can exist while requestAdapter returns
   * null or the GPU is blocklisted, and attachTo() can still fail for reasons no
   * fallback covers. That is a real failure and gets a real message.
   */
  try {
    await attachNiiVue()
  } catch (err) {
    // warn, not error, so the smoke test's console.error gate stays meaningful.
    console.warn('BrowserQC: renderer init failed', err)
    setStatus(
      'This browser/GPU can’t initialize either WebGPU or WebGL2 — BrowserQC ' +
      'needs a reasonably recent desktop browser.',
    )
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

// --- Cleanup (HMR / tab close) ---
async function cleanup(): Promise<void> {
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  // Terminate the niimath worker FIRST (don't await `pending`): a WASM run is one
  // uninterruptible call, so awaiting the queue would stall teardown. The terminated
  // run never resolves; any run that already resolved hits `if (isCleanedUp) return`
  // before touching nv.
  resetNiimathWorker()
  nv.destroy()
}
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return
  void cleanup()
}, { once: true, signal: listeners.signal })
if (import.meta.hot) import.meta.hot.dispose(cleanup)

enqueue(init)
