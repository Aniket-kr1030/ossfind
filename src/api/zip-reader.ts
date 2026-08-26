import { inflateRaw } from "node:zlib";
import type { HttpClient } from "../http/client.js";

/**
 * A deliberately small ZIP reader for package wheels. It reads central-directory
 * metadata only and never writes an entry to disk.
 */

export type ZipResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * The result of opening a remote ZIP by HTTP byte ranges. `rangeUnsupported`
 * is only set when the *initial* range request was not honoured, so callers
 * can make a deliberate bounded whole-file fallback decision.
 */
export type RemoteZipResult<T> =
  | { ok: true; value: T; bytesFetched: number }
  | { ok: false; error: string; rangeUnsupported: boolean; bytesFetched: number };

export interface RemoteZipOptions {
  url: string;
  http: HttpClient;
  /** A caller may lower this; the default covers one bounded central-directory retry and one entry. */
  maxTotalBytes?: number;
}

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
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;

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

// Remote reading never downloads an archive as a unit. Conventional ZIP
// offsets are 32-bit, so a larger archive necessarily needs ZIP64, which this
// deliberately rejects. The fetch budget caps aggregate transfers, including
// overlapping tail retries and the one selected entry.
const MAX_REMOTE_ARCHIVE_BYTES = 0xffffffff;
const REMOTE_TAIL_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024] as const;
const DEFAULT_MAX_REMOTE_FETCH_BYTES = 10 * 1024 * 1024;

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

function parseCentralDirectoryEntries(bytes: Uint8Array, entryCount: number): ZipResult<ReadonlyMap<string, ZipEntry>> {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Map<string, ZipEntry>();
    let offset = 0;

    for (let index = 0; index < entryCount; index++) {
      if (!isRangeWithin(offset, CENTRAL_DIRECTORY_HEADER_SIZE, bytes.byteLength)) {
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
      if (nextOffset === undefined || nameOffset === undefined || nextOffset > bytes.byteLength || nameLength === 0) {
        return error("ZIP central-directory entry is truncated.");
      }

      // Copy names rather than retaining an arbitrary whole input buffer when
      // used by the remote reader.
      const nameBytes = Uint8Array.from(bytes.subarray(nameOffset, nameOffset + nameLength));
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

    if (offset !== bytes.byteLength) return error("ZIP central-directory size does not match its entries.");
    return { ok: true, value: entries };
  } catch {
    return error("Could not parse ZIP central-directory metadata safely.");
  }
}

function hasZip64Locator(bytes: Uint8Array, eocdOffset: number): boolean {
  if (!isRangeWithin(eocdOffset - 20, 4, bytes.byteLength)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(eocdOffset - 20, true) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE;
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

interface ContentRange {
  start: number;
  end: number;
  total: number;
}

type RangeFetchError = { ok: false; error: string; rangeUnsupported: boolean };
type RangeFetchResult =
  | { ok: true; value: Uint8Array; range: ContentRange }
  | RangeFetchError;

function remoteError<T>(message: string, rangeUnsupported: boolean, bytesFetched: number): RemoteZipResult<T> {
  return { ok: false, error: message, rangeUnsupported, bytesFetched };
}

function responseHeader(response: unknown, name: string): string | undefined {
  const headers = (response as { headers?: { get?: (headerName: string) => string | null } }).headers;
  const value = headers?.get?.(name);
  return typeof value === "string" ? value : undefined;
}

function parseContentRange(value: string | undefined): ContentRange | undefined {
  if (!value) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) return undefined;

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)
    || start < 0 || end < start || total <= end) {
    return undefined;
  }
  return { start, end, total };
}

function rangeResultError<T>(result: RangeFetchError): ZipResult<T> {
  return error(result.error);
}

/** A tightly bounded HTTP Range source used only by RemoteZipArchive. */
class RemoteZipSource {
  private bytesRead = 0;
  private requestCount = 0;
  private archiveLength: number | undefined;

  constructor(
    private readonly options: Required<RemoteZipOptions>,
  ) {}

