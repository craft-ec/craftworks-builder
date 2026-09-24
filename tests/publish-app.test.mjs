// PUBLISH PUTS THE APP ON THE NETWORK (builder#104; as a starter and load pieces, craftworks-sdk#347).
//
// The real SDK entry (`sdk.webapp`), this build's real pieces (cut by the SDK's
// `load-pieces` in build.sh) and `webapp` code, and a session that answers the
// way the node does — the PUT's KEY is what freenet-stdlib derives from (code,
// params, state), via the SDK. What is PUT is unpacked by the REAL xz and tar,
// and the pieces are DECODED by the real decoder wasm, and read back.
import assert from "node:assert";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
import { publishApp, starterOf, starterFiles, coreFiles, PROVISIONING_FILES, STARTER_LIMIT } from "../publish-app.js";
import { decoder, openPieces, linkModules } from "../sdk/pieces.js";
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
const pieces = JSON.parse(readFileSync(at("sdk/pieces.json"), "utf8"));
const PIECE_KEYS = ["core", "provisioning"].flatMap(b => pieces[b].pieces.map(p => p.address));
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

const starterPut = s => s.puts[s.puts.length - 1];
const keys = s => s.puts.map(p => p.key);

await t("**every load piece is PUT at the address sdk/pieces.json names, then the starter — whose key IS the app's address**", async () => {
  const s = node();
  const r = await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.deepStrictEqual(keys(s), [...PIECE_KEYS, r.address]);
  assert.strictEqual(r.address, sdk.webapp.address(readFileSync(at("sdk/webapp.wasm")), starterPut(s).state));
  assert.strictEqual(r.pieces, PIECE_KEYS.length);
  process.stdout.write(`      sizes: starter container ${r.containerBytes} B (bundle ${r.bundleBytes} B); ${r.pieces} piece containers ${r.piecesBytes} B, the same for every app of this build\n`);
});

await t("**the STARTER is ONE container under its limit (96 KiB): the one fetch nothing races** (craftworks-sdk#347)", async () => {
  const s = node();
  const r = await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(STARTER_LIMIT, 96 * 1024);
  assert.ok(r.containerBytes <= STARTER_LIMIT, `the starter is ${r.containerBytes} B, over ${STARTER_LIMIT} B`);
});

await t("**the starter holds the loader, the decoder, the SDK's pre-SDK modules, app.json naming the head, artefacts.json naming the pieces — and no other wasm**", async () => {
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const u = unpack(starterPut(s).state);
  try {
    assert.deepStrictEqual(u.list, [...Object.keys(starterFiles(manifest, sdk.ids)), "app.json", "artefacts.json"].sort());
    assert.deepStrictEqual(u.list.filter(f => /\.wasm$/.test(f)), ["decoder.wasm"], "the starter carries wasm other than the decoder");
    const app = JSON.parse(u.text("app.json"));
    // AND the app id its data was written under (craftworks-sdk#267).
    assert.deepStrictEqual(app.publisher, { head: HEAD, app: "proj1", seq: 7 }, "app.json does not name the app tree's head, app id and published seq");
    const art = JSON.parse(u.text("artefacts.json"));
    assert.deepStrictEqual(art.pieces, { core: pieces.core, provisioning: pieces.provisioning });
    for (const n of NAMED) assert.strictEqual(art[n].sha256, manifest[n].sha256, `${n} named with another hash`);
    assert.strictEqual(u.text("loader.js"), readFileSync(at("app-loader/loader.js"), "utf8"));
  } finally { u.done(); }
});

/** The files of one bundle, from what was PUT: any k piece containers unpacked and DECODED by the real decoder. */
async function bundleOf(s, b, drop = []) {
  const dec = await decoder(readFileSync(at("sdk/decoder.wasm")));
  const shape = pieces[b];
  const got = shape.pieces.map((p, i) => {
    if (drop.includes(i)) return null;
    const put = s.puts.find(x => x.key === p.address);
    const u = unpack(put.state);
    try { return new Uint8Array(readFileSync(join(u.dir, "piece"))); } finally { u.done(); }
  });
  return openPieces(dec, shape, got).files;
}

