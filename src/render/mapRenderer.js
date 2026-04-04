import { width, height, gpuContext, device } from '../core/gpuContext.js';
import { zoomState, isOrthographic, orthoRotate } from '../core/camera.js';
import { drawPolygons, drawThickLines, drawTextFull, drawThickCircle, resetUniformRing } from './shaders.js';
import { buffer as gpuBuffer } from './gpu.js';
import { appState } from '../state/appState.js';
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

    return function redraw() {
        resetUniformRing();

        const uTranslate = [zoomState.x, zoomState.y];
        const uScale = zoomState.k;
        const outlineColor = parseHexColor(appState.get('outlineColor'));
        const dynamicThickness = 1.0 * Math.pow(Math.min(zoomState.k, 2000), 0.256);
        const gratThickness = 1.2 * Math.pow(Math.min(zoomState.k, 150), 0.23);

        const loadedRegions = getLoadedRegions();
        const isAnyLoaded = loadedRegions.size > 0;
        const exclusiveMode = getExclusiveFocusMode();
        const showStrokes = appState.get('showStrokes');
        const showLabels = appState.get('showLabels');
        const showColors = appState.get('showColors');

        const baseProps = {
            uTranslate, uScale,
            uResolution: [width, height],
            uRotate: orthoRotate,
            uIsOrtho: isOrthographic,
            uOpacity: 1.0
        };

        const bgTri = [], fgTri = [], bgLines = [], fgLines = [];

        getRenderList().forEach(item => {
            if (item.isRegion && !loadedRegions.has(item.parentIso)) return;

            let itemOpacity = 1.0;
            if (!item.isRegion && isAnyLoaded) {
                const focused = loadedRegions.has(item.id) || (item.feature && loadedRegions.has(item.feature.iso));
                itemOpacity = exclusiveMode ? (focused ? 1.0 : 0.0) : (focused ? 1.0 : 0.4);
            }

            const tData = {
                pos: item.pos,
                posLonLat: item.posLonLat,
                colors: item.colors,
                count: item.count,
                uOpacity: itemOpacity,
            };
            if (item.isRegion) fgTri.push(tData); else bgTri.push(tData);

            if (item.lineVertexBuffer && item.elements) {
                const lData = {
                    lineVertexBuffer: item.lineVertexBuffer,
                    elements: item.elements,
                    uThickness: dynamicThickness,
                    uColor: strokeColor,
                    uOpacity: (item.isRegion && exclusiveMode) ? 1.0 : itemOpacity,
                };
                if (item.isRegion) fgLines.push(lData); else bgLines.push(lData);
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
            if (triList.length > 0 && showColors) drawPolygons(pass, triList.map(t => mkProps(t)));
            if (lineList.length > 0 && showStrokes) drawThickLines(pass, lineList.map(l => mkProps({ ...l, uColor: overrideColor || l.uColor || strokeColor })));
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
    };
}
