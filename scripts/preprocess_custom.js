import fs from 'fs';
import path from 'path';
import * as d3 from 'd3';
import * as d3Proj from 'd3-geo-projection';
import earcut from 'earcut';
import zlib from 'zlib';
import readline from 'readline';
import geojson from 'geojson-stream';

const CUSTOM_DATA_DIR = 'data/custom_geojson';
const OUTPUT_DIR = 'public/data/custom_bin';

const PROJECTIONS = [
    { id: 'mercator', name: 'Mercator', project: () => d3.geoMercator().scale(120).translate([0, 0]), clampLat: 85.0511 },
    { id: 'natural-earth-2', name: 'Natural Earth 2', project: () => d3Proj.geoNaturalEarth2().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'mollweide', name: 'Mollweide', project: () => d3Proj.geoMollweide().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'robinson', name: 'Robinson', project: () => d3Proj.geoRobinson().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'winkel3', name: 'Winkel Tripel', project: () => d3Proj.geoWinkel3().scale(120).translate([0, 0]), clampLat: 89.9 },
    { id: 'orthographic', name: 'Globe 3D (Orthographic)', project: () => d3.geoIdentity(), clampLat: 89.9 },
    { id: 'lonlat', name: 'Plate Carrée (Lon/Lat)', project: () => d3.geoIdentity(), clampLat: 90.0 }
];

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

