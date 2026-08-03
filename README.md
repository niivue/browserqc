# BrowserQC

Automated MRI quality control, **entirely in your browser** — no upload, no server. Drag in a NIfTI image (or a folder of DICOM files) and BrowserQC runs on its own: it segments the brain, shows the parcellation over your scan, and reports MRIQC-style image-quality metrics.

Live demo: [browserqc.org](https://browserqc.org).

## How it works

Everything runs in WebAssembly + WebGPU on your machine, so your images are never shared with the cloud. When an image loads (on startup and on every drag-and-drop):

1. **Segment** — the vendored [`@niivue/brainchop`](https://github.com/neuroneural/brainchopC) runs the [brainchop](https://github.com/neuroneural/brainchop) `model16chan18cls` ("Subcortical + GWM") model on WebGPU, parcellating the brain into 17 gray/white-matter and subcortical regions. Conform (256³ 1 mm), inference and back-projection to the native grid all happen inside the WebAssembly module.
2. **Back-project** — the labels are resliced onto the native input grid and drawn as a colour overlay on the original scan (adjust with the **Opacity** slider).
4. **Quality control** — [niimath](https://github.com/rordenlab/niimath) computes MRIQC-style anatomical image-quality metrics from the scan and its segmentation, shown in the side panel:
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

The segmentation engine is **vendored** (`src/brainchop/`, `public/brainchop/`)
and committed, so a plain clone builds with no other checkout. To pick up a new
build of it: `cd ../brainchopC/js && npm install && npm run build`, then
`npm run syncBrainchop` here, and commit what changes.


Requires **Node ≥ 22** (`npm run test:unit` imports the TypeScript sources directly via Node's type stripping).

```bash
npm install
npm run dev      # vite dev server (http://localhost:8091)
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
npm run test:unit # node --test: air-metric math (median, stats, hat, artifacts)
npm run test:e2e # build, then a headless-Chromium smoke of the full auto-run path
```

### Command line

Batch/scripted QC, same pipeline, JSON out (drop `--bids sidecar.json` to embed scan metadata):

```bash
npm run build
node cli/qc.mjs --in T1.nii.gz --out results.json
```

It runs the real app in headless Chrome (so the numbers match the browser exactly) and writes every `--qc` metric at full precision. Requires Google Chrome.

Requires a browser with WebGPU (recent desktop Chrome, Edge, or Safari).

## License

**BSD-2-Clause.** niimath comes from the [`@niivue/niimath`](https://www.npmjs.com/package/@niivue/niimath) npm package (BSD-2). Segmentation comes from the vendored [`@niivue/brainchop`](https://github.com/neuroneural/brainchopC) package (BSD-2), a C11 MeshNet reimplementation compiled to WebAssembly + WGSL.

## Links

This live demo already provides several of the core measures used by MRIQC (with more to come).

 - [MRIQC documentation](https://mriqc.readthedocs.io/en/latest/)
 - Esteban et al. (2017) MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites. PLoS One [PMID: 28945803](https://pubmed.ncbi.nlm.nih.gov/28945803/)
