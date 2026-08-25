import { inflateRaw } from "node:zlib";

/**
 * A deliberately small ZIP reader for package wheels. It reads central-directory
 * metadata only and never writes an entry to disk.
 */

export type ZipResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;

// Wheels used by the API extractor are much smaller than these limits. The
// caps keep malformed archives and decompression bombs bounded even if this
// reader is used elsewhere later.
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_COMPRESSED_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_ENTRY_BYTES = 16 * 1024 * 1024;

function error<T>(message: string): ZipResult<T> {
  return { ok: false, error: message };
}

function safeAdd(left: number, right: number): number | undefined {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= left && total >= right ? total : undefined;
}

function isRangeWithin(offset: number, size: number, length: number): boolean {
  const end = safeAdd(offset, size);
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && end !== undefined && end <= length;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array, label: string): ZipResult<string> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return error(`ZIP ${label} contains a NUL byte.`);
    return { ok: true, value: text };
  } catch {
    return error(`ZIP ${label} is not valid UTF-8.`);
  }
}

function inflate(compressed: Uint8Array, maxOutputLength: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    inflateRaw(compressed, { maxOutputLength }, (inflateError, output) => {
      if (inflateError) {
        reject(inflateError);
        return;
      }
      resolve(output);
    });
  });
}

/** Parsed central-directory metadata with bounded, on-demand text extraction. */
export class ZipArchive {
  private readonly names: readonly string[];

  constructor(
    private readonly bytes: Uint8Array,
    private readonly archiveStart: number,
    private readonly entriesByName: ReadonlyMap<string, ZipEntry>,
  ) {
    this.names = [...entriesByName.keys()].sort((left, right) => left.localeCompare(right));
  }

  /** Returns a stable copy so callers cannot mutate archive state. */
  listEntryNames(): string[] {
    return [...this.names];
  }

  /** Alias kept concise for consumers which want to enumerate a wheel. */
  entries(): string[] {
    return this.listEntryNames();
  }

  /**
   * Extract exactly one stored or deflated entry as UTF-8 text. Failures are
   * reported as results: malformed input, unsupported compression, and zlib
   * errors never escape to the caller.
   */
  async extractText(name: string): Promise<ZipResult<string>> {
    try {
      const entry = this.entriesByName.get(name);
      if (!entry) return error(`ZIP entry not found: ${name}.`);
      if ((entry.flags & 0x0001) !== 0) return error(`ZIP entry is encrypted: ${name}.`);
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        return error(`ZIP entry uses unsupported compression method ${entry.compressionMethod}: ${name}.`);
      }

      const localHeaderOffset = safeAdd(this.archiveStart, entry.localHeaderOffset);
      if (localHeaderOffset === undefined || !isRangeWithin(localHeaderOffset, LOCAL_FILE_HEADER_SIZE, this.bytes.byteLength)) {
        return error(`ZIP local header is outside the archive: ${name}.`);
      }

      const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
        return error(`ZIP local header signature is invalid: ${name}.`);
      }

      const localFlags = view.getUint16(localHeaderOffset + 6, true);
      const localMethod = view.getUint16(localHeaderOffset + 8, true);
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      if ((localFlags & 0x0001) !== 0 || localMethod !== entry.compressionMethod) {
        return error(`ZIP local header does not match central-directory metadata: ${name}.`);
      }

      const localNameOffset = safeAdd(localHeaderOffset, LOCAL_FILE_HEADER_SIZE);
      const dataOffset = localNameOffset === undefined
        ? undefined
        : safeAdd(localNameOffset, localNameLength + localExtraLength);
      if (localNameOffset === undefined || dataOffset === undefined || !isRangeWithin(localNameOffset, localNameLength, this.bytes.byteLength)) {
        return error(`ZIP local header is truncated: ${name}.`);
      }
      if (!bytesEqual(this.bytes.subarray(localNameOffset, localNameOffset + localNameLength), entry.nameBytes)) {
        return error(`ZIP local entry name does not match central-directory metadata: ${name}.`);
      }
      if (!isRangeWithin(dataOffset, entry.compressedSize, this.bytes.byteLength)) {
        return error(`ZIP entry data is truncated: ${name}.`);
      }