class GlobalVertexManager {
    constructor(precision = 1e7) {
        this.precision = precision;
        this.vertexMap = new Map();
        this.capacity = 10 * 1024 * 1024;
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

function getEdgesGlobal(rings, vm, projFunc, clampLat = 89.9) {
    let allPaths = [];
    rings.forEach(ring => {
        if (ring.length < 2) return;
        let paths = [], currentPath = [];
        for (let j = 0; j < ring.length - 1; j++) {
            const pt1 = ring[j], pt2 = ring[j + 1];
            const dLon = Math.abs(pt1[0] - pt2[0]);
            const EPS = 0.01; 
            const isVertical = Math.abs(pt1[0] - pt2[0]) < 1e-4;
            const isLonEdge = isVertical && (Math.abs(Math.abs(pt1[0]) - 180) < EPS);

            if (dLon > 180 || isLonEdge) {
                currentPath.push([pt1[0], Math.max(-clampLat, Math.min(clampLat, pt1[1]))]);
                if (currentPath.length > 1) paths.push(currentPath);
                currentPath = [];
                continue;
            }
            const dist = Math.max(dLon, Math.abs(pt1[1] - pt2[1]));
            const numSteps = Math.ceil(dist / 2.0);
            for (let s = 0; s < numSteps; s++) {
                const t = s / numSteps;
                currentPath.push([pt1[0] + (pt2[0] - pt1[0]) * t, Math.max(-clampLat, Math.min(clampLat, pt1[1] + (pt2[1] - pt1[1]) * t))]);
            }
        }
        const lastPt = ring[ring.length - 1];
        currentPath.push([lastPt[0], Math.max(-clampLat, Math.min(clampLat, lastPt[1]))]);
        if (currentPath.length > 1) paths.push(currentPath);
        
        paths.forEach(p => allPaths.push(p.map(pt => vm.getOrCreate(projFunc(pt) || [0, 0], pt))));
    });
    return allPaths;
}

function processSingleFeature(f, idx, ctx) {
    const { vm, polyIndices, linePaths, meta, projFunc, clampLat } = ctx;
    const props = f.properties || {};
    const name = props.NAME_FR || props.NAME || props.name || props.admin || `Feature ${idx}`;
    const iso = (props.ISO_A2 || props.iso_a2 || props.iso_3166_1 || `F${idx}`).toUpperCase();

    if (!f.geometry) return;

    let featurePolyIndices = [], featureLinePaths = [];
    const processRingSet = (ringSet) => {
        let ptsLocalIdx = [], holes = [], currentOffset = 0;
        ringSet.forEach((ring, rIdx) => {
            if (currentOffset > 0 && rIdx > 0) holes.push(currentOffset);
            ring.forEach(pt => {
                const safeLat = Math.max(-clampLat, Math.min(clampLat, pt[1]));
                const px = projFunc([pt[0], safeLat]);
                if (px) {
                    ptsLocalIdx.push(vm.getOrCreate(px, [pt[0], safeLat]));
                    currentOffset++;
                }
            });
        });
        if (ptsLocalIdx.length >= 3) {
            const flatProj = [];
            ptsLocalIdx.forEach(gIdx => flatProj.push(vm.vertices[gIdx * 2], vm.vertices[gIdx * 2 + 1]));
            const tris = earcut(flatProj, holes);
            tris.forEach(tIdx => featurePolyIndices.push(ptsLocalIdx[tIdx]));
        }
        getEdgesGlobal(ringSet, vm, projFunc, clampLat).forEach(p => featureLinePaths.push(p));
    };

    const polygonSets = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
    polygonSets.forEach(ringSet => processRingSet(ringSet));

    if (featurePolyIndices.length > 0 || featureLinePaths.length > 0) {
        const polyOffset = polyIndices.length;
        featurePolyIndices.forEach(i => polyIndices.push(i));
        const pathOffset = linePaths.length;
        featureLinePaths.forEach(p => linePaths.push(p));

        meta.push({
            name, iso,
            tri: { offset: polyOffset, count: featurePolyIndices.length },
            path: { offset: pathOffset, count: featureLinePaths.length }
        });
    }
}

function packFile(processed, outputFilename, projId) {
    console.log(` -> Finalisation de ${path.basename(outputFilename)}...`);
    const totalPoints = processed.vm.offset / 2;
    const pPosArr = new Float32Array(processed.vm.vertices.buffer, 0, processed.vm.offset);
    const polyPosBuf = Buffer.from(pPosArr.buffer, pPosArr.byteOffset, pPosArr.byteLength);
    const polyIndBuf = Buffer.from(new Uint32Array(processed.polyIndices).buffer);

    let totalPathVerts = 0;
    processed.linePaths.forEach(p => totalPathVerts += p.length);
    const lpIndArr = new Uint32Array(totalPathVerts);
    const lpPrArr = new Int16Array(totalPathVerts * 2);
    const lpNxArr = new Int16Array(totalPathVerts * 2);
    const lpStartArr = new Uint32Array(processed.linePaths.length);

    let currP = 0;
    const SCALE = 1e5;

    processed.linePaths.forEach((path, i) => {
        lpStartArr[i] = currP;
        const N = path.length;
        const isClosed = (path[0] === path[N - 1] && N > 2);

        for (let j = 0; j < N; j++) {
            const currIdx = path[j];
            lpIndArr[currP + j] = currIdx;

            const pX = processed.vm.vertices[currIdx * 2];
            const pY = processed.vm.vertices[currIdx * 2 + 1];

            let prIdx = j > 0 ? path[j - 1] : (isClosed ? path[N - 2] : path[0]);
            let nxIdx = j < N - 1 ? path[j + 1] : (isClosed ? path[1] : path[N - 1]);

            const prX = processed.vm.vertices[prIdx * 2];
            const prY = processed.vm.vertices[prIdx * 2 + 1];
            const nxX = processed.vm.vertices[nxIdx * 2];
            const nxY = processed.vm.vertices[nxIdx * 2 + 1];

            const writeOffset = (arr, baseIdx, dx, dy) => {
                arr[baseIdx * 2] = Math.max(-32767, Math.min(32767, Math.round(dx * SCALE)));
                arr[baseIdx * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(dy * SCALE)));
            };

            writeOffset(lpPrArr, currP + j, prX - pX, prY - pY);
            writeOffset(lpNxArr, currP + j, nxX - pX, nxY - pY);
        }
        currP += N;
    });

    const lpIndBuf = Buffer.from(lpIndArr.buffer);
    const lpPrBuf = Buffer.from(lpPrArr.buffer);
    const lpNxBuf = Buffer.from(lpNxArr.buffer);
    const lpStartBuf = Buffer.from(lpStartArr.buffer);

    const pad = (buf) => {
        const paddedLen = Math.ceil(buf.length / 4) * 4;
        if (buf.length === paddedLen) return buf;
        const padded = Buffer.alloc(paddedLen, 0x20);
        buf.copy(padded);
        return padded;
    };

    let pMetaBuf = pad(Buffer.from(JSON.stringify(processed.meta), 'utf8'));
    const header = {
        projId, stride: 2, metaLength: pMetaBuf.length,
        polyCount: totalPoints, polyIndexCount: processed.polyIndices.length,
        pathCount: processed.linePaths.length, pathIndexCount: lpIndArr.length,
        offsets: {
            polyPos: 0,
            polyIndices: polyPosBuf.length,
            lpInd: polyPosBuf.length + polyIndBuf.length,
            lpPr: polyPosBuf.length + polyIndBuf.length + lpIndBuf.length,
            lpNx: polyPosBuf.length + polyIndBuf.length + lpIndBuf.length + lpPrBuf.length,
            lpStart: polyPosBuf.length + polyIndBuf.length + lpIndBuf.length + lpPrBuf.length + lpNxBuf.length
        }
    };

    let pHeaderBuf = pad(Buffer.from(JSON.stringify(header), 'utf8'));
    const rawBuf = Buffer.concat([
        Buffer.from('GEOB'),
        Buffer.alloc(4).fill(0).map((_, i) => (pHeaderBuf.length >> (8 * i)) & 0xFF),
        pHeaderBuf, pMetaBuf, polyPosBuf, polyIndBuf, lpIndBuf, lpPrBuf, lpNxBuf, lpStartBuf
    ]);
    fs.writeFileSync(outputFilename, zlib.gzipSync(rawBuf));
    console.log(` -> ${path.basename(outputFilename)} [TERMINE]`);
}

async function streamFeatures(filePath, callback) {
    return new Promise((resolve, reject) => {
        const source = filePath.endsWith('.gz') 
            ? fs.createReadStream(filePath).pipe(zlib.createGunzip())
            : fs.createReadStream(filePath);

        const parser = geojson.parse();
        let count = 0;

        parser.on('data', feature => {
            callback(feature, count++);
        });

        parser.on('end', () => resolve(count));
        parser.on('error', reject);

        source.pipe(parser);
    });
}

const ask = (q) => new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => { rl.close(); res(ans); });
});

