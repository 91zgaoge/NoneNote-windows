/**
 * ZIP access with an uncompressed-size budget (zip-bomb guard).
 * Port of Android's extract/SafeZip.kt: the total uncompressed spend of every
 * entry read through one ZipBudget is bounded, which also caps any single
 * entry (it cannot exceed the total). Entry names come from the central
 * directory so listing never decompresses data.
 */
import { Inflate } from "fflate";
import { ExtractFailure, Limits, malformedPart, resourceLimit } from "./types.ts";

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

export interface ZipCentralDirectory {
  entries: ZipEntry[];
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** Parses the end-of-central-directory record; null when this is no ZIP. */
export function eocd(bytes: Uint8Array): ZipCentralDirectory | null {
  const minEocd = 22;
  if (bytes.length < minEocd) return null;
  const scanFrom = Math.max(0, bytes.length - minEocd - 65535);
  for (let i = bytes.length - minEocd; i >= scanFrom; i--) {
    if (readU32(bytes, i) !== EOCD_SIG) continue;
    const count = readU16(bytes, i + 10);
    const cdSize = readU32(bytes, i + 12);
    const cdOffset = readU32(bytes, i + 16);
    if (cdOffset + cdSize > bytes.length) continue;
    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
      if (p + 46 > bytes.length || readU32(bytes, p) !== CDH_SIG) return null;
      entries.push({
        flags: readU16(bytes, p + 8),
        method: readU16(bytes, p + 10),
        compressedSize: readU32(bytes, p + 20),
        localHeaderOffset: readU32(bytes, p + 42),
        name: new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(p + 46, p + 46 + readU16(bytes, p + 28)),
        ),
      });
      p += 46 + readU16(bytes, p + 28) + readU16(bytes, p + 30) + readU16(bytes, p + 32);
    }
    return { entries };
  }
  return null;
}

/** Entry names, in central-directory order. */
export function entryNames(zip: Uint8Array): string[] {
  const cd = eocd(zip);
  return cd ? cd.entries.map((e) => e.name) : [];
}

/** Streams one entry out of the zip; null when absent. Bounded by budget. */
export function readEntry(zip: Uint8Array, name: string, budget: ZipBudget): Uint8Array | null {
  const cd = eocd(zip);
  if (!cd) return null;
  const entry = cd.entries.find((e) => e.name === name);
  if (!entry) return null;
  return readEntryData(zip, entry, budget);
}

/**
 * Decompresses one entry's data, feeding the inflater in slices so the budget
 * aborts mid-stream instead of materialising a bomb (Android reads through a
 * ZipInputStream 16 KB at a time; this mirrors that granularity).
 */
function readEntryData(zip: Uint8Array, entry: ZipEntry, budget: ZipBudget): Uint8Array {
  const off = entry.localHeaderOffset;
  if (off + 30 > zip.length || readU32(zip, off) !== LFH_SIG) {
    throw malformedPart("zip local header missing or corrupt");
  }
  const nameLen = readU16(zip, off + 26);
  const extraLen = readU16(zip, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  if (entry.flags & 0x1) throw malformedPart("encrypted zip entry");
  const raw = zip.subarray(dataStart, dataStart + entry.compressedSize);
  if (raw.length < entry.compressedSize) throw malformedPart("zip entry data truncated");

  if (entry.method === 0) {
    budget.spend(raw.length);
    return raw.slice();
  }
  if (entry.method !== 8) {
    throw malformedPart(`unsupported zip compression method ${entry.method}`);
  }

  const parts: Uint8Array[] = [];
  const SLICE = 16 * 1024;
  const inflater = new Inflate((chunk: Uint8Array, _final: boolean) => {
    if (!chunk || chunk.length === 0) return;
    budget.spend(chunk.length);
    parts.push(chunk);
  });
  try {
    for (let i = 0; i < raw.length; i += SLICE) {
      inflater.push(raw.subarray(i, Math.min(i + SLICE, raw.length)), false);
    }
    inflater.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof ExtractFailure) throw e;
    throw malformedPart(`zip inflate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function readU16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function readU32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

/** ZIP spend tracker: aborts once the total uncompressed budget is exceeded. */
export class ZipBudget {
  total = 0;
  private readonly max: number;

  constructor(max: number = Limits.MAX_UNZIP_TOTAL) {
    this.max = max;
  }

  spend(n: number): void {
    this.total += n;
    if (this.total > this.max) resourceLimit(`uncompressed zip size > ${this.max}`);
  }
}
