import fs from 'fs';
import path from 'path';
import * as d3 from 'd3';
import * as d3Proj from 'd3-geo-projection';
import earcut from 'earcut';
import zlib from 'zlib';

const RESOLUTION = '10m';
const DATA_DIR = 'data/natural_earth';
const OUTPUT_BASE_DIR = 'public/data/binary';

// Configuration des projections (doit être en phase avec src/config/projections.js)
const PROJECTIONS = [
    { id: 'mercator', project: () => d3.geoMercator().scale(120).translate([0, 0]), clampLat: 85.0511 },
    { id: 'natural-earth-2', project: () => d3Proj.geoNaturalEarth2().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'mollweide', project: () => d3Proj.geoMollweide().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'robinson', project: () => d3Proj.geoRobinson().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'winkel3', project: () => d3Proj.geoWinkel3().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'lonlat', project: () => d3.geoIdentity(), clampLat: 90.0 }
];

if (!fs.existsSync(OUTPUT_BASE_DIR)) fs.mkdirSync(OUTPUT_BASE_DIR, { recursive: true });

class GlobalVertexManager {
    constructor(precision = 1e7) {
        this.precision = precision;
        this.vertexMap = new Map();
        this.capacity = 1 * 1024 * 1024; // 1 million floats (2 floats per vertex)
        this.vertices = new Float32Array(this.capacity);
        this.offset = 0;
    }

    ensureCapacity(needed) {
        if (this.offset + needed > this.capacity) {
            this.capacity *= 2;
            const next = new Float32Array(this.capacity);
            next.set(this.vertices);
            this.vertices = next;
        }
    }

    getOrCreate(ptProj, ptLonLat) {
        const sx = Math.round(ptLonLat[0] * this.precision);
        const sy = Math.round(ptLonLat[1] * this.precision);
        const key = `${sx},${sy}`;
        if (this.vertexMap.has(key)) return this.vertexMap.get(key);

        const idx = this.offset / 2;
        this.ensureCapacity(2);
        this.vertices[this.offset++] = ptProj[0];
        this.vertices[this.offset++] = ptProj[1];

        this.vertexMap.set(key, idx);
        return idx;
    }
}

function flattenRingsGlobal(rings, vm, projFunc, clampLat = 89.9) {
    let ptsLocalIdx = [];
    let holes = [];
    let currentOffset = 0;

    rings.forEach((ring, rIdx) => {
        if (currentOffset > 0 && rIdx > 0) holes.push(currentOffset);
        ring.forEach(pt => {
            const safeLat = Math.max(-clampLat, Math.min(clampLat, pt[1]));
            const px = projFunc([pt[0], safeLat]);
            if (px) {
                const globalIdx = vm.getOrCreate(px, [pt[0], safeLat]);
                ptsLocalIdx.push(globalIdx);
                currentOffset++;
            }
        });
    });
    return { ptsLocalIdx, holes };
}

function getEdgesGlobal(rings, vm, projFunc, clampLat = 89.9) {
    let allPaths = [];

    rings.forEach(ring => {
        if (ring.length < 2) return;

        let paths = [];
        let currentPath = [];

        for (let j = 0; j < ring.length - 1; j++) {
            const pt1_raw = ring[j];
            const pt2_raw = ring[j + 1];
            const dLon = Math.abs(pt1_raw[0] - pt2_raw[0]);
            const EPS = 0.05;
            const isLonEdge = (Math.abs(Math.abs(pt1_raw[0]) - 180) < EPS && Math.abs(Math.abs(pt2_raw[0]) - 180) < EPS);

            if (dLon > 180 || isLonEdge) {
                currentPath.push([pt1_raw[0], Math.max(-clampLat, Math.min(clampLat, pt1_raw[1]))]);
                if (currentPath.length > 1) paths.push(currentPath);
                currentPath = [];
                continue;
            }

            const dist = Math.max(dLon, Math.abs(pt1_raw[1] - pt2_raw[1]));
            const numSteps = Math.ceil(dist / 2.0);

            for (let s = 0; s < numSteps; s++) {
                const t1 = s / numSteps;
                const lon = pt1_raw[0] + (pt2_raw[0] - pt1_raw[0]) * t1;
                const lat = Math.max(-clampLat, Math.min(clampLat, pt1_raw[1] + (pt2_raw[1] - pt1_raw[1]) * t1));
                currentPath.push([lon, lat]);
            }
        }

        if (currentPath.length > 0) {
            const lastPt = ring[ring.length - 1];
            currentPath.push([lastPt[0], Math.max(-clampLat, Math.min(clampLat, lastPt[1]))]);
            if (currentPath.length > 1) paths.push(currentPath);
        }

        paths.forEach(path => {
            if (path.length < 2) return;
            const pathGlobalIndices = path.map(pt => {
                const px = projFunc(pt) || [0, 0];
                return vm.getOrCreate(px, pt);
            });
            allPaths.push(pathGlobalIndices);
        });
    });

    return allPaths;
}