async function run() {
    let files = fs.readdirSync(CUSTOM_DATA_DIR).filter(f => f.endsWith('.geojson') || f.endsWith('.geojson.gz'));
    if (files.length === 0) {
        console.log("Aucun fichier GeoJSON trouvé.");
        return;
    }

    files.forEach((f, i) => console.log(`${i + 1}. ${f}`));
    const choiceIdx = parseInt(await ask('Numéro du fichier : ')) - 1;
    const selectedFile = files[choiceIdx];
    const filePath = path.join(CUSTOM_DATA_DIR, selectedFile);

    PROJECTIONS.forEach((p, i) => console.log(`${i + 1}. ${p.name}`));
    const projInput = await ask('Projections (ex: 1,2 ou all) : ');
    const selectedProjs = projInput.trim() === 'all' ? [...PROJECTIONS] : projInput.split(',').map(n => PROJECTIONS[parseInt(n.trim()) - 1]).filter(Boolean);

    const useStreaming = (await ask('Utiliser le mode Streaming (fichiers > 200Mo) ? (y/n) : ')).toLowerCase() === 'y';

    const baseName = selectedFile.replace(/\.geojson(\.gz)?$/, '');

    for (const proj of selectedProjs) {
        console.log(`\nTraitement : ${selectedFile} [${proj.name}]${useStreaming ? ' (STREAMING)' : ''}`);
        const ctx = {
            vm: new GlobalVertexManager(),
            polyIndices: [],
            linePaths: [],
            meta: [],
            projFunc: proj.project(),
            clampLat: proj.clampLat || 89.9
        };

        if (useStreaming) {
            await streamFeatures(filePath, (f, idx) => {
                if (idx % 1000 === 0 && idx > 0) process.stdout.write(`\rFeatures : ${idx}...`);
                processSingleFeature(f, idx, ctx);
            });
            console.log(`\n${ctx.meta.length} features traitées.`);
        } else {
            const content = fs.readFileSync(filePath);
            const countries = JSON.parse(selectedFile.endsWith('.gz') ? zlib.gunzipSync(content) : content);
            countries.features.forEach((f, idx) => {
                if (idx % 1000 === 0 && idx > 0) process.stdout.write(`\rFeatures : ${idx}...`);
                processSingleFeature(f, idx, ctx);
            });
            console.log(`\n${ctx.meta.length} features traitées.`);
        }
        const outName = `${baseName}_${proj.id}.bin`;
        const outPath = path.join(OUTPUT_DIR, outName);
        packFile(ctx, outPath, proj.id);
    }
    console.log('\n--- TERMINÉ ---');
}
run();
