// PUBLISH PUTS THE APP ON THE NETWORK (builder#104).
//
// The real SDK entry (`sdk.webapp`), this build's real artefacts container
// and `webapp` code, and a session that answers the way the node does — the
// PUT's KEY is what freenet-stdlib derives from (code, params, state), via the
// SDK. What is PUT is unpacked by the REAL xz and tar and read back.
import assert from "node:assert";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
import { publishApp, settled, APP_FILES } from "../publish-app.js";
import { NAMED } from "../package-app.js";

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
const at = p => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = async p => (/\.(js|html|json)$/.test(p) ? readFileSync(at(p), "utf8") : new Uint8Array(readFileSync(at(p))));
const sdk = await loadSdk(readFileSync(at("sdk/craftworks_sdk_bg.wasm")));
const manifest = JSON.parse(readFileSync(at("sdk/artefacts.json"), "utf8"));
const HEAD = "c3".repeat(32);
const APP = { name: "Notes", components: [{ type: "table", domain: "notes" }] };

/** A session as the node answers it: each PUT keyed as the node keys it; `answer(key, n)` scripts put_status. */
function node(answer = () => "put") {
  const puts = [], polls = {};
  return {
    puts,
    put_contract(code, params, state) {
      const key = sdk.webapp.address(code, state);
      assert.deepStrictEqual(params, sdk.webapp.params(state), "a PUT whose params are not webapp's for its state");
      puts.push({ key, state });
      return key;
    },
    put_status(key) {
      polls[key] = (polls[key] ?? 0) + 1;
      const s = answer(key, polls[key], puts.filter(p => p.key === key).length);
      return JSON.stringify(typeof s === "string" ? { state: s, said: "" } : s);
    },
  };
}
const fast = { everyMs: 0, sleep: async () => {} };
const unpack = state => {
  const dir = mkdtempSync(join(tmpdir(), "app-container-"));
  const web = Number(new DataView(state.buffer, state.byteOffset).getBigUint64(8));
  assert.equal(state.length, 16 + web, "the node's framing does not add up");
  const x = spawnSync("sh", ["-c", `xz -dc | tar -xf - -C ${dir}`], { input: state.subarray(16) });
  assert.equal(x.status, 0, `the real xz/tar refused the app container: ${x.stderr}`);
  const list = spawnSync("sh", ["-c", "find . -type f | sort"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n").map(f => f.slice(2));
  return { dir, list, text: f => readFileSync(join(dir, f), "utf8"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

await t("**both containers are PUT: the SDK's artefacts container at its manifest address, and the app's — whose key IS the app's address**", async () => {
  const s = node();
  const r = await publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(r.artefactsKey, manifest.container.address);
  assert.deepStrictEqual(s.puts.map(p => p.key), [manifest.container.address, r.address]);
  assert.strictEqual(r.address, sdk.webapp.address(readFileSync(at("sdk/webapp.wasm")), s.puts[1].state));
  process.stdout.write(`      sizes: app container ${r.containerBytes} B (bundle ${r.bundleBytes} B, xz stored); artefacts container ${r.artefactsBytes} B, PUT once per SDK build\n`);
});

await t("**the app container holds the loader, the runtime, the SDK's JavaScript, app.json naming the publisher's head, artefacts.json naming the artefacts — and NO wasm**", async () => {
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const u = unpack(s.puts[1].state);
  try {
    assert.deepStrictEqual(u.list, [...Object.keys(APP_FILES), "app.json", "artefacts.json"].sort());
    assert.ok(!u.list.some(f => /\.wasm$/.test(f)), "the app carries wasm");
    const app = JSON.parse(u.text("app.json"));
    // AND the app id its data was written under (craftworks-sdk#267): a
    // visitor opens that app's space in the publisher's tree, or reads an
    // empty one.
    assert.deepStrictEqual(app.publisher, { head: HEAD, app: "proj1" }, "app.json does not name the publisher's head and app");
    const art = JSON.parse(u.text("artefacts.json"));
    assert.strictEqual(art.contract, manifest.container.address);
    for (const n of NAMED) assert.strictEqual(art[n].sha256, manifest[n].sha256, `${n} named with another hash`);
    assert.strictEqual(u.text("loader.js"), readFileSync(at("app-loader/loader.js"), "utf8"));
  } finally { u.done(); }
});

await t("DETERMINISTIC: the same app publishes to the same address; another app to another", async () => {
  const a = await publishApp(APP, { sdk, session: node(), headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const b = await publishApp(APP, { sdk, session: node(), headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const c = await publishApp({ ...APP, name: "Other" }, { sdk, session: node(), headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(a.address, b.address);
  assert.notStrictEqual(a.address, c.address, "THE CONTROL: a different app got the same address");
});

await t("**a refused PUT fails in the node's words, naming WHICH container**", async () => {
  const s = node(key => (key === manifest.container.address ? "put" : { state: "refused", said: "invalid contract update" }));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }),
    /the node refused the app's container: invalid contract update/);
});

await t("**the SDK ENDS the PUT: `failed` (given up, in its words) fails the publish naming the container — and the builder never PUTs again itself**", async () => {
  const s = node(key => (key === manifest.container.address ? "put" : { state: "failed", said: "the node did not acknowledge the PUT in 120 s (7 attempts)" }));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }),
    /the app's container was not acknowledged: the node did not acknowledge the PUT in 120 s/);
  assert.strictEqual(s.puts.length, 2, "the builder PUT again on its own — the re-send is the SDK's");
});

await t("**pending is the SDK's to end: the builder waits it out, with no budget of its own (a slow node that acks late still publishes)**", async () => {
  const s = node((key, poll) => (poll < 400 ? "pending" : "put"));
  const r = await publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.ok(r.address, "a late ack did not publish");
  assert.strictEqual(s.puts.length, 2, "the builder PUT again on its own");
});

await t("refused before anything is sent: no head, and an artefacts container that is not the manifest's", async () => {
  const s = node();
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: "", appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }), /no head yet/);
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest: { ...manifest, container: { ...manifest.container, address: "elsewhere" } }, read, subtle: crypto.subtle, ...fast }),
    /not the elsewhere its manifest names/);
});


await t("**no app id, no publication** — a visitor would read an empty space (craftworks-sdk#267)", async () => {
  const s = node();
  for (const appId of [undefined, "", "Has.Dot", "x".repeat(33)]) {
    await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId, manifest, read, subtle: crypto.subtle, ...fast }), /no app id/,
      `app id ${JSON.stringify(appId)} was published`);
  }
  assert.strictEqual(s.puts.length, 0, "something was PUT for an app that names no space");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok publish app\n");
process.exit(failures ? 1 : 0);
