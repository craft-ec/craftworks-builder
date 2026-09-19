// The builder's SDK loader must yield a working SDK: load the same module the page
// loads and check one call against a known BLAKE3 vector.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";

const wasm = readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url));
const sdk = await loadSdk(wasm);
assert.match(sdk.version(), /^\d+\.\d+\.\d+$/);
assert.strictEqual(
  sdk.cidHex(new TextEncoder().encode("abc")),
  "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
);
console.log(`ok builder loads sdk ${sdk.version()}`);
