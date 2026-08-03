/**
 * Every refusal this package makes carries a machine-readable `code` alongside
 * the prose, because the interesting failures here are ones a caller may want
 * to act on rather than merely display -- "this GPU is too small" is a
 * different situation from "you passed an option this model does not have".
 *
 * There is deliberately no fallback path behind any of these. The project's
 * position, recorded in plan_wasm.md, is that a silently downgraded
 * segmentation is worse than a refusal: cropping changes the answer and the
 * CPU engine takes minutes in wasm. So these are terminal, and they say which
 * limit was short and by how much.
 */
export type BrainchopErrorCode = 'no-webgpu' | 'no-adapter' | 'device-too-small' | 'no-f16' | 'unsupported-option' | 'bad-input' | 'inference-failed';
export declare class BrainchopError extends Error {
    readonly code: BrainchopErrorCode;
    /** The module's own output, when the failure came from inside it. */
    readonly log?: string[];
    constructor(code: BrainchopErrorCode, message: string, log?: string[]);
}
//# sourceMappingURL=error.d.ts.map