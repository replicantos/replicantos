import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { pngInternalsForTest } from "../lib/png.mjs";

const { chunkBuffer, PNG_SIGNATURE } = pngInternalsForTest;

export function syntheticPng({ extraChunks = [], height = 1, width = 1 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const row = Buffer.alloc(width + 1);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    chunkBuffer("IHDR", header),
    ...extraChunks.map(({ data = Buffer.alloc(0), type }) =>
      chunkBuffer(type, data),
    ),
    chunkBuffer("IDAT", deflateSync(pixels)),
    chunkBuffer("IEND", Buffer.alloc(0)),
  ]);
}
