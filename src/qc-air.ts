/**
 * MRIQC-style air ("hat") mask metrics.
 *
 * niimath's `--qc` covers the tissue-based IQMs but has no air term (see qc.c). These
 * are the ones that need the background: `summary_bg_*`, Dietrich SNR (`snrd_*`),
 * `fber`, `qi_1`, and the air term of `cnr`.
 *
 * Method follows MRIQC's ArtifactMask (mriqc/interfaces/anatomical.py):
 *   1. head mask (we use Otsu + fill + close; MRIQC uses a gradient threshold)
 *   2. an affine registration to the template (transform only)
 *   3. the "hat" = head-free voxels superior to the template z = -14 landmark plane,
 *      i.e. air above/behind the head, excluding face and neck (see LANDMARK_PLANE_Z:
 *      we test the plane directly where MRIQC approximates it with axis-aligned slabs)
 *   4. artifacts = air voxels > `zscore` MADs, ignoring a 10% shell nearest the head,
 *      then a binary opening; `air = hat − artifacts`
 *
 * Volumes are RAS-canonical (`niimath -ras`, == nibabel's as_closest_canonical).
 */

/**
 * MRIQC's standard-space landmarks (ArtifactMask defaults) are glabella [0,90,-14]
 * and inion [0,-120,-14] — note they share the SAME template z. So MRIQC's two
 * axis-aligned slab fills are really an approximation of one template-space plane,
 * "exclude everything inferior to z = -14", resolved onto the subject's voxel axes.
 * That approximation recovers pitch (the two landmarks land at different subject
 * heights when the head nods) but not roll or yaw, and it splits anterior/posterior
 * at the IMAGE midpoint rather than anatomy.
 *
 * We test the plane directly instead, which is both simpler and exact under all three
 * rotations. Costs nothing: only the z row of (template<-subject affine) is needed, so
 * the test is a plane equation in voxel indices.
 */
const LANDMARK_PLANE_Z = -14
/** 1 / sqrt(2 / (4 - pi)) — Dietrich's Rayleigh correction (mriqc DIETRICH_FACTOR). */
const DIETRICH_FACTOR = 0.6551364
const ZSCORE = 10.0

/** A numeric voxel array — a typed-array view whose type follows the NIfTI datatype.
 *  Read by index; never sorted or mutated in place. */
export type VoxelArray = ArrayLike<number>
export type Nii = { dims: number[]; pixDims: number[]; affine: number[][]; img: VoxelArray }

/** Minimal NIfTI-1 reader — the counterpart to writeNifti, for niimath's output.
 *  `img` is a typed-array VIEW over `raw` (no copy): niimath always writes vox_offset
 *  352 into a fresh zero-offset buffer, so it is aligned for every datatype we emit.
 *  Callers read `img` by index only — hold `raw`/the Nii while using it. On the RAS
 *  256³ volume this avoids two full-volume copies (the old slice + Float32 expansion). */
export function readNii(raw: Uint8Array): Nii {
  const buf = raw.buffer as ArrayBuffer
  const dv = new DataView(buf, raw.byteOffset, raw.byteLength)
  const dims = [dv.getInt16(40, true), dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)]
  const pixDims = [0, 1, 2, 3].map((i) => dv.getFloat32(76 + i * 4, true))
  const datatype = dv.getInt16(70, true)
  const voxOffset = dv.getFloat32(108, true)
  const affine = [0, 1, 2]
    .map((r) => [0, 1, 2, 3].map((c) => dv.getFloat32(280 + r * 16 + c * 4, true)))
    .concat([[0, 0, 0, 1]])
  const n = dims[1] * dims[2] * dims[3]
  const Ctor = { 2: Uint8Array, 4: Int16Array, 8: Int32Array, 16: Float32Array, 512: Uint16Array }[
    datatype
  ]
  if (!Ctor) throw new Error(`readNii: unsupported datatype ${datatype}`)
  const img = new Ctor(buf, raw.byteOffset + voxOffset, n)
  return { dims, pixDims, affine, img }
}

