import { device, presentationFormat } from '../core/gpuContext.js';

const RING_SLOTS = 4096;
const SLOT_STRIDE = 256;
const RING_SIZE = RING_SLOTS * SLOT_STRIDE;

const BLEND_OVER = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

let uniformRingBuffer = null;
let ringSlotIndex = 0;

function ensureRingBuffer() {
    if (!uniformRingBuffer) {
        uniformRingBuffer = device.createBuffer({
            label: 'UniformRingBuffer',
            size: RING_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }
}

export function resetUniformRing() {
    ringSlotIndex = 0;
}

function allocSlot(data) {
    ensureRingBuffer();
    const offset = ringSlotIndex * SLOT_STRIDE;
    device.queue.writeBuffer(uniformRingBuffer, offset, data);
    ringSlotIndex = (ringSlotIndex + 1) % RING_SLOTS;
    return offset;
}

function makeShader(label, code) {
    return device.createShaderModule({ label, code });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DRAW POLYGONS
// ─────────────────────────────────────────────────────────────────────────────

const POLY_WGSL = /* wgsl */`
struct Uniforms {
    uOpacity      : f32,
    uThickness    : f32,
    uTranslate    : vec2f,
    uScale        : f32,
    uIsOrtho      : f32,
    uResolution   : vec2f,
    uRotate       : vec2f,
    uSinCosRota   : vec4f, // sin(rLon), cos(rLon), sin(rLat), cos(rLat)
    uColor        : vec3f,
    _pad1         : f32,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct VIn {
    @location(0) aPos   : vec2f,
    @location(1) aColor : vec3f,
};
struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) vColor    : vec3f,
    @location(1) vZ        : f32,
};

const PI = 3.14159265358979323846f;

@vertex fn vs(i: VIn) -> VOut {
    var o: VOut;
    o.vColor = i.aColor;
    let center = u.uResolution / 2.0;

    if (u.uIsOrtho > 0.5) {
        let lon = i.aPos.x * PI/180.0; let lat = i.aPos.y * PI/180.0;
        let sLon = sin(lon); let cLon = cos(lon);
        let sLat = sin(lat); let cLat = cos(lat);
        let rS = u.uSinCosRota.x; let rC = u.uSinCosRota.y;
        let rSL = u.uSinCosRota.z; let rCL = u.uSinCosRota.w;

        let xr = cLat * (sLon * rC - cLon * rS);
        let yr = rCL * sLat - rSL * cLat * (cLon * rC + sLon * rS);
        let zr = rSL * sLat + rCL * cLat * (cLon * rC + sLon * rS);

        let pxO = vec2f(120.0*xr, -120.0*yr) * u.uScale + u.uTranslate + center;
        var clipO = (pxO / u.uResolution) * 2.0 - 1.0; clipO.y = -clipO.y;
        o.pos = vec4f(clipO, 0.0, 1.0);
        o.vZ = zr;
    } else {
        let px = i.aPos * u.uScale + u.uTranslate + center;
        var clip = (px / u.uResolution) * 2.0 - 1.0; clip.y = -clip.y;
        o.pos = vec4f(clip, 0.0, 1.0);
        o.vZ = 1.0;
    }
    return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
    if (u.uIsOrtho > 0.5 && i.vZ < 0.0) { discard; }
    return vec4f(i.vColor, u.uOpacity);
}
`;

const POLY_VB_LAYOUTS = [
    { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
];

let polyPipeline = null;
let polyBG_Uniforms = null;
let uniformBGL = null;
const polyUniformBuf = new Float32Array(20); // 80 octets

function ensureUniformBGL() {
    if (uniformBGL) return;
    ensureRingBuffer();
    uniformBGL = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 } }],
    });
    polyBG_Uniforms = device.createBindGroup({
        layout: uniformBGL,
        entries: [{ binding: 0, resource: { buffer: uniformRingBuffer, size: 80 } }]
    });
}

