/**
 * gpu.js — Mini-wrapper WebGPU remplaçant l'API regl.
 * Expose buffer(), elements(), texture() avec une interface proche de regl.
 */
import { device } from '../core/gpuContext.js';

// ---------- helpers ----------

function toFloat32(data) {
    if (data instanceof Float32Array) return data;
    if (Array.isArray(data)) {
        const flat = [];
        for (const v of data) {
            if (Array.isArray(v) || ArrayBuffer.isView(v)) { for (const x of v) flat.push(x); }
            else flat.push(v);
        }
        return new Float32Array(flat);
    }
    return new Float32Array(data);
}

function toUint32(data) {
    if (data instanceof Uint32Array) return data;
    if (Array.isArray(data)) return new Uint32Array(data);
    return new Uint32Array(data);
}

function alignTo(n, alignment) {
    return Math.ceil(n / alignment) * alignment;
}

// ---------- buffer() — vertex buffer ----------

export function buffer(data) {
    const arr = toFloat32(data);
    const byteLen = Math.max(arr.byteLength, 16);
    const size = alignTo(byteLen, 4);

    let gpuBuf = device.createBuffer({
        size,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (arr.byteLength > 0) device.queue.writeBuffer(gpuBuf, 0, arr);

    // L'objet retourné est callable (compatibilité regl): buf({ data: newData })
    const fn = function (opts) {
        if (opts && opts.data !== undefined) {
            const newArr = toFloat32(opts.data);
            const newSize = alignTo(Math.max(newArr.byteLength, 16), 4);
            if (newSize > gpuBuf.size) {
                gpuBuf.destroy();
                gpuBuf = device.createBuffer({
                    size: newSize,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }
            if (newArr.byteLength > 0) device.queue.writeBuffer(gpuBuf, 0, newArr);
        }
        return fn;
    };

    Object.defineProperty(fn, '_gpuBuffer', { get: () => gpuBuf, enumerable: true });
    fn._isVertexBuffer = true;
    fn.destroy = () => { try { gpuBuf.destroy(); } catch(_) {} };
    return fn;
}

// ---------- elements() — index buffer ----------

export function elements(opts) {
    const raw = (opts && opts.data) ? opts.data : opts;
    const arr = toUint32(raw);
    const size = alignTo(Math.max(arr.byteLength, 4), 4);

    const gpuBuf = device.createBuffer({
        size,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    if (arr.byteLength > 0) device.queue.writeBuffer(gpuBuf, 0, arr);

    const fn = function () { return fn; };
    Object.defineProperty(fn, '_gpuBuffer', { get: () => gpuBuf, enumerable: true });
    fn._isIndexBuffer = true;
    fn._indexCount = arr.length;
    fn.destroy = () => { try { gpuBuf.destroy(); } catch(_) {} };
    return fn;
}

// ---------- texture() — GPUTexture wrapper ----------

export function texture(opts = {}) {
    let gpuTex = null;
    let gpuView = null;
    let sampler = null;

    function makeSampler(mag = 'linear', min = 'linear') {
        return device.createSampler({
            magFilter: mag, minFilter: min,
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
        });
    }

    function makeDefault1x1(r = 0, g = 0, b = 0, a = 255) {
        gpuTex = device.createTexture({
            size: [1, 1, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: gpuTex }, new Uint8Array([r, g, b, a]),
            { bytesPerRow: 4 }, [1, 1]);
        gpuView = gpuTex.createView();
        if (!sampler) sampler = makeSampler();
    }

    function upload(source, magF = 'linear', minF = 'linear') {
        const w = source.width || source.naturalWidth;
        const h = source.height || source.naturalHeight;
        if (!w || !h) return;
        if (gpuTex) gpuTex.destroy();
        gpuTex = device.createTexture({
            size: [w, h, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture({ source }, { texture: gpuTex }, [w, h]);
        gpuView = gpuTex.createView();
        sampler = makeSampler(magF, minF);
    }

    if (opts.data) {
        upload(opts.data, opts.mag, opts.min);
    } else {
        makeDefault1x1();
    }

    const fn = function (newOpts) {
        if (newOpts && newOpts.data) {
            upload(newOpts.data, newOpts.mag, newOpts.min);
        }
        return fn;
    };

    Object.defineProperty(fn, '_gpuTexture', { get: () => gpuTex, enumerable: true });
    Object.defineProperty(fn, '_gpuView',    { get: () => gpuView, enumerable: true });
    Object.defineProperty(fn, '_gpuSampler', { get: () => sampler, enumerable: true });
    fn._isTexture = true;
    fn.destroy = () => { try { if (gpuTex) gpuTex.destroy(); } catch(_) {} };
    return fn;
}