/** 4x4 product, row-major. */
export function mul4(A: number[][], B: number[][]): number[][] {
  return A.map((row) => [0, 1, 2, 3].map((c) => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c] + row[3] * B[3][c]))
}

// --- statistics ---------------------------------------------------------
/** Median of an ascending-sorted array, averaging the two central elements for even
 *  length (the numpy/scipy convention MRIQC uses). */
export function median(sorted: Float32Array): number {
  const n = sorted.length
  const mid = n >> 1
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** numpy's default ('linear') percentile of an ascending-sorted array, as MRIQC and
 *  niimath's --qc use. */
function pctl(sorted: Float32Array, q: number): number {
  const r = q * (sorted.length - 1)
  const lo = Math.floor(r)
  return lo + 1 < sorted.length ? sorted[lo] + (r - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo]
}

export function stats(sorted: Float32Array): Record<string, number> {
  const n = sorted.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += sorted[i]
  const mean = sum / n
  let s2 = 0
  let s4 = 0
  for (let i = 0; i < n; i++) {
    const d = sorted[i] - mean
    s2 += d * d
    s4 += d * d * d * d
  }
  const varc = s2 / n
  const stdv = Math.sqrt(varc)
  const med = median(sorted)
  const dev = new Float32Array(n)
  for (let i = 0; i < n; i++) dev[i] = Math.abs(sorted[i] - med)
  dev.sort()
  // scipy/statsmodels MAD is scaled to be a consistent estimator of sigma.
  const mad = median(dev) * 1.4826
  return {
    median: med,
    mean,
    stdv,
    mad,
    p05: pctl(sorted, 0.05),
    p95: pctl(sorted, 0.95),
    k: varc > 0 ? s4 / n / (varc * varc) - 3 : 0, // Fisher (excess) kurtosis
    n,
  }
}

/** 6-connected binary opening (erode then dilate), as MRIQC applies to the qi_1 mask. */
function open6(mask: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const nxy = nx * ny
  const ero = new Uint8Array(mask.length)
  const at = (i: number, j: number, k: number) => mask[i + j * nx + k * nxy]
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const o = i + j * nx + k * nxy
        if (!mask[o]) continue
        if (at(i - 1, j, k) && at(i + 1, j, k) && at(i, j - 1, k) && at(i, j + 1, k) && at(i, j, k - 1) && at(i, j, k + 1))
          ero[o] = 1
      }
  const dil = new Uint8Array(mask.length)
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const o = i + j * nx + k * nxy
        if (!ero[o]) continue
        dil[o] = 1
        dil[o - 1] = 1
        dil[o + 1] = 1
        dil[o - nx] = 1
        dil[o + nx] = 1
        dil[o - nxy] = 1
        dil[o + nxy] = 1
      }
  return dil
}

export type AirMetrics = Record<string, number>

/**
 * Compute the air-dependent IQMs. `t1`/`head`/`dist` must share the RAS grid;
 * `tissue` supplies the medians/means/stdvs niimath already produced.
 */