function getLabelMetrics(feature, projFunc, clampLat = 89.9) {
    if (!feature || !feature.geometry) return null;
    let bestRing = null;
    let maxArea = -1;
    const coords = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    coords.forEach(poly => {
        const tempFeat = { type: 'Polygon', coordinates: poly };
        const area = d3.geoArea(tempFeat);
        const correctedArea = area > 2 * Math.PI ? 4 * Math.PI - area : area;
        if (correctedArea > maxArea) {
            maxArea = correctedArea;
            bestRing = poly[0];
        }
    });
    if (!bestRing) return null;
    let projRing = [], minY = Infinity, maxY = -Infinity;
    bestRing.forEach(pt => {
        const safePt = [pt[0], Math.max(-clampLat, Math.min(clampLat, pt[1]))];
        const px = projFunc(safePt);
        if (px) {
            projRing.push(px);
            minY = Math.min(minY, px[1]);
            maxY = Math.max(maxY, px[1]);
        }
    });
    const centerY = (minY + maxY) / 2;
    let intersections = [];
    for (let i = 0, j = projRing.length - 1; i < projRing.length; j = i++) {
        let p1 = projRing[i], p2 = projRing[j];
        if ((p1[1] > centerY) !== (p2[1] > centerY)) {
            intersections.push(p1[0] + (centerY - p1[1]) * (p2[0] - p1[0]) / (p2[1] - p1[1]));
        }
    }
    if (intersections.length >= 2) {
        intersections.sort((a, b) => a - b);
        const minX_int = intersections[0], maxX_int = intersections[intersections.length - 1];
        const centerPx = [(minX_int + maxX_int) / 2, centerY];

        let polyMinX = Infinity, polyMaxX = -Infinity, polyMinY = Infinity, polyMaxY = -Infinity;
        projRing.forEach(px => {
            polyMinX = Math.min(polyMinX, px[0]); polyMaxX = Math.max(polyMaxX, px[0]);
            polyMinY = Math.min(polyMinY, px[1]); polyMaxY = Math.max(polyMaxY, px[1]);
        });

        return { 
            width: maxX_int - minX_int, 
            point: centerPx, 
            geoPoint: projFunc.invert ? projFunc.invert(centerPx) : null,
            polygonBBox: [[polyMinX, polyMinY], [polyMaxX, polyMaxY]]
        };
    }
    return null;
}

function getBBox(feature, projFunc) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const coords = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    coords.forEach(poly => poly.forEach(ring => ring.forEach(pt => {
        const px = projFunc([pt[0], Math.max(-89.9, Math.min(89.9, pt[1]))]);
        if (px) {
            minX = Math.min(minX, px[0]); minY = Math.min(minY, px[1]);
            maxX = Math.max(maxX, px[0]); maxY = Math.max(maxY, px[1]);
        }
    })));
    return [[minX, minY], [maxX, maxY]];
}

function processFeatures(features, proj, isState = false) {
    const meta = [];
    const vm = new GlobalVertexManager();
    let allPolyIndices = [];
    let allLinePaths = [];

    const projInstance = proj.project();
    const projFunc = projInstance;
    const clampLat = proj.clampLat || 89.9;

    features.forEach((f, idx) => {
        const name = f.properties.NAME_FR || f.properties.name_fr || f.properties.NAME || f.properties.name || f.properties.ADMIN || f.properties.admin || "Unknown";
        const getParentIso = (p) => {
            const val = [p.ISO_A2_EH, p.iso_a2_eh, p.ISO_A2, p.iso_a2, p.ADM0_A3, p.adm0_a3].find(v => v && v !== "-99" && v !== -99);
            return (val || "XX").toUpperCase();
        };
        const getFeatureIso = (p) => {
            if (isState) {
                const stateVal = [p.iso_3166_2, p.ISO_3166_2, p.code_hasc, p.CODE_HASC, p.adm1_code, p.ADM1_CODE].find(v => v && v !== "-99" && v !== -99);
                if (stateVal) return stateVal.toUpperCase();
                return (getParentIso(p) + "-" + name).toUpperCase();
            }
            return getParentIso(p);
        };

        const iso = getFeatureIso(f.properties);
        const parentIso = getParentIso(f.properties);

        let featurePolyIndices = [];
        let featureLinePaths = [];

        const processRingSet = (ringSet) => {
            const { ptsLocalIdx, holes } = flattenRingsGlobal(ringSet, vm, projFunc, clampLat);
            if (ptsLocalIdx.length >= 3) {
                const flatProj = [];
                ptsLocalIdx.forEach(gIdx => {
                    flatProj.push(vm.vertices[gIdx * 2], vm.vertices[gIdx * 2 + 1]);
                });
                const tris = earcut(flatProj, holes);
                tris.forEach(tIdx => featurePolyIndices.push(ptsLocalIdx[tIdx]));
            }
            const paths = getEdgesGlobal(ringSet, vm, projFunc, clampLat);
            paths.forEach(p => featureLinePaths.push(p));
        };

        const polygonSets = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        if (idx % 50 === 0) console.log(`Processing ${idx}/${features.length}: ${name} | Verts: ${vm.offset / 2}`);
        polygonSets.forEach(ringSet => processRingSet(ringSet));

        const polyOffset = allPolyIndices.length, polyCount = featurePolyIndices.length;
        featurePolyIndices.forEach(i => allPolyIndices.push(i));
        const pathOffset = allLinePaths.length, pathCount = featureLinePaths.length;
        featureLinePaths.forEach(p => allLinePaths.push(p));

        meta.push({
            name, iso, parentIso,
            tri: { offset: polyOffset, count: polyCount },
            path: { offset: pathOffset, count: pathCount },
            labelMetrics: getLabelMetrics(f, projFunc, clampLat),
            bbox: getBBox(f, projFunc),
            geoBox: d3.geoBounds(f),
            centroid: d3.geoCentroid(f),
            mapcolor9: f.properties.MAPCOLOR9 || f.properties.mapcolor9 || 1
        });
    });

    return { meta, vm, linePaths: allLinePaths, polyIndices: allPolyIndices };
}

