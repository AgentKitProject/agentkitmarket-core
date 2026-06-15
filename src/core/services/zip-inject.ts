/**
 * Dependency-free, minimal ZIP single-file injector for per-buyer watermarking.
 *
 * `.agentkit.zip` packages are standard ZIP archives. To watermark a package we
 * inject (or overwrite) exactly one file — `.agentkit-license/LICENSE.txt` —
 * without re-compressing the rest of the archive. We do this by parsing the
 * End-Of-Central-Directory (EOCD) record and the existing central directory,
 * appending a new STORED (uncompressed) local file entry for the watermark file,
 * dropping any prior central-directory entry with the same name, appending a
 * fresh central directory, and writing a new EOCD.
 *
 * Why no library: @agentkitforge/market-core must stay `npm install`-clean on
 * every platform (no native deps); a full zip lib (jszip) is heavier than the
 * one operation we need. STORED-mode injection is deterministic and testable.
 *
 * Scope/limits (v1): handles standard (non-ZIP64) archives, which covers Agent
 * Kits (capped at 100MB uncompressed / 2000 entries by core's package
 * safeguards, well under ZIP64 thresholds). If an EOCD is not found the input is
 * not a recognizable zip and we throw — the route surfaces a 500. A future
 * iteration can add ZIP64 support if package limits ever grow.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;

/** CRC-32 (IEEE 802.3) — needed for both local and central headers. */
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface CentralEntry {
  /** The raw central-directory record bytes (variable length). */
  record: Buffer;
  fileName: string;
}

/** Finds the EOCD record offset by scanning backwards (no zip comment expected). */
function findEocd(buf: Buffer): number {
  // Scan from the end; the EOCD has a max 64KB trailing comment, but Agent Kit
  // packages carry none, so a bounded backward scan is sufficient and safe.
  const minStart = Math.max(0, buf.length - (EOCD_MIN_SIZE + 0xffff));
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return -1;
}

function parseCentralDirectory(buf: Buffer, cdOffset: number, cdCount: number): CentralEntry[] {
  const entries: CentralEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < cdCount; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('Malformed central directory entry');
    }
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const recordLen = 46 + nameLen + extraLen + commentLen;
    const record = buf.subarray(offset, offset + recordLen);
    const fileName = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ record: Buffer.from(record), fileName });
    offset += recordLen;
  }
  return entries;
}

/**
 * Injects (or overwrites) a single STORED file into a zip. Returns the new zip
 * bytes. `fileName` should use forward slashes (zip convention).
 */
export function injectFileIntoZip(zip: Buffer, fileName: string, content: string): Buffer {
  const eocdOffset = findEocd(zip);
  if (eocdOffset < 0) {
    throw new Error('Not a valid zip archive (EOCD not found)');
  }

  const cdCount = zip.readUInt16LE(eocdOffset + 10);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);

  // Everything before the central directory = local file records we keep as-is.
  const localSection = zip.subarray(0, cdOffset);
  const existing = parseCentralDirectory(zip, cdOffset, cdCount)
    // Drop any prior entry with the same name so we overwrite rather than dupe.
    .filter((entry) => entry.fileName !== fileName);

  const nameBytes = Buffer.from(fileName, 'utf8');
  const dataBytes = Buffer.from(content, 'utf8');
  const crc = crc32(dataBytes);
  const newLocalOffset = localSection.length;

  // --- new local file header (STORED, no compression) ---
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(LOCAL_SIGNATURE, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // method 0 = stored
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(dataBytes.length, 18); // compressed size
  localHeader.writeUInt32LE(dataBytes.length, 22); // uncompressed size
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra len

  // --- new central directory record for the injected file ---
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(0, 10); // method
  centralHeader.writeUInt16LE(0, 12); // mod time
  centralHeader.writeUInt16LE(0x21, 14); // mod date
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(dataBytes.length, 20);
  centralHeader.writeUInt32LE(dataBytes.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra
  centralHeader.writeUInt16LE(0, 32); // comment
  centralHeader.writeUInt16LE(0, 34); // disk
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(newLocalOffset, 42); // local header offset

  // Assemble: existing local section + new local entry + central dir + EOCD.
  const newLocalEntry = Buffer.concat([localHeader, nameBytes, dataBytes]);
  const localOut = Buffer.concat([localSection, newLocalEntry]);

  const newCentralRecord = Buffer.concat([centralHeader, nameBytes]);
  const centralOut = Buffer.concat([...existing.map((e) => e.record), newCentralRecord]);

  const totalEntries = existing.length + 1;
  const newCdOffset = localOut.length;

  const eocd = Buffer.alloc(EOCD_MIN_SIZE);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(totalEntries, 8);
  eocd.writeUInt16LE(totalEntries, 10);
  eocd.writeUInt32LE(centralOut.length, 12); // cd size
  eocd.writeUInt32LE(newCdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localOut, centralOut, eocd]);
}

/** Reads all bytes from an AsyncIterable<Uint8Array> (an ObjectStore stream). */
export async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