function ensurePolyPipeline() {
    if (polyPipeline) return;
    ensureUniformBGL();
    const mod = makeShader('poly', POLY_WGSL);
    polyPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [uniformBGL] }),
        vertex: { module: mod, entryPoint: 'vs', buffers: POLY_VB_LAYOUTS },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: presentationFormat, blend: BLEND_OVER }] },
        primitive: { topology: 'triangle-list' },
    });
}

export function drawPolygons(pass, items) {
    if (!items || items.length === 0) return;
    ensurePolyPipeline();
    pass.setPipeline(polyPipeline);
    for (const p of items) {
        if (!p.pos || p.count <= 0) continue;
        if (!p.isAtlas && !p.forceDraw) continue;

        polyUniformBuf[0] = p.uOpacity || 1.0;
        polyUniformBuf[1] = 1.0; // Thickness par défaut
        polyUniformBuf[2] = p.uTranslate[0]; polyUniformBuf[3] = p.uTranslate[1];
        polyUniformBuf[4] = p.uScale;
        polyUniformBuf[5] = p.uIsOrtho ? 1.0 : 0.0;
        polyUniformBuf[6] = p.uResolution[0]; polyUniformBuf[7] = p.uResolution[1];
        polyUniformBuf[8] = p.uRotate[0]; polyUniformBuf[9] = p.uRotate[1];
        if (p.uSinCosRota) {
            polyUniformBuf[12] = p.uSinCosRota[0]; polyUniformBuf[13] = p.uSinCosRota[1];
            polyUniformBuf[14] = p.uSinCosRota[2]; polyUniformBuf[15] = p.uSinCosRota[3];
        }
        polyUniformBuf[16] = 1.0; polyUniformBuf[17] = 1.0; polyUniformBuf[18] = 1.0; // Color blanc par défaut
        const dynOffset = allocSlot(polyUniformBuf);
        pass.setBindGroup(0, polyBG_Uniforms, [dynOffset]);
        pass.setVertexBuffer(0, p.pos._gpuBuffer);
        pass.setVertexBuffer(1, p.colors._gpuBuffer);

        const firstVertex = p.offset || 0;
        pass.draw(p.count, 1, firstVertex, 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.5. DRAW POLYGONS FOR PICKING (ID COLOR)
// ─────────────────────────────────────────────────────────────────────────────

const PICK_WGSL = /* wgsl */`
struct Uniforms {
    uOpacity      : f32,
    uThickness    : f32,
    uTranslate    : vec2f,
    uScale        : f32,
    uIsOrtho      : f32,
    uResolution   : vec2f,
    uRotate       : vec2f,
    uSinCosRota   : vec4f, 
    uColor        : vec3f,
    _pad1         : f32,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct VIn {
    @location(0) aPos : vec2f,
    @location(1) aPickColor : vec3f,
};
struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) vPickColor : vec3f,
    @location(1) vZ        : f32,
};

const PI = 3.14159265358979323846f;

@vertex fn vs(i: VIn) -> VOut {
    var o: VOut;
    o.vPickColor = i.aPickColor;
    let center = u.uResolution / 2.0;

    if (u.uIsOrtho > 0.5) {
        let lon = i.aPos.x * PI/180.0; let lat = i.aPos.y * PI/180.0;
        let sLon = sin(lon); let cLon = cos(lon);
        let sLat = sin(lat); let cLat = cos(lat);
        let rS = u.uSinCosRota.x; let rC = u.uSinCosRota.y;
        let rSL = u.uSinCosRota.z; let rCL = u.uSinCosRota.w;

        let xr = cLat * (sLon * rC - cLon * rS);
        let yr = rCL * sLat - rSL * cLat * (cLon * rC + sLon * rS);
        let zr = rSL * sLat + rCL * cLat * (cLon * rC + sLon * rS);

        let pxO = vec2f(120.0*xr, -120.0*yr) * u.uScale + u.uTranslate + center;
        var clipO = (pxO / u.uResolution) * 2.0 - 1.0; clipO.y = -clipO.y;
        o.pos = vec4f(clipO, 0.0, 1.0);
        o.vZ = zr;
    } else {
        let px = i.aPos * u.uScale + u.uTranslate + center;
        var clip = (px / u.uResolution) * 2.0 - 1.0; clip.y = -clip.y;
        o.pos = vec4f(clip, 0.0, 1.0);
        o.vZ = 1.0;
    }
    return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
    if (u.uIsOrtho > 0.5 && i.vZ < 0.0) { discard; }
    return vec4f(i.vPickColor, 1.0);
}
`;

let pickPipeline = null;
let pickBG_Uniforms = null;
const pickUniformBuf = new Float32Array(20);

function ensurePickPipeline() {
    if (pickPipeline) return;
    ensureRingBuffer();
    const mod = makeShader('pick_poly', PICK_WGSL);
    const bgl = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 } }],
    });
    pickBG_Uniforms = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: uniformRingBuffer, size: 80 } }] });
    pickPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: {
            module: mod, entryPoint: 'vs', buffers: [
                { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
                { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] }
            ]
        },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] },
        primitive: { topology: 'triangle-list' },
    });
}

