// WHAT A PUBLISHED APP CARRIES, AND WHAT IT ONLY NAMES.
//
// ARCHITECTURE §19: an app names its artefacts by hash and carries none of
// them. The measurement below is taken against THIS BUILD's real manifest,
// not against numbers written into the test — the whole claim is a size, and
// a size asserted from memory is a size that goes stale.
import assert from "node:assert";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packageApp, weightCarrying, NAMED } from "../package-app.js";

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
const KEY = "ARTEFACTSCONTRACT";

await t("**a packaged app carries NONE of the four artefacts**", async () => {
  const { files } = await packageApp(APP, { sdkFiles: SDK_JS, manifest, artefactsKey: KEY, subtle });
  const carried = Object.keys(files).filter(p => /\.wasm$/.test(p));
  assert.deepStrictEqual(carried, [],
    `the bundle carries ${carried.join(", ")} — every app would ship its own copy of bytes ` +
    "every other app already has");
  // And it NAMES all four, with the hashes this build produced.
  const named = JSON.parse(files["artefacts.json"]);
  assert.strictEqual(named.contract, KEY, "the bundle does not say where to fetch them");
  for (const n of NAMED) {
    assert.strictEqual(named[n].sha256, manifest[n].sha256,
      `${n} is named with a hash that is not this build's`);
  }
});

await t("**the measurement: naming instead of carrying**", async () => {
  // THE REAL JAVASCRIPT, not the two stub files the other tests use. A
  // measurement taken over a fixture measures the fixture: with stubs the
  // saving reads "100.0%", which is true of nothing anyone would publish.
  // What a real app carries is the SDK's actual JS, and that is what the
  // percentage has to be against.
  const real = {};
  for (const f of readdirSync(at("../sdk"))) {
    if (/\.js$/.test(f)) real[`sdk/${f}`] = readFileSync(at(`../sdk/${f}`), "utf8");
  }
  assert.ok(Object.keys(real).length >= 5,
    `only ${Object.keys(real).length} SDK js files found — this is measuring a fixture again`);
  const { bytes } = await packageApp(APP, { sdkFiles: real, manifest, artefactsKey: KEY, subtle });
  const carrying = weightCarrying(bytes, manifest);
  const saved = carrying - bytes;
  process.stdout.write(
    `      carrying ${carrying.toLocaleString()} B → naming ${bytes.toLocaleString()} B ` +
    `(${saved.toLocaleString()} B saved, ${((saved / carrying) * 100).toFixed(1)}%)\n`);
  assert.ok(saved > 1_500_000,
    `only ${saved} B saved; the four artefacts are supposed to be ~1.7 MB of every app`);
  assert.ok(bytes < 200_000, `the bundle is still ${bytes} B — something large is being carried`);
  assert.ok(bytes > 50_000,
    `the bundle is only ${bytes} B, which is smaller than the SDK's JavaScript — ` +
    "this is measuring stubs rather than what an app actually carries");
});

await t("**the bundle hash is DETERMINISTIC** — rollback depends on it", async () => {
  // builder#47 is blocked on this: a publication can only be rolled back to
  // if it is a thing that can be named again.
  const a = await packageApp(APP, { sdkFiles: SDK_JS, manifest, artefactsKey: KEY, subtle });
  const b = await packageApp(APP, { sdkFiles: SDK_JS, manifest, artefactsKey: KEY, subtle });
  assert.strictEqual(a.bundleHash, b.bundleHash, "the same app packaged twice gave two hashes");
  assert.match(a.bundleHash, /^[0-9a-f]{64}$/, "that is not a sha256");
});

await t("THE CONTROL: a DIFFERENT app hashes differently", async () => {
  // Without this, a hash that was a constant would satisfy determinism
  // perfectly and make every publication look like every other.
  const a = await packageApp(APP, { sdkFiles: SDK_JS, manifest, artefactsKey: KEY, subtle });
  const b = await packageApp(
    { ...APP, name: "Notes 2" },
    { sdkFiles: SDK_JS, manifest, artefactsKey: KEY, subtle },
  );
  assert.notStrictEqual(a.bundleHash, b.bundleHash,
    "two different apps package to the same hash, so a rollback could not tell them apart");
});

await t("THE CONTROL: a different FILE hashes differently too", async () => {
  // The app definition is not the only thing in a bundle. A hash covering
  // only `app.json` would pass the control above while ignoring the code.
  const a = await packageApp(APP, { sdkFiles: SDK_JS, manifest, artefactsKey: KEY, subtle });
  const b = await packageApp(APP, {
    sdkFiles: { ...SDK_JS, "sdk/index.js": "export const a = 2;\n" },
    manifest, artefactsKey: KEY, subtle,
  });
  assert.notStrictEqual(a.bundleHash, b.bundleHash, "the bundle hash does not cover the app's code");
});

await t("a wasm handed in is REFUSED, not silently dropped", async () => {
  // A caller passing one believes the app will carry it. Dropping it quietly
  // is the difference between a smaller bundle and a broken one.
  await assert.rejects(
    () => packageApp(APP, {
      sdkFiles: { ...SDK_JS, "sdk/block.wasm": new Uint8Array([0]) },
      manifest, artefactsKey: KEY, subtle,
    }),
    /block\.wasm is not a file an app carries/,
  );
});

await t("no artefacts key is a refusal", async () => {
  await assert.rejects(
    () => packageApp(APP, { sdkFiles: SDK_JS, manifest, artefactsKey: null, subtle }),
    /must name the contract/,
  );
});

await t("a manifest missing a hash is a refusal, naming which", async () => {
  const broken = { ...manifest, delegate: { file: "engine_delegate.wasm" } };
  await assert.rejects(
    () => packageApp(APP, { sdkFiles: SDK_JS, manifest: broken, artefactsKey: KEY, subtle }),
    /no hash for: delegate/,
  );
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok package app\n");
process.exit(failures ? 1 : 0);
