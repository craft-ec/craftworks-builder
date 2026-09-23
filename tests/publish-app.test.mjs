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
import { publishApp, settled, APP_FILES, appFiles } from "../publish-app.js";
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
    // THE SITE (builder#117): one stable key per app, the next version per
    // publish. Recorded as a PUT of the state the node would hold (the web
    // part, framed), so the container checks below read the same bytes.
    publish_site(app, code, web) {
      assert.ok(code.length > 0, "the site was published with no contract code");
      const key = SITE_KEY(app);
      const framed = new Uint8Array(16 + web.length);
      new DataView(framed.buffer).setBigUint64(8, BigInt(web.length));
      framed.set(web, 16);
      puts.push({ key, state: framed, site: true });
      this.site = key;
      return key;
    },
    site_status() {
      if (!this.site) return JSON.stringify({ state: "none", version: 0, key: "", said: "" });
      polls[this.site] = (polls[this.site] ?? 0) + 1;
      const a = answer(this.site, polls[this.site], puts.filter(p => p.key === this.site).length);
      const { state, said = "" } = typeof a === "string" ? { state: a } : a;
      const version = puts.filter(p => p.key === this.site).length;
      return JSON.stringify({ state: state === "put" ? "published" : state === "pending" ? "putting" : state, version, key: this.site, said });
    },
  };
}
/** A site's key: the fake's, stable per app (the real one derives from the identity and the app id). */
const SITE_KEY = app => `site-key-of-${app}`;
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
  assert.strictEqual(r.address, SITE_KEY("proj1"), "the app's address is not its SITE's key");
  assert.strictEqual(r.version, 1, "the first publish is not the site's version 1");
  process.stdout.write(`      sizes: app container ${r.containerBytes} B (bundle ${r.bundleBytes} B, xz stored); artefacts container ${r.artefactsBytes} B, PUT once per SDK build\n`);
});

await t("**the app container holds the loader, the runtime, the SDK's JavaScript, app.json naming the head of the app's tree, artefacts.json naming the artefacts — and NO wasm**", async () => {
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const u = unpack(s.puts[1].state);
  try {
    assert.deepStrictEqual(u.list, [...Object.keys(appFiles(manifest)), "app.json", "artefacts.json"].sort());
    assert.ok(!u.list.some(f => /\.wasm$/.test(f)), "the app carries wasm");
    const app = JSON.parse(u.text("app.json"));
    // AND the app id its data was written under (craftworks-sdk#267): a
    // user opens that app's space in the app's tree, or reads an
    // empty one.
    assert.deepStrictEqual(app.publisher, { head: HEAD, app: "proj1" }, "app.json does not name the app tree's head and app id");
    const art = JSON.parse(u.text("artefacts.json"));
    assert.strictEqual(art.contract, manifest.container.address);
    for (const n of NAMED) assert.strictEqual(art[n].sha256, manifest[n].sha256, `${n} named with another hash`);
    assert.strictEqual(u.text("loader.js"), readFileSync(at("app-loader/loader.js"), "utf8"));
  } finally { u.done(); }
});