export function drawPickingPolygons(pass, items) {
    if (!items || items.length === 0) return;
    ensurePickPipeline();
    pass.setPipeline(pickPipeline);
    for (const p of items) {
        if (!p.pos || p.count <= 0 || !p.isAtlas) continue;
        pickUniformBuf[2] = p.uTranslate[0]; pickUniformBuf[3] = p.uTranslate[1];
        pickUniformBuf[4] = p.uScale;
        pickUniformBuf[6] = p.uResolution[0]; pickUniformBuf[7] = p.uResolution[1];
        pickUniformBuf[8] = p.uRotate[0]; pickUniformBuf[9] = p.uRotate[1];
        pickUniformBuf[10] = p.uIsOrtho ? 1.0 : 0.0;
        if (p.uSinCosRota) {
            pickUniformBuf[12] = p.uSinCosRota[0]; pickUniformBuf[13] = p.uSinCosRota[1];
            pickUniformBuf[14] = p.uSinCosRota[2]; pickUniformBuf[15] = p.uSinCosRota[3];
        }
        const dynOffset = allocSlot(pickUniformBuf);
        pass.setBindGroup(0, pickBG_Uniforms, [dynOffset]);
        pass.setVertexBuffer(0, p.pos._gpuBuffer);
        pass.setVertexBuffer(1, p.pickColors._gpuBuffer);
        pass.draw(p.count);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DRAW THICK LINES
// ─────────────────────────────────────────────────────────────────────────────

const LINE_WGSL = /* wgsl */`
struct Uniforms {
    uOpacity   : f32,
    uThickness : f32,
    uTranslate : vec2f,
    uScale     : f32,
    uIsOrtho   : f32,
    uResolution: vec2f,
    uRotate    : vec2f,
    uSinCosRota: vec4f,
    uColor     : vec3f,
    _pad2      : f32,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VIn {
    @location(0) aPos  : vec2f,
    @location(1) aPrev : vec2f,
    @location(2) aNext : vec2f,
    @location(3) aSide : f32,
    @location(4) aColor: vec3f,
};
struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) vColor    : vec3f,
    @location(1) vZ        : f32,
};

const PI = 3.14159265358979323846f;

fn projectGlobe(ll: vec2f, center: vec2f) -> vec3f {
    let lon = ll.x*PI/180.0; let lat = ll.y*PI/180.0;
    let sLon = sin(lon); let cLon = cos(lon);
    let sLat = sin(lat); let cLat = cos(lat);
    let rS = u.uSinCosRota.x; let rC = u.uSinCosRota.y;
    let rSL = u.uSinCosRota.z; let rCL = u.uSinCosRota.w;

    let x = cLat * (sLon * rC - cLon * rS);
    let y = rCL * sLat - rSL * cLat * (cLon * rC + sLon * rS);
    let z = rSL * sLat + rCL * cLat * (cLon * rC + sLon * rS);
    
    return vec3f(vec2f(120.0*x, -120.0*y)*u.uScale + u.uTranslate + center, z);
}

@vertex fn vs(i: VIn) -> VOut {
    var o: VOut;
    o.vColor = i.aColor;
    let center = u.uResolution / 2.0;
    var p: vec3f; var pr: vec3f; var nx: vec3f;

    if (u.uIsOrtho > 0.5) {
        p = projectGlobe(i.aPos, center);
        pr = projectGlobe(i.aPrev, center);
        nx = projectGlobe(i.aNext, center);
    } else {
        p = vec3f(i.aPos * u.uScale + u.uTranslate + center, 1.0);
        pr = vec3f(i.aPrev * u.uScale + u.uTranslate + center, 1.0);
        nx = vec3f(i.aNext * u.uScale + u.uTranslate + center, 1.0);
    }

    let d1 = p.xy - pr.xy; let d2 = nx.xy - p.xy;
    var dir1 = vec2f(1,0); var dir2 = vec2f(1,0);
    if(length(d1)>0.001){ dir1=normalize(d1); }
    if(length(d2)>0.001){ dir2=normalize(d2); }
    if(length(d1)<=0.001){ dir1=dir2; } if(length(d2)<=0.001){ dir2=dir1; }
    let ds = dir1 + dir2;
    var miterDir = dir1; if(length(ds)>0.001){ miterDir=normalize(ds); }
    let normal = vec2f(-miterDir.y, miterDir.x);
    let lineN = vec2f(-dir1.y, dir1.x);
    let miterDot = dot(normal, lineN);
    var miterLen = u.uThickness / max(miterDot, 0.1);
    miterLen = min(miterLen, u.uThickness * 4.0);
    let offset = normal * i.aSide * (miterLen / 2.0);
    var clip = ((p.xy + offset) / u.uResolution) * 2.0 - 1.0; clip.y = -clip.y;
    o.pos = vec4f(clip, 0.0, 1.0); o.vZ = p.z;
    return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
    if (u.uIsOrtho > 0.5 && i.vZ < 0.0) { discard; }
    return vec4f(i.vColor, u.uOpacity);
}
`;

const LINE_VB_LAYOUTS = [
    {
        arrayStride: 7 * 4,
        attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32x2' },
            { shaderLocation: 3, offset: 24, format: 'float32' },
        ],
    },
    {
        arrayStride: 12,
        attributes: [
            { shaderLocation: 4, offset: 0, format: 'float32x3' }
        ]
    }
];

let linePipeline = null;
let lineBG_Uniforms = null;
const lineUniformBuf = new Float32Array(20);

function ensureLinePipeline() {
    if (linePipeline) return;
    ensureRingBuffer();
    const mod = makeShader('line', LINE_WGSL);
    const bgl = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 } }],
    });
    lineBG_Uniforms = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: uniformRingBuffer, size: 80 } }] });
    linePipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module: mod, entryPoint: 'vs', buffers: LINE_VB_LAYOUTS },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: presentationFormat, blend: BLEND_OVER }] },
        primitive: { topology: 'triangle-list' },
    });
}

