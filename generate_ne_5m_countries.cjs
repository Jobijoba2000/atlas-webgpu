/**
 * generate_ne_5m_countries.cjs
 * 
 * Génère le fichier ne_5m_admin_0_countries.geojson en fusionnant GADM 4.1 et NE 10m.
 * Respecte strictement la structure de ne_10m_admin_0_countries.geojson.
 */

const fs = require('fs');
const path = require('path');

const NE_IN = 'data_ne/ne_10m_admin_0_countries.geojson';
const GADM_DIR = path.join(__dirname, 'data_gadm/level_0');
const OUT_FILE = 'data/natural_earth/ne_5m_admin_0_countries.geojson';

if (!fs.existsSync('data/natural_earth')) fs.mkdirSync('data/natural_earth', { recursive: true });

// --- CONFIGURATION DU MAPPING SPECIAL ---

const MULTI_GADM = {
    'FRA': ['FRA', 'GUF', 'GLP', 'MTQ', 'MYT', 'REU'],
    'NOR': ['NOR', 'SJM'],
    'NLD': ['NLD', 'BES'],
    'AUS': ['AUS', 'CCK', 'CXR'],
    'NZL': ['NZL', 'TKL'],
    'MAR': ['MAR', 'ESH']
};

const SKIP_FEATURES = new Set(['SAH']);

const NO_GADM = new Set([
    'ESB', 'USG', 'HKG', 'KAS', 'WSB', 'SPI', 'BRT', 'PGA', 'MAC', 'BJN', 'SER', 'SCR'
]);

// Pays où GADM est incomplet par rapport à NE (ex: îles Prince Edward pour ZAF)
const PARTIAL_GADM = {
    'ZAF': ['ZAF'], // Prendra GADM + les polygones NE orphelins
    'GBR': ['GBR']
};

// --- UTILS ---

function getPolygons(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
}

function getBBox(poly) {
    let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    poly[0].forEach(pt => {
        if (pt[0] < minLon) minLon = pt[0]; if (pt[0] > maxLon) maxLon = pt[0];
        if (pt[1] < minLat) minLat = pt[1]; if (pt[1] > maxLat) maxLat = pt[1];
    });
    return { minLon, maxLon, minLat, maxLat };
}

function distBBox(b1, b2) {
    const dLon = Math.max(0, b1.minLon - b2.maxLon, b2.minLon - b1.maxLon);
    const dLat = Math.max(0, b1.minLat - b2.maxLat, b2.minLat - b1.maxLat);
    return Math.sqrt(dLon * dLon + dLat * dLat);
}

function loadGadmPolygons(codes) {
    let allPolys = [];
    for (const code of codes) {
        const f = path.join(GADM_DIR, `gadm41_${code}_0.json`);
        if (!fs.existsSync(f)) {
            console.warn(`  [WARN] GADM ${code} introuvable`);
            continue;
        }
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        data.features.forEach(feat => {
            allPolys = allPolys.concat(getPolygons(feat.geometry));
        });
    }
    return allPolys;
}

// --- MAIN ---

console.log('Chargement NE 10m...');
const neData = JSON.parse(fs.readFileSync(NE_IN, 'utf8'));
const outFeatures = [];

neData.features.forEach((neFeat, idx) => {
    const p = neFeat.properties;
    const adm0 = p.ADM0_A3;
    const name = p.NAME;

    if (SKIP_FEATURES.has(adm0)) {
        console.log(`  [SKIP] Suppression de l'entité séparée : ${name} (${adm0})`);
        return;
    }

    let finalPolygons = [];
    let method = '';

    if (NO_GADM.has(adm0)) {
        // CAS 1 : Pas de GADM
        finalPolygons = getPolygons(neFeat.geometry);
        method = 'NE-ONLY';
    }
    else if (MULTI_GADM[adm0]) {
        // CAS 2 : Fusion multi-GADM
        finalPolygons = loadGadmPolygons(MULTI_GADM[adm0]);
        method = `GADM-MERGE(${MULTI_GADM[adm0].join(',')})`;
    }
    else {
        // CAS 3 & 4 : GADM simple ou partiel
        const gadmCode = adm0 === 'XKX' ? 'XKO' : (adm0 === 'CYN' ? 'ZNC' : adm0);
        const gadmPolys = loadGadmPolygons([gadmCode]);

        if (gadmPolys.length === 0) {
            finalPolygons = getPolygons(neFeat.geometry);
            method = 'NE-FALLBACK';
        } else {
            finalPolygons = gadmPolys;
            method = 'GADM-BASIC';

            // Pour les partiels (ZAF, GBR, MAR), on vérifie si NE a des polygones "loin" du GADM
            if (PARTIAL_GADM[adm0] || ['ZAF', 'GBR', 'MAR'].includes(adm0)) {
                const nePolys = getPolygons(neFeat.geometry);
                const gadmFullBBox = gadmPolys.map(getBBox).reduce((acc, b) => ({
                    minLon: Math.min(acc.minLon, b.minLon), maxLon: Math.max(acc.maxLon, b.maxLon),
                    minLat: Math.min(acc.minLat, b.minLat), maxLat: Math.max(acc.maxLat, b.maxLat)
                }), { minLon: 180, maxLon: -180, minLat: 90, maxLat: -90 });

                nePolys.forEach(neP => {
                    const neB = getBBox(neP);
                    // Si le polygone NE est à plus de 2 degrés du bloc GADM, on l'ajoute
                    if (distBBox(neB, gadmFullBBox) > 2.0) {
                        finalPolygons.push(neP);
                        method += '+NE-EXTRA';
                    }
                });
            }
        }
    }

    outFeatures.push({
        type: 'Feature',
        properties: { ...p, SOURCE: method },
        geometry: {
            type: 'MultiPolygon',
            coordinates: finalPolygons
        }
    });

    if (idx % 50 === 0) console.log(`Processed ${idx}/${neData.features.length} (${name})...`);
});

const output = {
    type: 'FeatureCollection',
    features: outFeatures
};

fs.writeFileSync(OUT_FILE, JSON.stringify(output));
console.log(`\nFini ! Fichier généré : ${OUT_FILE}`);
console.log(`Total features : ${outFeatures.length}`);
