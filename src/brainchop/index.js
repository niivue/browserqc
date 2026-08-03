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
var MODULE_FILE = {
  mindgrab: "./brainchop-mindgrab-gpu.js",
  "16chan18cls": "./brainchop-16chan18cls-gpu.js"
};
var factories = /* @__PURE__ */ new Map();
function moduleUrl(model, assetPath) {
  if (!assetPath) return new URL(MODULE_FILE[model], import.meta.url).href;
  const base = assetPath.endsWith("/") ? assetPath : `${assetPath}/`;
  const here = typeof location !== "undefined" ? location.href : "file:///";
  const url = new URL(`${base}${MODULE_FILE[model].replace("./", "")}`, here);
  if (typeof location !== "undefined" && url.origin !== location.origin)
    throw new BrainchopError(
      "unsupported-option",
      `assetPath must be same-origin; ${url.origin} is not ${location.origin}`
    );
  return url.href;
}
function loadFactory(model, assetPath) {
  const url = moduleUrl(model, assetPath);
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
  const factory = await loadFactory(request.model, request.assetPath);
  const log = [];
  const record = (line) => {
    log.push(line);
    request.onLog?.(line);
  };
  let settle;
  const exited = new Promise((resolve) => {
    settle = resolve;
  });
  const module = await factory({
    noInitialRun: true,
    // bc_cli_parse takes the program name from argv[0]; without this the module
    // would identify itself as whatever host script loaded it.
    thisProgram: `brainchop-${request.model}`,
    preinitializedWebGPUDevice: request.device,
    print: record,
    printErr: record,
    onExit: (code2) => settle(code2)
  });
  module.FS.writeFile("/in.nii", request.input);
  const started = performance.now();
  try {
    module.callMain([...request.args, "-backend", "webgpu", "-o", "/out.nii", "/in.nii"]);
  } catch (e) {
    if (!(e && typeof e.status === "number")) {
      record(`threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      settle(-1);
    }
  }
  let timer;
  const limit = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const code = await Promise.race([
    exited,
    new Promise((_, reject2) => {
      timer = setTimeout(() => reject2(new BrainchopError(
        "inference-failed",
        `the ${request.model} module did not finish within ${limit} ms; the GPU device may have been lost`,
        log
      )), limit);
    })
  ]).finally(() => clearTimeout(timer));
  const elapsedMs = performance.now() - started;
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
function listModels() {
  return Object.values(MODELS);
}
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
async function segment(input, options) {
  const raw = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (raw.byteLength === 0)
    throw new BrainchopError("bad-input", "the input is empty");
  const { args, maskPath } = buildArgs(options);
  const compressed = isGzip(raw);
  const bytes = compressed ? await gunzip(raw) : raw;
  const wantGzip = options.gzipOutput ?? compressed;
  const device = options.device ?? await acquireDevice();
  const result = await run({
    model: options.model,
    device,
    input: bytes,
    args,
    extraOutputs: maskPath ? [maskPath] : [],
    assetPath: options.assetPath,
    timeoutMs: options.timeoutMs,
    onLog: options.onLog
  });
  const pack = async (data) => {
    const out = wantGzip ? await gzip(data) : data;
    return out.slice().buffer;
  };
  const segmented = {
    image: await pack(result.image),
    elapsedMs: result.elapsedMs
  };
  const mask = maskPath ? result.extras.get(maskPath) : void 0;
  if (mask) segmented.mask = await pack(mask);
  return segmented;
}
export {
  ACTIVATION_BYTES,
  BrainchopError,
  MODELS,
  acquireDevice,
  checkSupport,
  listModels,
  segment
};
//# sourceMappingURL=index.js.map