export function drawThickLines(pass, items, overrideColor) {
    if (!items || items.length === 0) return;
    ensureLinePipeline();
    pass.setPipeline(linePipeline);
    for (const p of items) {
        if (!p.lineVertexBuffer || !p.elements) continue;
        const finalColor = overrideColor || p.uColor || [1, 1, 1];
        lineUniformBuf[0] = p.uOpacity || 1.0; lineUniformBuf[1] = p.uThickness;
        lineUniformBuf[2] = p.uTranslate[0]; lineUniformBuf[3] = p.uTranslate[1];
        lineUniformBuf[4] = p.uScale; lineUniformBuf[5] = p.uIsOrtho ? 1.0 : 0.0;
        lineUniformBuf[6] = p.uResolution[0]; lineUniformBuf[7] = p.uResolution[1];
        lineUniformBuf[8] = p.uRotate[0]; lineUniformBuf[9] = p.uRotate[1];
        if (p.uSinCosRota) {
            lineUniformBuf[12] = p.uSinCosRota[0]; lineUniformBuf[13] = p.uSinCosRota[1];
            lineUniformBuf[14] = p.uSinCosRota[2]; lineUniformBuf[15] = p.uSinCosRota[3];
        }
        lineUniformBuf[16] = finalColor[0]; lineUniformBuf[17] = finalColor[1]; lineUniformBuf[18] = finalColor[2];
        const dynOffset = allocSlot(lineUniformBuf);
        pass.setBindGroup(0, lineBG_Uniforms, [dynOffset]);
        pass.setVertexBuffer(0, p.lineVertexBuffer._gpuBuffer);
        pass.setVertexBuffer(1, p.lineColors._gpuBuffer);
        pass.setIndexBuffer(p.elements._gpuBuffer, 'uint32');
        pass.drawIndexed(p.elements._indexCount);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. DRAW GLOBE BACKGROUND & THICK CIRCLE
// ─────────────────────────────────────────────────────────────────────────────

const CIRCLE_WGSL = /* wgsl */`
struct Uniforms {
    uRadius     : f32, uThickness : f32,
    uCenter     : vec2f,
    uResolution : vec2f,
    uOpacity    : f32, 
    _pad        : f32,
    uColor      : vec3f,
    _pad2       : f32,
};
@group(0) @binding(0) var<uniform> u : Uniforms;
struct VIn { @location(0) pA: vec2f, @location(1) pB: vec2f, @location(2) aDir: f32 };
@vertex fn vs(i: VIn) -> @builtin(position) vec4f {
    let pA = u.uCenter + i.pA * u.uRadius;
    let pB = u.uCenter + i.pB * u.uRadius;
    let normal = vec2f(-(pB.y-pA.y), pB.x-pA.x);
    let fp = pA + normalize(normal) * i.aDir * (u.uThickness / 2.0);
    var clip = (fp / u.uResolution) * 2.0 - 1.0; clip.y = -clip.y;
    return vec4f(clip, 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(u.uColor, u.uOpacity); }
`;

let circlePipeline = null;
let circleBG_Uniforms = null;
const circleUniformBuf = new Float32Array(12);

export function drawThickCircle(pass, p) {
    if (!p.circleVertexBuffer) return;
    ensureRingBuffer();
    if (!circlePipeline) {
        const mod = makeShader('circle', CIRCLE_WGSL);
        const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } }] });
        circleBG_Uniforms = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: uniformRingBuffer, size: 48 } }] });
        circlePipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }, { shaderLocation: 2, offset: 16, format: 'float32' }] }] },
            fragment: { module: mod, entryPoint: 'fs', targets: [{ format: presentationFormat, blend: BLEND_OVER }] },
        });
    }
    circleUniformBuf[0] = p.uRadius; circleUniformBuf[1] = p.uThickness;
    circleUniformBuf[2] = p.uCenter[0]; circleUniformBuf[3] = p.uCenter[1];
    circleUniformBuf[4] = p.uResolution[0]; circleUniformBuf[5] = p.uResolution[1];
    circleUniformBuf[6] = p.uOpacity;
    circleUniformBuf[8] = p.uColor[0]; circleUniformBuf[9] = p.uColor[1]; circleUniformBuf[10] = p.uColor[2];
    const dynOffset = allocSlot(circleUniformBuf);
    pass.setPipeline(circlePipeline);
    pass.setBindGroup(0, circleBG_Uniforms, [dynOffset]);
    pass.setVertexBuffer(0, p.circleVertexBuffer._gpuBuffer);
    pass.draw(p.count);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. DRAW TEXT
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_WGSL = /* wgsl */`
struct Uniforms {
    uOpacity      : f32, 
    uScale        : f32,
    uTranslate    : vec2f,
    uResolution   : vec2f,
    uRotate       : vec2f, 
    uAnchor       : vec2f,
    uIsOrtho      : f32, 
    uSize         : f32,
    uAtlasSize    : vec2f,
    uSinCosRota   : vec4f,
    uColor        : vec3f,
    uHaloThick    : f32,
    uHaloColor    : vec3f, 
    _pad          : f32,
};
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(1) @binding(0) var uSampler: sampler;
@group(1) @binding(1) var uTexture: texture_2d<f32>;

struct VIn { @location(0) pos: vec2f, @location(1) uv: vec2f };
struct VOut { @builtin(position) pos : vec4f, @location(0) vUV: vec2f, @location(1) vZ: f32 };

const PI = 3.14159265358979323846f;

@vertex fn vs(i: VIn) -> VOut {
    var o: VOut; o.vUV = i.uv;
    let center = u.uResolution / 2.0;
    var anc: vec3f;
    if (u.uIsOrtho > 0.5) {
        let lon = u.uAnchor.x*PI/180.0; let lat = u.uAnchor.y*PI/180.0;
        let sLon = sin(lon); let cLon = cos(lon);
        let sLat = sin(lat); let cLat = cos(lat);
        let rS = u.uSinCosRota.x; let rC = u.uSinCosRota.y;
        let rSL = u.uSinCosRota.z; let rCL = u.uSinCosRota.w;

        let x = cLat * (sLon * rC - cLon * rS);
        let y = rCL * sLat - rSL * cLat * (cLon * rC + sLon * rS);
        let z = rSL * sLat + rCL * cLat * (cLon * rC + sLon * rS);
        
        anc = vec3f(vec2f(120.0*x, -120.0*y)*u.uScale + u.uTranslate + center, z);
    } else {
        anc = vec3f(u.uAnchor * u.uScale + u.uTranslate + center, 1.0);
    }
    let fp = anc.xy + i.pos * u.uSize * u.uScale;
    var clip = (fp / u.uResolution) * 2.0 - 1.0; clip.y = -clip.y;
    o.pos = vec4f(clip, 0, 1); o.vZ = anc.z;
    return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
    if (u.uIsOrtho > 0.5 && i.vZ < 0.0) { discard; }
    let alpha = textureSample(uTexture, uSampler, i.vUV).a;
    let d = vec2f(u.uHaloThick/u.uAtlasSize.x, u.uHaloThick/u.uAtlasSize.y);
    var hA=0.0;
    hA+=textureSample(uTexture, uSampler, i.vUV+vec2f(d.x,0)).a; hA+=textureSample(uTexture, uSampler, i.vUV-vec2f(d.x,0)).a;
    hA+=textureSample(uTexture, uSampler, i.vUV+vec2f(0,d.y)).a; hA+=textureSample(uTexture, uSampler, i.vUV-vec2f(0,d.y)).a;
    let sA=smoothstep(0.45,0.55,alpha); let sH=smoothstep(0.45,0.55,hA);
    if(sA<0.01 && sH<0.01){ discard; }
    return vec4f(mix(u.uHaloColor, u.uColor, sA), max(sA,sH)*u.uOpacity);
}
`;

