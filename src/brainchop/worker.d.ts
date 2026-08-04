import type { SegmentOptions } from './types.js';
/** Everything the main thread sends. `options` is already structured-clonable. */
export interface WorkerRequest {
    input: Uint8Array;
    options: Omit<SegmentOptions, 'device' | 'glContext' | 'onLog' | 'worker'>;
}
export type WorkerResponse = {
    type: 'log';
    line: string;
} | {
    type: 'done';
    image: ArrayBuffer;
    mask?: ArrayBuffer;
    elapsedMs: number;
    backend: 'webgpu' | 'webgl2';
} | {
    type: 'error';
    code: string;
    message: string;
    log?: string[];
};
//# sourceMappingURL=worker.d.ts.map