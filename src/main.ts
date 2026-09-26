/**
 * BrowserQC — browser-only MRI quality control. No data leaves the machine.
 *
 * Drop a NIfTI (or DICOM files/folders → dcm2niix, with a series picker when there
 * are several) and it runs automatically: segment with @brainchop/mindgrab (conform,
 * inference and back-projection all inside its wasm module), overlay the result,
 * then compute niimath MRIQC-style quality metrics into the side panel.
 */

import NiiVue, { type ColorMap, MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import { runDcm2niix, traverseDataTransferItems } from '@niivue/nv-ext-dcm2niix'
import { Niimath, type QcTissues } from '@niivue/niimath'
import { MODELS as BRAINCHOP, type ModelName, segment, segmentTissues } from '@brainchop/mindgrab'
import { MODELS, type Model, type QcMetrics, type QcReport, bindSidecar, renderQc } from './qc'

declare global {
  interface Window {
    // Automation seams: full-precision report (the panel rounds) and the exact QC inputs.
    browserqcMetrics?: QcReport
    browserqcInputs?: { t1: Uint8Array } & QcTissues
  }
}

const BASE = import.meta.env.BASE_URL
const NIFTI = /\.nii(\.gz)?$/i
// Bounds niimath and dcm2niix (mindgrab bounds itself via timeoutMs): a worker that
// never answers would otherwise leave `busy` set until reload.
const WORKER_TIMEOUT_MS = 60_000
// Overlay tints: a light floor..tint ramp stays readable over bright T1 white matter.
const TISSUES = [['gm', [255, 64, 64]], ['wm', [255, 255, 255]], ['csf', [64, 128, 255]]] as const

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const modelPick = $<HTMLSelectElement>('modelPick')
const seriesPick = $<HTMLSelectElement>('seriesPick')
const seriesDialog = $<HTMLDialogElement>('seriesDialog')
const ovlSlider = $<HTMLInputElement>('ovlSlider')
const saveBtn = $<HTMLButtonElement>('saveBtn')
const qcBody = $('qcBody')
const params = new URLSearchParams(location.search)

type Series = { file: File; label: string; detail: string; voxels: number; meta: unknown }
let series: Series[] = []
let current: Series | null = null
let stagedSidecar: unknown = null // a .json dropped alone, bound to the next image only
let busy = false
let tissueColormaps: Record<string, string> = {}

const nv = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })

function setStatus(msg: string): void {
  const el = $('statusMsg')
  el.textContent = el.title = msg // the footer ellipsizes; hover shows it all
  el.hidden = !msg
}

// Disables everything that starts a run, so a run needs no stale-image checks.
function setBusy(on: boolean): void {
  busy = modelPick.disabled = seriesPick.disabled = on
  $('loadingCircle').style.visibility = on ? 'visible' : 'hidden'
}

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer = 0
  const expire = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), WORKER_TIMEOUT_MS)
  })
  return Promise.race([p, expire]).finally(() => clearTimeout(timer))
}

// One niimath per QC, disposed after: a failed run cannot poison the next one.
async function computeQc(t1: Uint8Array<ArrayBuffer>, tissues: QcTissues): Promise<QcReport> {
  const niimath = new Niimath()
  try {
    return await withTimeout((async () => {
      await niimath.init()
      const air = new File([await (await fetch(`${BASE}avg152T1.nii.gz`)).blob()], 'avg152T1.nii.gz')
      return niimath.image(t1).qc(tissues, air)
    })(), 'niimath --qc')
  } finally {
    niimath.dispose()
  }
}

