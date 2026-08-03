import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { inspectPng, stripPngMetadata } from "./lib/png.mjs";
import { syntheticPng } from "./test-helpers/png.mjs";

test("accepts a PNG containing only rendering chunks", () => {
  assert.deepEqual(inspectPng(syntheticPng({ height: 3, width: 4 })), {
    errors: [],
    height: 3,
    width: 4,
  });
});

test("detects and strips textual metadata deterministically", () => {
  const source = syntheticPng({
    extraChunks: [
      { data: Buffer.from("Software\0private-host"), type: "tEXt" },
    ],
  });
  assert.match(inspectPng(source).errors.join("\n"), /text metadata/u);
  const first = stripPngMetadata(source);
  const second = stripPngMetadata(source);
  assert.deepEqual(first.buffer, second.buffer);
  assert.deepEqual(first.removedChunks, ["tEXt"]);
  assert.deepEqual(inspectPng(first.buffer).errors, []);
  assert.equal(first.buffer.includes(Buffer.from("private-host")), false);
});

test("rejects unknown PNG chunks instead of silently changing rendering", () => {
  const source = syntheticPng({ extraChunks: [{ type: "vpAg" }] });
  assert.match(inspectPng(source).errors.join("\n"), /unapproved/u);
  assert.throws(() => stripPngMetadata(source), /unknown PNG extension/u);
});

test("rejects corrupt PNG chunk checksums", () => {
  const source = syntheticPng();
  source[source.length - 1] ^= 1;
  assert.match(inspectPng(source).errors.join("\n"), /invalid CRC/u);
});
