import * as d3 from 'd3';
import { width, height, loadingDiv } from '../core/gpuContext.js';
import { isOrthographic } from '../core/camera.js';
import { appState } from '../state/appState.js';
import { buffer as gpuBuffer, elements as gpuElements } from '../render/gpu.js';
import { getMapColor, computeLabelLayout, getTextGeometry } from '../math/geoUtils.js';
import { getProjectionById } from '../config/projections.js';
import { fetchAndDecode } from '../providers.js';

export function setupDataLoaders(deps) {
    const { fontAtlas, mapState, redraw } = deps;

    function processBinaryAtlas(binaryData) {
        if (!binaryData || !binaryData.meta) return;
        const { meta, header, buffer, dataOffset } = binaryData;
        const offsets = header.offsets;

        const polyPos = new Float32Array(buffer, dataOffset + offsets.polyPos, (offsets.polyIndices - offsets.polyPos) / 4);
        const polyIndices = new Uint32Array(buffer, dataOffset + offsets.polyIndices, (offsets.lpInd - offsets.polyIndices) / 4);
        const lpInd = new Uint32Array(buffer, dataOffset + offsets.lpInd, (offsets.lpPr - offsets.lpInd) / 4);
        const lpPr = new Int16Array(buffer, dataOffset + offsets.lpPr, (offsets.lpNx - offsets.lpPr) / 2);
        const lpNx = new Int16Array(buffer, dataOffset + offsets.lpNx, (offsets.lpStart - offsets.lpNx) / 2);
        const lpStart = new Uint32Array(buffer, dataOffset + offsets.lpStart, (buffer.byteLength - (dataOffset + offsets.lpStart)) / 4);

        const stride = header.stride || 2;
        const isLite = header.isLite || false;
        const SCALE = 1e5; // Doit matcher le preprocess
        const { countrySat, countryLit } = appState.getTheme ? appState.getTheme() : { countrySat: 0.5, countryLit: 0.5 };

        // 1. Préparation des Buffers Généraux pour les Polygones
        const totalTriVertices = header.polyIndexCount;
        const atlasPos = new Float32Array(totalTriVertices * 2);
        const atlasCol = new Float32Array(totalTriVertices * 3);
        const atlasPick = new Float32Array(totalTriVertices * 3);

        // 2. Préparation pour les Lignes (Technique geojson_viewer: 2 sommets par point)
        const totalLineVertices = header.pathIndexCount * 2;
        const totalLineIndices = (header.pathIndexCount - header.pathCount) * 6;

        const atlasLineVerts = new Float32Array(totalLineVertices * 7); // p(2), pr(2), nx(2), side(1)
        const atlasLineIndices = new Uint32Array(totalLineIndices);

        let triVOffset = 0;
        let lineVOffset = 0; 
        let lineIOffset = 0;

        meta.forEach(m => {
            let uPickColor = [0, 0, 0];
            let vColor = [0.33, 0.33, 0.33];

            if (!isLite) {
                let pickId = mapState.isoToPickId.get(m.iso);
                if (pickId === undefined) {
                    pickId = mapState.nextPickId++;
                    mapState.isoToPickId.set(m.iso, pickId);
                    mapState.pickIdToIso.set(pickId, m.iso);
                }
                uPickColor = [(pickId & 255) / 255.0, ((pickId >> 8) & 255) / 255.0, ((pickId >> 16) & 255) / 255.0];
                const baseColor = getMapColor(m.mapcolor9 || 1);
                const hsl = d3.hsl(d3.rgb(baseColor[0] * 255, baseColor[1] * 255, baseColor[2] * 255));
                hsl.s = countrySat; hsl.l = countryLit;
                const rgb = hsl.rgb();
                vColor = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
            }

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

            mapState.featureMeta.set(m.iso, { atlasOffset: atlasTriStart, atlasCount: tCount, iso: m.iso, name: m.name });

            // Remplissage des lignes (Logic geojson_viewer)
            if (m.path) {
                for (let i = 0; i < m.path.count; i++) {
                    const pIdx = m.path.offset + i;
                    const start = lpStart[pIdx];
                    const end = (pIdx === header.pathCount - 1) ? lpInd.length : lpStart[pIdx + 1];
                    const N = end - start;
                    if (N < 2) continue;

                    const lineVertexBase = lineVOffset;

                    for (let j = 0; j < N; j++) {
                        const idxInPath = start + j;
                        const gIdx = lpInd[idxInPath];
                        const x = polyPos[gIdx * stride];
                        const y = polyPos[gIdx * stride + 1];

                        // Reconstruction des positions absolues des voisins
                        const prX = x + lpPr[idxInPath * 2] / SCALE;
                        const prY = y + lpPr[idxInPath * 2 + 1] / SCALE;
                        const nxX = x + lpNx[idxInPath * 2] / SCALE;
                        const nxY = y + lpNx[idxInPath * 2 + 1] / SCALE;

                        // 2 sommets par point
                        for (let side of [1, -1]) {
                            const k = lineVOffset * 7;
                            atlasLineVerts[k + 0] = x;   atlasLineVerts[k + 1] = y;
                            atlasLineVerts[k + 2] = prX; atlasLineVerts[k + 3] = prY;
                            atlasLineVerts[k + 4] = nxX; atlasLineVerts[k + 5] = nxY;
                            atlasLineVerts[k + 6] = side;
                            lineVOffset++;
                        }

                        // Génération des indices (Quads entre points successifs)
                        if (j < N - 1) {
                            const v1 = lineVertexBase + j * 2;
                            const v2 = v1 + 1;
                            const v3 = v1 + 2;
                            const v4 = v1 + 3;
                            // Triangle 1
                            atlasLineIndices[lineIOffset++] = v1;
                            atlasLineIndices[lineIOffset++] = v2;
                            atlasLineIndices[lineIOffset++] = v3;
                            // Triangle 2
                            atlasLineIndices[lineIOffset++] = v2;
                            atlasLineIndices[lineIOffset++] = v4;
                            atlasLineIndices[lineIOffset++] = v3;
                        }
                    }
                }
            }

            // Labels (désactivés en mode Lite)
            if (!isLite && m.labelMetrics && fontAtlas) {
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
        const atlasP = {
            id: 'atlas_polygons',
            pos: gpuBuffer(atlasPos),
            colors: gpuBuffer(atlasCol),
            pickColors: gpuBuffer(atlasPick),
            count: totalTriVertices,
            isAtlas: true
        };
        mapState.renderList.push(atlasP);
        mapState.atlasPolygons = atlasP;

        if (totalLineVertices > 0) {
            const atlasL = {
                id: 'atlas_lines',
                lineVertexBuffer: gpuBuffer(atlasLineVerts),
                elements: gpuElements({ data: atlasLineIndices }),
                isAtlasLines: true
            };
            mapState.renderList.push(atlasL);
            mapState.atlasLines = atlasL;
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
        mapState.atlasPolygons = null;
        mapState.atlasLines = null;
        mapState.textRenderList.forEach(item => {
            if (item.uPositions) item.uPositions.destroy();
            if (item.uUvs) item.uUvs.destroy();
        });
        mapState.renderList = [];
        mapState.textRenderList = [];
        mapState.featureMeta.clear();

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

    return { 
        loadGlobalData, 
        processBinaryAtlas, 
        loadCustomMapData: async (url) => {
            loadingDiv.style.display = 'block';
            const fileName = url.split('/').pop();
            loadingDiv.innerText = `Chargement ${fileName}...`;
            
            try {
                const data = await fetchAndDecode(url);
                if (!data) return;

                // Nettoyage avant chargement custom
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
                mapState.featureMeta.clear();

                processBinaryAtlas(data);

                // Synchronisation de la projection
                if (data.header && data.header.projId) {
                    appState.set('projection', data.header.projId);
                }
                
                redraw();
            } catch (e) {
                console.error(e);
            } finally {
                loadingDiv.style.display = 'none';
            }
        } 
    };
}
