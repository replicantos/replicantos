import { Buffer } from "node:buffer";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRITICAL_OR_RENDERING_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
]);
const FORBIDDEN_METADATA_CHUNKS = new Map([
  ["eXIf", "EXIF metadata"],
  ["iTXt", "international text metadata"],
  ["tEXt", "text metadata"],
  ["tIME", "timestamp metadata"],
  ["zTXt", "compressed text metadata"],
]);
const KNOWN_REMOVABLE_METADATA_CHUNKS = new Set([
  ...FORBIDDEN_METADATA_CHUNKS.keys(),
  "bKGD",
  "cHRM",
  "gAMA",
  "hIST",
  "iCCP",
  "pHYs",
  "sBIT",
  "sPLT",
  "sRGB",
]);

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parseChunks(buffer) {
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new Error("invalid PNG signature");
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length)
      throw new Error("truncated PNG chunk header");
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("truncated PNG chunk data");

    const typeBuffer = buffer.subarray(offset + 4, offset + 8);
    const type = typeBuffer.toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error("invalid PNG chunk type");

    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBuffer, data]));
    if (actualCrc !== expectedCrc)
      throw new Error(`invalid CRC for PNG chunk ${type}`);

    chunks.push({ data, length, type });
    offset = end;
    if (type === "IEND") break;
  }

  if (offset !== buffer.length)
    throw new Error("data appears after PNG IEND chunk");
  if (
    chunks.length < 3 ||
    chunks[0]?.type !== "IHDR" ||
    chunks.at(-1)?.type !== "IEND"
  ) {
    throw new Error("invalid PNG chunk sequence");
  }
  if (chunks[0].length !== 13) throw new Error("invalid PNG IHDR length");
  if (chunks.at(-1).length !== 0) throw new Error("invalid PNG IEND length");
  if (!chunks.some((chunk) => chunk.type === "IDAT"))
    throw new Error("PNG has no image data");

  const counts = new Map();
  for (const chunk of chunks)
    counts.set(chunk.type, (counts.get(chunk.type) ?? 0) + 1);
  if ((counts.get("IHDR") ?? 0) !== 1 || (counts.get("IEND") ?? 0) !== 1) {
    throw new Error("PNG must contain exactly one IHDR and IEND chunk");
  }
  if ((counts.get("PLTE") ?? 0) > 1 || (counts.get("tRNS") ?? 0) > 1) {
    throw new Error("PNG contains duplicate palette or transparency chunks");
  }
  const firstIdat = chunks.findIndex((chunk) => chunk.type === "IDAT");
  const lastIdat = chunks.findLastIndex((chunk) => chunk.type === "IDAT");
  if (
    chunks.slice(firstIdat, lastIdat + 1).some((chunk) => chunk.type !== "IDAT")
  ) {
    throw new Error("PNG IDAT chunks must be consecutive");
  }
  for (const type of ["PLTE", "tRNS"]) {
    const index = chunks.findIndex((chunk) => chunk.type === type);
    if (index > firstIdat)
      throw new Error(`PNG ${type} chunk must precede image data`);
  }

  const width = chunks[0].data.readUInt32BE(0);
  const height = chunks[0].data.readUInt32BE(4);
  if (width === 0 || height === 0)
    throw new Error("PNG dimensions must be nonzero");
  const bitDepth = chunks[0].data[8];
  const colorType = chunks[0].data[9];
  const allowedDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  if (!allowedDepths.get(colorType)?.has(bitDepth))
    throw new Error("invalid PNG color type");
  if (chunks[0].data[10] !== 0 || chunks[0].data[11] !== 0) {
    throw new Error("unsupported PNG compression or filter method");
  }
  if (![0, 1].includes(chunks[0].data[12]))
    throw new Error("invalid PNG interlace method");
  return { chunks, height, width };
}

function chunkBuffer(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.allocUnsafe(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    8 + data.length,
  );
  return output;
}

/**
 * Inspect a PNG for release-safety. Rendering chunks are accepted; all metadata
 * and unrecognized chunks are rejected so new encoders cannot silently add
 * host, time, text, profile, or application data.
 */
export function inspectPng(buffer) {
  let parsed;
  try {
    parsed = parseChunks(buffer);
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      height: undefined,
      width: undefined,
    };
  }

  const errors = [];
  for (const chunk of parsed.chunks) {
    const forbidden = FORBIDDEN_METADATA_CHUNKS.get(chunk.type);
    if (forbidden)
      errors.push(`forbidden PNG ${forbidden} chunk (${chunk.type})`);
    else if (!CRITICAL_OR_RENDERING_CHUNKS.has(chunk.type)) {
      errors.push(`unapproved PNG metadata or extension chunk (${chunk.type})`);
    }
  }
  return { errors, height: parsed.height, width: parsed.width };
}

/** Remove every non-rendering chunk and re-encode chunk CRCs deterministically. */
export function stripPngMetadata(buffer) {
  const parsed = parseChunks(buffer);
  const unknown = parsed.chunks.find(
    (chunk) =>
      !CRITICAL_OR_RENDERING_CHUNKS.has(chunk.type) &&
      !KNOWN_REMOVABLE_METADATA_CHUNKS.has(chunk.type),
  );
  if (unknown) {
    throw new Error(
      `refusing to strip unknown PNG extension chunk (${unknown.type})`,
    );
  }
  const retained = parsed.chunks.filter((chunk) =>
    CRITICAL_OR_RENDERING_CHUNKS.has(chunk.type),
  );
  const output = Buffer.concat([
    PNG_SIGNATURE,
    ...retained.map((chunk) => chunkBuffer(chunk.type, chunk.data)),
  ]);
  const inspection = inspectPng(output);
  if (inspection.errors.length > 0) {
    throw new Error(
      `sanitized PNG did not pass inspection: ${inspection.errors.join(", ")}`,
    );
  }
  return {
    buffer: output,
    height: parsed.height,
    removedChunks: parsed.chunks
      .filter((chunk) => !CRITICAL_OR_RENDERING_CHUNKS.has(chunk.type))
      .map((chunk) => chunk.type),
    width: parsed.width,
  };
}

export const pngInternalsForTest = Object.freeze({
  chunkBuffer,
  crc32,
  PNG_SIGNATURE,
});
