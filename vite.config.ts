import { defineConfig } from 'vite'

// Served at browserqc.org — a custom domain (public/CNAME), so the site lives at
// the root, not a /repo/ subpath (still use import.meta.env.BASE_URL in code).
export default defineConfig({
  base: '/',
  server: {
    open: '/index.html',
    port: 8091,
  },
  // mindgrab's worker uses top-level await, which the default iife format cannot hold.
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
  },
  // Vite's dev prebundler (esbuild) moves these into .vite/deps, where their
  // `new Worker(new URL(...))` workers and wasm no longer resolve. Rollup (build) is fine.
  optimizeDeps: {
    exclude: ['@niivue/dcm2niix', '@niivue/nv-ext-dcm2niix', '@niivue/niimath', '@brainchop/mindgrab'],
  },
})
