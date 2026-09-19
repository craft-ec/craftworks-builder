// The builder's SDK loader must yield a working SDK: load the same module the
// page loads and check it against a known vector from the SDK's own frozen set.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";

const wasm = readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url));
const sdk = await loadSdk(wasm);
assert.match(sdk.version(), /^\d+\.\d+\.\d+$/);
// craftworks-sdk tests/block_vectors.txt, `raw 616263`. A block id, not a plain
// BLAKE3: that is what the SDK hands out and what the builder displays.
const abc = "raw:b14157d03cf324d8896c43f2c5e241223eab944698e40c01f8f4e028fd1751e4";
assert.strictEqual(sdk.blockId(new TextEncoder().encode("abc")), abc);
// And the loader's SDK can read an id back, which the tree panel depends on.
assert.deepStrictEqual(sdk.parseBlockId(abc), {
  tag: "raw",
  hex: abc.slice(4),
  id: abc,
});
assert.throws(() => sdk.parseBlockId(abc.slice(4)), "an untagged hash is not an id");
console.log(`ok builder loads sdk ${sdk.version()}`);
