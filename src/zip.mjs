/**
 * Minimal ZIP reader/writer using only Web platform APIs, so the exact same
 * module runs in the browser and in Node 18+ (CompressionStream is global in
 * both). No Buffer, no node:zlib, no dependencies.
 *
 * Entry order matters: Bingers sniffs the archive format by scanning the first
 * 512 KB for marker filenames, so we control ordering explicitly rather than
 * delegating to a library that may reorder entries.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

async function pipe(bytes, stream) {
    const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await response.arrayBuffer());
}

const deflateRaw = bytes => pipe(bytes, new CompressionStream('deflate-raw'));
const inflateRaw = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));

function dosDateTime(date) {
    // ZIP stores MS-DOS timestamps: epoch 1980, two-second resolution.
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/**
 * Reads a ZIP archive into a Map of filename -> Uint8Array.
 * Handles the stored (0) and deflate (8) methods, which is all these exporters
 * ever emit.
 * @param {ArrayBuffer|Uint8Array} input
 */
export async function readZip(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const files = new Map();

    for (let i = 0; i < count; i++) {
        if (view.getUint32(offset, true) !== CENTRAL_SIG) break;
        const method = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);
        const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

        // The local header repeats name/extra lengths and they may differ from
        // the central directory's, so the data offset must be read from there.
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = bytes.subarray(dataStart, dataStart + compressedSize);

        if (!name.endsWith('/')) {
            files.set(name, method === 8 ? await inflateRaw(raw) : raw.slice());
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }

    return files;
}

/** Convenience: read a ZIP entry as UTF-8 text. */
export function textOf(bytes) {
    return decoder.decode(bytes);
}

/**
 * Writes entries, preserving the given order, into a ZIP archive.
 * @param {Array<{name: string, data: Uint8Array|string}>} entries
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(entries, { date = new Date() } = {}) {
    const { time, day } = dosDateTime(date);
    const chunks = [];
    const centrals = [];
    let offset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
        const compressed = await deflateRaw(data);
        // Deflate can grow tiny or incompressible payloads; fall back to stored.
        const useDeflate = compressed.length < data.length;
        const payload = useDeflate ? compressed : data;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(data);

        const local = new Uint8Array(30);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, LOCAL_SIG, true);
        localView.setUint16(4, 20, true);       // version needed
        localView.setUint16(6, 0x0800, true);   // UTF-8 filename flag
        localView.setUint16(8, method, true);
        localView.setUint16(10, time, true);
        localView.setUint16(12, day, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, payload.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, name.length, true);
        chunks.push(local, name, payload);

        const central = new Uint8Array(46);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, CENTRAL_SIG, true);
        centralView.setUint16(4, 20, true);     // version made by
        centralView.setUint16(6, 20, true);     // version needed
        centralView.setUint16(8, 0x0800, true);
        centralView.setUint16(10, method, true);
        centralView.setUint16(12, time, true);
        centralView.setUint16(14, day, true);
        centralView.setUint32(16, crc, true);
        centralView.setUint32(20, payload.length, true);
        centralView.setUint32(24, data.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, offset, true);
        centrals.push(central, name);

        offset += local.length + name.length + payload.length;
    }

    const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, EOCD_SIG, true);
    eocdView.setUint16(8, entries.length, true);
    eocdView.setUint16(10, entries.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);

    const all = [...chunks, ...centrals, eocd];
    const total = all.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of all) { out.set(part, cursor); cursor += part.length; }
    return out;
}