function packFile(processed, outputFilename, projId) {
    const totalPoints = processed.vm.offset / 2;
    const pPosArr = new Float32Array(processed.vm.vertices.buffer, 0, processed.vm.offset);
    const polyPosBuf = Buffer.from(pPosArr.buffer, pPosArr.byteOffset, pPosArr.byteLength);
    const pIndArr = new Uint32Array(processed.polyIndices);
    const polyIndBuf = Buffer.from(pIndArr.buffer, pIndArr.byteOffset, pIndArr.byteLength);

    let totalPathVerts = 0;
    processed.linePaths.forEach(p => totalPathVerts += p.length);
    const linePathInds = new Uint32Array(totalPathVerts);
    const linePathStarts = new Uint32Array(processed.linePaths.length);
    let currP = 0;
    processed.linePaths.forEach((path, i) => {
        linePathStarts[i] = currP;
        linePathInds.set(path, currP);
        currP += path.length;
    });

    const lpIndBuf = Buffer.from(linePathInds.buffer);
    const lpStartBuf = Buffer.from(linePathStarts.buffer);

    const pad = (buf) => {
        const len = buf.length;
        const paddedLen = Math.ceil(len / 4) * 4;
        if (len === paddedLen) return buf;
        const padded = Buffer.alloc(paddedLen, 0x20); // Pad with spaces
        buf.copy(padded);
        return padded;
    };

    let metaBuf = Buffer.from(JSON.stringify(processed.meta), 'utf8');
    const originalMetaLen = metaBuf.length;
    metaBuf = pad(metaBuf);

    const header = {
        projId,
        stride: 2,
        metaLength: metaBuf.length, // Include padding
        polyCount: totalPoints,
        polyIndexCount: processed.polyIndices.length,
        pathCount: processed.linePaths.length,
        pathIndexCount: linePathInds.length,
        offsets: {
            polyPos: 0,
            polyIndices: polyPosBuf.length,
            lpInd: polyPosBuf.length + polyIndBuf.length,
            lpStart: polyPosBuf.length + polyIndBuf.length + lpIndBuf.length
        }
    };

    let headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    headerBuf = pad(headerBuf);

    const finalBuf = Buffer.concat([
        Buffer.from('GEOB'),
        Buffer.alloc(4).fill(0).map((_, i) => (headerBuf.length >> (8 * i)) & 0xFF), // header length u32le
        headerBuf,
        metaBuf,
        polyPosBuf,
        polyIndBuf,
        lpIndBuf,
        lpStartBuf
    ]);

    fs.writeFileSync(outputFilename, finalBuf);
    console.log(`Saved ${outputFilename} (${(finalBuf.length / 1024).toFixed(1)} KB)`);
}

async function run() {
    const args = process.argv.slice(2);
    const targetProjId = args[0];

    const projectionsToProcess = targetProjId 
        ? PROJECTIONS.filter(p => p.id === targetProjId)
        : PROJECTIONS;

    if (projectionsToProcess.length === 0) {
        console.error(`Projection '${targetProjId}' not found.`);
        return;
    }

    console.log(`--- Processing 10m Maps (${projectionsToProcess.map(p => p.id).join(', ')}) ---`);

    const countriesGeoJSON = path.join(DATA_DIR, `ne_10m_admin_0_countries.geojson`);

    if (!fs.existsSync(countriesGeoJSON)) {
        console.error(`Missing ${countriesGeoJSON}`);
        return;
    }

    const countries = JSON.parse(fs.readFileSync(countriesGeoJSON, 'utf8'));

    for (const proj of projectionsToProcess) {
        console.log(`\n=== Projection: ${proj.id} ===`);
        const outputDir = path.join(OUTPUT_BASE_DIR, '10m');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const pC = processFeatures(countries.features, proj, false);
        packFile(pC, path.join(outputDir, `countries_10m_${proj.id}.bin`), proj.id);
    }

    console.log("\n--- Finished ---");
}

run().catch(console.error);
