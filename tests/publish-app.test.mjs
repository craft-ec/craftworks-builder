// PUBLISHING AN APP (ARCHITECTURE §19; app-as-data P5): ONE `publishDefinition` -- the definition in one write, and
// the SITE in the same call only at the app's first publish or when the build changed (`publishDefinition({ site })`,
// sdk#560): the build's ONE piece set and the STARTER (index.html, the loader, the decoder, the SDK's pre-SDK modules,
// artefacts.json naming the set), never an app.json -- the app is data in its owner's tree. "Published" only once the
// site READS published (`app_publish_status`), never when the call returns.
import assert from "node:assert";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
import { publishSite, starterOf, starterFiles, appBundleFiles, STARTER_LIMIT } from "../publish-app.js";
import { decoder, openPieces, linkModules } from "../sdk/pieces.js";
import { NAMED } from "../package-app.js";

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
};
const at = p => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = async p => (/\.(js|html|json)$/.test(p) ? readFileSync(at(p), "utf8") : new Uint8Array(readFileSync(at(p))));
const sdk = await loadSdk(readFileSync(at("sdk/craftworks_sdk_bg.wasm")));
const manifest = JSON.parse(readFileSync(at("sdk/artefacts.json"), "utf8"));
const pieces = JSON.parse(readFileSync(at("sdk/pieces.json"), "utf8"));
const SITE_CODE = new Uint8Array(readFileSync(at("sdk/site.wasm")));
const linkOf = appId => `site-link-of-${appId}`;
const fast = { everyMs: 0, sleep: async () => {} };

/** The owner's tree (`publishDefinition`) and its session (`site_link`, `app_publish_status` scripted by `status(n)`). */
function node(status = n => (n < 3 ? { state: n === 1 ? "pieces" : "siting" } : { state: "published", version: 1 })) {
  const calls = [];
  let polls = 0;
  const cancelled = [];
  return {
    calls, cancelled,
    db: {
      async publishDefinition(opts) {
        calls.push(opts ?? null);
        if (!opts?.site) return 1;
        assert.deepStrictEqual(opts.site.siteCode, SITE_CODE, "the site under another code than site.wasm");
        return { changed: 1, link: linkOf("proj1") };
      },
    },
    session: {
      site_link(appId, code) {
        assert.deepStrictEqual(code, SITE_CODE, "the site linked under another code than site.wasm");
        return linkOf(appId);
      },
      app_publish_status() {
        polls += 1;
        if (cancelled.length) return JSON.stringify({ state: "cancelled", version: 0, said: "" });
        return JSON.stringify({ version: 0, said: "", ...status(polls) });
      },
      cancel_app_publish(appId) { cancelled.push(appId); },
    },
    polls: () => polls,
  };
}
const publish = (n, over = {}) => publishSite("proj1", { sdk, db: n.db, session: n.session, manifest, read, subtle: crypto.subtle, ...fast, ...over });

