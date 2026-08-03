import type { ModelInfo, ModelName, SegmentOptions, SegmentResult } from './types.js';
export { BrainchopError } from './error.js';
export type { BrainchopErrorCode } from './error.js';
export { checkSupport, acquireDevice, ACTIVATION_BYTES } from './device.js';
export type { DeviceReport } from './device.js';
export type { ModelName, ModelInfo, ModelCapabilities, SegmentOptions, SegmentResult, } from './types.js';
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
 * @example
 * const stripped = await segment(await file.arrayBuffer(), { model: 'mindgrab' })
 */
export declare function segment(input: ArrayBuffer | ArrayBufferView, options: SegmentOptions): Promise<SegmentResult>;
//# sourceMappingURL=index.d.ts.map