let textPipeline = null;
let textBG_Uniforms = null;
const textUniformBuf = new Float32Array(36);

export function drawTextFull(pass, items) {
    if (!items || items.length === 0) return;
    ensureRingBuffer();
    if (!textPipeline) {
        const mod = makeShader('text', TEXT_WGSL);
        const bglU = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 144 } }] });
        const bglT = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
        textBG_Uniforms = device.createBindGroup({ layout: bglU, entries: [{ binding: 0, resource: { buffer: uniformRingBuffer, size: 144 } }] });
        textPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bglU, bglT] }),
            vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }, { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] }] },
            fragment: { module: mod, entryPoint: 'fs', targets: [{ format: presentationFormat, blend: BLEND_OVER }] },
        });
    }
    pass.setPipeline(textPipeline);
    for (const p of items) {
        textUniformBuf[0] = p.uOpacity; textUniformBuf[1] = p.uScale;
        textUniformBuf[2] = p.uTranslate[0]; textUniformBuf[3] = p.uTranslate[1];
        textUniformBuf[4] = p.uResolution[0]; textUniformBuf[5] = p.uResolution[1];
        textUniformBuf[6] = p.uRotate[0]; textUniformBuf[7] = p.uRotate[1];
        textUniformBuf[8] = p.uAnchor[0]; textUniformBuf[9] = p.uAnchor[1];
        textUniformBuf[10] = p.uIsOrtho ? 1.0 : 0.0; textUniformBuf[11] = p.uSize;
        textUniformBuf[16] = p.uSinCosRota ? p.uSinCosRota[0] : 0;
        textUniformBuf[17] = p.uSinCosRota ? p.uSinCosRota[1] : 1;
        textUniformBuf[18] = p.uSinCosRota ? p.uSinCosRota[2] : 0;
        textUniformBuf[19] = p.uSinCosRota ? p.uSinCosRota[3] : 1;

        textUniformBuf[20] = p.uColor[0]; textUniformBuf[21] = p.uColor[1]; textUniformBuf[22] = p.uColor[2];
        textUniformBuf[23] = p.uHaloThick;
        textUniformBuf[24] = p.uHaloColor[0]; textUniformBuf[25] = p.uHaloColor[1]; textUniformBuf[26] = p.uHaloColor[2];

        const dynOffset = allocSlot(textUniformBuf);
        const bgT = device.createBindGroup({ layout: textPipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: p.uFontAtlas._gpuSampler }, { binding: 1, resource: p.uFontAtlas._gpuView }] });
        pass.setBindGroup(0, textBG_Uniforms, [dynOffset]); pass.setBindGroup(1, bgT);
        pass.setVertexBuffer(0, p.uPositions._gpuBuffer); pass.setVertexBuffer(1, p.uUvs._gpuBuffer);
        pass.draw(p.count);
    }
}

