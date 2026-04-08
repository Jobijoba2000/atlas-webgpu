import { width, height, gpuContext, device } from '../core/gpuContext.js';
import { zoomState, isOrthographic, orthoRotate } from '../core/camera.js';
import { drawPolygons, drawFastLines, drawTextFull, drawThickCircle, resetUniformRing, drawPickingPolygons } from './shaders.js';
import { buffer as gpuBuffer } from './gpu.js';
import { appState } from '../state/appState.js';
import { mapState } from '../state/mapState.js';
import { parseHexColor, getProjectionTextScale } from '../math/geoUtils.js';

// ─── Circle geometry (globe outline) ─────────────────────────────────────────
function buildCircleData(n = 128) {
    const verts = [];
    for (let i = 0; i < n; i++) {
        const a1 = (i / n) * Math.PI * 2;
        const a2 = ((i + 1) / n) * Math.PI * 2;
        const p1 = [Math.cos(a1), Math.sin(a1)];
        const p2 = [Math.cos(a2), Math.sin(a2)];
        verts.push(...p1, ...p2, 1.0, 0, ...p1, ...p2, -1.0, 0, ...p2, ...p1, 1.0, 0);
        verts.push(...p2, ...p1, 1.0, 0, ...p2, ...p1, -1.0, 0, ...p1, ...p2, -1.0, 0);
    }
    return new Float32Array(verts);
}

