// Stage @brainchop/mindgrab's wasm modules into public/ so Vite serves them.
//
// They cannot be left in node_modules and imported: the package loads its
// emscripten glue by a COMPUTED URL, and each glue file then finds its own
// .wasm through its own import.meta.url -- so Vite neither rewrites the import
// nor emits the assets, and the pair has to stay adjacent and unhashed. public/
// is exactly the directory that preserves names, in dev and build alike, so the
// copies land at <base>brainchop/<version>/ where `assetPath` points.
//
// Versioned because these names are fixed across releases while the page
// bundle is hashed: GitHub Pages serves them with max-age=600, so right after a
// deploy a browser ran the NEW page against its cached OLD worker.js, which
// refused the new model. A new version is a new URL, so the pair cannot mix.
//
// Runs before dev/build via `&&` (not an npm pre-script: bun and npm disagree
// about those). public/brainchop/ is gitignored — staged, not committed.
//
// The three segmentation models, and only their WebGPU + WebGL2 pairs. The package
// also ships the mindgrab model and a threaded-CPU build of each; this app runs
// neither. The CPU build needs a cross-origin-isolated page (COOP/COEP) that
// GitHub Pages can't provide, so `auto` never reaches it here — no 404, and no
// ~1.5 MB shipped for nothing.

import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = join(here, '..', 'node_modules', '@brainchop', 'mindgrab', 'dist')
const root = join(here, '..', 'public', 'brainchop')
const { version } = JSON.parse(readFileSync(join(from, '..', 'package.json'), 'utf8'))
const to = join(root, version)

const files = [
  'worker.js',
  'brainchop-16chan18cls-gpu.js', 'brainchop-16chan18cls-gpu.wasm',
  'brainchop-16chan18cls-gl.js', 'brainchop-16chan18cls-gl.wasm',
  'brainchop-mindmap-gpu.js', 'brainchop-mindmap-gpu.wasm',
  'brainchop-mindmap-gl.js', 'brainchop-mindmap-gl.wasm',
  'brainchop-mindsnap-gpu.js', 'brainchop-mindsnap-gpu.wasm',
  'brainchop-mindsnap-gl.js', 'brainchop-mindsnap-gl.wasm',
]

rmSync(root, { recursive: true, force: true }) // else files a version bump renames linger and ship
mkdirSync(to, { recursive: true })
for (const f of files) copyFileSync(join(from, f), join(to, f))
console.log(`copy-brainchop: staged ${files.length} files into public/brainchop/${version}/`)