const unpackWeb = web => {
  const dir = mkdtempSync(join(tmpdir(), "starter-"));
  const x = spawnSync("sh", ["-c", `xz -dc | tar -xf - -C ${dir}`], { input: web });
  assert.equal(x.status, 0, `the real xz/tar refused the starter: ${x.stderr}`);
  const list = spawnSync("sh", ["-c", "find . -type f | sort"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n").map(f => f.slice(2));
  return { dir, list, text: f => readFileSync(join(dir, f), "utf8"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

await t("**the first publish is ONE publishDefinition WITH the site: the build's `app` piece set, every piece's container, the starter -- and it is PUBLISHED only once the site reads so**", async () => {
  const n = node();
  const r = await publish(n);
  assert.strictEqual(n.calls.length, 1, "not ONE publishDefinition");
  const { site } = n.calls[0];
  assert.deepStrictEqual(site.set, { name: "app", ...pieces.app });
  assert.strictEqual(site.pieceStates.length, pieces.app.pieces.length);
  assert.strictEqual(r.address, linkOf("proj1"));
  assert.strictEqual(r.version, 1);
  assert.strictEqual(r.put, true);
  assert.ok(n.polls() >= 3, `resolved before the site read published (${n.polls()} status reads): a link that does not open yet`);
});

await t("**the STARTER is ONE container under its limit, and holds the loader, the decoder, the SDK's pre-SDK modules and artefacts.json naming the ONE set -- never an app.json, never another wasm**", async () => {
  const s = await starterOf({ sdk, manifest, pieces, read, subtle: crypto.subtle });
  assert.ok(s.state.length <= STARTER_LIMIT, `the starter is ${s.state.length} B, over ${STARTER_LIMIT} B`);
  const u = unpackWeb(s.container().web());
  try {
    assert.deepStrictEqual(u.list, [...Object.keys(starterFiles(manifest, sdk.ids)), "artefacts.json"].sort());
    assert.deepStrictEqual(u.list.filter(f => /\.wasm$/.test(f)), ["decoder.wasm"]);
    const art = JSON.parse(u.text("artefacts.json"));
    assert.deepStrictEqual(art.pieces, { app: pieces.app });
    for (const k of NAMED) assert.strictEqual(art[k].sha256, manifest[k].sha256, `${k} named with another hash`);
    assert.strictEqual(u.text("loader.js"), readFileSync(at("app-loader/loader.js"), "utf8"));
  } finally { u.done(); }
});

await t("**THE SITE IS CURRENT: the same link, starter and SDK -> the definition alone is published, no site**", async () => {
  const first = node();
  const r = await publish(first);
  const again = node();
  const r2 = await publish(again, { last: { app_contract_id: r.address, bundle_hash: r.bundleHash, sdk_version: "v1" }, sdkVersion: "v1" });
  assert.deepStrictEqual(again.calls, [null], "a current site was published again, or the definition was not");
  assert.strictEqual(r2.put, false);
  // THE CONTROL: another SDK -> the site again.
  const up = node();
  await publish(up, { last: { app_contract_id: r.address, bundle_hash: r.bundleHash, sdk_version: "v1" }, sdkVersion: "v2" });
  assert.ok(up.calls[0]?.site, "a new build did not publish its site");
});

await t("**a refused, superseded or cancelled site fails in its words** (no time ends it)", async () => {
  await assert.rejects(publish(node(() => ({ state: "refused", said: "no room" }))), /the app's site was refused: no room/);
  await assert.rejects(publish(node(() => ({ state: "superseded", version: 4 }))), /another publication of this app's site is live: version 4/);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(publish(node(() => ({ state: "siting" })), { signal: stop.signal }), /cancelled/);
});

/** The ONE bundle's files, from the piece containers publish hands over, any k DECODED by the real decoder. */
async function bundleOf(states, drop = []) {
  const dec = await decoder(readFileSync(at("sdk/decoder.wasm")));
  const got = states.map((state, i) => {
    if (drop.includes(i)) return null;
    const web = Number(new DataView(state.buffer, state.byteOffset).getBigUint64(8));
    const u = unpackWeb(state.subarray(16, 16 + web));
    try { return new Uint8Array(readFileSync(join(u.dir, "piece"))); } finally { u.done(); }
  });
  return openPieces(dec, pieces.app, got).files;
}

await t("**the ONE bundle decodes to its files from ANY k pieces, and its modules LINK and import (the SDK loads from its bytes)**", async () => {
  const n = node();
  await publish(n);
  const states = n.calls[0].site.pieceStates;
  const lost = [...Array(Math.min(pieces.app.m, pieces.app.k)).keys()];
  const files = await bundleOf(states, lost);
  const want = appBundleFiles(manifest, sdk.ids);
  assert.deepStrictEqual([...files.keys()].sort(), Object.keys(want).sort());
  for (const [p, from] of Object.entries(want)) assert.ok(Buffer.from(files.get(p)).equals(readFileSync(at(from))), `${p} is not ${from}`);
  const external = p => (Object.keys(starterFiles(manifest, sdk.ids)).includes(p) ? new URL(`../${p}`, import.meta.url).href : null);
  let k = 0;
  const toUrl = text => `data:text/javascript;base64,${Buffer.from(`${text}\n// ${(k += 1)}`).toString("base64")}`;
  const urls = linkModules(files, { external, toUrl });
  for (const [p, u] of urls) await assert.doesNotReject(() => import(u), `${p} did not import through its linked URL`);
  const { load } = await import(urls.get("sdk/index.js"));
  const linked = await load(files.get("sdk/craftworks_sdk_bg.wasm"));
  assert.strictEqual(typeof linked.openPointer, "function", "the linked SDK has no openPointer: the loader could not read its pointer");
  assert.strictEqual(typeof (await import(urls.get("app-code.js"))).codeOf, "function");
  assert.strictEqual(typeof (await import(urls.get("definition.js"))).appOf, "function");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
