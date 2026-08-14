// src/error.ts
var BrainchopError = class extends Error {
  code;
  /** The module's own output, when the failure came from inside it. */
  log;
  constructor(code, message, log) {
    super(message);
    this.name = "BrainchopError";
    this.code = code;
    this.log = log;
  }
};

// src/device.ts
var ACTIVATION_BYTES = 256 * 256 * 256 * 16 * 2;
var WANT_BYTES = 1024 * 1024 * 1024;
var MiB = (n) => `${Math.round(n / (1024 * 1024))} MiB`;
async function checkSupport() {
  if (typeof navigator === "undefined" || !navigator.gpu)
    return {
      supported: false,
      reasons: [
        "navigator.gpu is undefined: either this browser has no WebGPU, or the page is not a secure context. about:blank and file:// are NOT secure contexts and look exactly like a browser without WebGPU; serve over https or localhost."
      ]
    };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { supported: false, reasons: ["requestAdapter returned null"] };
  const reasons = [];
  const hasShaderF16 = adapter.features.has("shader-f16");
  const { maxBufferSize, maxStorageBufferBindingSize } = adapter.limits;
  if (!hasShaderF16)
    reasons.push(
      "the adapter does not support the shader-f16 feature, which the kernels require; an f32 path would need more than 2 GiB of activations"
    );
  if (maxStorageBufferBindingSize < ACTIVATION_BYTES)
    reasons.push(
      `maxStorageBufferBindingSize is ${MiB(maxStorageBufferBindingSize)}, but one activation buffer needs ${MiB(ACTIVATION_BYTES)}`
    );
  if (maxBufferSize < ACTIVATION_BYTES)
    reasons.push(
      `maxBufferSize is ${MiB(maxBufferSize)}, but one activation buffer needs ${MiB(ACTIVATION_BYTES)}`
    );
  return {
    supported: reasons.length === 0,
    reasons,
    maxBufferSize,
    maxStorageBufferBindingSize,
    hasShaderF16
  };
}
async function acquireDevice() {
  if (typeof navigator === "undefined" || !navigator.gpu)
    throw new BrainchopError(
      "no-webgpu",
      "navigator.gpu is undefined: either this browser has no WebGPU, or the page is not a secure context (https or localhost)"
    );
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new BrainchopError("no-adapter", "requestAdapter returned null");
  if (!adapter.features.has("shader-f16"))
    throw new BrainchopError(
      "no-f16",
      "this adapter lacks the shader-f16 feature, which the segmentation kernels require"
    );
  const maxBufferSize = Math.min(WANT_BYTES, adapter.limits.maxBufferSize);
  const maxStorageBufferBindingSize = Math.min(WANT_BYTES, adapter.limits.maxStorageBufferBindingSize);
  if (maxStorageBufferBindingSize < ACTIVATION_BYTES || maxBufferSize < ACTIVATION_BYTES)
    throw new BrainchopError(
      "device-too-small",
      `this device allows ${MiB(maxStorageBufferBindingSize)} per storage binding and ${MiB(maxBufferSize)} per buffer, but the model needs ${MiB(ACTIVATION_BYTES)} for a single activation`
    );
  return adapter.requestDevice({
    requiredFeatures: ["shader-f16"],
    requiredLimits: { maxBufferSize, maxStorageBufferBindingSize }
  });
}

