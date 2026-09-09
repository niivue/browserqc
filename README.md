# BrowserQC

Automated MRI quality control, **entirely in your browser** — no upload, no server. Drag in a NIfTI image (or a folder of DICOM files) and BrowserQC runs on its own: it segments the brain, shows the parcellation over your scan, and reports MRIQC-style image-quality metrics.

Live demo: [browserqc.org](https://browserqc.org).

## How it works

Everything runs in WebAssembly + WebGPU (WebGL2 fallback) on your machine, so your images are never shared with the cloud. When an image loads (on startup and on every drag-and-drop):

1. **Segment** — [`@brainchop/mindgrab`](https://www.npmjs.com/package/@brainchop/mindgrab) runs the [brainchop](https://github.com/neuroneural/brainchop) `model16chan18cls` ("Subcortical + GWM") model, parcellating the brain into 17 gray/white-matter and subcortical regions. Conform (256³ 1 mm), inference and back-projection to the native grid all happen inside the WebAssembly module — on WebGPU where available, WebGL2 otherwise (so no WebGPU is required).
2. **Back-project** — the labels are resliced onto the native input grid and drawn as a colour overlay on the original scan (adjust with the **Opacity** slider).
3. **Quality control** — [niimath](https://github.com/rordenlab/niimath) computes MRIQC-style anatomical image-quality metrics from the scan and its segmentation, shown in the side panel:
   - **CJV** — coefficient of joint variation (noise + intensity non-uniformity); lower is better
   - **CNR** — contrast-to-noise (GM vs WM, over tissue + air noise); higher is better
   - **SNRd** — Dietrich SNR, normalised by background (air) noise; higher is better
   - **FBER** — foreground-background energy ratio; higher is better
   - **SNR** — signal-to-noise, averaged over tissues; higher is better
   - **WM2MAX** — white-matter median ÷ P99.95 intensity
   - **EFC** — entropy focus criterion (ghosting / blur); lower is better
   - **Tissue composition** — CSF / GM / WM as % of intracranial volume and absolute volume

Rendering uses [NiiVue](https://niivue.com/); DICOM import uses [dcm2niix](https://github.com/rordenlab/dcm2niix).

Metric names and definitions follow [MRIQC](https://mriqc.readthedocs.io/en/latest/), so outputs can be diffed against it directly. A **Save** button writes the metrics as MRIQC-style JSON (the CLI writes the same file); drop a BIDS sidecar `.json` alongside the image and it rides along as `bids_meta`.

> This is a fast **approximation** of MRIQC, not a reimplementation: it uses a hard deep-learning parcellation rather than FSL-FAST partial-volume maps, and raw intensities rather than an N4-bias-corrected image. Expect the same ballpark and the same ranking, not the same numbers — validated against MRIQC, `snrd_*` land within ~10 % while background *levels* and `icvs_csf` differ systematically. Not a substitute for MRIQC's normative values.

## Develop

The segmentation engine is the [`@brainchop/mindgrab`](https://www.npmjs.com/package/@brainchop/mindgrab)
npm package. Its wasm modules can't be bundled (each glue file finds its own
`.wasm` by a runtime URL), so `scripts/copy-brainchop.mjs` stages them into
`public/brainchop/` (gitignored) before every `dev`/`build` — a plain
`npm install` is all it needs.


Requires **Node ≥ 22** (`npm run test:unit` imports the TypeScript sources directly via Node's type stripping).

```bash
npm install
npm run dev      # vite dev server (http://localhost:8091)
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
npm run test:unit # node --test: air-metric math (median, stats, hat, artifacts) + the browserqc.sh contract
npm run test:e2e # build, then a headless-Chrome smoke of the full auto-run path (needs Google Chrome)
```

### Command line

The same pipeline on native executables, no browser. Put [`brainchop-16chan18cls`](https://github.com/neuroneural/brainchopC/releases) and a [niimath](https://github.com/rordenlab/niimath) with `--qc --air`/`--json` (its `qc` branch; newer than the 1.3.3 release) on your PATH, then:

```bash
./browserqc.sh T1.nii.gz results.json
```

It segments with brainchop and runs `niimath --qc ... --air avg152T1.nii.gz --json`, which computes every metric the page shows, air metrics included, with niimath's own provenance (no `bids_meta`). On the bundled subject, native and browser agree to within 0.4 % on every metric (56 of 58 within 0.1 %); the residual is the GPU segmentation, not the QC.

To reproduce the browser's numbers exactly, drive the real app in headless Chrome instead (needs `npm run build` and Google Chrome; `--bids sidecar.json` embeds scan metadata):

```bash
node cli/qc.mjs --in T1.nii.gz --out results.json
```

## License

**BSD-2-Clause.** niimath comes from the [`@niivue/niimath`](https://www.npmjs.com/package/@niivue/niimath) npm package (BSD-2). Segmentation comes from the [`@brainchop/mindgrab`](https://www.npmjs.com/package/@brainchop/mindgrab) npm package (MIT), a C11 MeshNet reimplementation compiled to WebAssembly + WGSL.

## Links

This live demo already provides several of the core measures used by MRIQC (with more to come).

 - [MRIQC documentation](https://mriqc.readthedocs.io/en/latest/)
 - Esteban et al. (2017) MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites. PLoS One [PMID: 28945803](https://pubmed.ncbi.nlm.nih.gov/28945803/)