export function createRenderer(deps) {
    const {
        getRenderList, getLoadedRegions, getExclusiveFocusMode,
        getGraticuleRenderData, getBgRenderData,
        getOutlineHorizontalData, getOutlineVerticalData,
        getTextRenderList, fontAtlas
    } = deps;

    const circleData = buildCircleData(128);
    const circleVertexBuffer = gpuBuffer(circleData);
    const circleCount = circleData.length / 6;

    let strokeColor = parseHexColor(appState.get('borderColor'));
    let gratColor = parseHexColor(appState.get('gratColor'));
    let gratOpacityParam = appState.get('gratOpacity');
    let graticulesEnabled = appState.get('graticulesEnabled');
    let labelColor = parseHexColor(appState.get('fontColor') || '#ffffff');
    let labelHaloColor = parseHexColor(appState.get('fontOutlineColor') || '#000000');
    let labelHaloThick = appState.get('fontOutlineWidth') || 2.0;

    let pickingTexture = null;
    let pickingReadBuffer = null;
    let pickingWidth = 0;
    let pickingHeight = 0;

    function ensurePickingResources() {
        if (width !== pickingWidth || height !== pickingHeight) {
            pickingWidth = width;
            pickingHeight = height;
            if (pickingTexture) pickingTexture.destroy();
            pickingTexture = device.createTexture({
                size: [width, height, 1],
                format: 'bgra8unorm',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
            });
            if (pickingReadBuffer) pickingReadBuffer.destroy();
            pickingReadBuffer = device.createBuffer({
                size: 4, // 4 bytes pour un pixel (BGRA)
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });
        }
    }

    appState.subscribe((_, key, value) => {
        switch (key) {
            case 'gratColor': gratColor = parseHexColor(value); break;
            case 'gratOpacity': gratOpacityParam = value; break;
            case 'borderColor': strokeColor = parseHexColor(value); break;
            case 'fontColor': labelColor = parseHexColor(value); break;
            case 'fontOutlineColor': labelHaloColor = parseHexColor(value); break;
            case 'fontOutlineWidth': labelHaloThick = value; break;
            case 'graticulesEnabled': graticulesEnabled = value; break;
        }
    });

    return {
        redraw: function redraw() {
            resetUniformRing();

            const uTranslate = [zoomState.x, zoomState.y];
            const uScale = zoomState.k;
            const outlineColor = parseHexColor(appState.get('outlineColor'));
            const dynamicThickness = 1.0 * Math.pow(Math.min(zoomState.k, 200000), 0.256);
            const gratThickness = 1.2 * Math.pow(Math.min(zoomState.k, 150), 0.23);

            const loadedRegions = getLoadedRegions();
            const isAnyLoaded = loadedRegions.size > 0;
            const exclusiveMode = getExclusiveFocusMode();
            const showStrokes = appState.get('showStrokes');
            const showLabels = appState.get('showLabels');
            const showColors = appState.get('showColors');

            const rLonRad = orthoRotate[0] * Math.PI / 180;
            const rLatRad = orthoRotate[1] * Math.PI / 180;
            const uSinCosRota = [
                Math.sin(rLonRad), Math.cos(rLonRad),
                Math.sin(rLatRad), Math.cos(rLatRad)
            ];

            const baseProps = {
                uTranslate, uScale,
                uResolution: [width, height],
                uRotate: orthoRotate,
                uSinCosRota,
                uIsOrtho: isOrthographic,
                uOpacity: 1.0
            };

            const bgTri = [], fgTri = [], bgLines = [], fgLines = [];

            // ACCÈS DIRECT AU BATCH GLOBAL (O(1))
            const atlasPolygons = mapState.atlasPolygons;
            const atlasLines = mapState.atlasLines;

            if (atlasPolygons) {
                const itemOpacity = exclusiveMode ? 0.4 : 1.0;
                bgTri.push({ ...baseProps, ...atlasPolygons, uOpacity: itemOpacity });
            }

            if (atlasLines && showStrokes) {
                const itemOpacity = exclusiveMode ? 0.2 : 1.0;
                bgLines.push({ ...baseProps, ...atlasLines, uOpacity: itemOpacity, uThickness: dynamicThickness, uColor: strokeColor });
            }

            // On n'ajoute en surbrillance (Foreground) QUE les régions réellement chargées/sélectionnées
            loadedRegions.forEach(iso => {
                const meta = mapState.featureMeta.get(iso);
                if (meta && atlasPolygons) {
                    fgTri.push({
                        ...baseProps,
                        pos: atlasPolygons.pos,
                        colors: atlasPolygons.colors,
                        count: meta.atlasCount,
                        offset: meta.atlasOffset,
                        uOpacity: 1.0,
                        forceDraw: true
                    });
                }
            });

            const graticuleData = getGraticuleRenderData();
            const bgRenderData = getBgRenderData();
            const outlineHorizontal = getOutlineHorizontalData();
            const outlineVertical = getOutlineVerticalData();

            const encoder = device.createCommandEncoder({ label: 'frame' });
            const view = gpuContext.getCurrentTexture().createView();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
            });

            const mkProps = (extra = {}) => ({ ...baseProps, ...extra });

            // ── Globe circle ──
            if (isOrthographic) {
                drawThickCircle(pass, mkProps({
                    circleVertexBuffer, count: circleCount,
                    uRadius: 120.0 * zoomState.k, uThickness: dynamicThickness * 2.0,
                    uCenter: [width / 2, height / 2],
                    uColor: outlineColor, uOpacity: 1.0
                }));
            }

            const drawElements = (triList, lineList, overrideColor) => {
                if (triList.length > 0 && showColors) drawPolygons(pass, triList);
                if (lineList.length > 0 && showStrokes) drawFastLines(pass, lineList, overrideColor);
            };

            if (bgRenderData && !isOrthographic && showColors) drawPolygons(pass, [mkProps(bgRenderData)]);
            if (graticulesEnabled && graticuleData) {
                drawThickLines(pass, [mkProps({ ...graticuleData, uThickness: gratThickness, uColor: gratColor, uOpacity: gratOpacityParam })]);
            }
            if (!isOrthographic) {
                if (outlineHorizontal) drawThickLines(pass, [mkProps({ ...outlineHorizontal, uThickness: dynamicThickness * 2.0, uColor: outlineColor, uOpacity: 1.0 })]);
                if (outlineVertical) drawThickLines(pass, [mkProps({ ...outlineVertical, uThickness: dynamicThickness * 2.0, uColor: outlineColor, uOpacity: 1.0 })]);
            }

            drawElements(bgTri, bgLines, null);
            drawElements(fgTri, fgLines, null);

            if (showLabels) {
                const textRenderList = getTextRenderList();
                const activeText = [];
                textRenderList.forEach(item => {
                    if (item.isRegion && !loadedRegions.has(item.parentIso)) return;
                    let labelOpacity = 1.0;
                    if (!item.isRegion && isAnyLoaded) {
                        const focused = loadedRegions.has(item.iso);
                        labelOpacity = exclusiveMode ? (focused ? 1.0 : 0.0) : (focused ? 0.2 : 0.4);
                    }
                    if (item.uPositions && item.count > 0) {
                        const projId = appState.get('projection');
                        const textScale = getProjectionTextScale(projId, isOrthographic, item.uAnchor);
                        activeText.push(mkProps({
                            uPositions: item.uPositions,
                            uUvs: item.uUvs,
                            uAnchor: item.uAnchor,
                            uAnchorLL: item.uAnchorLL,
                            uFontAtlas: fontAtlas.texture,
                            uColor: labelColor,
                            uHaloColor: labelHaloColor,
                            uHaloThick: labelHaloThick,
                            uAtlasSize: [fontAtlas.texSize, fontAtlas.texSize],
                            uSize: item.uSize * textScale,
                            uOpacity: labelOpacity,
                            count: item.count,
                        }));
                    }
                });
                if (activeText.length > 0) drawTextFull(pass, activeText);
            }

            pass.end();
            device.queue.submit([encoder.finish()]);
        },

        doPicking: async function doPicking(clientX, clientY) {
            ensurePickingResources();
            resetUniformRing();

            const x = Math.floor(clientX);
            const y = Math.floor(clientY);

            if (x < 0 || y < 0 || x >= pickingWidth || y >= pickingHeight) return null;

            const uTranslate = [zoomState.x, zoomState.y];
            const uScale = zoomState.k;

            const loadedRegions = getLoadedRegions();
            const fgTri = [], bgTri = [];

            getRenderList().forEach(item => {
                if (item.isAtlas) {
                    bgTri.push({
                        ...baseProps,
                        ...item,
                        uTranslate, uScale,
                        uResolution: [width, height],
                        uRotate: orthoRotate,
                        uSinCosRota: [
                            Math.sin(orthoRotate[0] * Math.PI / 180),
                            Math.cos(orthoRotate[0] * Math.PI / 180),
                            Math.sin(orthoRotate[1] * Math.PI / 180),
                            Math.cos(orthoRotate[1] * Math.PI / 180)
                        ],
                        uIsOrtho: isOrthographic
                    });
                }
            });

            const encoder = device.createCommandEncoder({ label: 'picking frame' });

            // On ne rend que dans un VIEWPORT 1x1 pour économiser les pixels
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: pickingTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
            });

            // Optimisation: utiliser setScissorRect ou juste rendre et copier 1 pixel

            drawPickingPolygons(pass, bgTri);
            drawPickingPolygons(pass, fgTri);

            pass.end();

            encoder.copyTextureToBuffer(
                { texture: pickingTexture, origin: [x, y, 0] },
                { buffer: pickingReadBuffer, bytesPerRow: 256 },
                [1, 1, 1]
            );

            device.queue.submit([encoder.finish()]);

            await pickingReadBuffer.mapAsync(GPUMapMode.READ);
            const arrayBuffer = pickingReadBuffer.getMappedRange();
            const pixels = new Uint8Array(arrayBuffer);

            // bgra8unorm: B, G, R, A
            const r = pixels[2];
            const g = pixels[1];
            const b = pixels[0];

            let foundIso = null;
            if (r > 0 || g > 0 || b > 0) {
                const pickId = r + (g << 8) + (b << 16);
                foundIso = mapState.pickIdToIso.get(pickId);
            }

            pickingReadBuffer.unmap();
            return foundIso;
        }
    };
}
