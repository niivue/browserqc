/** 256^3 voxels x 16 channels x 2 bytes: one f16 activation buffer. */
export declare const ACTIVATION_BYTES: number;
export interface DeviceReport {
    supported: boolean;
    /** Why not, in the caller's terms. Empty when supported. */
    reasons: string[];
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
    hasShaderF16?: boolean;
}
/**
 * Ask whether this browser can run the models, without running one.
 *
 * Worth calling before showing a user a button that would only fail. It
 * requests an adapter but never a device, so it is cheap and side-effect free.
 */
export declare function checkSupport(): Promise<DeviceReport>;
/**
 * Acquire a device sized for the model, or refuse and say which limit was short.
 *
 * The elevated limits must be requested explicitly: WebGPU's defaults are
 * 128/256 MiB, well under the 512 MiB one activation needs, and a device
 * created with defaults fails later and less legibly.
 */
export declare function acquireDevice(): Promise<GPUDevice>;
//# sourceMappingURL=device.d.ts.map