      const compressed = this.bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
      const output = entry.compressionMethod === 0
        ? compressed
        : await inflate(compressed, entry.uncompressedSize);
      if (output.byteLength !== entry.uncompressedSize) {
        return error(`ZIP entry size does not match central-directory metadata: ${name}.`);
      }

      return decodeUtf8(output, `entry ${name}`);
    } catch {
      return error(`Could not extract ZIP entry safely: ${name}.`);
    }
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number | undefined {
  const start = Math.max(0, bytes.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_SIZE);
  for (let offset = bytes.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= start; offset--) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength === bytes.byteLength) return offset;
  }
  return undefined;
}

/**
 * Parses a conventional, single-disk ZIP archive. ZIP64 and split archives are
 * intentionally rejected rather than attempting unsafe partial support.
 */
export function parseZip(bytes: Uint8Array): ZipResult<ZipArchive> {
  try {
    if (!(bytes instanceof Uint8Array)) return error("ZIP input must be a byte array.");
    if (bytes.byteLength < END_OF_CENTRAL_DIRECTORY_SIZE) return error("ZIP archive is truncated before its central directory.");
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) return error("ZIP archive exceeds the safe size limit.");

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findEndOfCentralDirectory(bytes, view);
    if (eocdOffset === undefined) return error("ZIP end-of-central-directory record was not found.");

    const diskNumber = view.getUint16(eocdOffset + 4, true);
    const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
    const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
    const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
      return error("Split ZIP archives are not supported.");
    }
    if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
      return error("ZIP64 archives are not supported.");
    }
    if (entryCount > MAX_ENTRIES) return error("ZIP archive has too many entries.");
    if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) return error("ZIP central directory exceeds the safe size limit.");

    // The offsets recorded by a ZIP are relative to the archive start. This
    // also safely supports a small self-extracting prefix without searching
    // unboundedly for central-directory records.
    const archiveStart = eocdOffset - centralDirectorySize - centralDirectoryOffset;
    if (!Number.isSafeInteger(archiveStart) || archiveStart < 0) return error("ZIP central-directory offset is invalid.");
    const centralOffset = safeAdd(archiveStart, centralDirectoryOffset);
    if (centralOffset === undefined || !isRangeWithin(centralOffset, centralDirectorySize, bytes.byteLength)) {
      return error("ZIP central directory is outside the archive.");
    }
    const centralEnd = centralOffset + centralDirectorySize;
    if (centralEnd > eocdOffset) return error("ZIP central directory overlaps its end record.");

    const entries = new Map<string, ZipEntry>();
    let offset = centralOffset;
    for (let index = 0; index < entryCount; index++) {
      if (!isRangeWithin(offset, CENTRAL_DIRECTORY_HEADER_SIZE, centralEnd)) {
        return error("ZIP central directory is truncated.");
      }
      if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
        return error("ZIP central-directory entry signature is invalid.");
      }

      const flags = view.getUint16(offset + 8, true);
      const compressionMethod = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const diskStart = view.getUint16(offset + 34, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);

      if (diskStart !== 0) return error("Split ZIP entries are not supported.");
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        return error("ZIP64 entry metadata is not supported.");
      }
      if (compressedSize > MAX_COMPRESSED_ENTRY_BYTES || uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES) {
        return error("ZIP entry exceeds the safe size limit.");
      }

      const variableLength = nameLength + extraLength + commentLength;
      const nextOffset = safeAdd(offset, CENTRAL_DIRECTORY_HEADER_SIZE + variableLength);
      const nameOffset = safeAdd(offset, CENTRAL_DIRECTORY_HEADER_SIZE);
      if (nextOffset === undefined || nameOffset === undefined || nextOffset > centralEnd || nameLength === 0) {
        return error("ZIP central-directory entry is truncated.");
      }

      const nameBytes = bytes.subarray(nameOffset, nameOffset + nameLength);
      const decodedName = decodeUtf8(nameBytes, "entry name");
      if (!decodedName.ok) return decodedName;
      if (entries.has(decodedName.value)) return error(`ZIP has duplicate entry name: ${decodedName.value}.`);

      entries.set(decodedName.value, {
        name: decodedName.value,
        nameBytes,
        flags,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      offset = nextOffset;
    }

    if (offset !== centralEnd) return error("ZIP central-directory size does not match its entries.");
    return { ok: true, value: new ZipArchive(bytes, archiveStart, entries) };
  } catch {
    return error("Could not parse ZIP archive safely.");
  }
}
