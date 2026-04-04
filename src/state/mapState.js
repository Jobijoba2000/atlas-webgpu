// src/state/mapState.js

export const mapState = {
    // Listes de rendu WebGL
    renderList: [],
    textLabels: [],
    textRenderList: [],

    // Données de fond de carte et graticules
    bgRenderData: null,
    graticuleRenderData: null,
    outlineHorizontalData: null,
    outlineVerticalData: null,

    // État des régions
    loadedRegions: new Set(),
    exclusiveFocusMode: false,
    statesProcessed: false,

    // Features globales (utilisé pour rebuildGeometry)
    globalFeatures: [],

    // Mapping pour le picking WebGPU
    pickIdToIso: new Map(),
    isoToPickId: new Map(),
    nextPickId: 1
};