export function computeAirMetrics(
  t1: Nii,
  head: VoxelArray,
  dist: VoxelArray,
  voxToTemplate: number[][],
  tissue: Record<string, number>,
): { metrics: AirMetrics; hat: Uint8Array } {
  const [, nx, ny, nz] = t1.dims
  const nxy = nx * ny
  const img = t1.img

  // 1. the hat: not head, and superior to the template z = -14 plane. Only the z row
  //    of the voxel->template affine matters, so this is a plane equation in (i,j,k).
  const [zi, zj, zk, z0] = voxToTemplate[2]
  const hat = new Uint8Array(img.length)
  let nHat = 0
  let distMax = 0
  for (let k = 0; k < nz; k++) {
    const zK = zk * k + z0
    for (let j = 0; j < ny; j++) {
      const zJK = zj * j + zK
      const base = j * nx + k * nxy
      for (let i = 0; i < nx; i++) {
        if (zi * i + zJK < LANDMARK_PLANE_Z) continue // inferior to the landmark plane
        const o = base + i
        if (head[o] > 0) continue
        hat[o] = 1
        nHat++
        if (dist[o] > distMax) distMax = dist[o]
      }
    }
  }
  if (nHat < 10) return { metrics: {}, hat } // e.g. skull-stripped: no usable background

  const out: AirMetrics = {}

  // 2. artifacts (Mortamet): flag hat voxels > ZSCORE MADs of the FULL-hat scale,
  //    excluding the 10% shell nearest the head, then open to drop isolated speckle.
  //    MRIQC then reports the background over air = hat − artifacts, so build that here.
  let mad0: number
  {
    const air0 = new Float32Array(nHat)
    let a = 0
    for (let o = 0; o < hat.length; o++) if (hat[o]) air0[a++] = img[o]
    air0.sort()
    mad0 = stats(air0).mad
  }

  const artifact = new Uint8Array(img.length)
  if (mad0 > 0 && distMax > 0) {
    for (let o = 0; o < hat.length; o++) {
      if (!hat[o] || img[o] <= 0 || dist[o] / distMax < 0.1) continue
      if (img[o] / mad0 > ZSCORE) artifact[o] = 1
    }
  }
  const opened = open6(artifact, nx, ny, nz)
  // air = hat − artifacts: prune the artifact voxels out of `hat` in place, so the
  // returned mask (drawn as the overlay) is exactly the one the metrics use.
  let nArt = 0
  for (let o = 0; o < opened.length; o++) if (opened[o] && hat[o]) { hat[o] = 0; nArt++ }
  out.qi_1 = nArt / nHat

  // 3. background statistics over the pruned air. If artifacts consumed the whole hat
  //    there's nothing to summarise — return just qi_1 rather than NaN-filled stats.
  const nAir = nHat - nArt
  if (nAir < 1) return { metrics: out, hat }
  const air = new Float32Array(nAir)
  { let a = 0; for (let o = 0; o < hat.length; o++) if (hat[o]) air[a++] = img[o] }
  air.sort()
  const bg = stats(air)
  for (const [key, v] of Object.entries(bg)) out[`summary_bg_${key}`] = v

  // 4. Dietrich SNR — verified against MRIQC: median (not mean) over air MAD.
  const sigmaAir = bg.mad > 1.0 ? bg.mad : bg.stdv
  if (sigmaAir > 1e-3) {
    const each: number[] = []
    for (const t of ['csf', 'gm', 'wm']) {
      const med = tissue[`summary_${t}_median`]
      if (!Number.isFinite(med)) continue
      const v = (DIETRICH_FACTOR * med) / sigmaAir
      out[`snrd_${t}`] = v
      each.push(v)
    }
    if (each.length) out.snrd_total = each.reduce((s, v) => s + v, 0) / each.length
  }

  // 5. FBER — median squared signal inside the head over the same in air.
  let nFg = 0
  for (let o = 0; o < head.length; o++) if (head[o] > 0) nFg++
  if (nFg) {
    const fg = new Float32Array(nFg)
    { let f = 0; for (let o = 0; o < head.length; o++) if (head[o] > 0) fg[f++] = img[o] * img[o] }
    fg.sort()
    // `air` is no longer needed after this point; square it in place instead of
    // retaining another full background-sized array.
    for (let i = 0; i < air.length; i++) air[i] *= air[i]
    air.sort()
    const bgMu = median(air)
    out.fber = bgMu < 1e-3 ? -1 : median(fg) / bgMu
  }

  // 6. CNR with the air term. MRIQC feeds cnr() the tissue MEDIANS (interfaces/
  //    anatomical.py), as niimath's cnr_noair does. sigma_air contributes <1% in
  //    practice — the tissue sigmas dominate — but this is the published formula.
  const { summary_wm_median: mw, summary_gm_median: mg, summary_wm_stdv: sw, summary_gm_stdv: sg } = tissue
  if ([mw, mg, sw, sg].every(Number.isFinite)) {
    out.cnr = Math.abs(mw - mg) / Math.sqrt(bg.stdv * bg.stdv + sg * sg + sw * sw)
  }
  return { metrics: out, hat }
}
