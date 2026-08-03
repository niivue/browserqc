/** The models this package ships. One wasm module each, weights compiled in. */
export type ModelName = 'mindgrab' | '16chan18cls';
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
    /** Reuse a device you already own instead of requesting one. */
    device?: GPUDevice;
    /**
     * Base URL the model's `.js` and `.wasm` are served from. Defaults to this
     * package's own directory, which is correct for an unbundled ES module. Set
     * it when a bundler has moved things: the two files must stay adjacent and
     * unhashed, so the usual answer is to copy them somewhere served and point
     * here.
     */
    assetPath?: string;
    /** Abort if inference has not finished within this many ms (default 120000). */
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
}
//# sourceMappingURL=types.d.ts.map