await t("**the pieces decode to their files — from ANY k of them** (the first m data pieces lost here)", async () => {
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const want = { core: coreFiles(manifest, sdk.ids), provisioning: PROVISIONING_FILES };
  for (const b of ["core", "provisioning"]) {
    const lost = [...Array(Math.min(pieces[b].m, pieces[b].k)).keys()];
    const files = await bundleOf(s, b, lost);
    assert.deepStrictEqual([...files.keys()].sort(), Object.keys(want[b]).sort(), `${b}: not its files`);
    for (const [at_, from] of Object.entries(want[b])) {
      assert.ok(Buffer.from(files.get(at_)).equals(readFileSync(at(from))), `${b}: ${at_} is not ${from}`);
    }
  }
});

await t("**the core bundle's modules LINK and import: the SDK loads its wasm from the bundle's bytes** (what the loader does, with data: URLs for blob: ones)", async () => {
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const files = await bundleOf(s, "core");
  const external = p => (Object.keys(starterFiles(manifest, sdk.ids)).includes(p) ? new URL(`../${p}`, import.meta.url).href : null);
  let n = 0;
  const toUrl = text => `data:text/javascript;base64,${Buffer.from(`${text}\n// ${(n += 1)}`).toString("base64")}`;
  const urls = linkModules(files, { external, toUrl });
  // EVERY module of the real core bundle, through its linked URL: no specifier mis-rewritten (the architect, #355).
  assert.deepStrictEqual([...urls.keys()].sort(), Object.keys(coreFiles(manifest, sdk.ids)).filter(p => p.endsWith(".js")).sort());
  for (const [p, u] of urls) await assert.doesNotReject(() => import(u), `${p} did not import through its linked URL`);
  const { load } = await import(urls.get("sdk/index.js"));
  const linked = await load(files.get("sdk/craftworks_sdk_bg.wasm"));
  assert.strictEqual(typeof linked.openAsked, "function");
  assert.strictEqual(typeof (await import(urls.get("runtime-logic.js"))).openPublished, "function");
});

await t("DETERMINISTIC: the same app publishes to the same address; another app to another; the pieces are the same for both", async () => {
  const [sa, sb, sc] = [node(), node(), node()];
  const a = await publishApp(APP, { sdk, session: sa, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const b = await publishApp(APP, { sdk, session: sb, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const c = await publishApp({ ...APP, name: "Other" }, { sdk, session: sc, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(a.address, b.address);
  assert.notStrictEqual(a.address, c.address, "THE CONTROL: a different app got the same address");
  assert.deepStrictEqual(keys(sc).slice(0, -1), PIECE_KEYS, "another app PUT other pieces");
});

await t("**a refused PUT fails in the node's words, naming WHICH container**", async () => {
  const s = node(key => (PIECE_KEYS.includes(key) ? "put" : { state: "refused", said: "invalid contract update" }));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }),
    /the node refused the app's starter container: invalid contract update/);
  const p = node(key => (key === PIECE_KEYS[2] ? { state: "refused", said: "no" } : "put"));
  await assert.rejects(() => publishApp(APP, { sdk, session: p, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }),
    /the node refused the core piece 2: no/);
});

await t("**the SDK ENDS the PUT: `failed` (given up, in its words) fails the publish naming the container — and the builder never PUTs again itself**", async () => {
  const s = node(key => (PIECE_KEYS.includes(key) ? "put" : { state: "failed", said: "the node did not acknowledge the PUT in 120 s (7 attempts)" }));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }),
    /the app's starter container was not acknowledged: the node did not acknowledge the PUT in 120 s/);
  assert.strictEqual(s.puts.length, PIECE_KEYS.length + 1, "the builder PUT again on its own — the re-send is the SDK's");
});

await t("**pending is the SDK's to end: the builder waits it out, with no budget of its own (a slow node that acks late still publishes)**", async () => {
  const s = node((key, poll) => (poll < 400 ? "pending" : "put"));
  const r = await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.ok(r.address, "a late ack did not publish");
  assert.strictEqual(s.puts.length, PIECE_KEYS.length + 1, "the builder PUT again on its own");
});

await t("refused before anything is sent: no head, and a piece that is not at the address sdk/pieces.json names", async () => {
  const s = node();
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: "", headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }), /no head yet/);
  const moved = { ...pieces, provisioning: { ...pieces.provisioning, pieces: pieces.provisioning.pieces.map((p, i) => (i === 1 ? { ...p, address: "elsewhere" } : p)) } };
  const readMoved = async p => (p === "sdk/pieces.json" ? JSON.stringify(moved) : read(p));
  await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read: readMoved, subtle: crypto.subtle, ...fast }),
    /the provisioning piece 1 is .*, not the elsewhere sdk\/pieces\.json names/);
  assert.strictEqual(s.puts.length, 0, "something was PUT");
});