await t("**ONE STABLE ADDRESS (builder#117): a changed app republishes at the SAME address — its site's — while another app id is another address**", async () => {
  const a = await publishApp(APP, { sdk, session: node(), headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const c = await publishApp({ ...APP, name: "Changed" }, { sdk, session: node(), headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.notStrictEqual(a.bundleHash, c.bundleHash, "THE SETUP: the changed app is not a different bundle");
  assert.strictEqual(a.address, c.address, "a changed app moved to another address: the link would break");
  const other = await publishApp(APP, { sdk, session: node(), headId: HEAD, appId: "proj2", manifest, read, subtle: crypto.subtle, ...fast });
  assert.notStrictEqual(a.address, other.address, "THE CONTROL: another app id got the same address");
});

await t("**a refused PUT fails in the node's words, naming WHICH container**", async () => {
  const s = node(key => (key === manifest.container.address ? "put" : { state: "refused", said: "invalid contract update" }));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }),
    /the app's site was not published: invalid contract update/);
});

await t("**a refused site ends the publish naming it — and the builder never re-publishes on its own**", async () => {
  const s = node(key => (key === manifest.container.address ? "put" : { state: "refused", said: "the signer refused the site's version 1" }));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }),
    /the app's site was not published: the signer refused the site's version 1/);
  assert.strictEqual(s.puts.filter(p => p.site).length, 1, "the builder published the site again on its own — the re-send is the SDK's");
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


await t("**UNCHANGED, NOTHING SENT: a reconnect whose app is the same BUNDLE on the same SDK PUTs neither container, and keeps its address** (re-PUTs made the node serve the artefacts 404 for a moment)", async () => {
  const first = await publishApp(APP, { sdk, session: node(), headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(first.put, true);
  const last = { app_contract_id: first.address, bundle_hash: first.bundleHash, sdk_version: "rev-1" };
  const s = node();
  const again = await publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast, last, sdkVersion: "rev-1" });
  assert.strictEqual(s.puts.length, 0, `an unchanged app was PUT again: ${s.puts.map(p => p.key)}`);
  assert.strictEqual(again.put, false);
  assert.strictEqual(again.address, first.address, "the unchanged app reports another address");
  assert.strictEqual(again.artefactsKey, manifest.container.address);
});

await t("THE CONTROLS: a changed app, a changed SDK, or an SDK that cannot say its version PUTs both containers", async () => {
  const first = await publishApp(APP, { sdk, session: node(), headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const last = { app_contract_id: first.address, bundle_hash: first.bundleHash, sdk_version: "rev-1" };
  for (const [what, app, sdkVersion] of [["a changed app", { ...APP, name: "Changed" }, "rev-1"], ["a changed SDK", APP, "rev-2"], ["no SDK version", APP, null]]) {
    const s = node();
    const r = await publishApp(app, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast, last, sdkVersion });
    assert.deepStrictEqual(s.puts.map(p => p.key), [manifest.container.address, r.address], `${what}: not both PUT`);
    assert.strictEqual(r.put, true, what);
  }
});

/**
 * Every module the SDK's entry reaches, by following its imports: an oracle
 * INDEPENDENT of the manifest (the manifest is what is under test).
 */
function reachableFrom(dir, entry = "index.js") {
  const seen = new Set();
  const walk = f => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']\.\/([A-Za-z0-9_.-]+\.js)["']/g)) walk(m[1]);
  };
  walk(entry);
  return [...seen].sort();
}
/** The reachable modules a published container is missing. */
const missingFrom = (list, dir) => reachableFrom(dir).filter(m => !list.includes(`sdk/${m}`));

await t("**the published app carries EVERY module the SDK's entry reaches — from the SDK's own `modules`, never a hand list** (a missing rto.js hung every published page on \"Loading…\")", async () => {
  const sdkDir = at("sdk");
  const reach = reachableFrom(sdkDir);
  assert.ok(reach.length >= 5 && reach.includes("index.js"), `the oracle read nothing: ${reach}`);
  assert.deepStrictEqual([...manifest.modules].sort(), reach, "the SDK's `modules` is not what its entry reaches");
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const u = unpack(s.puts[1].state);
  try {
    assert.deepStrictEqual(missingFrom(u.list, sdkDir), [], "the published app is missing modules its SDK imports");
    for (const m of manifest.modules) assert.ok(u.list.includes(`sdk/${m}`), `sdk/${m} is not in the published app`);
  } finally { u.done(); }
});

await t("THE CONTROL: a manifest that leaves out ONE module publishes an app the check names as missing it", async () => {
  const dropped = manifest.modules.find(m => m !== "index.js");
  const short = { ...manifest, modules: manifest.modules.filter(m => m !== dropped) };
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest: short, read, subtle: crypto.subtle, ...fast });
  const u = unpack(s.puts[1].state);
  try {
    assert.deepStrictEqual(missingFrom(u.list, at("sdk")), [dropped], "the check did not name the module the manifest left out");
  } finally { u.done(); }
});

await t("**no `modules`, no publication — refused by name before anything is PUT; and a module outside sdk/ is refused**", async () => {
  for (const [bad, re] of [[{ ...manifest, modules: undefined }, /names no `modules`/], [{ ...manifest, modules: [] }, /names no `modules`/],
    [{ ...manifest, modules: ["index.js", "../app.js"] }, /not a file beside its index\.js/], [{ ...manifest, modules: ["index.js", ".hidden.js"] }, /not a file beside/]]) {
    const s = node();
    await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId: "proj1", manifest: bad, read, subtle: crypto.subtle, ...fast }), re);
    assert.strictEqual(s.puts.length, 0, "something was PUT for a manifest that names no modules");
  }
});

await t("**no app id, no publication** — a user would read an empty space (craftworks-sdk#267)", async () => {
  const s = node();
  for (const appId of [undefined, "", "Has.Dot", "x".repeat(33)]) {
    await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, appId, manifest, read, subtle: crypto.subtle, ...fast }), /no app id/,
      `app id ${JSON.stringify(appId)} was published`);
  }
  assert.strictEqual(s.puts.length, 0, "something was PUT for an app that names no space");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok publish app\n");
process.exit(failures ? 1 : 0);
