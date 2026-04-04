/**
 * fontAtlas.js — Génère un atlas de police sur canvas 2D
 * et l'uploade en GPUTexture via gpu.texture().
 */
import { texture } from './gpu.js';

export function createFontAtlas(_unused, options = {}) {
    const {
        fontSize   = 96,
        fontFamily = 'Arial',
        fontWeight = '600',
        characters = ' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\u00E0\u00E2\u00E9\u00E8\u00EA\u00EB\u00EE\u00EF\u00F4\u00FB\u00F9\u00E7\u00C0\u00C2\u00C9\u00C8\u00CA\u00CB\u00CE\u00CF\u00D4\u00DB\u00D9\u00C7-.,\'()',
        padding    = 4
    } = options;

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    const font   = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.font = font;

    const metrics   = {};
    let   totalWidth = 0;
    const rowHeight  = Math.ceil(fontSize * 1.4) + padding * 2;

    for (const char of characters) {
        const m = ctx.measureText(char);
        const w = Math.ceil(m.width) + padding * 2;
        metrics[char] = { width: w, height: rowHeight, advance: m.width };
        totalWidth += w;
    }

    const area    = totalWidth * rowHeight;
    const texSize = Math.pow(2, Math.ceil(Math.log2(Math.sqrt(area * 1.8))));
    canvas.width  = texSize;
    canvas.height = texSize;

    ctx.font          = font;
    ctx.fillStyle     = 'white';
    ctx.textBaseline  = 'alphabetic';
    ctx.textAlign     = 'left';
    ctx.clearRect(0, 0, texSize, texSize);

    let x = 0, y = 0;
    const baselineOffset = Math.ceil(fontSize * 1.0) + padding;

    for (const char of characters) {
        const m = metrics[char];
        if (x + m.width > texSize) { x = 0; y += rowHeight + 8; }
        ctx.fillText(char, x + padding, y + baselineOffset);
        m.u0 = (x + 0.5) / texSize;  m.v0 = (y + 0.5) / texSize;
        m.u1 = (x + m.width - 0.5) / texSize;  m.v1 = (y + rowHeight - 0.5) / texSize;
        x += m.width;
    }

    // Upload vers GPUTexture
    const gpuTex = texture({ data: canvas, mag: 'linear', min: 'linear' });

    return {
        texture: gpuTex,   // objet gpu.texture() — exposé comme antes
        metrics,
        fontSize,
        texSize
    };
}