// Display `current`, segment it with the picked model, overlay the result, then QC it.
async function run(): Promise<void> {
  if (!current) return
  const model = modelPick.value as Model
  const { label, pve } = MODELS[model]
  setBusy(true)
  window.browserqcMetrics = undefined
  saveBtn.disabled = true
  renderQc(qcBody, null)
  const t0 = performance.now()
  try {
    setStatus(`Loading ${current.label}…`)
    await nv.loadVolumes([{ url: current.file, name: current.file.name }])
    setStatus(`Segmenting (${label})…`)
    // Segment the bytes NiiVue DISPLAYS, not the dropped file: NiiVue may reorient on
    // load and the module answers on the grid it is given, so this keeps the T1 and
    // the segmentation on one grid, which --qc requires.
    const t1 = (await nv.saveVolume({ volumeByIndex: 0, filename: '' })) as Uint8Array<ArrayBuffer>
    // ?backend=webgl2 forces the fallback, which a WebGPU machine would never otherwise run.
    const wanted = params.get('backend')
    const options = {
      backend: wanted === 'webgl2' || wanted === 'webgpu' ? wanted : undefined,
      worker: true, // keeps the page responsive, and makes the timeout a real cancellation
      timeoutMs: WORKER_TIMEOUT_MS,
      onLog: (line: string) => console.debug('brainchop:', line),
    } as const
    const opacity = Number(ovlSlider.value) / 255
    let tissues: QcTissues
    let backend: string
    if (pve) {
      const result = await segmentTissues(t1, { model: pve as 'mindmap', ...options })
      for (const [name] of TISSUES) {
        // colormapType 1 (transparent below calMin): else the 3D render shows every tiny fraction.
        await nv.addVolume({ url: new File([result.tissues[name]], `${name}.nii`), colormap: tissueColormaps[name],
          colormapType: 1, calMin: 0.03, calMax: 1, opacity })
      }
      tissues = { pve: [result.tissues.csf, result.tissues.gm, result.tissues.wm] }
      backend = result.backend
    } else {
      const result = await segment(t1, { model: model as ModelName, ...options })
      await nv.addVolume({ url: new File([result.image], 'segmentation.nii'), opacity })
      // NiiVue fills in label values (I) and alpha (A, label 0 transparent) itself.
      await nv.setColormapLabel(1, BRAINCHOP[model as ModelName].colormap as ColorMap)
      tissues = { seg: result.image, csf: MODELS[model].csf!, wm: MODELS[model].wm! }
      backend = result.backend
    }
    window.browserqcInputs = { t1, ...tissues }
    // QC is non-fatal: a failure leaves the segmentation up and says so.
    try {
      setStatus('Computing image-quality metrics (niimath)…')
      const report = await computeQc(t1, tissues)
      Object.assign(report.provenance as object, { segmentation: `brainchop ${model} (${label})` })
      if (current.meta) report.bids_meta = current.meta
      window.browserqcMetrics = report
      saveBtn.disabled = false
      renderQc(qcBody, report as QcMetrics)
      setStatus(`${label} on ${backend} + QC: ${Math.round(performance.now() - t0)} ms`)
    } catch (err) {
      console.warn('QC failed', err)
      setStatus(`Segmented — QC unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  } catch (err) {
    console.error('run failed', err)
    setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    setBusy(false)
  }
}

// --- drops: NIfTI directly, everything else through dcm2niix ---

// Dimensions and voxel size from a little-endian NIfTI-1 header, which the first stream
// chunk holds; anything else (NIfTI-2, big-endian) has no shape to show.
async function niftiShape(file: File): Promise<{ dims: number[]; mm: number }> {
  let stream = file.stream()
  if (/\.gz$/i.test(file.name)) stream = stream.pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const { value } = await reader.read()
  void reader.cancel()
  const header = value && value.byteLength >= 348 ? new DataView(value.buffer, value.byteOffset) : null
  if (header?.getInt32(0, true) !== 348) return { dims: [], mm: 0 }
  return { dims: Array.from({ length: Math.min(header.getInt16(40, true), 7) }, (_, i) => header.getInt16(42 + 2 * i, true)),
    mm: header.getFloat32(80, true) }
}

// Label each image by its sidecar (series number, description, echo/phase suffix) and its
// shape, so a 3D anatomical stands out from fMRI or field maps. An image without its own
// sidecar gets `fallback` (a dropped/staged one) only when it is the only image.
async function describeSeries(images: File[], sidecars: File[], fallback: unknown): Promise<Series[]> {
  const entries = await Promise.all(images.map(async (file) => {
    const base = file.name.replace(NIFTI, '')
    const own = sidecars.find((f) => f.name === `${base}.json`)
    const meta = own ? await own.text().then(JSON.parse).catch(() => null) : images.length === 1 ? fallback : null
    const suffix = base.match(/_(e\d+(_ph)?|ph)$/)?.[1]
    const noShape = { dims: [] as number[], mm: 0 } // a corrupt file still gets its tile
    const { dims, mm } = NIFTI.test(file.name) ? await niftiShape(file).catch(() => noShape) : noShape
    const volumes = dims[3] > 1 ? dims[3] : 1
    const m = (meta ?? {}) as { SeriesNumber?: number; SeriesDescription?: string }
    return { file, meta, number: m.SeriesNumber ?? 0,
      voxels: volumes === 1 ? dims.slice(0, 3).reduce((a, b) => a * b, 1) : 0,
      label: [m.SeriesNumber, m.SeriesDescription ?? base, suffix].filter((x) => x !== undefined).join(' · '),
      detail: dims.length ? `${dims.slice(0, 3).join('×')} · ${mm.toFixed(1)} mm${volumes > 1 ? ` · ${volumes} volumes` : ''}` : '' }
  }))
  return entries.sort((a, b) => a.number - b.number)
}

function pick(index: number): void {
  seriesPick.value = String(index)
  current = series[index]
  void run()
}

// Several series: offer them all, suggesting the largest single 3D volume (the anatomical
// the models expect) rather than running one arbitrarily.
function chooseSeries(): void {
  const suggested = series.reduce((best, s, i) => (s.voxels > series[best].voxels ? i : best), 0)
  setStatus(`${series.length} series: choose one`)
  $('seriesList').replaceChildren(...series.map((s, i) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'series-opt' })
    button.append(Object.assign(document.createElement('strong'), { textContent: s.label }),
      Object.assign(document.createElement('small'), { textContent: `${s.detail}${i === suggested ? ' · suggested' : ''}` }))
    button.onclick = () => {
      seriesDialog.close()
      pick(i)
    }
    return button
  }))
  seriesDialog.showModal()
  ;($('seriesList').children[suggested] as HTMLButtonElement).focus()
}

async function openFiles(files: File[]): Promise<void> {
  if (busy) return // a run may have started while the drop was read
  setBusy(true)
  try {
    const jsons = files.filter((f) => /\.json$/i.test(f.name))
    const volumes = files.filter((f) => nv.volumeExtensions.some((ext) => f.name.toUpperCase().endsWith(`.${ext}`)))
    const other = files.filter((f) => !jsons.includes(f) && !volumes.includes(f))
    let converted: File[] = []
    if (other.length) {
      setStatus(`Converting ${other.length} file(s) with dcm2niix…`)
      // ponytail: on timeout the dcm2niix worker is abandoned, not terminated (the extension owns it).
      converted = await withTimeout(runDcm2niix(other, { niftiOnly: false }), 'dcm2niix').catch((err) => {
        if (!volumes.length) throw err
        return [] // stray non-DICOM files beside a volume
      })
    }
    const images = [...volumes, ...converted.filter((f) => NIFTI.test(f.name))]
    const dropMeta = jsons.length ? await jsons[0].text().then(JSON.parse).catch(() => null) : null
    const sidecar = bindSidecar(dropMeta, stagedSidecar, images.length > 0)
    stagedSidecar = sidecar.staged
    if (!images.length) {
      setStatus(dropMeta ? 'Sidecar stored — now drop the image.' : 'No images: drop NIfTI or DICOM files or folders.')
      return
    }
    series = await describeSeries(images, [...jsons, ...converted.filter((f) => /\.json$/i.test(f.name))], sidecar.bind)
    seriesPick.replaceChildren(...series.map((s, i) => new Option(s.label, String(i))))
    seriesPick.parentElement!.hidden = series.length < 2
    seriesPick.selectedIndex = -1 // nothing chosen yet
  } catch (err) {
    console.error('drop failed', err)
    setStatus(`Could not open the drop: ${err instanceof Error ? err.message : String(err)}`)
    return
  } finally {
    setBusy(false)
  }
  if (series.length > 1) chooseSeries()
  else pick(0)
}

// --- wiring ---
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  if (busy || !e.dataTransfer) return
  // Called synchronously: the item list is emptied once the event returns.
  traverseDataTransferItems(e.dataTransfer.items).then(openFiles, (err) => setStatus(`Could not read the drop: ${err}`))
})
seriesPick.onchange = () => pick(Number(seriesPick.value))
modelPick.onchange = () => void run()
ovlSlider.oninput = () => {
  for (const v of nv.volumes.slice(1)) v.opacity = Number(ovlSlider.value) / 255
  nv.updateGLVolume()
}
$('aboutBtn').onclick = () => $<HTMLDialogElement>('aboutDialog').showModal()
saveBtn.onclick = () => {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(window.browserqcMetrics, null, 2)}\n`], { type: 'application/json' }))
  Object.assign(document.createElement('a'), { href: url, download: `${current!.file.name.replace(/\.(nii|nii\.gz|mgz|mgh)$/i, '')}_qc.json` }).click()
  setTimeout(() => URL.revokeObjectURL(url))
}

