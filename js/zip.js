// Minimal zip reader (stored + deflate entries). No DOM; needs DecompressionStream('deflate-raw').

const u16 = (d, o) => d.getUint16(o, true);
const u32 = (d, o) => d.getUint32(o, true);

/** List entries from the central directory. */
export function listZipEntries(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file.');
  const count = u16(dv, eocd + 10);
  let p = u32(dv, eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (u32(dv, p) !== 0x02014b50) throw new Error('Corrupt zip directory.');
    const method = u16(dv, p + 10);
    const compSize = u32(dv, p + 20);
    const nameLen = u16(dv, p + 28), extraLen = u16(dv, p + 30), commentLen = u16(dv, p + 32);
    const localOffset = u32(dv, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipEntry(buf, entry) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = entry.localOffset;
  if (u32(dv, o) !== 0x04034b50) throw new Error('Corrupt zip entry.');
  const start = o + 30 + u16(dv, o + 26) + u16(dv, o + 28);
  const data = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error('Unsupported zip compression method ' + entry.method);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unzip files. Extract the zip and import readings.csv instead.');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Text of the first entry whose name ends in readings.csv. */
export async function readReadingsCsvFromZip(buf) {
  const entry = listZipEntries(buf).find(e => /readings\.csv$/i.test(e.name));
  if (!entry) throw new Error('No readings.csv found inside the zip.');
  return new TextDecoder().decode(await readZipEntry(buf, entry));
}
