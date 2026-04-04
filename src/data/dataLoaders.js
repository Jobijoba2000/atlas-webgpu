import * as d3 from 'd3';
import { width, height, loadingDiv } from '../core/gpuContext.js';
import { isOrthographic } from '../core/camera.js';
import { appState } from '../state/appState.js';
import { buffer as gpuBuffer, elements as gpuElements } from '../render/gpu.js';
import { getMapColor, computeLabelLayout, getTextGeometry } from '../math/geoUtils.js';
import { getProjectionById } from '../config/projections.js';

export function setupDataLoaders(deps) {
    const { fontAtlas, mapState, redraw } = deps;

    function processBinaryAtlas(binaryData) {
        if (!binaryData || !binaryData.meta) return;
        const { meta, header, buffer, dataOffset } = binaryData;
        const offsets = header.offsets;

        const polyPos = new Float32Array(buffer, dataOffset + offsets.polyPos, (offsets.polyIndices - offsets.polyPos) / 4);
        const polyIndices = new Uint32Array(buffer, dataOffset + offsets.polyIndices, (offsets.lpInd - offsets.polyIndices) / 4);
        const lpInd = new Uint32Array(buffer, dataOffset + offsets.lpInd, (offsets.lpStart - offsets.lpInd) / 4);
        const lpStart = new Uint32Array(buffer, dataOffset + offsets.lpStart, (buffer.byteLength - (dataOffset + offsets.lpStart)) / 4);

        const stride = header.stride || 2;
        const { countrySat, countryLit } = appState.getTheme ? appState.getTheme() : { countrySat: 0.5, countryLit: 0.5 };

        meta.forEach(m => {
            let pickId = mapState.isoToPickId.get(m.iso);
            if (pickId === undefined) {
                pickId = mapState.nextPickId++;
                mapState.isoToPickId.set(m.iso, pickId);
                mapState.pickIdToIso.set(pickId, m.iso);
            }
            const rPick = (pickId & 255) / 255.0;
            const gPick = ((pickId >> 8) & 255) / 255.0;
            const bPick = ((pickId >> 16) & 255) / 255.0;
            const uPickColor = [rPick, gPick, bPick];

            const baseColor = getMapColor(m.mapcolor9);
            const hsl = d3.hsl(d3.rgb(baseColor[0] * 255, baseColor[1] * 255, baseColor[2] * 255));
            hsl.s = countrySat; hsl.l = countryLit;
            const rgb = hsl.rgb();
            const vColor = [rgb.r / 255, rgb.g / 255, rgb.b / 255];

            const tCount = m.tri.count;
            const tOff = m.tri.offset;
            const pData = new Float32Array(tCount * 2);
            const cData = new Float32Array(tCount * 3);

            for (let i = 0; i < tCount; i++) {
                const gIdx = polyIndices[tOff + i];
                pData[i * 2] = polyPos[gIdx * stride];
                pData[i * 2 + 1] = polyPos[gIdx * stride + 1];
                cData[i * 3] = vColor[0]; cData[i * 3 + 1] = vColor[1]; cData[i * 3 + 2] = vColor[2];
            }

            const featurePaths = [];
            if (m.path) {
                for (let i = 0; i < m.path.count; i++) {
                    const pIdx = m.path.offset + i;
                    const start = lpStart[pIdx];
                    const end = (pIdx === header.pathCount - 1) ? lpInd.length : lpStart[pIdx + 1];
                    featurePaths.push(lpInd.slice(start, end));
                }
            }

            let totalLineVerts = 0;
            featurePaths.forEach(p => totalLineVerts += p.length * 2);
            const lineVerts = new Float32Array(totalLineVerts * 7);
            const lineInds = new Uint32Array(Math.max(0, (totalLineVerts - featurePaths.length * 2) * 3));
            let vOff = 0, eOff = 0;

            featurePaths.forEach(path => {
                const N = path.length; if (N < 2) return;
                for (let i = 0; i < N; i++) {
                    const cur = path[i], prev = path[Math.max(0, i - 1)], next = path[Math.min(N - 1, i + 1)];
                    for (let side of [1, -1]) {
                        const k = vOff * 7;
                        lineVerts[k + 0] = polyPos[cur * stride]; lineVerts[k + 1] = polyPos[cur * stride + 1];
                        lineVerts[k + 2] = polyPos[prev * stride]; lineVerts[k + 3] = polyPos[prev * stride + 1];
                        lineVerts[k + 4] = polyPos[next * stride]; lineVerts[k + 5] = polyPos[next * stride + 1];
                        lineVerts[k + 6] = side;
                        vOff++;
                    }
                    if (i < N - 1) {
                        const cV = vOff - 2, nV = vOff;
                        lineInds[eOff++] = cV; lineInds[eOff++] = cV + 1; lineInds[eOff++] = nV;
                        lineInds[eOff++] = cV + 1; lineInds[eOff++] = nV + 1; lineInds[eOff++] = nV;
                    }
                }
            });

            const renderItem = {
                id: m.iso,
                pickId: pickId,
                uPickColor: uPickColor,
                pos: gpuBuffer(pData), colors: gpuBuffer(cData), count: tCount,
                lineVertexBuffer: totalLineVerts > 0 ? gpuBuffer(lineVerts) : null,
                elements: lineInds.length > 0 ? gpuElements({ data: lineInds }) : null,
                feature: { iso: m.iso, properties: { name: m.name } }
            };
            mapState.renderList.push(renderItem);

            if (m.labelMetrics && fontAtlas) {
                const layout = computeLabelLayout(m, fontAtlas);
                const geom = getTextGeometry(m.name, 1.0, fontAtlas);
                if (geom) {
                    mapState.textRenderList.push({
                        uPositions: gpuBuffer(geom.positions),
                        uUvs: gpuBuffer(geom.uvs),
                        uAnchor: layout.position,
                        uSize: layout.size,
                        count: geom.positions.length / 2,
                        iso: m.iso
                    });
                }
            }
        });
    }

    async function loadGlobalData() {
        loadingDiv.style.display = 'block';
        const projId = isOrthographic ? 'lonlat' : appState.get('projection');
        loadingDiv.innerText = `Chargement ${projId}...`;

        // Nettoyage
        mapState.renderList.forEach(item => {
            if (item.pos) item.pos.destroy();
            if (item.colors) item.colors.destroy();
            if (item.lineVertexBuffer) item.lineVertexBuffer.destroy();
            if (item.elements) item.elements.destroy();
        });
        mapState.textRenderList.forEach(item => {
            if (item.uPositions) item.uPositions.destroy();
            if (item.uUvs) item.uUvs.destroy();
        });
        mapState.renderList = [];
        mapState.textRenderList = [];

        try {
            const provider = deps.getCurrentProvider();
            const data = await provider.loadData();
            if (data.countries) processBinaryAtlas(data.countries);
            redraw();
        } catch (e) {
            console.error(e);
        }
        loadingDiv.style.display = 'none';
    }

    return { loadGlobalData, processBinaryAtlas };
}