await t("**UNCHANGED, NOTHING SENT: a reconnect whose app is the same address on the same SDK PUTs nothing** (re-PUTs made the node serve a container 404 for a moment)", async () => {
  const first = await publishApp(APP, { sdk, session: node(), headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(first.put, true);
  const last = { app_contract_id: first.address, sdk_version: "rev-1" };
  const s = node();
  const again = await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast, last, sdkVersion: "rev-1" });
  assert.strictEqual(s.puts.length, 0, `an unchanged app was PUT again: ${keys(s)}`);
  assert.strictEqual(again.put, false);
  assert.strictEqual(again.address, first.address, "the unchanged app reports another address");
});

await t("**ROWS ADDED SINCE MOVE NOTHING: the same app, its data's seq now newer, is not PUT — same address, and it keeps the seq it was published at** (craftworks-sdk#349: the link changes with the app, never with its data)", async () => {
  const first = await publishApp(APP, { sdk, session: node(), headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  assert.strictEqual(first.seq, 7);
  const last = { app_contract_id: first.address, sdk_version: "rev-1", head_seq: first.seq };
  const s = node();
  const again = await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 12, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast, last, sdkVersion: "rev-1" });
  assert.strictEqual(s.puts.length, 0, `an app whose DATA moved was PUT again: ${keys(s)}`);
  assert.strictEqual(again.address, first.address, "the app's link moved with its data");
  assert.strictEqual(again.seq, 7, "the kept container's seq is not the one it was published at");
  // THE CONTROL: the app itself changed — PUT, and at the NEW seq.
  const c = node();
  const changed = await publishApp({ ...APP, name: "Changed" }, { sdk, session: c, headId: HEAD, headSeq: 12, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast, last, sdkVersion: "rev-1" });
  assert.strictEqual(changed.put, true);
  assert.strictEqual(changed.seq, 12, "a changed app was not published at the newest seq");
  const u = unpack(starterPut(c).state);
  try { assert.strictEqual(JSON.parse(u.text("app.json")).publisher.seq, 12); } finally { u.done(); }
});

await t("**an app published BEFORE the seq (its app.json names none) is the same app: not PUT, its address kept**", async () => {
  // The address that publication had: the same starter, its app.json without a seq.
  const old = (await starterOf(APP, { sdk, headId: HEAD, appId: "proj1", seq: null, manifest, pieces, read, subtle: crypto.subtle, code: readFileSync(at("sdk/webapp.wasm")) })).address;
  const s = node();
  const again = await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 12, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast, last: { app_contract_id: old, sdk_version: "rev-1" }, sdkVersion: "rev-1" });
  assert.strictEqual(s.puts.length, 0, "an app published before the seq was PUT again, its link moved");
  assert.strictEqual(again.address, old);
  assert.strictEqual(again.seq, null, "a kept container that names no seq reported one");
});

