import type { Backend, ModelName } from './types.js';
export interface RunRequest {
    model: ModelName;
    backend: Backend;
    /** Required for the webgpu backend. */
    device?: GPUDevice;
    /** Required for the webgl2 backend. */
    glContext?: WebGL2RenderingContext;
    input: Uint8Array;
    /** CLI arguments, excluding the input path and `-o`. */
    args: string[];
    /** Extra files to collect from MEMFS afterwards, by path. */
    extraOutputs?: string[];
    /** Base URL for the emscripten glue and .wasm; see moduleUrl(). */
    assetPath?: string;
    /** Abort if the module has not exited within this many ms. */
    timeoutMs?: number;
    onLog?: (line: string) => void;
}
export interface RunResult {
    image: Uint8Array;
    extras: Map<string, Uint8Array>;
    elapsedMs: number;
}
/**
 * Run one segmentation to completion.
 *
 * The subtlety is the exit: the module is built with ASYNCIFY so the C can wait
 * synchronously on the GPU readback, and under ASYNCIFY `callMain` RETURNS at
 * the first yield rather than at exit. Awaiting it would resolve before any GPU
 * work had happened and report success on an empty output. The module is linked
 * with `-sEXIT_RUNTIME=1` so `onExit` fires for real, and that is what is
 * awaited here.
 */
export declare function run(request: RunRequest): Promise<RunResult>;
//# sourceMappingURL=run.d.ts.map