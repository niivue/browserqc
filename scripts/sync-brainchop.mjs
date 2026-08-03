#!/usr/bin/env node
// Re-sync the vendored @niivue/brainchop from a sibling brainchopC checkout.
//
// This is a MAINTENANCE tool, not a build step. Everything it writes is
// committed, so `npm ci && npm run build` works on a runner that has only this
// repository — which is the whole point: the package is not published yet, and
// a `file:../brainchopC/js` dependency cannot resolve in CI.
//
//   cd ../brainchopC/js && npm install && npm run build
//   node scripts/sync-brainchop.mjs
//
// Two destinations, and the split is not arbitrary:
//   src/brainchop/   the ESM wrapper + its types. Vite bundles these.
//   public/brainchop/ the emscripten glue and .wasm. Served as-is, because the
//                    glue locates its own .wasm through its own import.meta.url,
//                    so the pair must stay adjacent and unhashed — a bundler
//                    would rewrite one and hash the other.
//
// Only model16chan18cls is vendored; BrowserQC runs no other model, and
// MindGrab would add 860 KB for nothing.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const src = process.env.BRAINCHOP_JS ?? resolve(repo, '..', 'brainchopC', 'js')
const dist = join(src, 'dist')

if (!existsSync(join(dist, 'index.js'))) {
  console.error(`sync-brainchop: no build at ${dist}`)
  console.error('sync-brainchop: run `npm install && npm run build` there first,')
  console.error('sync-brainchop: or set BRAINCHOP_JS to the package directory.')
  process.exit(1)
}

const MODEL = 'brainchop-16chan18cls-gpu'
const code = join(repo, 'src', 'brainchop')
const assets = join(repo, 'public', 'brainchop')
mkdirSync(code, { recursive: true })
mkdirSync(assets, { recursive: true })

// index.js is a single esbuild bundle; only the type declarations are split.
// The .map files are deliberately not copied — they point at TypeScript sources
// that do not exist in this repository.
const wrapper = ['index.js', ...readdirSync(dist).filter((f) => f.endsWith('.d.ts'))]
for (const f of wrapper) copyFileSync(join(dist, f), join(code, f))
for (const f of [`${MODEL}.js`, `${MODEL}.wasm`]) copyFileSync(join(dist, f), join(assets, f))

console.log(`sync-brainchop: ${wrapper.length} files -> src/brainchop/`)
console.log(`sync-brainchop: ${MODEL}.{js,wasm} -> public/brainchop/`)
console.log('sync-brainchop: commit both directories.')