// ─── FAST THICK LINES (Lignes avec normales pré-calculées sur CPU) ──────────
const FAST_LINE_WGSL = /* wgsl */`
struct Uniforms {
    uOpacity      : f32,
    uThickness    : f32,
    uTranslate    : vec2f,
    uScale        : f32,
    uIsOrtho      : f32,
    uResolution   : vec2f,
    uRotate       : vec2f,
    uSinCosRota   : vec4f,
    uColor        : vec3f,
    _pad1         : f32,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) vZ        : f32,
};

const PI = 3.1415926535f;

fn project(p: vec2f) -> vec3f {
    let center = u.uResolution / 2.0;
    if (u.uIsOrtho > 0.5) {
        let lon = p.x * PI / 180.0;
        let lat = p.y * PI / 180.0;
        let sLon = sin(lon); let cLon = cos(lon);
        let sLat = sin(lat); let cLat = cos(lat);
        let rS = u.uSinCosRota.x; let rC = u.uSinCosRota.y;
        let rSL = u.uSinCosRota.z; let rCL = u.uSinCosRota.w;

        let x = cLat * (sLon * rC - cLon * rS);
        let yr = rCL * sLat - rSL * cLat * (cLon * rC + sLon * rS);
        let zr = rSL * sLat + rCL * cLat * (cLon * rC + sLon * rS);

        let pxO = vec2f(x * 120.0, -yr * 120.0) * u.uScale + u.uTranslate + center;
        return vec3f(pxO, zr);
    } else {
        return vec3f(p * u.uScale + u.uTranslate + center, 1.0);
    }
}

@vertex fn vs(
    @location(0) aPos  : vec2f,
    @location(1) aPrev : vec2f,
    @location(2) aNext : vec2f,
    @location(3) aSide : f32
) -> VOut {
    var o: VOut;
    let pos  = project(aPos);
    let prev = project(aPrev);
    let next = project(aNext);

    let d1 = pos.xy - prev.xy;
    let d2 = next.xy - pos.xy;
    
    var dir1 = vec2f(0.0);
    var dir2 = vec2f(0.0);
    
    if (length(d1) > 0.0001) { dir1 = normalize(d1); }
    if (length(d2) > 0.0001) { dir2 = normalize(d2); }
    
    if (length(d1) <= 0.0001) { dir1 = dir2; }
    if (length(d2) <= 0.0001) { dir2 = dir1; }

    let ds = dir1 + dir2;
    var miterDir = vec2f(-dir1.y, dir1.x); // Fallback: simple normal
    if (length(ds) > 0.0001) {
        miterDir = normalize(ds);
    }

    let normal = vec2f(-miterDir.y, miterDir.x);
    let lineNormal = vec2f(-dir1.y, dir1.x);
    let miterDot = dot(normal, lineNormal);
    
    // Facteur d'extension (1/cos) avec limite de miter
    var miterLen = u.uThickness / max(abs(miterDot), 0.1);
    miterLen = min(miterLen, u.uThickness * 4.0);

    let finalPos = pos.xy + normal * aSide * (miterLen / 2.0);
    var clip = (finalPos / u.uResolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    o.pos = vec4f(clip, 0.0, 1.0);
    o.vZ = pos.z;
    return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
    if (u.uIsOrtho > 0.5 && i.vZ < 0.0) { discard; }
    return vec4f(u.uColor, u.uOpacity);
}
`;

