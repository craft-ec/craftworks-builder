// PUBLISH THE BUILDER AS AN APP (ARCHITECTURE §19; app-as-data P5): the one path every app takes. The builder is app
// `craftworks-builder` in B's tree (B's node's signer: its one provisioned key). Its files -- every builder module and
// its page -- are written as `f/<path>` records of its draft (`draftFile`), `meta.entry` names `f/builder-entry.js`
// (which the loader starts with the SDK it loaded), and `publishSite` publishes it: ONE publishDefinition, with the
// site created at the first run or when the build changed. Prints the address once the site reads PUBLISHED.
// Run it through `tools/publish-builder.sh` (realnet.sh's lock, tunnel to B, build and cleanup).
//
//   RN_B=<B's ws, through the tunnel> node tools/publish-builder.mjs
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openFreshBrowser, openPageHost } from "../tests/page-host.mjs";

/** The builder's app id: fixed, so the site's link (B's Register + this id) is the same every run. */
export const BUILDER_APP = "craftworks-builder";
/** Its entry module (builder-entry.js `start`). */
export const BUILDER_ENTRY = "builder-entry.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The builder's code: every top-level module and its page. The SDK is the loader's (its piece set), never a file here. */
export function builderCodeFiles(dir = root) {
  const files = readdirSync(dir).filter(n => statSync(join(dir, n)).isFile() && (/\.js$/.test(n) || n === "index.html")).sort();
  for (const need of ["index.html", "app.js", BUILDER_ENTRY, "sdk-loader.js"]) {
    if (!files.includes(need)) throw new Error(`the builder's ${need} is not there`);
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const B = Number(process.env.RN_B);
  if (!Number.isInteger(B) || B <= 0) { console.log("FAIL  RN_B must name B's ws port (through the tunnel)"); process.exit(2); }
  if ([7509, 7609].includes(B)) { console.log(`FAIL  ${B} is the owner's node: the builder is never published there`); process.exit(2); }
  const STEP_MS = Number(process.env.STEP_MS ?? 180_000);
  const files = builderCodeFiles();
  const host = await openPageHost("publish-builder", { budgetMs: Number(process.env.BUDGET_MS ?? 900_000) });
  let failed = 1;
  try {
    const tab = await host.tab("publisher");
    await tab.navigate(`http://127.0.0.1:${host.port}/#node=${B}`, { ms: STEP_MS });
    const proof = await tab.evaluate(host.pageProof);
    if (proof !== host.nonce) throw new Error(`the page is not served from this tree (its proof: ${JSON.stringify(proof)})`);
    const t0 = Date.now();
    const r = await tab.evaluate(`
      const { loadSdk } = await import("./sdk-loader.js");
      const { readBuilderFile: read, readSdkManifest } = await import("./builder-files.js");
      const { publishSite } = await import("./publish-app.js");
      const sdk = await loadSdk();
      const h = await sdk.open({ app: ${JSON.stringify(BUILDER_APP)}, port: ${B}, artefacts: sdk.SHIPPED_ARTEFACTS, onEvent: () => {} });
      const db = h.db;
      const enc = new TextEncoder();
      const files = ${JSON.stringify(files)};
      for (const p of files) {
        const v = await read(p);
        await db.draftFile(p, typeof v === "string" ? enc.encode(v) : new Uint8Array(v));
      }
      // A file the builder no longer has leaves the draft.
      for (const r of await db.definition("draft")) {
        if (r.key.startsWith("f/") && !files.includes(r.key.slice(2))) await db.draftDelete(r.key);
      }
      await db.draftPut("meta", { name: "Craftec Builder", entry: ${JSON.stringify(`f/${BUILDER_ENTRY}`)} });
      const put = await publishSite(${JSON.stringify(BUILDER_APP)}, { sdk, db, session: h.session, manifest: await readSdkManifest(), read, subtle: crypto.subtle });
      return { ...put, files: files.length };`, { ms: STEP_MS * 3 });
    console.log(`SITE  the builder is published as app ${BUILDER_APP}: ${r.files} code files; its site at ${r.address}, version ${r.version ?? "?"} (${Date.now() - t0} ms)`);
    console.log(`ADDRESS ${r.address}`);
    // PASS ONLY IF IT LOADS (main): a fresh browser opens the address through A, read-only, and the builder's page
    // must reach "SDK ready" (its #sdk line) -- else FAIL with what the page said.
    const A = Number(process.env.RN_A);
    if (!Number.isInteger(A) || A <= 0) throw new Error("RN_A must name A's ws port: the published builder is checked through A");
    if ([7509, 7609].includes(A) && process.env.REALNET_OWNER_OK !== "1") throw new Error(`${A} is the owner's node: reading through it needs REALNET_OWNER_OK=1`);
    const b = await openFreshBrowser("publish-builder: the builder through A");
    try {
      const view = await b.tab("builder-on-a");
      const tL = Date.now();
      await view.navigate(`http://127.0.0.1:${A}/v1/contract/web/${r.address}/`, { ms: STEP_MS });
      const frame = `127.0.0.1:${A}/v1/contract/web/${r.address}/?__sandbox=1`;
      let seen = null;
      while (Date.now() - tL < STEP_MS) {
        seen = await view.evaluateIn(frame, `return { sdk: document.getElementById("sdk")?.textContent ?? null, status: document.getElementById("status")?.textContent ?? null, phases: globalThis.__craftworksOpen ?? null };`).catch(e => ({ error: e.message }));
        if (/^SDK /.test(seen?.sdk ?? "")) break;
        await new Promise(ok => setTimeout(ok, 1000));
      }
      if (!/^SDK /.test(seen?.sdk ?? "")) throw new Error(`the builder did not reach SDK ready through A in ${STEP_MS / 1000} s: ${JSON.stringify(seen)}`);
      console.log(`PASS  the builder LOADS through A: "${seen.sdk}" in ${Date.now() - tL} ms`);
    } finally {
      await b.stop();
    }
    failed = 0;
  } catch (e) {
    console.log(`FAIL  the builder was not published: ${e.message}`);
  } finally {
    await host.done(failed);
  }
}