// src/webgl2.ts
var GL_ACTIVATION_BYTES = ACTIVATION_BYTES * 2;
var DIM = 256;
var LABEL_W = 2048;
var MiB2 = (n) => `${Math.round(n / (1024 * 1024))} MiB`;
function newContext() {
  const canvas = typeof OffscreenCanvas !== "undefined" && typeof document === "undefined" ? new OffscreenCanvas(1, 1) : typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  return canvas.getContext("webgl2", {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance"
  });
}
function checkWebgl2Support() {
  const gl = newContext();
  if (!gl)
    return {
      supported: false,
      reasons: ["a webgl2 context could not be created; this browser is either too old or has WebGL disabled or blocklisted"]
    };
  const reasons = [];
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const float = gl.getExtension("EXT_color_buffer_float");
  if (!float)
    reasons.push("this device lacks EXT_color_buffer_float, which the kernels require in order to render into float textures");
  const max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  const drawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  const attachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  if (max3d < DIM)
    reasons.push(`MAX_3D_TEXTURE_SIZE is ${max3d}, but the model needs ${DIM}`);
  if (drawBuffers < 4 || attachments < 4)
    reasons.push(`this device allows ${drawBuffers} draw buffers and ${attachments} colour attachments, but the model writes 4 at once`);
  if (maxTexture < LABEL_W || viewport[0] < LABEL_W || viewport[1] < LABEL_W)
    reasons.push(`MAX_TEXTURE_SIZE is ${maxTexture} and MAX_VIEWPORT_DIMS ${viewport[0]}x${viewport[1]}, but the label texture is ${LABEL_W}x${LABEL_W}`);
  let allocates;
  if (float && max3d >= DIM) {
    while (gl.getError() !== gl.NO_ERROR) {
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, DIM, DIM, DIM);
    allocates = gl.getError() === gl.NO_ERROR && !gl.isContextLost();
    gl.deleteTexture(tex);
    if (!allocates)
      reasons.push(`this device could not allocate even one ${MiB2(ACTIVATION_BYTES / 4)} activation plane; a run needs ${MiB2(GL_ACTIVATION_BYTES)} of them`);
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return {
    supported: reasons.length === 0,
    reasons,
    renderer,
    max3dTextureSize: max3d,
    maxDrawBuffers: drawBuffers,
    maxColorAttachments: attachments,
    maxTextureSize: maxTexture,
    allocates
  };
}
function releaseGlContext(gl) {
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}
function acquireGlContext() {
  const gl = newContext();
  if (!gl)
    throw new BrainchopError(
      "no-webgpu",
      "a webgl2 context could not be created; this browser is either too old or has WebGL disabled or blocklisted"
    );
  if (!gl.getExtension("EXT_color_buffer_float"))
    throw new BrainchopError(
      "no-f16",
      "this device lacks EXT_color_buffer_float, which the segmentation kernels require in order to render into float textures"
    );
  const max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  if (max3d < DIM)
    throw new BrainchopError(
      "device-too-small",
      `this device allows 3D textures up to ${max3d}, but the model needs ${DIM}`
    );
  return gl;
}

// src/gzip.ts
var GZIP_MAGIC = [31, 139];
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}
async function through(bytes, stream) {
  const copy = new Uint8Array(bytes);
  const body = new Blob([copy]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
async function gunzip(bytes) {
  if (typeof DecompressionStream === "undefined")
    throw new BrainchopError(
      "bad-input",
      "the input is gzipped but this environment has no DecompressionStream; decompress it before calling, or pass an uncompressed NIfTI"
    );
  return through(bytes, new DecompressionStream("gzip"));
}
async function gzip(bytes) {
  if (typeof CompressionStream === "undefined")
    throw new BrainchopError(
      "bad-input",
      "gzip output was requested but this environment has no CompressionStream"
    );
  return through(bytes, new CompressionStream("gzip"));
}

// src/run.ts
var DEFAULT_TIMEOUT_MS = 12e4;
var CPU_TIMEOUT_MS = 9e5;
var MODULE_FILE = {
  webgpu: {
    mindgrab: "./brainchop-mindgrab-gpu.js",
    "16chan18cls": "./brainchop-16chan18cls-gpu.js"
  },
  webgl2: {
    mindgrab: "./brainchop-mindgrab-gl.js",
    "16chan18cls": "./brainchop-16chan18cls-gl.js"
  },
  // No suffix: the CPU modules are the plain `make wasm` output, and they are
  // the only ones built with -pthread.
  cpu: {
    mindgrab: "./brainchop-mindgrab.js",
    "16chan18cls": "./brainchop-16chan18cls.js"
  }
};
var factories = /* @__PURE__ */ new Map();
function moduleUrl(backend, model, assetPath) {
  const file = MODULE_FILE[backend][model];
  if (!assetPath) return new URL(file, import.meta.url).href;
  const base = assetPath.endsWith("/") ? assetPath : `${assetPath}/`;
  const here = typeof location !== "undefined" ? location.href : "file:///";
  const url = new URL(`${base}${file.replace("./", "")}`, here);
  if (typeof location !== "undefined" && url.origin !== location.origin)
    throw new BrainchopError(
      "unsupported-option",
      `assetPath must be same-origin; ${url.origin} is not ${location.origin}`
    );
  return url.href;
}
function loadFactory(backend, model, assetPath) {
  const url = moduleUrl(backend, model, assetPath);
  let pending = factories.get(url);
  if (!pending) {
    pending = import(
      /* @vite-ignore */
      url
    ).then((m) => m.default);
    factories.set(url, pending);
  }
  return pending;
}
async function run(request) {
  const factory = await loadFactory(request.backend, request.model, request.assetPath);
  const log = [];
  const record = (line) => {
    log.push(line);
    request.onLog?.(line);
  };
  let settle;
  const exited = new Promise((resolve) => {
    settle = resolve;
  });
  let timer;
  const config = {
    noInitialRun: true,
    // bc_cli_parse takes the program name from argv[0]; without this the module
    // would identify itself as whatever host script loaded it.
    thisProgram: `brainchop-${request.model}`,
    print: record,
    printErr: record,
    onExit: (code2) => settle(code2)
  };
  if (request.backend === "webgpu") {
    config.preinitializedWebGPUDevice = request.device;
  } else if (request.backend === "webgl2") {
    config.preinitializedWebGLContext = request.glContext;
  }
  const limit = request.timeoutMs ?? (request.backend === "cpu" ? CPU_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const module = await Promise.race([
    factory(config),
    new Promise((_, reject2) => {
      timer = setTimeout(() => reject2(new BrainchopError(
        "inference-failed",
        `the ${request.model} module did not finish initialising within ${limit} ms`,
        log
      )), limit);
    })
  ]).finally(() => clearTimeout(timer));
  if (request.backend === "webgl2") {
    if (!module.specialHTMLTargets)
      throw new BrainchopError(
        "inference-failed",
        "this WebGL2 module was built without specialHTMLTargets exported; rebuild it with the flags in src/Makefile",
        log
      );
    module.specialHTMLTargets["#brainchop-webgl2"] = request.glContext.canvas;
  }
  module.FS.writeFile("/in.nii", request.input);
  const started = performance.now();
  try {
    module.callMain([
      ...request.args,
      "-backend",
      request.backend,
      "-o",
      "/out.nii",
      "/in.nii"
    ]);
  } catch (e) {
    if (e && typeof e.status === "number") {
      settle(e.status);
    } else {
      record(`threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      settle(-1);
    }
  }
  const code = request.backend === "webgl2" ? await exited : await Promise.race([
    exited,
    new Promise((_, reject2) => {
      timer = setTimeout(() => reject2(new BrainchopError(
        "inference-failed",
        `the ${request.model} module did not finish within ${limit} ms; ` + (request.backend === "cpu" ? "this machine may simply be slower than the limit allows" : "the GPU device may have been lost"),
        log
      )), limit);
    })
  ]).finally(() => clearTimeout(timer));
  const elapsedMs = performance.now() - started;
  if (request.backend === "webgl2" && request.glContext?.isContextLost())
    throw new BrainchopError(
      "inference-failed",
      `the WebGL2 context was lost while running ${request.model}; the GPU or its driver reset. Any output from this run is meaningless.`,
      log
    );
  if (code !== 0)
    throw new BrainchopError(
      "inference-failed",
      `the ${request.model} module exited with status ${code}`,
      log
    );
  if (!module.FS.analyzePath("/out.nii").exists)
    throw new BrainchopError(
      "inference-failed",
      `the ${request.model} module exited cleanly but wrote no output`,
      log
    );
  const extras = /* @__PURE__ */ new Map();
  for (const path of request.extraOutputs ?? [])
    if (module.FS.analyzePath(path).exists) extras.set(path, module.FS.readFile(path));
  return { image: module.FS.readFile("/out.nii"), extras, elapsedMs };
}

// src/index.ts
var MODELS = {
  mindgrab: {
    name: "mindgrab",
    description: "skull stripping in any modality",
    outputKind: "mask",
    capabilities: {
      ct: true,
      comply: true,
      saveConform: false,
      mask: true,
      border: true
    }
  },
  "16chan18cls": {
    name: "16chan18cls",
    description: "18-class brain segmentation",
    outputKind: "labels",
    capabilities: {
      ct: true,
      comply: true,
      saveConform: true,
      mask: false,
      border: false
    }
  }
};
function reject(model, option, why) {
  throw new BrainchopError(
    "unsupported-option",
    `${model} does not support \`${option}\`: ${why}`
  );
}
function buildArgs(options) {
  const model = Object.hasOwn(MODELS, options.model) ? MODELS[options.model] : void 0;
  if (!model)
    throw new BrainchopError(
      "unsupported-option",
      `unknown model '${options.model}'; expected one of ${Object.keys(MODELS).join(", ")}`
    );
  const args = [];
  if (options.ct) args.push("--ct");
  if (options.comply) args.push("--comply");
  if (options.saveConform) {
    if (!model.capabilities.saveConform)
      reject(
        options.model,
        "saveConform",
        "its output is the input image with non-brain voxels floored, so it is inherently in the input space"
      );
    args.push("--save-conform");
  }
  if (options.borderMm !== void 0 && !model.capabilities.border)
    reject(options.model, "borderMm", "a mask border is only meaningful for a mask model");
  if (options.mask && !model.capabilities.mask)
    reject(options.model, "mask", "a brain mask is only meaningful for a mask model");
  let maskPath;
  if (options.mask || options.borderMm !== void 0) {
    maskPath = "/mask.nii";
    args.push("--mask", maskPath);
  }
  if (options.borderMm !== void 0) {
    if (!Number.isFinite(options.borderMm) || options.borderMm < 0)
      throw new BrainchopError(
        "unsupported-option",
        `borderMm must be a non-negative number, got ${options.borderMm}`
      );
    args.push("--border", String(options.borderMm));
  }
  return { args, maskPath };
}
function workerUrl(assetPath) {
  if (!assetPath) return new URL("./worker.js", import.meta.url).href;
  const base = assetPath.endsWith("/") ? assetPath : `${assetPath}/`;
  const here = typeof location !== "undefined" ? location.href : "file:///";
  const url = new URL(`${base}worker.js`, here);
  if (typeof location !== "undefined" && url.origin !== location.origin)
    throw new BrainchopError(
      "unsupported-option",
      `assetPath must be same-origin; ${url.origin} is not ${location.origin}`
    );
  return url.href;
}
async function runInWorker(input, options) {
  if (typeof Worker === "undefined")
    throw new BrainchopError(
      "unsupported-option",
      "this environment has no Worker; run with worker: false"
    );
  const worker = new Worker(workerUrl(options.assetPath), { type: "module" });
  const { device, glContext, onLog, worker: _w, ...rest } = options;
  let timer;
  try {
    return await new Promise((resolve, reject2) => {
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "log") {
          onLog?.(message.line);
          return;
        }
        if (message.type === "done") {
          resolve({
            image: message.image,
            mask: message.mask,
            elapsedMs: message.elapsedMs,
            backend: message.backend
          });
          return;
        }
        reject2(new BrainchopError(message.code, message.message, message.log));
      };
      worker.onerror = (event) => reject2(new BrainchopError(
        "inference-failed",
        `the segmentation worker failed to start or threw: ${event.message ?? "unknown"}`
      ));
      const named = options.backend && options.backend !== "auto" ? options.backend : null;
      const limit = options.timeoutMs ?? (named && named !== "cpu" ? 12e4 : CPU_TIMEOUT_MS);
      timer = setTimeout(() => reject2(new BrainchopError(
        "inference-failed",
        `the segmentation did not finish within ${limit} ms`
      )), limit);
      worker.postMessage({ input, options: rest });
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}
async function acquire(options) {
  const named = options.backend && options.backend !== "auto" ? options.backend : null;
  if (options.device && named && named !== "webgpu")
    throw new BrainchopError(
      "unsupported-option",
      `backend: '${named}' was requested but a GPUDevice was supplied; a device selects the webgpu backend. Drop the device, or drop the backend.`
    );
  if (options.glContext && named && named !== "webgl2")
    throw new BrainchopError(
      "unsupported-option",
      `backend: '${named}' was requested but a WebGL2RenderingContext was supplied; a context selects the webgl2 backend. Drop the glContext, or drop the backend.`
    );
  if (options.device)
    return { backend: "webgpu", device: options.device, ownsContext: false };
  if (options.glContext)
    return { backend: "webgl2", glContext: options.glContext, ownsContext: false };
  const want = options.backend ?? "auto";
  if (want === "webgpu")
    return { backend: "webgpu", device: await acquireDevice(), ownsContext: false };
  if (want === "webgl2")
    return { backend: "webgl2", glContext: acquireGlContext(), ownsContext: true };
  if (want === "cpu") {
    const cpu2 = checkCpuSupport();
    if (!cpu2.supported)
      throw new BrainchopError("no-webgpu", `the cpu backend cannot run here: ${cpu2.reasons.join("; ")}`);
    return { backend: "cpu", ownsContext: false };
  }
  const gpu = await checkSupport();
  if (gpu.supported)
    return { backend: "webgpu", device: await acquireDevice(), ownsContext: false };
  const gl = checkWebgl2Support();
  if (gl.supported)
    return { backend: "webgl2", glContext: acquireGlContext(), ownsContext: true };
  const cpu = checkCpuSupport();
  if (cpu.supported) return { backend: "cpu", ownsContext: false };
  throw new BrainchopError(
    "no-webgpu",
    `no backend can run here.
  WebGPU: ${gpu.reasons.join("; ")}
  WebGL2: ${gl.reasons.join("; ")}
  CPU:    ${cpu.reasons.join("; ")}`
  );
}
function checkCpuSupport() {
  const reasons = [];
  if (typeof SharedArrayBuffer === "undefined")
    reasons.push("this environment has no SharedArrayBuffer");
  else if (globalThis.crossOriginIsolated !== true)
    reasons.push("this page is not cross-origin isolated; serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp");
  return { supported: reasons.length === 0, reasons };
}
async function segment(input, options) {
  const raw = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (raw.byteLength === 0)
    throw new BrainchopError("bad-input", "the input is empty");
  const { args, maskPath } = buildArgs(options);
  if (options.worker && (options.device || options.glContext))
    throw new BrainchopError(
      "unsupported-option",
      "worker cannot be combined with device or glContext: a GPUDevice and a WebGL2RenderingContext belong to the thread that created them and cannot cross into a worker"
    );
  if (options.worker) {
    const out = await runInWorker(raw, options);
    const result2 = {
      image: out.image,
      elapsedMs: out.elapsedMs,
      backend: out.backend,
      ranInWorker: true
    };
    if (out.mask) result2.mask = out.mask;
    return result2;
  }
  const compressed = isGzip(raw);
  const bytes = compressed ? await gunzip(raw) : raw;
  const wantGzip = options.gzipOutput ?? compressed;
  const { backend, device, glContext, ownsContext } = await acquire(options);
  let result;
  try {
    result = await run({
      model: options.model,
      backend,
      device,
      glContext,
      input: bytes,
      args,
      extraOutputs: maskPath ? [maskPath] : [],
      assetPath: options.assetPath,
      timeoutMs: options.timeoutMs,
      onLog: options.onLog
    });
  } finally {
    if (ownsContext && glContext) releaseGlContext(glContext);
  }
  const pack = async (data) => {
    const out = wantGzip ? await gzip(data) : data;
    return out.slice().buffer;
  };
  const segmented = {
    image: await pack(result.image),
    elapsedMs: result.elapsedMs,
    backend,
    ranInWorker: false
  };
  const mask = maskPath ? result.extras.get(maskPath) : void 0;
  if (mask) segmented.mask = await pack(mask);
  return segmented;
}

// src/worker.ts
self.onmessage = async (event) => {
  const post = (message, transfer = []) => self.postMessage(message, transfer);
  try {
    const result = await segment(event.data.input, {
      ...event.data.options,
      // Logs cannot be a callback across the boundary, so they are streamed.
      onLog: (line) => post({ type: "log", line })
    });
    const transfer = [result.image];
    if (result.mask) transfer.push(result.mask);
    post({
      type: "done",
      image: result.image,
      mask: result.mask,
      elapsedMs: result.elapsedMs,
      backend: result.backend
    }, transfer);
  } catch (error) {
    const e = error;
    post({
      type: "error",
      code: e && e.code || "inference-failed",
      message: e && e.message || String(error),
      log: e && e.log
    });
  }
};
//# sourceMappingURL=worker.js.map
