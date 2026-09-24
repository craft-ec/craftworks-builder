// CUT THE LOAD PIECES (craftworks-sdk#347), run by build.sh after sdk/ is in place.
//
// usage: node tools/cut-pieces.mjs <load-pieces binary>
//
// Which files go in which bundle is publish-app.js's (`coreFiles`, `PROVISIONING_FILES`); the bundle format, the
// cut and each piece's container are the SDK's `load-pieces` (its one implementation). This only calls it once per
// bundle and writes `sdk/pieces.json`: per bundle `{ k, m, payload, bundle_len, pieces: [{ address, sha256 }] }`,
// the sha256 being of the piece's SERVED bytes (what a loader verifies), and `sdk/pieces/<bundle>/piece-<i>.webapp`
// (the container state publish PUTs). The same SDK and builder build cut the same pieces.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadSdk } from "../sdk-loader.js";
import { coreFiles, PROVISIONING_FILES, PIECE_M, PIECE_PAYLOAD, STARTER_LIMIT, starterOf } from "../publish-app.js";

const tool = process.argv[2];
if (!tool) throw new Error("usage: node tools/cut-pieces.mjs <load-pieces binary>");
const sdk = await loadSdk(readFileSync("sdk/craftworks_sdk_bg.wasm"));
const manifest = JSON.parse(readFileSync("sdk/artefacts.json", "utf8"));

const out = {};
for (const [name, files] of [["core", coreFiles(manifest, sdk.ids)], ["provisioning", PROVISIONING_FILES]]) {
  const dir = `sdk/pieces/${name}`;
  rmSync(dir, { recursive: true, force: true });
  const args = ["sdk/webapp.wasm", String(PIECE_PAYLOAD), String(PIECE_M), dir, ...Object.entries(files).map(([at, from]) => `${at}=${from}`)];
  const run = spawnSync(tool, args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`load-pieces refused the ${name} bundle: ${run.stderr.trim()}`);
  const shape = JSON.parse(run.stdout);
  for (const [i, p] of shape.pieces.entries()) {
    const bin = `${dir}/piece-${i}.bin`;
    p.sha256 = createHash("sha256").update(readFileSync(bin)).digest("hex");
    // The served bytes are inside the .webapp container; kept once, not twice.
    rmSync(bin);
  }
  rmSync(`${dir}/bundle.bin`);
  out[name] = shape;
  const bytes = Object.values(files).reduce((n, f) => n + readFileSync(f).length, 0);
  console.log(`  ${name}: ${Object.keys(files).length} files, ${bytes} B -> k=${shape.k} + m=${shape.m} pieces of ${shape.payload} B`);
}
writeFileSync("sdk/pieces.json", `${JSON.stringify(out, null, 2)}\n`);

// THE STARTER, MEASURED (main's ruling): one container under STARTER_LIMIT, or no build. An app with no components
// and a placeholder head and app id: app.json is the only per-app file, and it is small.
const read = async p => readFileSync(p);
const { state } = await starterOf({ name: "" }, {
  sdk, headId: "0".repeat(64), appId: "app", manifest, pieces: out, read, subtle: crypto.subtle, code: readFileSync("sdk/webapp.wasm"),
});
console.log(`  starter: ${state.length} B (limit ${STARTER_LIMIT} B)`);
if (state.length > STARTER_LIMIT) {
  throw new Error(`the starter is ${state.length} B, over its ${STARTER_LIMIT} B limit: it is the one fetch nothing races`);
}
