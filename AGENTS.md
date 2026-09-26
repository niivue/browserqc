This file provides guidance to AI agents when working with code in this repository.

## What this is

**BrowserQC** — browser-only automated MRI quality control. Drag in a NIfTI (or DICOM files/folders) and it runs on its own: deep-learning segmentation → overlay on the native scan → niimath MRIQC-style quality metrics in a side panel. **No data leaves the machine** — everything runs in WebAssembly + WebGPU (WebGL2 fallback). There is no Apply button: segmentation + QC run whenever an image loads (startup, every drop, every model or series change).

**Keep it minimal.** This is a worked example meant to teach the concept — readable end to end. It is built only from stock npm packages (the lean pattern of `../brainchop-next`); prefer the smallest change that works, no defensive code for cases that can't happen, no abstractions for a single caller.

## Commands

```bash
npm run dev         # vite dev server on http://localhost:8091
npm run build       # tsc --noEmit (typecheck) + vite build to dist/
npm run typecheck   # tsc --noEmit only
npm run preview     # serve the production build (port 4173)
npm run test:unit   # node --test — sidecar state machine + cli/qc.py wiring (stub executables; needs python3)
npm run test:e2e    # build, then headless-Chrome smoke (system Chrome)
npm run test:dicom  # build, then the DICOM series picker on ../bidsui's reproin sample (skips if absent)
npm run test:parity # build, then web ⇄ native CLI parity (needs brainchop-* + niimath, $BROWSERQC_BIN)
```

The linter is just `tsc`; "validate before commit" = typecheck + unit + build + smoke (+ dicom/parity when the data/tools are present; CI runs only unit + build). `test/preview.mjs` is the shared harness: it boots `vite preview` (failing fast on a port clash and refusing a stale server that won the port), launches system Chrome with software WebGPU (`--use-gl=angle --enable-unsafe-swiftshader`), and its `newPage()` records every `console.error`/page error, which `finish()` turns into a failure in all three browser tests — keep that gate meaningful (a handled capability-absence should `console.warn`). The smoke waits for the default image's report, asserts the panel populated and `snrd_total` is finite, switches to PVE and waits for `provenance.pve`, then drives Opacity + About.

## Architecture

Single page, no framework. [src/main.ts](src/main.ts) is the whole controller; [src/qc.ts](src/qc.ts) renders the panel and binds sidecars; [src/models.json](src/models.json) lists the four models with their tissue grouping, or for PVE the mindmap model whose fractions it uses (`"pve": "mindmap"`) — the one source for the page, the CLI and the parity test. The UI is the canvas, the right-side panel (Model, Series — shown only with ≥ 2 series —, Opacity, Save, About) and the series picker dialog. Packages, all exact-pinned:

- **NiiVue** (`@niivue/niivue` 1.0.0-rc.16) — rendering. `attachTo` falls back to WebGL2; only when both renderers fail does init show a message (`console.warn`, not error).
- **mindgrab** (`@brainchop/mindgrab`) — segmentation, one wasm module per model with weights compiled in. Exact-pinned because the publisher puts the build date in the patch field: `^` would make every publish (~1 MB of opaque wasm with page privileges) a silent install away.
- **niimath** (`@niivue/niimath`) — `image(t1).qc(tissues, air)` runs `--qc … --air … --json` in its worker and resolves to the parsed report.
- **nv-ext-dcm2niix** (`@niivue/nv-ext-dcm2niix` 1.0.0-rc.14, peer of NiiVue rc.16) — `traverseDataTransferItems` + `runDcm2niix(files, {niftiOnly:false})`.