// --- init: NiiVue falls back to WebGL2 and mindgrab does too, so no navigator.gpu guard ---
async function init(): Promise<void> {
  try {
    await nv.attachTo('gl1')
  } catch (err) {
    // warn, not error: the smoke test's console.error gate is for real failures.
    console.warn('BrowserQC: renderer init failed', err)
    setStatus('This browser/GPU can’t initialize WebGPU or WebGL2 — BrowserQC needs a recent desktop browser.')
    return
  }
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  nv.showRender = SHOW_RENDER.ALWAYS
  nv.crosshairGap = 5
  nv.meshXRay = 0.05 // let the crosshairs show through the volume in the render view
  nv.isLegendVisible = false
  nv.addEventListener('locationChange', (e) => { $('location').textContent = e.detail.string })
  // addColormap returns the canonical name volumes must use.
  tissueColormaps = Object.fromEntries(TISSUES.map(([name, [r, g, b]]) =>
    [name, nv.addColormap(`tissue-${name}`, { R: [r >> 1, r], G: [g >> 1, g], B: [b >> 1, b], A: [0, 48], I: [0, 255] })]))
  const requested = params.get('model')
  if (requested && Object.hasOwn(MODELS, requested)) modelPick.value = requested
  const [t1, meta] = await Promise.all([
    fetch(`${BASE}t1_crop.nii.gz`).then((r) => r.blob()),
    fetch(`${BASE}t1_crop.json`).then((r) => r.json()),
  ])
  if (busy || series.length) return // a drop arrived while the default image downloaded
  series = [{ file: new File([t1], 't1_crop.nii.gz'), label: 't1_crop', detail: '', voxels: 0, meta }]
  pick(0)
}
renderQc(qcBody, null)
void init()
