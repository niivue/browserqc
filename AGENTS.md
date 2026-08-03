This file provides guidance to AI agents when working with code in this repository.

## What this is

**BrowserQC** — browser-only automated MRI quality control. Drag in a NIfTI (or a DICOM folder) and it runs on its own: conform → deep-learning parcellation ("Subcortical + GWM") → back-project the labels onto the native scan as a colour overlay → niimath MRIQC-style quality metrics in a side panel. **No data leaves the machine** — everything runs in WebAssembly + WebGPU. There is no method picker and no Apply button: segmentation + QC run automatically whenever an image loads (startup + every drop).

**Keep it minimal.** This is a worked example meant to teach the concept — readable end to end. Prefer the smallest change that works. Don't add defensive code for cases that can't happen, speculative options, or abstractions for a single caller; bloat obscures the idea. Guard real failure paths, not imaginary ones.

## Commands

```bash
npm run dev        # vite dev server on http://localhost:8091
npm run build      # tsc --noEmit (typecheck) + vite build to dist/
npm run typecheck  # tsc --noEmit only
npm run preview    # serve the production build (port 4173)
npm run test:unit  # node --test — src/qc-air.ts math + the qc.ts sidecar state machine
npm run test:e2e   # builds first, then headless-Chromium smoke
```

The linter is just `tsc`; "validate before commit" = typecheck + unit + build + smoke. `test:unit` uses Node's built-in runner (no dependency) on the air-metric math (median even/odd, `stats`, hat selection, artifact exclusion / `qi_1`) — the numeric code the smoke can't check. `test:e2e` builds first (so it can't pass against a stale `dist`), boots `vite preview` (failing fast on a port clash), and drives the real app in system Chrome with software WebGPU (`--use-gl=angle --enable-unsafe-swiftshader`). It loads the default image, waits for the **auto** segmentation + QC to complete, asserts the QC panel populated **and that `SNRd` is present**, asserts the Air-mask checkbox became enabled and toggles that overlay, drives the Opacity slider + About dialog, and **fails on any `console.error`/page error** — keep that gate meaningful (a handled capability-absence should `console.warn`, not `error`).

## Architecture

Single-page app, no framework. [src/main.ts](src/main.ts) is the whole UI controller. There are no toolbar controls — the only UI is the canvas, the right-side QC panel (Opacity slider, Air-mask checkbox, Save button, About button), and the drag-drop / DICOM-picker. It wires four subsystems:

- **NiiVue** (`@niivue/niivue`, WebGPU) — renders volumes. Constructed eagerly, but `attachTo('gl1')` is deferred to `init()` behind a guard: `init()` checks `navigator.gpu` *and* try/catches `attachNiiVue()`, so every WebGPU-unavailable path (no adapter, device-creation failure, blocklisted GPU) shows a friendly message instead of an unhandled rejection.
- **brainchop** (vendored `@niivue/brainchop`, a WebGPU wasm module in [src/brainchop/](src/brainchop/) + [public/brainchop/](public/brainchop/)) — the deep-learning parcellation. See "Segmentation".
- **niimath** (`@niivue/niimath`, BSD build) — the QC metrics (`--qc`) + the air-mask chain, in a WASM worker. See "niimath (the QC + air engine)".
- **dcm2niix** ([src/dcm2niix/](src/dcm2niix/)) — converts dropped DICOM folders to NIfTI; drop traversal uses `webkitGetAsEntry()` and stamps `_webkitRelativePath` so dcm2niix groups by series.

**Auto-run flow.** Every image (the bundled default at startup, a dropped NIfTI, or a picked dcm2niix series) is passed to `runSegment(file)`, which is the whole pipeline: display it → segment (conform + inference + back-projection all inside the wasm module) → overlay → QC. See "Segmentation" + "QC".

### Concurrency — single-flight (gotcha)
Loads, drops, and segmentation runs must not overlap: everything is serialized through one promise chain (`enqueue`/`pending`). Required because (a) the niimath wrapper reassigns the worker's one `onmessage` handler per run — and our raw `--qc` post does the same (see "QC") — so two overlapping jobs on the same worker cross-wire each other's results; and (b) NiiVue holds one displayed scene. One job at a time.

### Worker recovery (gotcha)
A failed niimath run can leave the worker heap + MEMFS in an undefined state. The QC step catches → `resetNiimathWorker()` (terminates the worker via a cast to the wrapper's private `worker` field — it exposes no public `terminate`, and clears `niimathReady`) so the next QC spins up a fresh worker. A QC failure is **non-fatal** — the segmentation overlay stays up and the failure is reported in the status bar.

**`cleanup()` terminates the worker FIRST, then does NOT await `pending`.** A niimath run is a single uninterruptible WASM call, so awaiting the queue on HMR/tab-close would stall teardown. `cleanup()` sets `isCleanedUp`, terminates the worker (killing any in-flight run — whose promise then never resolves, hence no await), disposes the NiiVue context, and `nv.destroy()`s. Any run that *did* resolve hits `if (isCleanedUp) return` before touching `nv`/`ctx`.

## Segmentation ("Subcortical + GWM")

Runs [brainchop](https://github.com/neuroneural/brainchop)'s default "Subcortical + GWM" model (id 3, `model16chan18cls` — a 16-channel gridding-free MeshNet, 17 regions: GWM + subcortical) and overlays the labels on the input. Ported from `brainchop-test`.

**One wasm module, vendored as build output.** `@niivue/brainchop` is a C11
reimplementation of MeshNet compiled to WebAssembly with hand-written WGSL
kernels ([brainchopC](../brainchopC), `js/`). It replaced ~4.0k lines of vendored
tfjs engine (`inference-logic.js`, `tensor-utils.js`, `bwlabels.js`,
`brainchop-webworker.js`, `brainchop-parameters.js`, `diagnostic-stats.js`; 4.2k with
`segment.ts` and `reslice.ts`) plus `@tensorflow/tfjs` and
`@niivue/nv-ext-image-processing`. Weights are compiled into the module, so
`public/models/` now holds only `colormap.json`.

**It does conform, inference AND back-projection.** `segment()` returns a label
NIfTI (uint8, `intent_code` 1002) already on the input's own grid, so the whole
conform → infer → reslice → writeNifti chain collapsed into one call. This is
why `nv.volumeTransform.conform` and the ext that provided it are gone.

**Feed it `nv.saveVolume(volumes[0])`, not the dropped file** — the one subtlety.
NiiVue may reorient on load, and the module returns labels on whatever grid it
was handed. Passing the bytes NiiVue is *displaying* is what keeps the T1 and the
segmentation geometry-identical for `--qc`, which requires that. It is the same
argument the old code made by building the label volume from `volumes[0].hdr`;
`computeQc` serializes `volumes[0]` the same way.

**It is VENDORED, not a dependency, and everything it needs is committed.**
The package is not published yet, and a `file:../brainchopC/js` dependency
cannot resolve on a CI runner that checks out only this repository — so
`npm ci && npm run build` would fail. Instead:

- [src/brainchop/](src/brainchop/) — `index.js` (one esbuild bundle) plus the
  `.d.ts` files. Vite bundles these; `main.ts` imports `./brainchop/index.js`.
- [public/brainchop/](public/brainchop/) — the emscripten glue and its `.wasm`,
  served as-is. They are NOT bundled because the glue locates its own `.wasm`
  through its own `import.meta.url`, so the pair must stay adjacent and
  unhashed; a bundler would rewrite one and hash the other. `main.ts` points
  `assetPath` at them. Same class of problem as the niimath/dcm2niix
  `optimizeDeps.exclude` workaround.

Re-sync with [`npm run syncBrainchop`](scripts/sync-brainchop.mjs) after
rebuilding the package in `../brainchopC/js` (`BRAINCHOP_JS` overrides the
path). It is a maintenance tool, deliberately **not** wired into `dev`/`build` —
those must work from a plain checkout. Only `model16chan18cls` is vendored;
MindGrab would add 860 KB for a model this app never runs.

**Flow** (`runSegment(file)` in [src/main.ts](src/main.ts)): `nv.loadVolumes([file])`
(display) → `nv.saveVolume(volumes[0])` → `segment(t1, {model:'16chan18cls'})` →
`addVolume` → `setColormapLabel(idx, colormap.json)` (rc.9 needs `A`+`I` arrays
added; label 0 alpha 0) → QC. The overlay is native-grid labels (verified on the
default 192×256×201 · 0.9 mm `t1_crop`, genuinely non-256³ so the back-projection
does real work). The **Opacity** slider (`#ovlSlider`) drives the overlay's
opacity via `nv.setVolume(last, {opacity})`.

**It no longer crops, and that changed the numbers.** The tfjs path ran with
`enableCrop: true`, which brainchop's own parameter file annotates as *"WebGL2
fallback only (texture limit); WebGPU runs the full volume."* — model16's
receptive field is 255 on a 256³ volume, so cropping feeds the large-dilation
layers mostly zero padding, and upstream states this model family cannot crop.
The wasm module runs the full volume and refuses `--crop`. **The uncropped result
is the authoritative one**; that is brainchop's own designation, not a
preference. Characterized on the default subject (`cli/qc.mjs`, 58 shared numeric
metrics):

| metric group | Δ | why |
| --- | --- | --- |
| air/background (`summary_bg_*`, `fber`, `qi_1`, `efc_brain`, `wm2max`, `snrd_wm`) | **0.00 %** — bit-identical | depend only on the T1 + air mask, not the labels |
| WM (`summary_wm_*`, `snr_wm`, `vol_wm_mm3`) | 0.2–1.7 % | large confident region, least boundary-sensitive |
| GM | 1.8–6.3 % | more boundary |
| CSF (ventricles only, ~18k voxels) | 3–16 % | smallest structure, most boundary-sensitive |
| `summary_gm_k`, `summary_wm_k` | huge in % | excess kurtosis near zero (0.005 → 0.13); absolute change is 0.13/0.33 — do not read the percentage |

Median |Δ| across all shared metrics is **1.6 %**. End-to-end run time went
**27.6 s → 6.6 s** (headless Chrome, software WebGPU).

**`.npmrc` is gone.** It existed only to allow `@niivue/nv-ext-image-processing@rc.10`'s peer-pin against our NiiVue rc.9; with the ext removed there is no peer conflict and no `legacy-peer-deps`.

## QC (niimath `--qc`)

After the overlay is displayed, [src/main.ts](src/main.ts) `computeQc` runs niimath's `--qc` (MRIQC-style anatomical IQMs: CJV, CNR-noair, SNR, WM2MAX, EFC, ICV fractions, per-tissue volumes) on the **native** T1 + the **native-space** segmentation and fills the right-side [#qcPanel](index.html) (see [src/qc.ts](src/qc.ts) for the TSV parser + panel renderer).

- **Matching grids (requirement).** `--qc` demands the T1 and segmentation share a voxel grid. We serialize the T1 with `nv.saveVolume({volumeByIndex:0, filename:''})` (bytes, no download) so it comes from the **same** `volumes[0]` geometry the native segmentation was built from — they align by construction.
- **Fixed tissue labels.** `--qc` classifies each voxel CSF/GM/WM from the label values we pass; the "Subcortical + GWM" model always emits the same 18 labels, so [src/qc.ts](src/qc.ts) hard-codes `CSF_LABELS = [3,4,11,12]` (ventricles), `WM_LABELS = [1,5]` (cerebral + cerebellar WM); every other non-zero label is GM. No runtime name parsing.
- **WASM invocation (the gotcha).** `--qc` isn't a chain op (image→ops→image) — it takes its own argv and writes a **TSV**, not a NIfTI. The vendored wrapper's `run()` can't express that, so **`runNiimathRaw`** posts a raw job **straight to the niimath Web Worker** (via the wrapper's private `worker` field, same access pattern as `resetNiimathWorker`/`cleanup`): the worker is generic — it stages `blob` + `extraFiles` into MEMFS, runs `cmd` argv through `callMain`, and reads `outName` back as bytes. `runNiimathQc` is a thin text wrapper over it; the air passes reuse it too. Safe against the wrapper's per-run `onmessage` swap because the single-flight queue serializes all niimath work. The QC and aggregate air pipeline are `withTimeout`-bounded; air also captures the worker identity so a fetch/import that resolves after timeout cannot re-enter the replacement worker.
- **Report + Save.** `computeQc` builds an MRIQC-style report (`buildQcReport`, [src/qc.ts](src/qc.ts)): metrics flat at top level + `size_*`/`spacing_*` + optional `bids_meta` + `provenance`, mirroring MRIQC's `<sub>_T1w.json`. Exposed at full precision as `window.browserqcMetrics` (the CLI's seam) and downloaded by the **Save** button. `bids_meta` comes from a dropped `.json` sidecar, bound to the *current* image (never a leftover — see `stagedSidecar`); dcm2niix-generated sidecars are **not** auto-paired yet (drop the `.json` yourself, or use `--bids`).
- **Panel lifecycle.** Empty on load; cleared at the top of every `runSegment` (which also clears `window.browserqcMetrics`); populated when the TSV parses. Hidden below 720 px (`#qcPanel` in [src/style.css](src/style.css)).

CLI reference the WASM call mirrors: `niimath --qc <t1> --seg <seg> --csf 3,4,11,12 --wm 1,5 [--erode 0|1] [--out qc.tsv]` ([qc.c](../niimath/src/qc.c)). niimath's TSV names its air-free CNR `cnr_noair`; the air step (below) computes a real `cnr` that supersedes it (the panel falls back to `cnr_noair` if the air step was skipped).

## niimath (the QC + air engine)

niimath drives `--qc` **and** the air-mask chain (`-ras`/`-allineate -savemat`/`-otsu`/`-edt`). It's the npm package **`@niivue/niimath` (^1.3.3)** — `main.ts` imports `{ Niimath } from '@niivue/niimath'`. (It was vendored under `src/niimath/` while `--qc`/`-allineate` were newer than any release; 1.3.3 ships them, so the local copy was dropped.) We reach the wrapper's **private `worker` field** for the raw-post trick (see "QC"); that field name + the worker message protocol (`{blob,extraFiles,cmd,outName}` → `blob`/`ready`/`error`) are load-bearing — re-verify on any bump.

Like `@niivue/dcm2niix`, it's in `optimizeDeps.exclude` ([vite.config.ts](vite.config.ts)) because Vite's dev prebundler can't resolve its `new Worker(new URL('./worker.js', import.meta.url))` + WASM under `.vite/deps` — exclude keeps the worker a standalone module whose runtime URL resolves. (Production `vite build` uses Rollup and handles it either way.)

## Deploy


Served at [browserqc.org](https://browserqc.org) — a **custom domain** ([public/CNAME](public/CNAME)), so `base: '/'` in [vite.config.ts](vite.config.ts) (root, not a `/repo/` subpath). Still reference bundled assets through `import.meta.env.BASE_URL`, not absolute `/`. The [workflow](.github/workflows/ghpages.yml) (Node 22) runs `test:unit` before `build`, then JamesIves deploys `dist/` (which includes `public/CNAME`) to `gh-pages` — a broken air-metric test blocks deploy. `@niivue/dcm2niix` + `@niivue/niimath` are in `optimizeDeps.exclude` because Vite's prebundler breaks their WASM workers; don't remove that. Anything shipped in `public/` is public: `t1_crop.json` is a **de-identified** fixture (scanner/site/patient identifiers stripped) — keep it minimal.

## CLI (`cli/qc.mjs`)

`node cli/qc.mjs --in T1.nii[.gz] --out results.json [--bids sidecar.json]` — headless QC, JSON out. Needs `npm run build` and Chrome.

It **drives the real page in headless Chrome** rather than re-implementing the pipeline in Node, so results are the browser's by construction (verified: 38/38 metrics bit-identical, and deterministic run-to-run). That is still forced, though the reason changed with the engine: segmentation now needs **WebGPU**, which Node has no implementation of — the wasm module's only backend is `webgpu` and it refuses rather than falling back. (The module does still link a CPU engine, but at 141–266 s/volume single-threaded it is validation-only and the JS package declines to invoke it.)

Two seams: the CLI intercepts the page's request for its bundled default image to inject the input (so the normal auto-run does the work, no CLI special-casing in the app), and `computeQc` publishes `window.browserqcMetrics` at full precision because the panel rounds to 3 s.f.

## Air ("hat") metrics — [src/qc-air.ts](src/qc-air.ts)

niimath's `--qc` has no air term, so the background IQMs are computed here: `summary_bg_*` (8), `snrd_*` (4), `fber`, `qi_1`, and the air term of `cnr` (which replaces niimath's `cnr_noair`). Method mirrors MRIQC's `ArtifactMask`, via four niimath passes in `computeAirQc` ([src/main.ts](src/main.ts)):

1. `-ras` → RAS-canonical (== nibabel `as_closest_canonical`), so MRIQC's `[:, :, :k]` slice fills hit the right axes. **This is the correctness trap** — native storage order is often sagittal.
2. `-allineate avg152T1.nii.gz -savemat xf.json` → affine **transform only** (~2 s in WASM). MRIQC's two landmarks (glabella `[0,90,-14]`, inion `[0,-120,-14]`) share the same template z, so its two axis-aligned slab fills are really one template plane, **z = −14**. We test that plane directly (compose `moving_to_fixed · ras_affine` → voxel→template; the z row is a plane equation in voxel indices) — exact under pitch/roll/yaw, where MRIQC's slabs only approximate pitch. `LANDMARK_PLANE_Z` in [src/qc-air.ts](src/qc-air.ts).
3. `-otsu 5 -fillh -close` → head mask; 4. `-binv -edt` → distance from the head boundary into air.

Then in TS: hat = head-free voxels superior to the plane; artifacts = >10 MADs (of the full-hat scale) excluding the 10 % shell nearest the head, opened (6-connected). `summary_bg_*`/SNRd/FBER report over **air = hat − artifacts** (MRIQC's method — the artifacts are pruned out of the hat in place, so the returned mask is exactly the metrics' background); `qi_1` = artifact fraction; if artifacts consume the whole hat, only `qi_1` is returned (no NaN stats). `median()` averages the two central elements for even n (numpy convention). `computeAirQc` is `withTimeout`-bounded like every niimath step, and a failure resets the worker (the air catch mirrors the `--qc` catch). `-gz 0` on every pass. `readNii` returns typed-array **views** over the niimath output (no copy — vox_offset is always 352, aligned), so callers hold the bytes while reading; keeps peak memory down on the 256³ RAS volume. The air mask is written as a NIfTI on the RAS grid and shown as a translucent **blue overlay** (the **Air mask** checkbox, off by default) — QC-of-the-QC. On upright heads the plane and slab masks agree to <1 %; the plane's value is on rotated heads. Pure math is unit-tested (`test/qc-air.test.mjs`); the sidecar state machine in `test/qc-report.test.mjs`.

**Verified against MRIQC** on `qc/in` subjects: hat size within 7–12 %, `qi_1` exact (0 on both), `snrd_wm` within 8–11 %. `snrd_*` formula was reverse-engineered exactly: `0.6551364 × summary_<t>_median / bg_mad` (**median**, not mean; falls back to `bg_stdv` when `mad ≤ 1`, as MRIQC does).

**Absolute background levels sit low vs MRIQC** (`bg_mad` ~0.4×, `fber` ~0.17×) because MRIQC computes summary stats on an **N4-INU-corrected, homogenised** image while we use raw intensities — the same reason our `summary_wm_median` is 316 vs their 884. Geometry agrees; intensity scale does not. Don't chase this with mask tweaks.

**`cnr` will not converge with MRIQC** regardless of the air mask: σ_air is only **0.5 %** of the CNR denominator (σ_air 14.8 vs σ_gm 163, σ_wm 116). The gap is tissue segmentation (brainchop vs FSL-FAST) + INU. Likewise `icvs_csf` (0.01 vs 0.28) — our CSF is ventricles only.

## Deliberate decisions & known limitations

- **Single-flight liveness (invariant — keep it).** One unsettled job freezes the whole `enqueue`/`pending` chain (spinner stuck until reload), so **every worker-backed step must be time-bounded**: brainchop + niimath (init+run) + dcm2niix (init+run) via `withTimeout`. (brainchop's old per-attempt inactivity watchdog went with the tfjs worker; the wasm module is a single awaited call, so plain `withTimeout` covers it.) A worker can spawn and then never post back (no message, no `onerror`) — bound any new one you add.
- **Smoke is wiring-only.** Drives load → segmentation → overlay → `--qc` → panel to completion and fails on any `console.error`/page error, but does **not** assert segmentation or QC *values* (accuracy is brainchop's / niimath's to validate).
- **Tissue-label grouping is a judgement call.** WM = cerebral + cerebellar white matter (`[1,5]`); brainstem/VentralDC/deep-GM fall into GM. Fine for a relative CJV/CNR/SNR estimator; widen `WM_LABELS`/`CSF_LABELS` in [src/qc.ts](src/qc.ts) if needed. `--qc --erode` defaults to 1 (not exposed in the UI).
- **HMR dev-only limitation.** An already-running inference/conversion finishes after `cleanup()`; the execution-time + `runSegment`-entry `isCleanedUp` guards keep it from touching a destroyed NiiVue. Not worth cross-pipeline cancellation.
- **CLI error gate.** `cli/qc.mjs` fails (exit 1, no output written) on any page/console error — the app is expected to run clean (the smoke gates on the same signal), so a page error means the result may be wrong.
- **`junk.nii` in MEMFS (accepted).** The air `-allineate -savemat` pass must write a resliced image we don't read; the worker's cleanup only unlinks `outName` (`xf.json`). It's one small file (template grid) overwritten each run — bounded, not worth a vendored-worker edit.
- **dcm2niix sidecars not auto-paired.** `runDcm2niix` drops generated `.json`. A user-dropped sidecar is retained only when conversion yields one series; multi-series selection omits `bids_meta` because one sidecar cannot be paired safely. The CLI accepts an explicit `--bids`. Per-series pairing is a deferred enhancement (untested against real DICOM).
- **`shader-f16`-less GPU shows a technical message.** A GPU where NiiVue attaches (WebGPU renders) but brainchop's `acquireDevice()` fails (`no-f16` / device too small) surfaces the raw `BrainchopError` as `Failed: <code>` via the enqueue catch — graceful (no crash), but not the friendly "needs WebGPU" text (that only covers the NiiVue-attach path). Mapping `BrainchopError.code` → friendly text is a deferred nicety.
