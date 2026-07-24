// Focused correctness tests for the air-metric math (src/qc-air.ts). Pure functions,
// so they run in Node with no browser — `node --test` (built-in, no dependency).
// Node ≥22 imports the .ts directly via type stripping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { median, stats, computeAirMetrics } from '../src/qc-air.ts'

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)

test('median averages the two central elements for even length', () => {
  assert.equal(median(Float32Array.from([1, 2, 3])), 2) // odd → middle
  assert.equal(median(Float32Array.from([1, 2, 3, 4])), 2.5) // even → mean of centre pair
  assert.equal(median(Float32Array.from([5])), 5)
})

test('stats matches hand-computed values', () => {
  const s = stats(Float32Array.from([1, 2, 3, 4])) // already sorted
  close(s.mean, 2.5)
  close(s.median, 2.5)
  close(s.stdv, Math.sqrt(1.25)) // population stdv
  close(s.mad, 1.0 * 1.4826) // |x-2.5| = {1.5,0.5,0.5,1.5} → median 1.0, ×1.4826
  assert.equal(s.n, 4)
})

// Build a synthetic 8³ volume: a head slab (k<4) and background (k≥4). An identity
// voxel→template affine makes the z = -14 plane exclude nothing, isolating the
// head-mask + statistics path. Background alternates 3/5 (median 4, mad 1.4826).
function synthetic() {
  const nx = 8, ny = 8, nz = 8, n = nx * ny * nz
  const img = new Float32Array(n)
  const head = new Float32Array(n)
  const dist = new Float32Array(n).fill(10) // uniform → 10% shell excludes nothing
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const o = i + j * nx + k * nx * ny
        if (k < 4) { head[o] = 1; img[o] = 100 } // head slab
        else img[o] = i % 2 ? 5 : 3 // background noise
      }
  const t1 = { dims: [3, nx, ny, nz], pixDims: [1, 1, 1, 1], affine: ID, img }
  return { t1, head, dist, nBg: nx * ny * 4 } // 4 background slabs
}
const ID = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
const TISSUE = {
  summary_wm_median: 100, summary_gm_median: 50, summary_csf_median: 20,
  summary_wm_mean: 100, summary_gm_mean: 50, summary_wm_stdv: 10, summary_gm_stdv: 10,
}

test('computeAirMetrics: hat selection, background stats, SNRd, CNR', () => {
  const { t1, head, dist, nBg } = synthetic()
  const { metrics } = computeAirMetrics(t1, head, dist, ID, TISSUE)
  assert.equal(metrics.summary_bg_n, nBg) // exactly the non-head, above-plane voxels
  close(metrics.summary_bg_median, 4) // (3+5)/2
  close(metrics.summary_bg_mad, 1.4826)
  assert.equal(metrics.qi_1, 0) // no artifacts
  close(metrics.snrd_wm, (0.6551364 * 100) / 1.4826, 1e-3) // Dietrich, median/mad
  assert.ok(metrics.cnr > 0)
})

test('computeAirMetrics: an artifact blob is excluded from the background and counted in qi_1', () => {
  const { t1, head, dist } = synthetic()
  // A 3³ bright block in the background survives the binary opening (isolated speckle
  // would not), so it should be flagged as artifact, removed from bg, and raise qi_1.
  const nx = 8, ny = 8
  for (let k = 5; k <= 7; k++)
    for (let j = 1; j <= 3; j++)
      for (let i = 1; i <= 3; i++) t1.img[i + j * nx + k * nx * ny] = 1000
  const { metrics } = computeAirMetrics(t1, head, dist, ID, TISSUE)
  assert.ok(metrics.qi_1 > 0, 'qi_1 should be positive with an artifact blob')
  assert.ok(metrics.summary_bg_median < 10, 'artifact voxels must not inflate the background median')
})