  get bytesFetched(): number {
    return this.bytesRead;
  }

  async fetchSuffix(length: number): Promise<RangeFetchResult> {
    return this.fetch(`bytes=-${length}`, (range) =>
      range.end === range.total - 1
      && range.start === Math.max(0, range.total - length)
      && range.end - range.start + 1 <= length);
  }

  async fetchAbsolute(start: number, end: number): Promise<RangeFetchResult> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return { ok: false, error: "ZIP requested byte range is invalid.", rangeUnsupported: false };
    }
    if (this.archiveLength === undefined || end >= this.archiveLength) {
      return { ok: false, error: "ZIP requested byte range is outside the archive.", rangeUnsupported: false };
    }
    return this.fetch(`bytes=${start}-${end}`, (range) => range.start === start && range.end === end);
  }

  private async fetch(header: string, expected: (range: ContentRange) => boolean): Promise<RangeFetchResult> {
    const isInitialRequest = this.requestCount === 0;
    this.requestCount++;
    try {
      const response = await this.options.http(this.options.url, { headers: { Range: header } });
      if (response.status !== 206) {
        return {
          ok: false,
          error: "ZIP server did not honor HTTP Range requests.",
          rangeUnsupported: isInitialRequest,
        };
      }
      if (!response.ok) {
        return { ok: false, error: "ZIP range request failed.", rangeUnsupported: false };
      }

      const acceptRanges = responseHeader(response, "accept-ranges");
      if (!acceptRanges || !/^bytes(?:\s|$)/i.test(acceptRanges.trim())) {
        return {
          ok: false,
          error: "ZIP server did not advertise byte-range support.",
          rangeUnsupported: isInitialRequest,
        };
      }

      const range = parseContentRange(responseHeader(response, "content-range"));
      if (!range || !expected(range)) {
        return {
          ok: false,
          error: "ZIP range response has an invalid Content-Range header.",
          rangeUnsupported: isInitialRequest,
        };
      }
      if (range.total > MAX_REMOTE_ARCHIVE_BYTES) {
        return { ok: false, error: "ZIP archive requires unsupported ZIP64-sized offsets.", rangeUnsupported: false };
      }
      if (this.archiveLength !== undefined && range.total !== this.archiveLength) {
        return { ok: false, error: "ZIP archive length changed during range reads.", rangeUnsupported: false };
      }

      const announcedLength = range.end - range.start + 1;
      const nextTotal = safeAdd(this.bytesRead, announcedLength);
      if (nextTotal === undefined || nextTotal > this.options.maxTotalBytes) {
        return { ok: false, error: "ZIP range reads exceed the total safe fetch limit.", rangeUnsupported: false };
      }

      const binaryResponse = response as typeof response & { arrayBuffer?: () => Promise<ArrayBuffer> };
      if (typeof binaryResponse.arrayBuffer !== "function") {
        return { ok: false, error: "ZIP range response has no binary body.", rangeUnsupported: false };
      }
      const bytes = new Uint8Array(await binaryResponse.arrayBuffer());
      if (bytes.byteLength !== announcedLength) {
        return { ok: false, error: "ZIP range response body length does not match Content-Range.", rangeUnsupported: false };
      }

      this.archiveLength = range.total;
      this.bytesRead = nextTotal;
      return { ok: true, value: bytes, range };
    } catch {
      return { ok: false, error: "Could not fetch ZIP byte range safely.", rangeUnsupported: false };
    }
  }
}

interface RemoteZipLayout {
  archiveStart: number;
  centralDirectoryStart: number;
  centralDirectoryEnd: number;
  entryCount: number;
}

