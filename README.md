# BrowserQC

Automated MRI quality control, **entirely in your browser** — no upload, no server. Drag in a NIfTI image (or DICOM files or folders — with several series you pick one) and BrowserQC runs on its own: it segments the brain, shows the parcellation over your scan, and reports MRIQC-style image-quality metrics.

Live demo: [browserqc.org](https://browserqc.org).

## How it works

Everything runs in WebAssembly + WebGPU (WebGL2 fallback) on your machine, so your images are never shared with the cloud. When an image loads (on startup and on every drag-and-drop):

1. **Segment** — [`@brainchop/mindgrab`](https://www.npmjs.com/package/@brainchop/mindgrab) runs a [brainchop](https://github.com/neuroneural/brainchop) model picked from the **Model** menu: `16chan18cls` (fast, default) or `mindmap` (24-channel), each parcellating the brain into 17 gray/white-matter and subcortical regions; `mindsnap` (24-channel), 103 Desikan-Killiany cortical and subcortical regions; or `mindmap PVE`, GM/WM/CSF partial-volume fractions instead of labels. Conform (256³ 1 mm), inference and back-projection to the native grid all happen inside the WebAssembly module — on WebGPU where available, WebGL2 otherwise (so no WebGPU is required).
2. **Overlay** — the labels (or fractions) arrive on the native input grid and are drawn as a colour overlay on the original scan (adjust with the **Opacity** slider).
3. **Quality control** — [niimath](https://github.com/rordenlab/niimath) computes MRIQC-style anatomical image-quality metrics from the scan and its segmentation (with PVE, each voxel weighted by its tissue fraction, as MRIQC does), shown in the side panel:
   - **CJV** — coefficient of joint variation (noise + intensity non-uniformity); lower is better
   - **CNR** — contrast-to-noise (GM vs WM, over tissue + air noise); higher is better
   - **SNRd** — Dietrich SNR, normalised by background (air) noise; higher is better
   - **FBER** — foreground-background energy ratio; higher is better
   - **SNR** — signal-to-noise, averaged over tissues; higher is better
   - **WM2MAX** — white-matter median ÷ P99.95 intensity
   - **EFC** — entropy focus criterion (ghosting / blur); lower is better
   - **Tissue composition** — CSF / GM / WM as % of intracranial volume and absolute volume

Rendering uses [NiiVue](https://niivue.com/); DICOM import uses [dcm2niix](https://github.com/rordenlab/dcm2niix). A DICOM series' own sidecar becomes the report's `bids_meta`.

Metric names and definitions follow [MRIQC](https://mriqc.readthedocs.io/en/latest/), so outputs can be diffed against it directly. A **Save** button writes the metrics as MRIQC-style JSON (the CLI writes the same file); drop a BIDS sidecar `.json` alongside the image and it rides along as `bids_meta`.

> This is a fast **approximation** of MRIQC, not a reimplementation: it uses a deep-learning parcellation (or its CAT-lite fractions) rather than MRIQC's Atropos partial-volume maps, and raw intensities rather than an N4-bias-corrected image. Expect the same ballpark and the same ranking, not the same numbers — not yet re-validated against MRIQC with niimath's native `--air` metrics. Not a substitute for MRIQC's normative values.

## Develop

Requires **Node ≥ 22** (`npm run test:unit` imports the TypeScript sources directly via Node's type stripping).

```bash
npm install
npm run dev         # vite dev server (http://localhost:8091)
npm run build       # typecheck + production build to dist/
npm run preview     # serve the production build
npm run test:unit   # node --test: BIDS-sidecar state machine, CLI wiring
npm run test:e2e    # build, then a headless-Chrome smoke of the auto-run path (needs Google Chrome)
npm run test:dicom  # build, then drop a many-series DICOM folder (needs the reproin sample)
npm run test:parity # build, then compare the web app with the native CLI (needs the native tools)
```

### Command line

The same pipeline without a browser or Node — Python 3.8+ standard library only — on the native tools: `brainchop-<model>`
([brainchopC releases](https://github.com/neuroneural/brainchopC/releases)) and
[`niimath`](https://pypi.org/project/niimath/) ≥ v1.0.20260926 on `PATH` (or in `$BROWSERQC_BIN`):

```bash
python3 cli/qc.py --in T1.nii.gz --out qc.json [--model 16chan18cls|mindmap|mindsnap|mindmap-pve] [--bids sidecar.json]
```

It writes the report the page's **Save** does. `npm run test:parity` checks the two agree on the
bundled image: segmentation Dice ≥ 0.999, median metric difference < 0.01 %, worst ~2 % (a kurtosis).

## License

**BSD-2-Clause.** niimath comes from the [`@niivue/niimath`](https://www.npmjs.com/package/@niivue/niimath) npm package (BSD-2). Segmentation comes from the [`@brainchop/mindgrab`](https://www.npmjs.com/package/@brainchop/mindgrab) npm package (MIT), a C11 MeshNet reimplementation compiled to WebAssembly + WGSL.

## Links

This live demo already provides several of the core measures used by MRIQC (with more to come).

 - [MRIQC documentation](https://mriqc.readthedocs.io/en/latest/)
 - Esteban et al. (2017) MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites. PLoS One [PMID: 28945803](https://pubmed.ncbi.nlm.nih.gov/28945803/)
