import { initGPU, width, height, gpuCanvas as webglCanvas, updateSize } from './core/gpuContext.js';
import { zoomState, initCamera, setRedrawCallback, setRebuildCallback, setProjection, isOrthographic } from './core/camera.js';
import { parseHexColor } from './math/geoUtils.js';
import { createFontAtlas } from './render/fontAtlas.js';

import { appState } from './state/appState.js';
import { mapState } from './state/mapState.js';
import { Sidebar } from './ui/Sidebar.js';
import { setupInteractions } from './core/interactions.js';
import { createRenderer } from './render/mapRenderer.js';
import { setupDataLoaders } from './data/dataLoaders.js';
import { getProvider } from './providers.js';

async function startApp() {
  try { await initGPU(); } catch (err) {
    console.error(err);
    document.body.innerHTML = `<div style="color:red;padding:20px;">${err.message}</div>`;
    return;
  }

  const fontAtlas = createFontAtlas(null, { fontSize: 48, fontFamily: 'Inter, sans-serif', fontWeight: '700' });
  appState.initFromUrl();
  const sidebar = new Sidebar();
  const currentProvider = getProvider();

  const redraw = createRenderer({
    getRenderList: () => mapState.renderList,
    getLoadedRegions: () => mapState.loadedRegions,
    getExclusiveFocusMode: () => mapState.exclusiveFocusMode,
    getGraticuleRenderData: () => mapState.graticuleRenderData,
    getBgRenderData: () => mapState.bgRenderData,
    getOutlineHorizontalData: () => mapState.outlineHorizontalData,
    getOutlineVerticalData: () => mapState.outlineVerticalData,
    getTextRenderList: () => mapState.textRenderList,
    fontAtlas
  });

  const loaders = setupDataLoaders({
    fontAtlas,
    getCurrentProvider: () => currentProvider,
    mapState,
    redraw
  });

  appState.subscribe((state, key, value) => {
    switch (key) {
      case 'projection': setProjection(value); break;
      case 'countrySaturation':
      case 'countryLightness':
      case 'mapBackgroundColor':
          loaders.loadGlobalData();
          break;
    }
    redraw();
  });

  setupInteractions({
    updateSize,
    redraw
  });

  setRedrawCallback(redraw);
  setRebuildCallback(() => loaders.loadGlobalData());
  initCamera();
  
  // Premier chargement
  setProjection(appState.get('projection'));
}

startApp();
