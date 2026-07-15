This file provides guidance to AI agents when working with code in this repository.

## What this is

**BrowserQC** — browser-only automated MRI quality control. Drag in a NIfTI (or a DICOM folder) and it runs on its own: conform → deep-learning parcellation ("Subcortical + GWM") → back-project the labels onto the native scan as a colour overlay → niimath MRIQC-style quality metrics in a side panel. **No data leaves the machine** — everything runs in WebAssembly + WebGPU/WebGL2. There is no method picker and no Apply button: segmentation + QC run automatically whenever an image loads (startup + every drop).

**Keep it minimal.** This is a worked example meant to teach the concept — readable end to end. Prefer the smallest change that works. Don't add defensive code for cases that can't happen, speculative options, or abstractions for a single caller; bloat obscures the idea. Guard real failure paths, not imaginary ones.

## Commands

```bash
npm run dev        # vite dev server on http://localhost:8091
npm run build      # tsc --noEmit (typecheck) + vite build to dist/
npm run typecheck  # tsc --noEmit only
npm run preview    # serve the production build (port 4173)
npm run test:e2e   # builds first, then headless-Chromium smoke
```

No unit-test runner, no linter beyond `tsc` — "validate before commit" = typecheck + build + smoke. `test:e2e` builds first (so it can't pass against a stale `dist`), boots `vite preview` (failing fast on a port clash), and drives the real app in system Chrome with software WebGPU (`--use-gl=angle --enable-unsafe-swiftshader`). It loads the default image, waits for the **auto** segmentation + QC to complete, asserts the QC panel populated, drives the Opacity slider + About dialog, and **fails on any `console.error`/page error** — keep that gate meaningful (a handled capability-absence should `console.warn`, not `error`).

## Architecture

Single-page app, no framework. [src/main.ts](src/main.ts) is the whole UI controller. There are no toolbar controls — the only UI is the canvas, the right-side QC panel (with the Opacity slider + About button), and the drag-drop / DICOM-picker. It wires four subsystems:

- **NiiVue** (`@niivue/niivue`, WebGPU) — renders volumes. Constructed eagerly, but `attachTo('gl1')` is deferred to `init()` behind a guard: `init()` checks `navigator.gpu` *and* try/catches `attachNiiVue()`, so every WebGPU-unavailable path (no adapter, device-creation failure, blocklisted GPU) shows a friendly message instead of an unhandled rejection.
- **brainchop** (vendored tfjs engine in [src/brainchop/](src/brainchop/)) — the deep-learning parcellation. See "Segmentation".
- **niimath** (BSD build, vendored as local source in [src/niimath/](src/niimath/)) — used only for the QC metrics (`--qc`) in a WASM worker. See "niimath (the QC build)".
- **dcm2niix** ([src/dcm2niix/](src/dcm2niix/)) — converts dropped DICOM folders to NIfTI; drop traversal uses `webkitGetAsEntry()` and stamps `_webkitRelativePath` so dcm2niix groups by series.

**Auto-run flow.** Every image (the bundled default at startup, a dropped NIfTI, or a picked dcm2niix series) is passed to `runSegment(file)`, which is the whole pipeline: display it → conform → segment → back-project → overlay → QC. See "Segmentation" + "QC".

### Concurrency — single-flight (gotcha)
Loads, drops, and segmentation runs must not overlap: everything is serialized through one promise chain (`enqueue`/`pending`). Required because (a) the niimath wrapper reassigns the worker's one `onmessage` handler per run — and our raw `--qc` post does the same (see "QC") — so two overlapping jobs on the same worker cross-wire each other's results; and (b) NiiVue holds one displayed scene. One job at a time.

### Worker recovery (gotcha)
A failed niimath run can leave the worker heap + MEMFS in an undefined state. The QC step catches → `resetNiimathWorker()` (terminates the worker via a cast to the wrapper's private `worker` field — it exposes no public `terminate`, and clears `niimathReady`) so the next QC spins up a fresh worker. A QC failure is **non-fatal** — the segmentation overlay stays up and the failure is reported in the status bar.

**`cleanup()` terminates the worker FIRST, then does NOT await `pending`.** A niimath run is a single uninterruptible WASM call, so awaiting the queue on HMR/tab-close would stall teardown. `cleanup()` sets `isCleanedUp`, terminates the worker (killing any in-flight run — whose promise then never resolves, hence no await), disposes the NiiVue context, and `nv.destroy()`s. Any run that *did* resolve hits `if (isCleanedUp) return` before touching `nv`/`ctx`.

## Segmentation ("Subcortical + GWM")

Runs [brainchop](https://github.com/neuroneural/brainchop)'s default "Subcortical + GWM" model (id 3, `model16chan18cls` — a 16-channel gridding-free MeshNet, 17 regions: GWM + subcortical) and overlays the labels on the input. Ported from `brainchop-test`.

**Vendored engine** in [src/brainchop/](src/brainchop/) for easy upstream re-sync: `brainchop-webworker.js`, `inference-logic.js`, `tensor-utils.js`, `bwlabels.js`, `diagnostic-stats.js`, `brainchop-parameters.js` (full model list kept as-is; we only instantiate id 3). These are **niivue-independent** — they need only `@tensorflow/tfjs` and take `(opts, modelEntry, niftiHeader, niftiImage, callbackImg, callbackUI)`. We copied **only the tfjs/WebGL2 path**, not brainchop's custom-WebGPU runners — same weights, same segmentation. Assets: [public/models/model16chan18cls/](public/models/model16chan18cls/) `model.json` + `model.bin` (tfjs layers-model) + `colormap.json` (the WebGPU `.safetensors` were intentionally not copied). tfjs is large, so all of this is `import()`ed lazily on first use (code-split out of the initial bundle).

**Two divergences from verbatim** (grep `BrowserQC patch` / check git before re-syncing): (1) `brainchop-mainthread.js` was **removed** — it was only a redundant main-thread fallback that re-ran the same tfjs/WebGL2 backend after the worker already failed, and its static import dragged a second ~1.6 MB tfjs copy into the segment chunk (now ~11 kB). (2) `brainchop-webworker.js`'s message handler carries a one-line **`BrowserQC patch`**: it `.catch()`es the fire-and-forget `runInferenceWW` and emits the hard-failure UI protocol. Upstream launches it unawaited, so a model-fetch/backend-init rejection became an unhandled *worker* rejection that never reached the host — `segment.ts` `runWorker()` would hang forever and wedge the single-flight queue.

**Three thin TS wrappers** (typed, ours) bridge the engine to our rc.9 NiiVue:
- [src/brainchop/segment.ts](src/brainchop/segment.ts) — runs the engine in a Web Worker (fast path → seqConv retry; the main-thread fallback was dropped, see above); returns the label volume (`Uint8Array`, labels 0–17) in conformed order.
- [src/brainchop/reslice.ts](src/brainchop/reslice.ts) — back-projects the conformed labels onto the native grid (majority-vote 2× supersample). Cloned from brainchop-test `resliceLabelsToNative` (its "Segmentation: native space" Save), but the coordinate map is composed from the two volumes' `hdr.affine` directly (`inv(A_conf)·A_native`) because our NiiVue exposes no `mm2vox`/`toRASvox` **methods** on a volume.
- [src/brainchop/nifti.ts](src/brainchop/nifti.ts) — minimal NIfTI-1 writer. Needed because rc.9 `NVImage` is a plain object with no public factory/`clone`/`saveToDisk`, and the free `nii2volume`/`calculateRAS` helpers aren't exported — so we build a native-grid label `.nii` and `nv.addVolume({url: File})` (the supported path).

**Flow** (`runSegment(file)` in [src/main.ts](src/main.ts)): `nv.loadVolumes([file])` (display) → `nv.volumeTransform.conform(vol0)` (256³ 1 mm FreeSurfer-canonical, via the [@niivue/nv-ext-image-processing](https://www.npmjs.com/package/@niivue/nv-ext-image-processing) `conform` transform registered once — our rc.9 has no `nv.conform()`) → tfjs inference → `resliceToNative` → `writeNifti` native labels → `addVolume` → `setColormapLabel(idx, colormap.json)` (rc.9 needs `A`+`I` arrays added; label 0 alpha 0) → QC. **The conformed image is never shown** — vol 0 stays the native input, the overlay is native-grid labels (verified on the default 192×256×188 · 0.9 mm `t1_crop`, which is genuinely non-256³ so the reslice does real work). The **Opacity** slider (`#ovlSlider`) drives the overlay's opacity via `nv.setVolume(last, {opacity})`.

**Version pin gotcha.** The ext is `@niivue/nv-ext-image-processing@1.0.0-rc.10`, which peer-pins NiiVue `rc.10` while we're on `rc.9` — installed with `--legacy-peer-deps` (pinned via [.npmrc](.npmrc)). Safe because the `conform` transform's `apply` is a pure `(hdr,img)→{hdr,img}` worker (deps only `gl-matrix` + `nifti-reader-js`), independent of NiiVue internals. Re-verify on any NiiVue bump.

## QC (niimath `--qc`)

After the overlay is displayed, [src/main.ts](src/main.ts) `computeQc` runs niimath's `--qc` (MRIQC-style anatomical IQMs: CJV, CNR-noair, SNR, WM2MAX, EFC, ICV fractions, per-tissue volumes) on the **native** T1 + the **native-space** segmentation and fills the right-side [#qcPanel](index.html) (see [src/qc.ts](src/qc.ts) for the TSV parser + panel renderer).

- **Matching grids (requirement).** `--qc` demands the T1 and segmentation share a voxel grid. We serialize the T1 with `nv.saveVolume({volumeByIndex:0, filename:''})` (bytes, no download) so it comes from the **same** `volumes[0]` geometry the native segmentation was built from — they align by construction.
- **Fixed tissue labels.** `--qc` classifies each voxel CSF/GM/WM from the label values we pass; the "Subcortical + GWM" model always emits the same 18 labels, so [src/qc.ts](src/qc.ts) hard-codes `CSF_LABELS = [3,4,11,12]` (ventricles), `WM_LABELS = [1,5]` (cerebral + cerebellar WM); every other non-zero label is GM. No runtime name parsing.
- **WASM invocation (the gotcha).** `--qc` isn't a chain op (image→ops→image) — it takes its own argv and writes a **TSV**, not a NIfTI. The vendored wrapper's `run()` can't express that, so `runNiimathQc` posts a raw job **straight to the niimath Web Worker** (via the wrapper's private `worker` field, same access pattern as `resetNiimathWorker`/`cleanup`): the worker is generic — it stages `blob` + `extraFiles` into MEMFS, runs `cmd` argv through `callMain`, and reads `outName` back as a Blob (which we `.text()` → parse). Safe against the wrapper's per-run `onmessage` swap because the single-flight queue serializes all niimath work.
- **Panel lifecycle.** Empty state on load; `renderQc(qcBody, null)` clears it at the start of every `runSegment` (the "onImageLoaded" reset — every load goes through `runSegment`); populated when the TSV parses. Hidden below 720 px (see `#qcPanel` in [src/style.css](src/style.css)).

CLI reference (what the WASM call mirrors): `niimath --qc <t1> --seg <seg> --csf 3,4,11,12 --wm 1,5 [--erode 0|1] [--out qc.tsv]`. Source: [/Users/chris/src/niimath/src/qc.c](../niimath/src/qc.c). CNR omits the air-noise term (backgrounds are masked to 0), so it's a relative contrast measure, not comparable to MRIQC normative values.

## niimath (the QC build)

niimath is used **only for `--qc`**. It's a BSD-2 build vendored as local source (not an npm dependency) because `--qc` (and `-conform`) are newer than the npm release. The artifacts live in [src/niimath/](src/niimath/): the esbuild wrapper (`index.js`), the WASM worker (`worker.js`), the Emscripten glue + binary (`niimath.js` + `niimath.wasm`), plus `.d.ts`/`niimathOperators.json`. `main.ts` imports `{ Niimath } from './niimath'` — there is **no** `@niivue/niimath` dependency. Provenance + rebuild recipe: [src/niimath/README.md](src/niimath/README.md). **Delete `src/niimath/` and depend on `@niivue/niimath` once a release ships `--qc`.**

Because niimath is plain app source (not a node_module), Vite/Rollup emit its `new Worker(new URL('./worker.js', import.meta.url))` worker + `new URL('niimath.wasm', import.meta.url)` binary as hashed assets in both dev and build — so it needs **no `optimizeDeps.exclude`** entry (that was only for the prebundled node_module; `@niivue/dcm2niix` still needs it).

## Deploy

Served at `https://<org>.github.io/BrowserQC/`. The `/BrowserQC/` subpath is baked in via `base: '/BrowserQC/'` in [vite.config.ts](vite.config.ts) — reference bundled assets through `import.meta.env.BASE_URL`, not absolute `/`. `@niivue/dcm2niix` is in `optimizeDeps.exclude` because Vite's prebundler breaks its dynamic-import WASM worker; don't remove that.

## Deliberate decisions & known limitations

- **Single-flight liveness (invariant — keep it).** One unsettled job freezes the whole `enqueue`/`pending` chain (spinner stuck until reload), so **every worker-backed step must be time-bounded**: conform + niimath (init+run) + dcm2niix (init+run) via `withTimeout`; brainchop via a per-attempt inactivity watchdog (`WORKER_STALL_MS`). A worker can spawn and then never post back (no message, no `onerror`) — bound any new one you add.
- **Smoke is wiring-only.** Drives load → conform → segmentation → overlay → `--qc` → panel to completion and fails on any `console.error`/page error, but does **not** assert segmentation or QC *values* (accuracy is brainchop's / niimath's to validate).
- **Tissue-label grouping is a judgement call.** WM = cerebral + cerebellar white matter (`[1,5]`); brainstem/VentralDC/deep-GM fall into GM. Fine for a relative CJV/CNR/SNR estimator; widen `WM_LABELS`/`CSF_LABELS` in [src/qc.ts](src/qc.ts) if needed. `--qc --erode` defaults to 1 (not exposed in the UI).
- **Back-projection runs on the UI thread** ([src/brainchop/reslice.ts](src/brainchop/reslice.ts), 8 samples/voxel, synchronous). Fine for the bundled image; may block paint on large DICOM. Profile real DICOM before moving it to a worker or dropping to single-sample nearest-neighbour — don't add voxel-limit preflight checks.
- **HMR dev-only limitation.** An already-running inference/conversion finishes after `cleanup()`; the execution-time + `runSegment`-entry `isCleanedUp` guards keep it from touching a destroyed NiiVue. Not worth cross-pipeline cancellation.
