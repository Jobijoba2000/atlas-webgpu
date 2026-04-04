import * as d3 from 'd3';
import { PROJECTIONS } from '../config/projections.js';

export function geometryBox(geometry) {
    const coords = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    coords.forEach(poly => poly.forEach(ring => ring.forEach(pt => {
        if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1]; if (pt[1] > maxY) maxY = pt[1];
    })));
    return [[minX, minY], [maxX, maxY]];
}

export function rewindRing(ring, dir) {
    let area = 0, err = 0;
    for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
        const k = (ring[i][0] - ring[j][0]) * (ring[j][1] + ring[i][1]);
        const m = area + k; area = m;
    }
    if (area >= 0 !== dir) ring.reverse();
}

export function rewind(feature) {
    const coords = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    coords.forEach(poly => poly.forEach((ring, i) => rewindRing(ring, i === 0)));
}

export function parseHexColor(hex) {
    const c = d3.color(hex || '#ffffff').rgb();
    return [c.r / 255, c.g / 255, c.b / 255];
}

const PALETTE = ['#700000', '#633d00', '#715e00', '#456300', '#005500', '#006363', '#004471', '#000e6e', '#270071', '#4d0071', '#710071', '#710041', '#71001d'];
export function getMapColor(index) {
    const idx = Math.max(1, Math.min(13, parseInt(index) || 1)) - 1;
    return parseHexColor(PALETTE[idx]);
}

export function computeLabelLayout(m, atlas) {
    const position = m.labelMetrics ? m.labelMetrics.point : [0, 0];
    if (!m.name || !m.labelMetrics || !atlas) return { size: 1.0, position };

    const name = m.name;
    let totalAdvance = 0;
    for (const char of name.normalize('NFC')) {
        const metric = atlas.metrics[char] || atlas.metrics[' '];
        if (metric) totalAdvance += metric.advance;
    }
    if (totalAdvance === 0) return { size: 1.0, position };

    const realWidth = m.labelMetrics.width || 1.0;
    const baseSize = realWidth / totalAdvance; // 100% de la largeur utile

    // 1. Logarithmique
    const logMultiplier = 1.0 / Math.max(1.0, Math.log10(realWidth));

    // 2. Ajustement par caractères
    const charCount = Array.from(name.normalize('NFC')).length;
    let charMultiplier = 1.0;
    if (charCount >= 1 && charCount <= 5) {
        charMultiplier = 0.5;
    } else if (charCount >= 6 && charCount <= 10) {
        charMultiplier = 0.7;
    } else if (charCount >= 11 && charCount <= 15) {
        charMultiplier = 0.9;
    }

    let finalMultiplier = logMultiplier * charMultiplier;

    // 3. Ratio de la Croix Centrale (Hauteur / Largeur Utile)
    const bbox = m.labelMetrics.polygonBBox || m.bbox;
    if (bbox) {
        let bboxHeight;
        if (bbox.length === 4 && typeof bbox[0] === 'number') {
            bboxHeight = bbox[3] - bbox[1];
        } else if (bbox.length === 2 && Array.isArray(bbox[0])) {
            bboxHeight = bbox[1][1] - bbox[0][1];
        }

        if (bboxHeight !== undefined) {
            const ratio = Math.abs(bboxHeight / realWidth);
            finalMultiplier = finalMultiplier * ratio;
        }
    }

    // Le texte ne dépassera pas les bords géométriques de la largeur utile
    finalMultiplier = Math.min(1.0, finalMultiplier);
    
    const size = Math.max(0.001, baseSize * finalMultiplier);

    return { size, position };
}

export function getTextGeometry(text, size, atlas) {
    const positions = [], uvs = [];
    const normalizedText = (text || "").normalize('NFC');
    let totalWidth = 0;
    for (const char of normalizedText) {
        const m = atlas.metrics[char] || atlas.metrics[' '];
        if (m) totalWidth += m.advance;
    }
    let currentX = -totalWidth / 2;
    for (const char of normalizedText) {
        const m = atlas.metrics[char] || atlas.metrics[' '];
        if (!m) continue;
        const x0 = currentX, x1 = currentX + m.width, y0 = -m.height / 2, y1 = m.height / 2;
        positions.push([x0, y0], [x1, y0], [x0, y1], [x0, y1], [x1, y0], [x1, y1]);
        uvs.push([m.u0, m.v0], [m.u1, m.v0], [m.u0, m.v1], [m.u0, m.v1], [m.u1, m.v0], [m.u1, m.v1]);
        currentX += m.advance;
    }
    return { positions: new Float32Array(positions.flat()), uvs: new Float32Array(uvs.flat()) };
}

export function getProjectionTextScale(projId, isOrtho, uAnchorLL) {
    const M_EQUATOR = 120 * 2 * Math.PI;
    const GLOBAL_FACTOR = 1.0; // Rétabli à 100%

    if (isOrtho) {
        const pxPerDegree = M_EQUATOR / 360.0;
        const lat = (uAnchorLL && uAnchorLL.length > 1) ? uAnchorLL[1] : 0;
        const localCos = Math.cos(lat * Math.PI / 180.0);
        return pxPerDegree * localCos * GLOBAL_FACTOR;
    }

    const projDef = PROJECTIONS.find(p => p.id === projId);
    if (!projDef || !projDef.project) return 1.0 * GLOBAL_FACTOR;

    const proj = projDef.project(120);
    const ptLeft = proj([-180, 0]);
    const ptRight = proj([180, 0]);
    const P_EQUATOR = Math.abs(ptRight[0] - ptLeft[0]);

    if (P_EQUATOR < 1) return 1.0 * GLOBAL_FACTOR;
    return (P_EQUATOR / M_EQUATOR) * GLOBAL_FACTOR;
}