Vite: `worker.format: 'es'` (mindgrab's worker uses top-level await) and `optimizeDeps.exclude` for dcm2niix, nv-ext-dcm2niix, niimath, mindgrab (the dev prebundler moves them into `.vite/deps`, where their `new Worker(new URL(…))` workers and wasm no longer resolve). mindgrab is bundler-friendly — Vite emits and hashes each model's glue + wasm, so nothing is staged or copied.

### Flow (`run()`)
`nv.loadVolumes([current])` → `t1 = nv.saveVolume({filename:''})` → `segment(t1, {model, worker:true, timeoutMs})` (or `segmentTissues` for PVE) → `addVolume` + `setColormapLabel(BRAINCHOP[model].colormap)` (mindgrab ships names + RGB; NiiVue fills in `I` and `A`, label 0 transparent — the cast is for its stricter type only) → `computeQc` → panel.

**Feed mindgrab `nv.saveVolume(volumes[0])`, not the dropped file.** NiiVue may reorient on load and the module answers on the grid it is given, so this keeps the T1 and segmentation on one grid, which `--qc` requires (0.001 mm). The same `t1` bytes go to QC.

`?model=<id>` preselects a model (own keys only: `Object.hasOwn`, so `?model=toString` cannot break init); `?backend=webgl2|webgpu` forces mindgrab's backend (the only way to exercise the WebGL2 fallback on a WebGPU machine); the status line names the backend that ran.

### Concurrency: a busy flag
`setBusy` disables the Model and Series pickers and makes drops a no-op, so nothing overlaps and a run needs no stale-image checks. `openFiles` re-checks `busy` because the folder walk is asynchronous, and `init` skips the default image if a drop arrived while it downloaded (`busy || series.length`) — otherwise two runs interleaved and Save could name one subject's report after another. **Liveness:** every worker step is bounded — mindgrab by its own `timeoutMs` (with `worker:true` that terminates the worker), niimath and dcm2niix by `withTimeout` (60 s) — or a hung worker would leave `busy` set until reload. niimath is one instance per QC, `dispose()`d in `finally`, so a failed run cannot poison the next. On a dcm2niix timeout its worker is abandoned, not terminated (the extension owns it). No HMR teardown: a dev reload mid-run can leave a stray worker — dev only.

### Drops and the series picker
Files split three ways: `.json` sidecars; NiiVue `volumeExtensions`; everything else → dcm2niix (whose failure is ignored if the drop also held a volume — stray files). One image → run. Several → the picker: tiles of `SeriesNumber · SeriesDescription · echo suffix` and `dims · mm · N volumes` (shape from a little-endian NIfTI-1 header, first stream chunk), sorted by series number, the **largest single 3D volume focused as suggested**; nothing runs until one is picked. On the reproin XA60 sample: 34 folders → 19 series, suggested `5 · anat-T1w`.

**`bids_meta`** is bound to the image, never a leftover: an image's own sidecar (same basename — dcm2niix writes one per series), else — only when the drop has a single image — a dropped or staged sidecar (`bindSidecar`, unit-tested: a `.json` dropped alone is staged for the next image only).

### QC (`niimath --qc`)
MRIQC-style anatomical IQMs (CJV, CNR, SNRd, FBER, SNR, WM2MAX, EFC, ICV fractions, per-tissue summaries, background stats) on the T1 + segmentation, with `--air public/avg152T1.nii.gz` for MRIQC's ArtifactMask metrics. Failure is non-fatal: the overlay stays and the status bar says why. BrowserQC adds `provenance.segmentation` and `bids_meta`, publishes the report as `window.browserqcMetrics` (full precision; the panel rounds to 3 s.f.; also what **Save** downloads) and the exact inputs as `window.browserqcInputs` — the test seams.

- **Tissue grouping per label set** (`models.json`): 18-class (`16chan18cls`, `mindmap`) CSF `[3,4,11,12]` (ventricles), WM `[1,5]`; `mindsnap` CSF `87–93`, WM `85,86,95,96` + corpus callosum `99–103`. Every other non-zero label is GM. No runtime name parsing. On the default image the three give GM 749/728/703, WM 493/495/494, CSF 26.3/27.0/26.4 cm³. A judgement call (brainstem, deep GM count as GM) — fine for relative estimators.
- **PVE (`mindmap-pve`)**: `segmentTissues` returns GM/WM/CSF fractions (uint8, `scl_slope` 1/255, CAT-lite fit on mindmap's priors), shown as three tinted overlays and scored with `--pve csf gm wm`. niimath then weights each voxel by its fraction as MRIQC's `summary_stats` does: weighted mean/stdv/p05/median/p95, `n` = Σw, MAD and kurtosis over voxels above half the peak fraction, ICV from summed fractions, no erosion. Same JSON keys, so the panel is unchanged. PVE CSF includes sulcal CSF (2.9 % vs 2.2 % ventricles-only on the default image).
- One niimath failure mode to know: an air-mask failure (unreadable template, registration failure) exits `--qc` non-zero, so all QC fails. Too few air voxels is not a failure — niimath nulls `snrd_*`/`summary_bg_*` and the panel shows `—`. niimath also emits `cnr_noair` beside the air-aware `cnr` (panel shows `cnr`).

## CLI (`cli/qc.py`)

`python3 cli/qc.py --in T1.nii[.gz] --out qc.json [--model …] [--bids sidecar.json]` — Python 3.8+ standard library only, so CLI users need no Node (niimath's own install path is `pip`). The page's pipeline on the native `brainchop-<model>` (PVE: `brainchop-mindmap --pve`) and `niimath` executables, found on `PATH` or `$BROWSERQC_BIN`. No browser, no build, no image I/O (niimath reads the images). It adds `provenance.segmentation`, the template basename and `bids_meta` as the page does, and reads tissue labels from `src/models.json`. NIfTI input only (run dcm2niix yourself). The input is made absolute so a name starting with `-` cannot read as an option; a malformed `--bids` sidecar is a clean `error:` exit.

**Parity** (`test/cli-parity.mjs`, all four models, default image; brainchop 0.1.20260925 Metal/CPU vs headless-Chrome SwiftShader WebGPU): segmentation Dice ≥ 0.9994 per tissue, PVE mean |Δfraction| ≤ 0.0003; CLI vs page median metric Δ < 0.01 %, worst 1.7 % (`summary_wm_k`, excess kurtosis near zero). niimath wasm vs native on identical inputs differs by ≤ 0.043 %, not zero: niimath is built `-ffast-math`, so native and wasm round differently (~1e-13 in tissue stats) and the air registration amplifies that (0.04 % of air voxels → `summary_bg_*`). The test's bar is 0.1 %.

## Deploy

Served at [browserqc.org](https://browserqc.org) — a custom domain ([public/CNAME](public/CNAME)), so `base: '/'` in [vite.config.ts](vite.config.ts); still reference assets through `import.meta.env.BASE_URL`. The [workflow](.github/workflows/ghpages.yml) (Node 22) runs `npm ci`, `test:unit`, `build`, then JamesIves deploys `dist/` to `gh-pages`. Anything in `public/` is public: `t1_crop.json` is a **de-identified** fixture — keep it minimal.

**No data leaves the machine, audited** for mindgrab: no absolute URL, no `WebSocket`/`sendBeacon`, no `eval`; its only fetches are its own same-origin glue + wasm. Re-check on any version bump.

## Deliberate decisions & known limitations

- **Smoke is wiring-only**: it asserts the runs complete clean, not segmentation/QC values — that is what `test:parity` and the packages' own suites cover.
- **The CPU backend is unreachable**: `auto` falls through to it only on a cross-origin-isolated page (COOP/COEP), which GitHub Pages can't set.
- **A GPU that suits neither backend** surfaces mindgrab's raw error as `Failed: …` — graceful, not friendly.
- **Size wart**: every model's WebGPU, WebGL2 and CPU glue + wasm is emitted into `dist/` (Vite follows each literal `import()`); a browser downloads only the pair it runs.
- **Stray images in a DICOM drop** (NiiVue's `volumeExtensions` include PNG/JPG/TIF) become extra picker tiles, as in brainchop-next; a lone image with no own sidecar takes the drop's first `.json`, even an unrelated one (e.g. `dataset_description.json`). Both accepted.
- **60 s bound** on each worker step also caps mindgrab (its own default is 120 s): a 24-channel model on WebGL2 or a weak GPU could time out — cleanly, with `Failed: …`.
- **`test:dicom` never runs in CI** (the reproin sample is not in the repo); it prints `skipped` without it.

## Status and next steps (2026-09-26)

Refactor onto stock packages done (app code 1069 → ~490 lines), audited (security/bugs + simplification; fixes applied), all gates green locally. **Blocker to deploy:** `package.json` needs `@niivue/niimath` **1.4.20260926** (adds `qc()` and `--pve`; niimath branch `qc-pve`), which is not yet on npm — `package-lock.json` still pins 1.4.20260924, so `npm ci` fails until it is published and `npm install` refreshes the lock. Local development used `npm install --no-save <packed tarball>`. CLI users also need niimath ≥ v1.0.20260926 (PyPI) and brainchop ≥ 0.1.20260925 (`--pve`).