await t("**no published seq, no publication** — refused by name before anything is PUT", async () => {
  for (const headSeq of [undefined, null, -1, 1.5, NaN, 2 ** 60, "7"]) {
    const s = node();
    await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, headSeq, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast }), /published head's seq is .*not a whole number/, String(headSeq));
    assert.strictEqual(s.puts.length, 0, `${headSeq}: something was PUT`);
  }
});

await t("THE CONTROLS: a changed app, a changed SDK, or an SDK that cannot say its version PUTs every container", async () => {
  const first = await publishApp(APP, { sdk, session: node(), headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const last = { app_contract_id: first.address, sdk_version: "rev-1" };
  for (const [what, app, sdkVersion] of [["a changed app", { ...APP, name: "Changed" }, "rev-1"], ["a changed SDK", APP, "rev-2"], ["no SDK version", APP, null]]) {
    const s = node();
    const r = await publishApp(app, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast, last, sdkVersion });
    assert.deepStrictEqual(keys(s), [...PIECE_KEYS, r.address], `${what}: not all PUT`);
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
/** The reachable modules a published app (its starter plus its core pieces) is missing. */
const missingFrom = (list, dir) => reachableFrom(dir).filter(m => !list.includes(`sdk/${m}`));
/** Every path a published app serves or rebuilds: the starter's files and the core bundle's. */
async function publishedPaths(s) {
  const u = unpack(starterPut(s).state);
  try { return [...u.list, ...(await bundleOf(s, "core")).keys()]; } finally { u.done(); }
}

await t("**the published app carries EVERY module the SDK's entry reaches (starter + core pieces) — from the SDK's own `modules`, never a hand list** (a missing rto.js hung every published page on \"Loading…\")", async () => {
  const sdkDir = at("sdk");
  const reach = reachableFrom(sdkDir);
  assert.ok(reach.length >= 5 && reach.includes("index.js"), `the oracle read nothing: ${reach}`);
  assert.deepStrictEqual([...manifest.modules].sort(), reach, "the SDK's `modules` is not what its entry reaches");
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const list = await publishedPaths(s);
  assert.deepStrictEqual(missingFrom(list, sdkDir), [], "the published app is missing modules its SDK imports");
  for (const m of manifest.modules) assert.ok(list.includes(`sdk/${m}`), `sdk/${m} is not in the published app`);
});

await t("THE CONTROL: a published app missing ONE module is named as missing it by the check", async () => {
  const dropped = manifest.modules.find(m => m !== "index.js");
  const s = node();
  await publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest, read, subtle: crypto.subtle, ...fast });
  const list = (await publishedPaths(s)).filter(p => p !== `sdk/${dropped}`);
  assert.deepStrictEqual(missingFrom(list, at("sdk")), [dropped], "the check did not name the module left out");
});

await t("**no `modules`, no publication — refused by name before anything is PUT; and a module outside sdk/ is refused**", async () => {
  for (const [bad, re] of [[{ ...manifest, modules: undefined }, /names no `modules`/], [{ ...manifest, modules: [] }, /names no `modules`/],
    [{ ...manifest, modules: ["index.js", "../app.js"] }, /not a file beside its index\.js/], [{ ...manifest, modules: ["index.js", ".hidden.js"] }, /not a file beside/]]) {
    const s = node();
    await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId: "proj1", manifest: bad, read, subtle: crypto.subtle, ...fast }), re);
    assert.strictEqual(s.puts.length, 0, "something was PUT for a manifest that names no modules");
  }
});

await t("**no app id, no publication** — a user would read an empty space (craftworks-sdk#267)", async () => {
  const s = node();
  for (const appId of [undefined, "", "Has.Dot", "x".repeat(33)]) {
    await assert.rejects(() => publishApp(APP, { sdk, session: s, headId: HEAD, headSeq: 7, appId, manifest, read, subtle: crypto.subtle, ...fast }), /no app id/,
      `app id ${JSON.stringify(appId)} was published`);
  }
  assert.strictEqual(s.puts.length, 0, "something was PUT for an app that names no space");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok publish app\n");
process.exit(failures ? 1 : 0);
