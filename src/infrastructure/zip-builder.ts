import fs from 'fs';

export interface ZipFileEntry {
  name: string;
  // Read from disk when set. Ignored if `content` is also set.
  path?: string;
  // Used directly (no disk I/O) when set — for content generated in memory, e.g. exported
  // markdown text, rather than an existing file on disk.
  content?: Buffer;
}

/**
 * Creates a standard ZIP archive buffer containing the given files.
 * Pure TypeScript implementation without external native dependencies.
 */
export function createZipArchive(files: ZipFileEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const cdHeaders: Buffer[] = [];
  let offset = 0;
  let validFileCount = 0;

  for (const file of files) {
    const content = file.content ?? (file.path && fs.existsSync(file.path) ? fs.readFileSync(file.path) : null);
    if (!content) continue;
    const fileNameBuf = Buffer.from(file.name || 'document.pdf', 'utf8');

    const crc = crc32(content);
    const size = content.length;

    // Local File Header
    const localHeader = Buffer.alloc(30 + fileNameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4);         // Version needed
    localHeader.writeUInt16LE(0x0800, 6);     // General flag: bit 11 (EFS) = filename is UTF-8
    localHeader.writeUInt16LE(0, 8);          // Compression method (0 = STORE)
    localHeader.writeUInt16LE(0, 10);         // Last mod time
    localHeader.writeUInt16LE(0, 12);         // Last mod date
    localHeader.writeUInt32LE(crc, 14);       // CRC32
    localHeader.writeUInt32LE(size, 18);      // Compressed size
    localHeader.writeUInt32LE(size, 22);      // Uncompressed size
    localHeader.writeUInt16LE(fileNameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileNameBuf.copy(localHeader, 30);

    // Central Directory Header
    const cdHeader = Buffer.alloc(46 + fileNameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8);        // General flag: bit 11 (EFS) = filename is UTF-8
    cdHeader.writeUInt16LE(0, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(size, 20);
    cdHeader.writeUInt32LE(size, 24);
    cdHeader.writeUInt16LE(fileNameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42);
    fileNameBuf.copy(cdHeader, 46);

    localHeaders.push(localHeader, content);
    cdHeaders.push(cdHeader);
    offset += localHeader.length + size;
    validFileCount++;
  }

  const cdBuffer = Buffer.concat(cdHeaders);
  const cdOffset = offset;
  const cdSize = cdBuffer.length;

  // End of Central Directory Record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(validFileCount, 8);
  eocd.writeUInt16LE(validFileCount, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuffer, eocd]);
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
