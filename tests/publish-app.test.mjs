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
const fast = { budgetMs: 1000, everyMs: 0, sleep: async () => {} };
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
  const r = await publishApp(APP, { sdk, session: s, headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(r.artefactsKey, manifest.container.address);
  assert.deepStrictEqual(s.puts.map(p => p.key), [manifest.container.address, r.address]);
  assert.strictEqual(r.address, sdk.webapp.address(readFileSync(at("sdk/webapp.wasm")), s.puts[1].state));
  process.stdout.write(`      sizes: app container ${r.containerBytes} B (bundle ${r.bundleBytes} B, xz stored); artefacts container ${r.artefactsBytes} B, PUT once per SDK build\n`);
});

await t("**the app container holds the loader, the runtime, the SDK's JavaScript, app.json naming the publisher's head, artefacts.json naming the artefacts — and NO wasm**", async () => {
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast });
  const u = unpack(s.puts[1].state);
  try {
    assert.deepStrictEqual(u.list, [...Object.keys(APP_FILES), "app.json", "artefacts.json"].sort());
    assert.ok(!u.list.some(f => /\.wasm$/.test(f)), "the app carries wasm");
    const app = JSON.parse(u.text("app.json"));
    assert.deepStrictEqual(app.publisher, { head: HEAD }, "app.json does not name the publisher's head");
    const art = JSON.parse(u.text("artefacts.json"));
    assert.strictEqual(art.contract, manifest.container.address);
    for (const n of NAMED) assert.strictEqual(art[n].sha256, manifest[n].sha256, `${n} named with another hash`);
    assert.strictEqual(u.text("loader.js"), readFileSync(at("app-loader/loader.js"), "utf8"));
  } finally { u.done(); }
});

await t("DETERMINISTIC: the same app publishes to the same address; another app to another", async () => {
  const a = await publishApp(APP, { sdk, session: node(), headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast });
  const b = await publishApp(APP, { sdk, session: node(), headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast });
  const c = await publishApp({ ...APP, name: "Other" }, { sdk, session: node(), headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(a.address, b.address);
  assert.notStrictEqual(a.address, c.address, "THE CONTROL: a different app got the same address");
});

await t("**a refused PUT fails in the node's words, naming WHICH container**", async () => {
  const s = node(key => (key === manifest.container.address ? "put" : { state: "refused", said: "invalid contract update" }));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast }),
    /the node refused the app's container: invalid contract update/);
});

await t("an UNANSWERED PUT (the socket dropped) is PUT again once and settles; twice is a failure", async () => {
  let s = node((key, poll, sent) => (sent < 2 ? "unanswered" : "put"));
  await publishApp(APP, { sdk, session: s, headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(s.puts.length, 4, "each container was PUT again exactly once");
  s = node(() => "unanswered");
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, manifest, read, subtle: crypto.subtle, ...fast }), /unanswered twice/);
});

await t("silence past the budget fails saying so — never 'published' short of the ack", async () => {
  let clock = 0;
  await assert.rejects(
    () => settled(node(() => "pending"), "k", "the app's container", () => {}, { budgetMs: 5000, everyMs: 1000, now: () => clock, sleep: async ms => { clock += ms; } }),
    /did not acknowledge the app's container in 5 s/);
});

await t("refused before anything is sent: no head, and an artefacts container that is not the manifest's", async () => {
  const s = node();
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: "", manifest, read, subtle: crypto.subtle, ...fast }), /no head yet/);
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, manifest: { ...manifest, container: { ...manifest.container, address: "elsewhere" } }, read, subtle: crypto.subtle, ...fast }),
    /not the elsewhere its manifest names/);
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok publish app\n");
process.exit(failures ? 1 : 0);
