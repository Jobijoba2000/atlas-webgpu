export let width = window.innerWidth;
export let height = window.innerHeight;

// Canvas WebGPU (renommé dans index.html)
export const gpuCanvas = document.getElementById('webgpu-layer');
// Alias pour compatibilité avec camera.js / interactions.js
export const webglCanvas = gpuCanvas;
gpuCanvas.width = width;
gpuCanvas.height = height;

export const textCanvas = document.getElementById('text-layer');
textCanvas.width = width;
textCanvas.height = height;
export const textContext = textCanvas.getContext('2d');

export const loadingDiv = document.getElementById('loading');

// Ces exports sont des bindings vivants — ils seront mis à jour après initGPU()
export let device = null;
export let gpuContext = null;
export let presentationFormat = null;

export async function initGPU() {
    if (!navigator.gpu) {
        throw new Error('WebGPU non supporté. Utilisez Chrome 113+ ou Edge 113+.');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Aucun adaptateur WebGPU trouvé.');

    device = await adapter.requestDevice({ label: 'WorldMap GPU Device' });
    device.lost.then(info => console.error(`GPU perdu: ${info.message}`));

    gpuContext = gpuCanvas.getContext('webgpu');
    presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    gpuContext.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

    console.log('[WebGPU] Initialisé.');
    return device;
}

export function updateSize() {
    width = window.innerWidth;
    height = window.innerHeight;
    gpuCanvas.width = width;
    gpuCanvas.height = height;
    textCanvas.width = width;
    textCanvas.height = height;
    if (gpuContext && device) {
        gpuContext.configure({ device, format: presentationFormat, alphaMode: 'opaque' });
    }
}
