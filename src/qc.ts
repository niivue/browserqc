/**
 * MRIQC-style quality-control metrics for the segmentation result.
 *
 * niimath's `--qc` reads the input T1 + a matching integer segmentation and emits
 * a one-row TSV of anatomical IQMs (CJV, CNR, SNR, WM2MAX, EFC, ICV fractions,
 * per-tissue volume/intensity summaries). It classifies every voxel as CSF / GM /
 * WM: we pass the CSF and WM label values, and every other non-zero label is GM.
 *
 * The label→tissue mapping is FIXED for the "Subcortical + GWM" model
 * (model16chan18cls/colormap.json) — the model always emits the same 18 labels, so
 * we hard-code the grouping rather than parse names at runtime:
 *   CSF = ventricles          → 3 Lateral, 4 Inferior-Lateral, 11 3rd, 12 4th
 *   WM  = white matter        → 1 Cerebral-WM, 5 Cerebellum-WM
 *   GM  = everything else non-zero (cortex + deep-GM nuclei + brainstem, etc.)
 */

export const CSF_LABELS = [3, 4, 11, 12]
export const WM_LABELS = [1, 5]

/** Column-keyed values from niimath's `--qc` TSV (nan → NaN). */
export type QcMetrics = Record<string, number>

/**
 * Assemble an MRIQC-style report: metrics flat at the top level, alongside image
 * geometry, an optional BIDS sidecar (`bids_meta`, as dcm2niix emits) and provenance.
 * Mirrors the layout of MRIQC's `<sub>_T1w.json` so the two can be diffed directly.
 *
 * Naming follows MRIQC where the definition matches. `cnr` carries the air term (the
 * air step computes it and supersedes niimath's air-free `cnr_noair`, which only
 * survives as a fallback when that step is skipped) — but like the rest it is still an
 * approximation, not normatively comparable (different segmentation + no INU
 * correction). `efc_brain` keeps our name because it is computed over non-zero voxels,
 * not MRIQC's framed extent.
 */
export type QcReport = Record<string, unknown>

/**
 * Sidecar state transition for a drop (pure, so it can be unit-tested). `dropMeta` is
 * the parsed `.json` in this drop (or null); `staged` is a sidecar held from a prior
 * JSON-only drop; `hasImage` is whether this drop also carried an image.
 *  - image present → bind its own sidecar, else the staged one, else null (never a
 *    leftover from an earlier scan); the staged sidecar is consumed exactly once.
 *  - image absent  → stage this drop's sidecar for the next image.
 */
export function bindSidecar(
  dropMeta: unknown,
  staged: unknown,
  hasImage: boolean,
): { bind: unknown; staged: unknown } {
  if (!hasImage) return { bind: null, staged: dropMeta }
  return { bind: dropMeta ?? staged ?? null, staged: null }
}

export function buildQcReport(
  metrics: QcMetrics,
  geom: { dims: number[]; pixDims: number[] },
  bidsMeta?: unknown,
): QcReport {
  const report: QcReport = { ...metrics }
  report.size_x = geom.dims[1]
  report.size_y = geom.dims[2]
  report.size_z = geom.dims[3]
  report.spacing_x = geom.pixDims[1]
  report.spacing_y = geom.pixDims[2]
  report.spacing_z = geom.pixDims[3]
  if (bidsMeta) report.bids_meta = bidsMeta
  report.provenance = {
    software: 'BrowserQC',
    segmentation: 'brainchop model16chan18cls (Subcortical + GWM)',
    metrics: 'niimath --qc',
    csf_labels: CSF_LABELS,
    wm_labels: WM_LABELS,
  }
  return report
}

/** Parse niimath's two-line (header + values) `--qc` TSV. */
export function parseQcTsv(tsv: string): QcMetrics {
  const lines = tsv.trim().split('\n')
  if (lines.length < 2) throw new Error('QC output was empty or malformed')
  const keys = lines[0].split('\t')
  const vals = lines[1].split('\t')
  const out: QcMetrics = {}
  keys.forEach((k, i) => {
    out[k.trim()] = Number(vals[i])
  })
  return out
}

