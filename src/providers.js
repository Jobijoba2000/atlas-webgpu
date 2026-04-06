import { appState } from './state/appState.js';
import { isOrthographic } from './core/camera.js';

export const NATURAL_EARTH_PROVIDER = {
    id: 'natural_earth',
    async loadData(onProgress) {
        const res = appState.get('resolution') || '10m';
        const projId = isOrthographic ? 'lonlat' : appState.get('projection');

        if (!this._fetchAndDecode) {
            this._fetchAndDecode = async (url) => {
                const response = await fetch(url);
                if (!response.ok) return null;
                let buf = new Uint8Array(await response.arrayBuffer());

                // Décompression si GZIP (magic: 1f 8b)
                if (buf[0] === 0x1f && buf[1] === 0x8b) {
                    const ds = new DecompressionStream('gzip');
                    const decompressedStream = new Response(buf).body.pipeThrough(ds);
                    buf = new Uint8Array(await new Response(decompressedStream).arrayBuffer());
                }

                const magic = new TextDecoder().decode(buf.slice(0, 4));
                if (magic !== 'GEOB') throw new Error("Format Binaire non reconnu");
                const dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                const headerLen = dataView.getUint32(4, true);
                const headerStr = new TextDecoder().decode(buf.slice(8, 8 + headerLen));
                const header = JSON.parse(headerStr);
                const metaOffset = 8 + headerLen;
                const metaStr = new TextDecoder().decode(buf.slice(metaOffset, metaOffset + header.metaLength));
                const meta = JSON.parse(metaStr);
                return { meta, header, buffer: buf.buffer, dataOffset: metaOffset + header.metaLength };
            };
        }

        const countriesUrl = `data/binary/${res}/countries_${res}_${projId}.bin`;

        try {
            const countries = await this._fetchAndDecode(countriesUrl);
            if (!countries) throw new Error(`Échec du chargement : ${countriesUrl}`);
            if (onProgress) onProgress(100);
            return { countries };
        } catch (e) {
            console.error(`Error loading data for ${projId}:`, e);
            return {};
        }
    }
};

export function getProvider() {
    return NATURAL_EARTH_PROVIDER;
}
