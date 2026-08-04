import type { ModelInfo, ModelName, SegmentOptions, SegmentResult } from './types.js';
export { BrainchopError } from './error.js';
export type { BrainchopErrorCode } from './error.js';
export { checkSupport, acquireDevice, ACTIVATION_BYTES } from './device.js';
export type { DeviceReport } from './device.js';
export { checkWebgl2Support, acquireGlContext, releaseGlContext, GL_ACTIVATION_BYTES, } from './webgl2.js';
export type { Webgl2Report } from './webgl2.js';
export type { Backend, ModelName, ModelInfo, ModelCapabilities, SegmentOptions, SegmentResult, } from './types.js';
/**
 * What each executable actually offers, transcribed from its `model_meta.json`.
 *
 * `crop` and `exportClasses` are absent from both, and that is not an omission.
 * Both force the CPU engine, which this build still links but which takes
 * 141-266 s per volume in wasm without OpenMP. Accepting them would turn a
 * two-second call into a four-minute one with no warning, so they are refused
 * here rather than quietly served.
 */
export declare const MODELS: Record<ModelName, ModelInfo>;
/** The model names this package can run. */
export declare function listModels(): ModelInfo[];
/**
 * Segment one NIfTI volume.
 *
 * Takes a NIfTI file image and returns one, gzipped or not on either side. The
 * whole chain -- conform, normalise, the MeshNet layers, classify,
 * largest-component, reslice -- runs inside the wasm module on the GPU; this
 * function owns only the three things the module deliberately does not: gzip,
 * device acquisition, and deciding to refuse.
 *
 * BACKEND, and one warning worth reading. By default this runs on WebGPU where
 * it exists and WebGL2 where it does not. The WebGL2 module is SYNCHRONOUS --
 * glReadPixels blocks, so it needs no ASYNCIFY -- which means it holds the
 * calling thread for the whole segmentation, seconds at a time. On a main
 * thread that freezes the page -- measured at 2171 ms of a 2196 ms run, with
 * three frames drawn. Pass `worker: true` and it drops to zero; that is the
 * recommended way to call this from a UI, on either backend. `result.backend`
 * and `result.ranInWorker` say what actually happened.
 *
 * @example
 * const stripped = await segment(await file.arrayBuffer(), { model: 'mindgrab' })
 */
export declare function segment(input: ArrayBuffer | ArrayBufferView, options: SegmentOptions): Promise<SegmentResult>;
//# sourceMappingURL=index.d.ts.map