let fastLinePipeline = null;
function ensureFastLinePipeline() {
    if (!fastLinePipeline) {
        ensureUniformBGL();
        fastLinePipeline = device.createRenderPipeline({
            label: 'fast line pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [uniformBGL] }),
            vertex: {
                module: device.createShaderModule({ code: FAST_LINE_WGSL }),
                entryPoint: 'vs',
                buffers: [{
                    arrayStride: 28, // p(8) + pr(8) + nx(8) + side(4)
                    attributes: [
                        { format: 'float32x2', offset: 0, shaderLocation: 0 }, // aPos
                        { format: 'float32x2', offset: 8, shaderLocation: 1 }, // aPrev
                        { format: 'float32x2', offset: 16, shaderLocation: 2 }, // aNext
                        { format: 'float32', offset: 24, shaderLocation: 3 }, // aSide
                    ]
                }]
            },
            fragment: {
                module: device.createShaderModule({ code: FAST_LINE_WGSL }),
                entryPoint: 'fs',
                targets: [{
                    format: presentationFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
                    }
                }]
            },
            primitive: { topology: 'triangle-list' }
        });
    }
}

export function drawFastLines(pass, lineItems, overrideColor) {
    if (lineItems.length === 0) return;
    ensureFastLinePipeline();
    pass.setPipeline(fastLinePipeline);

    for (const p of lineItems) {
        const uBuf = new Float32Array(20);
        uBuf[0] = p.uOpacity ?? 1.0;
        uBuf[1] = p.uThickness ?? 1.0;
        uBuf[2] = p.uTranslate[0]; uBuf[3] = p.uTranslate[1];
        uBuf[4] = p.uScale;
        uBuf[5] = p.uIsOrtho ? 1.0 : 0.0;
        uBuf[6] = p.uResolution[0]; uBuf[7] = p.uResolution[1];
        uBuf[8] = (p.uRotate ? p.uRotate[0] : 0); uBuf[9] = (p.uRotate ? p.uRotate[1] : 0);

        if (p.uSinCosRota) {
            uBuf[12] = p.uSinCosRota[0]; uBuf[13] = p.uSinCosRota[1];
            uBuf[14] = p.uSinCosRota[2]; uBuf[15] = p.uSinCosRota[3];
        }

        const col = overrideColor || p.uColor || [1, 1, 1];
        uBuf[16] = col[0]; uBuf[17] = col[1]; uBuf[18] = col[2];

        const dynOffset = allocSlot(uBuf);
        pass.setBindGroup(0, polyBG_Uniforms, [dynOffset]);
        pass.setVertexBuffer(0, p.lineVertexBuffer._gpuBuffer);

        if (p.elements) {
            pass.setIndexBuffer(p.elements._gpuBuffer, 'uint32');
            pass.drawIndexed(p.elements._indexCount);
        } else {
            pass.draw(p.count);
        }
    }
}
