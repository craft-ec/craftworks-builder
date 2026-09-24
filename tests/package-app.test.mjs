// WHAT A PUBLISHED APP'S STARTER CARRIES, AND WHAT IT ONLY NAMES.
//
// ARCHITECTURE §19: an app names its artefacts by hash and carries none of
// them — since craftworks-sdk#347 it names the LOAD PIECES they are rebuilt
// from (by address and sha256), and carries only the decoder. The measurement below is taken against THIS BUILD's real manifest,
// not against numbers written into the test — the whole claim is a size, and
// a size asserted from memory is a size that goes stale.
import assert from "node:assert";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packageApp, weightCarrying, NAMED, PLATFORM, NOT_YET_NAMED } from "../package-app.js";
import { loadSdk } from "../sdk-loader.js";
// The REAL SDK's id rules: the manifest's shapes are checked by them.
const { ids } = await loadSdk(readFileSync(fileURLToPath(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url))));

const at = p => fileURLToPath(new URL(p, import.meta.url));
const subtle = crypto.subtle;

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

// THE REAL MANIFEST this build produced, so the measurement is of something.
const manifestPath = at("../sdk/artefacts.json");
if (!existsSync(manifestPath)) {
  // NOT A SKIP. The size claim is the point of this file, and a run that
  // could not read the manifest has measured nothing — which in a green log
  // is indistinguishable from having measured and agreed.
  process.stdout.write("  FAIL sdk/artefacts.json is not there — run ./build.sh first\n");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const APP = { name: "Notes", components: [{ type: "table", domain: "notes", mode: "owned" }] };
const SDK_JS = { "sdk/index.js": "export const a = 1;\n", "index.html": "<!doctype html>\n" };
// THE REAL PIECES this build cut (build.sh, the SDK's `load-pieces`).
const piecesPath = at("../sdk/pieces.json");
if (!existsSync(piecesPath)) { process.stdout.write("  FAIL sdk/pieces.json is not there — run ./build.sh first\n"); process.exit(1); }
const PIECES = JSON.parse(readFileSync(piecesPath, "utf8"));

await t("**a packaged app carries NONE of the four artefacts: it names the pieces they are rebuilt from**", async () => {
  const { files } = await packageApp(APP, { carried: SDK_JS, manifest, pieces: PIECES, subtle, ids });
  const carried = Object.keys(files).filter(p => /\.wasm$/.test(p));
  assert.deepStrictEqual(carried, [],
    `the bundle carries ${carried.join(", ")} — every app would ship its own copy of bytes ` +
    "every other app already has");
  // And it NAMES all four, with the hashes this build produced.
  const named = JSON.parse(files["artefacts.json"]);
  assert.deepStrictEqual(named.pieces, { core: PIECES.core, provisioning: PIECES.provisioning }, "the bundle does not name the pieces to rebuild them from");
  for (const n of NAMED) {
    assert.strictEqual(named[n].sha256, manifest[n].sha256,
      `${n} is named with a hash that is not this build's`);
  }
});

await t("**the measurement: naming instead of carrying**", async () => {
  // THE REAL STARTER — the loader, the decoder and the SDK's pre-SDK
  // JavaScript — not the stub files the other tests use: a measurement taken
  // over a fixture measures the fixture.
  const { STARTER_FILES, STARTER_SDK_MODULES } = await import("../publish-app.js");
  const real = {};
  for (const [p, from] of Object.entries(STARTER_FILES)) real[p] = readFileSync(at(`../${from}`));
  for (const m of STARTER_SDK_MODULES) real[`sdk/${m}`] = readFileSync(at(`../sdk/${m}`), "utf8");
  const { bytes } = await packageApp(APP, { carried: real, manifest, pieces: PIECES, subtle, ids });
  const carrying = weightCarrying(bytes, manifest);
  const saved = carrying - bytes;
  process.stdout.write(
    `      carrying ${carrying.toLocaleString()} B → naming ${bytes.toLocaleString()} B ` +
    `(${saved.toLocaleString()} B saved, ${((saved / carrying) * 100).toFixed(1)}%)\n`);
  assert.ok(saved > 1_500_000,
    `only ${saved} B saved; the four artefacts are supposed to be ~1.7 MB of every app`);
  assert.ok(bytes < 100_000, `the starter is still ${bytes} B — something large is being carried`);
  assert.ok(bytes > 30_000,
    `the starter is only ${bytes} B, less than the decoder and the SDK's pre-SDK JavaScript — ` +
    "this is measuring stubs rather than what an app actually carries");
});

await t("**the bundle hash is DETERMINISTIC** — rollback depends on it", async () => {
  // builder#47 is blocked on this: a publication can only be rolled back to
  // if it is a thing that can be named again.
  const a = await packageApp(APP, { carried: SDK_JS, manifest, pieces: PIECES, subtle, ids });
  const b = await packageApp(APP, { carried: SDK_JS, manifest, pieces: PIECES, subtle, ids });
  assert.strictEqual(a.bundleHash, b.bundleHash, "the same app packaged twice gave two hashes");
  assert.match(a.bundleHash, /^[0-9a-f]{64}$/, "that is not a sha256");
});

await t("THE CONTROL: a DIFFERENT app hashes differently", async () => {
  // Without this, a hash that was a constant would satisfy determinism
  // perfectly and make every publication look like every other.
  const a = await packageApp(APP, { carried: SDK_JS, manifest, pieces: PIECES, subtle, ids });
  const b = await packageApp(
    { ...APP, name: "Notes 2" },
    { carried: SDK_JS, manifest, pieces: PIECES, subtle, ids },
  );
  assert.notStrictEqual(a.bundleHash, b.bundleHash,
    "two different apps package to the same hash, so a rollback could not tell them apart");
});

await t("THE CONTROL: a different FILE hashes differently too", async () => {
  // The app definition is not the only thing in a bundle. A hash covering
  // only `app.json` would pass the control above while ignoring the code.
  const a = await packageApp(APP, { carried: SDK_JS, manifest, pieces: PIECES, subtle, ids });
  const b = await packageApp(APP, {
    carried: { ...SDK_JS, "sdk/index.js": "export const a = 2;\n" },
    manifest, pieces: PIECES, subtle, ids,
  });
  assert.notStrictEqual(a.bundleHash, b.bundleHash, "the bundle hash does not cover the app's code");
});

await t("a wasm handed in is REFUSED, not silently dropped", async () => {
  // A caller passing one believes the app will carry it. Dropping it quietly
  // is the difference between a smaller bundle and a broken one.
  await assert.rejects(
    () => packageApp(APP, {
      carried: { ...SDK_JS, "sdk/block.wasm": new Uint8Array([0]) },
      manifest, pieces: PIECES, subtle, ids,
    }),
    /block\.wasm is not a file an app carries/,
  );
  // THE CONTROL: the one wasm a starter does carry.
  const { files } = await packageApp(APP, { carried: { ...SDK_JS, "decoder.wasm": new Uint8Array([0]) }, manifest, pieces: PIECES, subtle, ids });
  assert.ok("decoder.wasm" in files, "the decoder was not carried");
});

await t("no pieces, or a malformed piece, is a refusal", async () => {
  const bad = [null, { core: PIECES.core }, { ...PIECES, core: { ...PIECES.core, pieces: PIECES.core.pieces.slice(1) } },
    { ...PIECES, provisioning: { ...PIECES.provisioning, pieces: PIECES.provisioning.pieces.map((p, i) => (i ? p : { ...p, sha256: "nope" })) } }];
  for (const pieces of bad) {
    await assert.rejects(() => packageApp(APP, { carried: SDK_JS, manifest, pieces, subtle, ids }), /no well-formed (core|provisioning) pieces/);
  }
});

await t("a manifest missing a hash is a refusal, naming which AND why", async () => {
  const broken = { ...manifest, signer: { file: "signer.wasm" } };
  await assert.rejects(
    () => packageApp(APP, { carried: SDK_JS, manifest: broken, pieces: PIECES, subtle, ids }),
    e => {
      assert.match(e.message, /no hash for: signer/, "it does not name the missing entry");
      assert.match(e.message, /too old/,
        "it does not say the SDK build is too old, so the reader treats a stale PIN as a " +
        "broken manifest — which is the wrong thing to go and fix");
      return true;
    },
  );
});

await t("**an EXTRA artefact is a mismatch too**", async () => {
  // The direction that goes stale quietly: the SDK grows an artefact, apps
  // carry on naming the four they know about, and the new one is never
  // fetched with nothing anywhere saying so.
  const grown = { ...manifest, keeper: { file: "keeper.wasm", sha256: "a".repeat(64), bytes: 1 } };
  await assert.rejects(
    () => packageApp(APP, { carried: SDK_JS, manifest: grown, pieces: PIECES, subtle, ids }),
    /does not name: keeper|not name: keeper|artefacts this build does not name: keeper/,
  );
});

// A manifest as the SDK ships it from builder#104 on: the four, plus the two
// publishing tools. Built from the real one, so the four hashes are real.
const CONTAINER = { address: "BimQYzQWHZLEiffGJHfVXCXHqk4mGiyVzuk1cgBKpxb", sha256: "e".repeat(64), bytes: 510922 };
const WEBAPP = { file: "webapp.wasm", sha256: "4".repeat(64), bytes: 30476 };
const DECODER = { file: "decoder.wasm", sha256: "5".repeat(64), bytes: 39488 };
const withTools = { ...Object.fromEntries(NAMED.map(n => [n, manifest[n]])), container: CONTAINER, webapp: WEBAPP, decoder: DECODER, modules: ["index.js", "wrap.js"] };

await t("**the publishing tools are NOT app artefacts: the app names exactly the four, never the container or the webapp code**", async () => {
  assert.deepStrictEqual(NAMED, ["sdk", "signer", "block", "register"], "NAMED changed: it is an exact set");
  assert.deepStrictEqual(Object.keys(PLATFORM).sort(), ["container", "decoder", "modules", "site", "webapp"]);
  const { files } = await packageApp(APP, { carried: SDK_JS, manifest: withTools, pieces: PIECES, subtle, ids });
  const named = JSON.parse(files["artefacts.json"]);
  assert.deepStrictEqual(Object.keys(named).sort(), ["note", "pieces", ...NAMED].sort(),
    `the app's artefacts.json names ${Object.keys(named).join(", ")}`);
});

await t("**a container or webapp entry shaped like an APP artefact is refused, not fetched**", async () => {
  for (const [k, bad] of [["container", { file: "container.wasm", sha256: "c".repeat(64), bytes: 1 }], ["webapp", { file: "other.wasm", sha256: "d".repeat(64), bytes: 1 }], ["decoder", { file: "decoder2.wasm", sha256: "d".repeat(64), bytes: 1 }],
    ["modules", { file: "modules.wasm", sha256: "e".repeat(64), bytes: 1 }], ["modules", ["index.js", "../app.js"]], ["modules", []]]) {
    await assert.rejects(
      () => packageApp(APP, { carried: SDK_JS, manifest: { ...withTools, [k]: bad }, pieces: PIECES, subtle, ids }),
      new RegExp(`${k} entry is not the shape of a publishing tool`),
    );
  }
});

await t("**THE REAL MANIFEST packages: the app names the four (the signer among them) and the pieces, and never the engine delegate**", async () => {
  const { files } = await packageApp(APP, { carried: SDK_JS, manifest, pieces: PIECES, subtle, ids });
  const named = JSON.parse(files["artefacts.json"]);
  assert.deepStrictEqual(Object.keys(named).sort(), ["note", "pieces", ...NAMED].sort());
  assert.ok("signer" in named, "the app does not name the signer: it could not provision");
  assert.ok(!("delegate" in named), "the app names the deleted engine delegate");
});

await t("THE CONTROL: this build's real manifest is exactly the four, the publishing tools, and what is not named yet", async () => {
  // Without this the refusals above could all be satisfied by a manifest
  // nobody actually ships. This asserts the shipped one matches, so the pin
  // being too old fails HERE rather than in a packaging call later.
  const keys = Object.keys(manifest).filter(k => k !== "note").sort();
  assert.deepStrictEqual(keys, [...NAMED, ...Object.keys(PLATFORM), ...Object.keys(NOT_YET_NAMED)].sort(),
    `sdk/artefacts.json carries ${keys.join(", ")}. If entries are MISSING the pinned SDK ` +
    "revision is too old to name what an app needs; if there are extra ones the SDK has " +
    "grown an artefact this build would never fetch.");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok package app\n");
process.exit(failures ? 1 : 0);