function parseRemoteZipLayout(tail: Uint8Array, tailStart: number, archiveLength: number): ZipResult<RemoteZipLayout> {
  try {
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const eocdOffset = findEndOfCentralDirectory(tail, view);
    if (eocdOffset === undefined) return error("ZIP end-of-central-directory record was not found in the fetched tail.");
    if (hasZip64Locator(tail, eocdOffset)) return error("ZIP64 archives are not supported.");

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

    const eocdAbsoluteOffset = safeAdd(tailStart, eocdOffset);
    if (eocdAbsoluteOffset === undefined || eocdAbsoluteOffset >= archiveLength) {
      return error("ZIP end-of-central-directory offset is invalid.");
    }
    const archiveStart = eocdAbsoluteOffset - centralDirectorySize - centralDirectoryOffset;
    if (!Number.isSafeInteger(archiveStart) || archiveStart < 0) return error("ZIP central-directory offset is invalid.");
    const centralDirectoryStart = safeAdd(archiveStart, centralDirectoryOffset);
    const centralDirectoryEnd = centralDirectoryStart === undefined
      ? undefined
      : safeAdd(centralDirectoryStart, centralDirectorySize);
    if (centralDirectoryStart === undefined || centralDirectoryEnd === undefined
      || centralDirectoryEnd !== eocdAbsoluteOffset
      || !isRangeWithin(centralDirectoryStart, centralDirectorySize, archiveLength)) {
      return error("ZIP central directory is outside the archive.");
    }

    return { ok: true, value: { archiveStart, centralDirectoryStart, centralDirectoryEnd, entryCount } };
  } catch {
    return error("Could not parse ZIP end-of-central-directory metadata safely.");
  }
}

/**
 * A remote conventional ZIP archive. It retains only central-directory names
 * and asks its source for the selected local header and compressed entry.
 */
export class RemoteZipArchive {
  private readonly names: readonly string[];

  constructor(
    private readonly source: RemoteZipSource,
    private readonly archiveStart: number,
    private readonly archiveLength: number,
    private readonly entriesByName: ReadonlyMap<string, ZipEntry>,
  ) {
    this.names = [...entriesByName.keys()].sort((left, right) => left.localeCompare(right));
  }

  get bytesFetched(): number {
    return this.source.bytesFetched;
  }

  listEntryNames(): string[] {
    return [...this.names];
  }

  entries(): string[] {
    return this.listEntryNames();
  }

