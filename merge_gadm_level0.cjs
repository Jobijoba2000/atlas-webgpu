/**
 * merge_gadm_level0.js
 *
 * Fusionne tous les fichiers GADM 4.1 level_0 en un seul FeatureCollection GeoJSON.
 * Les propriétés sont enrichies avec les métadonnées du Natural Earth 10m
 * (MAPCOLOR13, CONTINENT, REGION_UN, etc.) en faisant la jointure via le code ISO A3.
 *
 * Usage : node merge_gadm_level0.js
 * Sortie : data_ne/ne_10m_admin_0_countries_gadm.geojson
 */

const fs = require('fs');
const path = require('path');

// ── Chemins ──────────────────────────────────────────────────────────────────
const GADM_DIR = path.join(__dirname, 'data_gadm/level_0');
const NE_FILE = path.join(__dirname, 'data_ne/ne_10m_admin_0_countries.geojson');
const OUT_FILE = path.join(__dirname, 'data_ne/ne_10m_admin_0_countries_gadm.geojson');

// ── Chargement NE 10m ────────────────────────────────────────────────────────
console.log('Chargement Natural Earth 10m…');
const neData = JSON.parse(fs.readFileSync(NE_FILE, 'utf8'));

// Index NE par tous les codes ISO A3 disponibles
const neIndex = {};
for (const feat of neData.features) {
    const p = feat.properties;
    // Champs clés à tester (plusieurs variantes présentes dans NE)
    for (const key of ['ADM0_A3', 'ADM0_ISO', 'GU_A3', 'SU_A3', 'BRK_A3', 'ISO_A3_EH', 'WB_A3']) {
        const code = p[key];
        if (code && code !== '-99' && !neIndex[code]) {
            neIndex[code] = p;
        }
    }
}

// ── Lecture des fichiers GADM ────────────────────────────────────────────────
console.log('Lecture des fichiers GADM…');
const gadmFiles = fs.readdirSync(GADM_DIR).filter(f => f.endsWith('.json'));

const features = [];
let matched = 0, unmatched = 0;

for (const file of gadmFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(GADM_DIR, file), 'utf8'));
    const iso3 = raw.features?.[0]?.properties?.GID_0;
    const name = raw.features?.[0]?.properties?.COUNTRY;

    if (!iso3) {
        console.warn(`  ⚠ Pas de GID_0 dans ${file}, ignoré.`);
        continue;
    }

    const ne = neIndex[iso3];

    // Propriétés : COPIE STRICTE de NE si disponible, sinon fallback basique GADM
    const finalProps = ne ? { ...ne } : {
        GID_0: iso3,
        ADM0_A3: iso3,
        NAME: name ?? iso3,
        NAME_LONG: name ?? iso3,
        SOURCE: 'GADM 4.1 (Unmatched)',
    };

    if (ne) {
        finalProps.GID_0 = iso3;
        finalProps.SOURCE = 'GADM 4.1 + Natural Earth';
    }

    if (ne) matched++; else unmatched++;

    // Chaque fichier GADM peut contenir plusieurs features (MultiPolygon éclaté)
    // On les regroupe en une seule feature avec la géométrie d'origine
    for (const f of raw.features) {
        features.push({
            type: 'Feature',
            properties: { ...finalProps },
            geometry: f.geometry,
        });
    }
}

// ── Écriture ─────────────────────────────────────────────────────────────────
console.log(`\nFichiers traités : ${gadmFiles.length}`);
console.log(`  Avec correspondance NE : ${matched}`);
console.log(`  Sans correspondance NE : ${unmatched}`);
console.log(`  Features totales       : ${features.length}`);

const output = {
    type: 'FeatureCollection',
    features,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(output));
console.log(`\n✓ Fichier écrit : ${OUT_FILE}`);
