/** The models this package ships. One wasm module each, weights compiled in. */
export type ModelName = 'mindgrab' | '16chan18cls';
/**
 * Which GPU API runs the model.
 *
 * `webgpu` is preferred wherever it exists: it is faster (about 2x), and its
 * module yields to the event loop while the GPU works. `webgl2` is the fallback
 * for the browsers WebGPU has not reached -- notably Linux -- and is universal,
 * but it BLOCKS the calling thread for the duration. See `backend` in
 * SegmentOptions.
 */
export type Backend = 'webgpu' | 'webgl2';
/**
 * What each model's executable actually accepts.
 *
 * This mirrors `capabilities` in the model's `model_meta.json`, which is also
 * what generates the CLI's own `--help`. The C refuses an option a sibling
 * executable offers with a message naming the reason rather than
 * "unrecognized argument"; this table is how the TypeScript does the same
 * before a module is ever fetched.
 */
export interface ModelCapabilities {
    /** Convert Hounsfield to Cormack units for CT input. */
    ct: boolean;
    /** Insert the compliance transform before conform. */
    comply: boolean;
    /** Write the conformed 256^3 volume instead of reslicing to the input grid. */
    saveConform: boolean;
    /** Also produce a binary brain mask. */
    mask: boolean;
    /** Grow the mask border, in mm. Only meaningful alongside `mask`. */
    border: boolean;
}
export interface ModelInfo {
    name: ModelName;
    /** What the model does, as the executable's own --help states it. */
    description: string;
    /** 'mask' overwrites non-brain voxels of the input; 'labels' emits classes. */
    outputKind: 'mask' | 'labels';
    capabilities: ModelCapabilities;
}
export interface SegmentOptions {
    /** Which model to run. Required: there is no sensible default between these two. */
    model: ModelName;
    /** Treat the input as CT and convert Hounsfield to Cormack units. */
    ct?: boolean;
    /** Insert the compliance transform before conform. */
    comply?: boolean;
    /**
     * Return the conformed 256^3 volume rather than reslicing back to the input
     * grid. Off by default, matching the executables: output is in the input
     * image's own space unless you ask otherwise.
     */
    saveConform?: boolean;
    /** Also return a binary brain mask in `mask`. MindGrab only. */
    mask?: boolean;
    /** Grow the mask border by this many mm. MindGrab only, implies `mask`. */
    borderMm?: number;
    /**
     * gzip the returned buffers. Defaults to whatever the input was, so a
     * `.nii.gz` in gives a `.nii.gz` out.
     */
    gzipOutput?: boolean;
    /**
     * Which GPU API to use. Defaults to `auto`: WebGPU when this browser
     * supports it, otherwise WebGL2. Naming one explicitly makes an unsupported
     * choice an error rather than a silent downgrade, which is what you want in
     * a test.
     */
    backend?: Backend | 'auto';
    /**
     * Run the segmentation in a Web Worker instead of on the calling thread.
     *
     * STRONGLY RECOMMENDED in a page that must stay responsive, and the only way
     * to keep one during a WebGL2 run. Measured with a rAF ticker on an M4 Pro,
     * model16 on a 2 mm volume:
     *
     *   in-thread   webgpu 56 frames / 258 ms stall,  webgl2 3 frames / 2171 ms
     *   in a worker webgpu 72 frames / 0 ms stall,    webgl2 133 frames / 0 ms
     *
     * Off by default only because the worker script has to be reachable: it is
     * resolved next to this module, or under `assetPath` when a bundler has moved
     * things -- the same constraint the emscripten glue already has.
     *
     * Incompatible with `device` and `glContext`, which cannot cross a worker
     * boundary; passing both is refused rather than silently ignored.
     */
    worker?: boolean;
    /** Reuse a device you already own instead of requesting one. Implies webgpu. */
    device?: GPUDevice;
    /**
     * Reuse a WebGL2 context you already own instead of creating one. Implies
     * webgl2. It must have been created with `EXT_color_buffer_float` available;
     * `acquireGlContext()` does that for you.
     */
    glContext?: WebGL2RenderingContext;
    /**
     * Base URL the model's `.js` and `.wasm` are served from. Defaults to this
     * package's own directory, which is correct for an unbundled ES module. Set
     * it when a bundler has moved things: the two files must stay adjacent and
     * unhashed, so the usual answer is to copy them somewhere served and point
     * here.
     */
    assetPath?: string;
    /**
     * Abort if inference has not finished within this many ms (default 120000).
     *
     * Effective everywhere EXCEPT in-thread WebGL2:
     *
     *   in-thread webgpu   yes -- ASYNCIFY yields, so a timer can fire
     *   in-thread webgl2   NO  -- the module is synchronous and holds the thread
     *   worker, either     yes, and it is a REAL cancellation: the worker is
     *                      terminated, which stops the work rather than merely
     *                      giving up on waiting for it
     *
     * An earlier version of this note said "WebGPU only", which was wrong for
     * `worker: true` -- the case the package recommends and its own consumer uses.
     */
    timeoutMs?: number;
    /** Receives the module's stdout/stderr lines as they are produced. */
    onLog?: (line: string) => void;
}
export interface SegmentResult {
    /** The segmentation, as a NIfTI file image. */
    image: ArrayBuffer;
    /** The binary brain mask, present only when `mask` was requested. */
    mask?: ArrayBuffer;
    /** Milliseconds spent inside the wasm module, excluding device acquisition. */
    elapsedMs: number;
    /** Which backend actually ran, which matters when `backend` was `auto`. */
    backend: Backend;
    /** Whether it ran in a Web Worker. Follows `worker`; never silently different. */
    ranInWorker: boolean;
}
//# sourceMappingURL=types.d.ts.map