// --- Display spec ---
type Better = 'low' | 'high' | null
type MetricSpec = { key: string; label: string; desc: string; better: Better; alt?: string }

// Headline quality IQMs (order = display order).
const QUALITY: MetricSpec[] = [
  { key: 'cjv', label: 'CJV', desc: 'Coefficient of joint variation (noise + INU)', better: 'low' },
  // `cnr` needs the air term; if the air pipeline was skipped, fall back to niimath's
  // air-free `cnr_noair` so the row still shows a value.
  { key: 'cnr', alt: 'cnr_noair', label: 'CNR', desc: 'Contrast-to-noise (GM vs WM over tissue + air noise)', better: 'high' },
  { key: 'snrd_total', label: 'SNRd', desc: 'Dietrich SNR, mean over tissues (air MAD)', better: 'high' },
  { key: 'fber', label: 'FBER', desc: 'Foreground-background energy ratio', better: 'high' },
  { key: 'snr_total', label: 'SNR', desc: 'Signal-to-noise, mean over tissues', better: 'high' },
  { key: 'wm2max', label: 'WM2MAX', desc: 'White-matter median ÷ P99.95 intensity', better: null },
  { key: 'efc_brain', label: 'EFC', desc: 'Entropy focus criterion (ghosting / blur)', better: 'low' },
]

const TISSUES: { key: string; label: string }[] = [
  { key: 'gm', label: 'GM' },
  { key: 'wm', label: 'WM' },
  { key: 'csf', label: 'CSF' },
]

// 3 significant figures, trailing zeros trimmed; nan/inf → em dash.
function num(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return Number(v.toPrecision(3)).toString()
}
function pct(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—'
}
function cm3(mm3: number): string {
  return Number.isFinite(mm3) ? `${(mm3 / 1000).toFixed(1)} cm³` : '—'
}
function hint(b: Better): string {
  if (b === 'low') return '<span class="qc-hint" title="lower is better">↓</span>'
  if (b === 'high') return '<span class="qc-hint" title="higher is better">↑</span>'
  return ''
}
const esc = (s: string): string => s.replace(/"/g, '&quot;')

/**
 * Render the QC panel body. `metrics === null` renders the empty state (no QC yet).
 * All values are numbers we produced, so innerHTML is safe.
 */
export function renderQc(body: HTMLElement, metrics: QcMetrics | null): void {
  if (!metrics) {
    body.innerHTML = `<p class="qc-empty">No QC values yet — metrics appear automatically once an image loads.</p>`
    return
  }

  const snrDetail = TISSUES.map((t) => `${t.label} ${num(metrics[`snr_${t.key}`])}`).join(' · ')
  const quality = QUALITY.map((m) => {
    const title = m.key === 'snr_total' ? `${m.desc} — ${snrDetail}` : m.desc
    const value = metrics[m.key] ?? (m.alt !== undefined ? metrics[m.alt] : NaN)
    return `<div class="qc-row" title="${esc(title)}">
      <span class="qc-k">${m.label}${hint(m.better)}</span>
      <span class="qc-v">${num(value)}</span>
    </div>`
  }).join('')

  // Tissue composition: ICV fraction bar + absolute volume.
  const tissues = TISSUES.map((t) => {
    const frac = metrics[`icvs_${t.key}`]
    const w = Number.isFinite(frac) ? Math.max(0, Math.min(100, frac * 100)) : 0
    return `<div class="qc-tissue">
      <span class="qc-tlabel">${t.label}</span>
      <div class="qc-bar"><div class="qc-fill qc-fill-${t.key}" style="width:${w}%"></div></div>
      <span class="qc-tval">${pct(frac)} · ${cm3(metrics[`vol_${t.key}_mm3`])}</span>
    </div>`
  }).join('')

  body.innerHTML = `
    <div class="qc-group">${quality}</div>
    <h4 class="qc-subtitle">Tissue composition <span class="qc-subnote">(% intracranial)</span></h4>
    <div class="qc-group">${tissues}</div>
    <p class="qc-note">A fast MRIQC-style approximation (deep-learning parcellation, raw
      intensities). Same ballpark and ranking as MRIQC, not the same values.</p>`
}