  async extractText(name: string): Promise<ZipResult<string>> {
    try {
      const entry = this.entriesByName.get(name);
      if (!entry) return error(`ZIP entry not found: ${name}.`);
      if ((entry.flags & 0x0001) !== 0) return error(`ZIP entry is encrypted: ${name}.`);
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        return error(`ZIP entry uses unsupported compression method ${entry.compressionMethod}: ${name}.`);
      }

      const localHeaderOffset = safeAdd(this.archiveStart, entry.localHeaderOffset);
      if (localHeaderOffset === undefined || !isRangeWithin(localHeaderOffset, LOCAL_FILE_HEADER_SIZE, this.archiveLength)) {
        return error(`ZIP local header is outside the archive: ${name}.`);
      }
      const localHeader = await this.source.fetchAbsolute(localHeaderOffset, localHeaderOffset + LOCAL_FILE_HEADER_SIZE - 1);
      if (!localHeader.ok) return rangeResultError(localHeader);

      const localView = new DataView(localHeader.value.buffer, localHeader.value.byteOffset, localHeader.value.byteLength);
      if (localView.getUint32(0, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
        return error(`ZIP local header signature is invalid: ${name}.`);
      }
      const localFlags = localView.getUint16(6, true);
      const localMethod = localView.getUint16(8, true);
      const localNameLength = localView.getUint16(26, true);
      const localExtraLength = localView.getUint16(28, true);
      if ((localFlags & 0x0001) !== 0 || localMethod !== entry.compressionMethod) {
        return error(`ZIP local header does not match central-directory metadata: ${name}.`);
      }

      const localNameOffset = safeAdd(localHeaderOffset, LOCAL_FILE_HEADER_SIZE);
      const dataOffset = localNameOffset === undefined
        ? undefined
        : safeAdd(localNameOffset, localNameLength + localExtraLength);
      const requestedLength = dataOffset === undefined ? undefined : safeAdd(localNameLength + localExtraLength, entry.compressedSize);
      const dataEnd = requestedLength === undefined || localNameOffset === undefined
        ? undefined
        : safeAdd(localNameOffset, requestedLength);
      if (localNameOffset === undefined || dataOffset === undefined || requestedLength === undefined || dataEnd === undefined
        || requestedLength === 0 || !isRangeWithin(localNameOffset, requestedLength, this.archiveLength)) {
        return error(`ZIP local header is truncated: ${name}.`);
      }

      // This second request contains exactly the local name/extra bytes needed
      // for validation followed by this entry's compressed bytes, never the
      // rest of the wheel.
      const entryBytes = await this.source.fetchAbsolute(localNameOffset, dataEnd - 1);
      if (!entryBytes.ok) return rangeResultError(entryBytes);
      if (!bytesEqual(entryBytes.value.subarray(0, localNameLength), entry.nameBytes)) {
        return error(`ZIP local entry name does not match central-directory metadata: ${name}.`);
      }

      const compressed = entryBytes.value.subarray(localNameLength + localExtraLength);
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

/**
 * Opens a conventional ZIP using only bounded HTTP byte ranges. ZIP64 is
 * intentionally detected and rejected; it is not partially interpreted.
 */
export async function openRemoteZip(options: RemoteZipOptions): Promise<RemoteZipResult<RemoteZipArchive>> {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_REMOTE_FETCH_BYTES;
  if (typeof options.url !== "string" || options.url.length === 0 || typeof options.http !== "function") {
    return remoteError("Remote ZIP options are invalid.", false, 0);
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    return remoteError("Remote ZIP fetch limit is invalid.", false, 0);
  }

  const source = new RemoteZipSource({ ...options, maxTotalBytes });
  try {
    for (const tailSize of REMOTE_TAIL_SIZES) {
      const tail = await source.fetchSuffix(tailSize);
      if (!tail.ok) return remoteError(tail.error, tail.rangeUnsupported, source.bytesFetched);

      const layout = parseRemoteZipLayout(tail.value, tail.range.start, tail.range.total);
      if (!layout.ok) {
        // A maximum-length ZIP comment can hide the EOCD just outside a 64 KiB
        // first tail. Retry the same bounded escalation used for a large CD.
        if (/end-of-central-directory record was not found/i.test(layout.error) && tailSize !== REMOTE_TAIL_SIZES.at(-1)) {
          continue;
        }
        return remoteError(layout.error, false, source.bytesFetched);
      }

      if (layout.value.centralDirectoryStart < tail.range.start) {
        if (tailSize !== REMOTE_TAIL_SIZES.at(-1)) continue;
        return remoteError("ZIP central directory exceeds the bounded remote tail fetch limit.", false, source.bytesFetched);
      }
      const centralOffset = layout.value.centralDirectoryStart - tail.range.start;
      const centralLength = layout.value.centralDirectoryEnd - layout.value.centralDirectoryStart;
      if (!isRangeWithin(centralOffset, centralLength, tail.value.byteLength)) {
        return remoteError("ZIP central directory is truncated in the fetched tail.", false, source.bytesFetched);
      }
      const entries = parseCentralDirectoryEntries(tail.value.subarray(centralOffset, centralOffset + centralLength), layout.value.entryCount);
      if (!entries.ok) return remoteError(entries.error, false, source.bytesFetched);

      const archive = new RemoteZipArchive(source, layout.value.archiveStart, tail.range.total, entries.value);
      return { ok: true, value: archive, bytesFetched: source.bytesFetched };
    }
    return remoteError("ZIP central directory could not be located in bounded tail fetches.", false, source.bytesFetched);
  } catch {
    return remoteError("Could not open remote ZIP safely.", false, source.bytesFetched);
  }
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
    if (hasZip64Locator(bytes, eocdOffset)
      || entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
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

    const entries = parseCentralDirectoryEntries(bytes.subarray(centralOffset, centralEnd), entryCount);
    if (!entries.ok) return entries;
    return { ok: true, value: new ZipArchive(bytes, archiveStart, entries.value) };
  } catch {
    return error("Could not parse ZIP archive safely.");
  }
}
