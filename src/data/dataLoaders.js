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

        // 1. Préparation des Buffers Généraux pour les Polygones (Triangles)
        const totalTriVertices = header.polyIndexCount; // On dé-indexe pour le batching simple
        const atlasPos = new Float32Array(totalTriVertices * 2);
        const atlasCol = new Float32Array(totalTriVertices * 3);
        const atlasPick = new Float32Array(totalTriVertices * 3);

        // 2. Préparation pour les Lignes
        let totalLineVertices = 0;
        let totalLineIndices = 0;
        meta.forEach(m => {
            if (m.path) {
                for (let i = 0; i < m.path.count; i++) {
                    const pIdx = m.path.offset + i;
                    const start = lpStart[pIdx];
                    const end = (pIdx === header.pathCount - 1) ? lpInd.length : lpStart[pIdx + 1];
                    const N = end - start;
                    if (N >= 2) {
                        totalLineVertices += N * 2;
                        totalLineIndices += (N - 1) * 6;
                    }
                }
            }
        });

        const atlasLineVerts = new Float32Array(totalLineVertices * 7); // [pos.x, pos.y, prev.x, prev.y, next.x, next.y, side]
        const atlasLineCol = new Float32Array(totalLineVertices * 3);
        const atlasLineIndices = new Uint32Array(totalLineIndices);

        let triVOffset = 0;
        let lineVOffset = 0;
        let lineIOffset = 0;

        meta.forEach(m => {
            let pickId = mapState.isoToPickId.get(m.iso);
            if (pickId === undefined) {
                pickId = mapState.nextPickId++;
                mapState.isoToPickId.set(m.iso, pickId);
                mapState.pickIdToIso.set(pickId, m.iso);
            }
            const uPickColor = [
                (pickId & 255) / 255.0,
                ((pickId >> 8) & 255) / 255.0,
                ((pickId >> 16) & 255) / 255.0
            ];

            const baseColor = getMapColor(m.mapcolor9);
            const hsl = d3.hsl(d3.rgb(baseColor[0] * 255, baseColor[1] * 255, baseColor[2] * 255));
            hsl.s = countrySat; hsl.l = countryLit;
            const rgb = hsl.rgb();
            const vColor = [rgb.r / 255, rgb.g / 255, rgb.b / 255];

            // Remplissage des polygones
            const tCount = m.tri.count;
            const tOff = m.tri.offset;
            const atlasTriStart = triVOffset;
            for (let i = 0; i < tCount; i++) {
                const gIdx = polyIndices[tOff + i];
                const vBase = triVOffset * 2;
                const cBase = triVOffset * 3;
                atlasPos[vBase] = polyPos[gIdx * stride];
                atlasPos[vBase + 1] = polyPos[gIdx * stride + 1];
                atlasCol[cBase] = vColor[0]; atlasCol[cBase + 1] = vColor[1]; atlasCol[cBase + 2] = vColor[2];
                atlasPick[cBase] = uPickColor[0]; atlasPick[cBase + 1] = uPickColor[1]; atlasPick[cBase + 2] = uPickColor[2];
                triVOffset++;
            }

            // Reference pour le dessin individuel (surbrillance, etc.) sans doubler les buffers
            mapState.renderList.push({
                id: m.iso,
                iso: m.iso,
                atlasOffset: atlasTriStart,
                atlasCount: tCount,
                isReference: true,
                feature: { iso: m.iso, properties: { name: m.name } }
            });

            // Remplissage des lignes
            if (m.path) {
                for (let i = 0; i < m.path.count; i++) {
                    const pIdx = m.path.offset + i;
                    const start = lpStart[pIdx];
                    const end = (pIdx === header.pathCount - 1) ? lpInd.length : lpStart[pIdx + 1];
                    const path = lpInd.slice(start, end);
                    const N = path.length;
                    if (N < 2) continue;

                    const pathStartV = lineVOffset;
                    for (let j = 0; j < N; j++) {
                        const cur = path[j], prev = path[Math.max(0, j - 1)], next = path[Math.min(N - 1, j + 1)];
                        for (let side of [1, -1]) {
                            const k = lineVOffset * 7;
                            const ck = lineVOffset * 3;
                            atlasLineVerts[k + 0] = polyPos[cur * stride]; atlasLineVerts[k + 1] = polyPos[cur * stride + 1];
                            atlasLineVerts[k + 2] = polyPos[prev * stride]; atlasLineVerts[k + 3] = polyPos[prev * stride + 1];
                            atlasLineVerts[k + 4] = polyPos[next * stride]; atlasLineVerts[k + 5] = polyPos[next * stride + 1];
                            atlasLineVerts[k + 6] = side;
                            atlasLineCol[ck] = 1.0; atlasLineCol[ck + 1] = 1.0; atlasLineCol[ck + 2] = 1.0; // Blanc par défaut
                            lineVOffset++;
                        }
                        if (j < N - 1) {
                            const cV = lineVOffset - 2, nV = lineVOffset;
                            atlasLineIndices[lineIOffset++] = cV; atlasLineIndices[lineIOffset++] = cV + 1; atlasLineIndices[lineIOffset++] = nV;
                            atlasLineIndices[lineIOffset++] = cV + 1; atlasLineIndices[lineIOffset++] = nV + 1; atlasLineIndices[lineIOffset++] = nV;
                        }
                    }
                }
            }

            // Labels (restent individuels car ils ont des ancres/tailles spécifiques)
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

        // 3. Création des items de rendu uniques (Batchés)
        mapState.renderList.push({
            id: 'atlas_polygons',
            pos: gpuBuffer(atlasPos),
            colors: gpuBuffer(atlasCol),
            pickColors: gpuBuffer(atlasPick),
            count: totalTriVertices,
            isAtlas: true
        });

        if (totalLineVertices > 0) {
            mapState.renderList.push({
                id: 'atlas_lines',
                lineVertexBuffer: gpuBuffer(atlasLineVerts),
                lineColors: gpuBuffer(atlasLineCol),
                elements: gpuElements({ data: atlasLineIndices }),
                isAtlasLines: true
            });
        }
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
