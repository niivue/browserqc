// The BIDS-sidecar state machine (src/qc.ts bindSidecar) — the cross-scan-leak fix.
// Pure, so it runs under `node --test` with no browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindSidecar } from '../src/qc.ts'

const A = { RepetitionTime: 1 }
const B = { RepetitionTime: 2 }

test('image + its own sidecar → binds that sidecar', () => {
  assert.deepEqual(bindSidecar(A, null, true), { bind: A, staged: null })
})

test('image without a sidecar → binds null, never a prior scan’s metadata', () => {
  // The regression: A was bound earlier; a later image with no sidecar must not inherit it.
  assert.deepEqual(bindSidecar(null, null, true), { bind: null, staged: null })
})

test('sidecar dropped alone → staged for the next image', () => {
  assert.deepEqual(bindSidecar(A, null, false), { bind: null, staged: A })
})

test('staged sidecar is consumed exactly once', () => {
  const afterStage = bindSidecar(A, null, false) // stage A
  const onImage = bindSidecar(null, afterStage.staged, true) // next image, no own sidecar
  assert.deepEqual(onImage, { bind: A, staged: null }) // A applied…
  const nextImage = bindSidecar(null, onImage.staged, true) // …and not again
  assert.deepEqual(nextImage, { bind: null, staged: null })
})

test('own sidecar wins over a staged one', () => {
  assert.deepEqual(bindSidecar(B, A, true), { bind: B, staged: null })
})
