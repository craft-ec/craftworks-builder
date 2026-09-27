// PUBLISH THE BUILDER ITSELF on freenet, as the iterative test build (the owner, 2026-09-27). Run it through
// `tools/publish-builder.sh`, which is `tools/realnet.sh --publish-builder`: the realnet lock, the ONE tunnel to B,
// the build of THIS tree, B's before/after check and the cleanup proof are realnet.sh's, never copied here.
//
// The builder is ONE site (ARCHITECTURE §19's platform exception: a site written at creation and on an upgrade):
// the builder's served files -- its page, its modules, the app loader and the SDK it ships -- packed by the SDK's own `webapp.AppContainer` and published through the
// SDK's one site door (`session.publish_site`) under a FIXED app id. The site's link is `site_contract(site code,
// the publisher's Register, app id)`: the same publisher and the same id give the SAME address every run, each run
// its next version. The publisher is B's node's own signer (its one provisioned key, B's test key; the key never
// leaves the signer delegate). Prints the address and the version.
//
// THE CHECK, through A and READ-ONLY (never a write, never A's log): A serves the PUBLISHED version -- the site's
// build-info.json read by an HTTP GET through A names the same builder revision -- and the builder LOADS there: a fresh
// browser opens the address through A and the builder's page runs (its palette is drawn by its own code).
//
//   RN_B=<B's ws, through the tunnel> RN_A=<A's ws> node tools/publish-builder.mjs

/** One bounded read-only GET of `path` in the site `address` through `port`'s node: its bytes, or null. */
async function getThrough(port, address, path, ms = 30_000) {
  const once = new AbortController();
  try {
    return await served({ url: `http://127.0.0.1:${port}/v1/contract/web/${address}/${path}` }, {
      rec: null, name: path, signal: once.signal,
      init: { cache: "no-store", signal: AbortSignal.timeout(ms) },
      onWait: () => once.abort(),
    });
  } catch {
    return null;
  }
}
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openFreshBrowser, openPageHost } from "../tests/page-host.mjs";
import { served } from "../sdk/served.js";

/**
 * THE SITE'S BOUND: one site record rides ONE wire frame, and the SDK's frame is 4 MiB (sdk wire `MAX_FRAME`). A
 * 5.9 MB site (the SDK's load pieces included) was sent and sat "publishing" for 541 s with nothing said, so a site
 * over it is refused HERE, by name, before anything is sent. The load PIECES (sdk/pieces, 3.1 MB) are not carried:
 * the published builder loads and edits without them; publishing an app from it needs them (a later platform upgrade).
 */
export const SITE_LIMIT = 4 * 1024 * 1024;

/** The builder's site id: fixed, so every run publishes the next version at ONE address. */
export const BUILDER_APP = "craftworks-builder";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The files the builder SERVES (serve.sh serves the checkout): its page and build stamp, its page modules (every
 * top-level .js), the app loader, and the SDK directory the build wrote, less its load pieces (SITE_LIMIT). Never tests/, tools/,
 * docs/ or the repository's own files. Sorted: the same build packs the same list.
 */
export function builderSiteFiles(dir = root) {
  const walk = d => readdirSync(join(dir, d)).flatMap(n => {
    const p = d ? `${d}/${n}` : n;
    return statSync(join(dir, p)).isDirectory() ? walk(p) : [p];
  });
  const top = readdirSync(dir).filter(n => statSync(join(dir, n)).isFile() && (/\.js$/.test(n) || n === "index.html" || n === "build-info.json"));
  const files = [...top, ...walk("app-loader"), ...walk("sdk")].filter(p => !/(^|\/)\.DS_Store$/.test(p) && !p.startsWith("sdk/pieces/"));
  for (const need of ["index.html", "app.js", "build-info.json", "sdk/index.js", "sdk/craftworks_sdk_bg.wasm", "sdk/site.wasm"]) {
    if (!files.includes(need)) throw new Error(`the builder's ${need} is not there: run build.sh first (${relative(process.cwd(), dir) || "."})`);
  }
  return files.sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const B = Number(process.env.RN_B);
  const A = Number(process.env.RN_A);
  if (!Number.isInteger(A) || A <= 0) { console.log("FAIL  RN_A must name A's ws port: the published builder is checked through A"); process.exit(2); }
  if ([7509, 7609].includes(A) && process.env.REALNET_OWNER_OK !== "1") { console.log(`FAIL  ${A} is the owner's node: reading through it needs REALNET_OWNER_OK=1`); process.exit(2); }
  if (!Number.isInteger(B) || B <= 0) { console.log("FAIL  RN_B must name B's ws port (through the tunnel)"); process.exit(2); }
  if ([7509, 7609].includes(B)) { console.log(`FAIL  ${B} is the owner's node: the builder is never published there`); process.exit(2); }
  const STEP_MS = Number(process.env.STEP_MS ?? 180_000);
  let files;
  try { files = builderSiteFiles(); } catch (e) { console.log(`FAIL  ${e.message}`); process.exit(2); }
  const host = await openPageHost("publish-builder", { budgetMs: Number(process.env.BUDGET_MS ?? 900_000) });
  let failed = 1;
  try {
    const tab = await host.tab("publisher");
    await tab.navigate(`http://127.0.0.1:${host.port}/#node=${B}`, { ms: STEP_MS });
    // THIS TREE is what is published: the page must be served from it (page-host's nonce, builder#70).
    const proof = await tab.evaluate(host.pageProof);
    if (proof !== host.nonce) throw new Error(`the page is not served from this tree (its proof: ${JSON.stringify(proof)})`);
    const t0 = Date.now();
    // IN PHASES, each bounded and SAID (a single evaluate that stalled for 540 s named nothing): open, pack + send,
    // then the site's status read from outside the page until it ends on an answer.
    const say = (what, t) => console.log(`TIME  ${what} (${Date.now() - t} ms)`);
    let t = Date.now();
    await tab.evaluate(`
      const { loadSdk } = await import("./sdk-loader.js");
      const sdk = await loadSdk();
      const h = await sdk.open({ app: ${JSON.stringify(BUILDER_APP)}, port: ${B}, artefacts: sdk.SHIPPED_ARTEFACTS, onEvent: () => {} });
      globalThis.__pb = { sdk, h };
      return 1;`, { ms: STEP_MS });
    say("the Session is open on B (its signer provisioned)", t);
    t = Date.now();
    const sent = await tab.evaluate(`
      const { sdk, h } = globalThis.__pb;
      const { readBuilderFile: read } = await import("./builder-files.js");
      const enc = new TextEncoder();
      const c = new sdk.webapp.AppContainer();
      let raw = 0;
      for (const p of ${JSON.stringify(files)}) {
        const v = await read(p);
        const b = typeof v === "string" ? enc.encode(v) : new Uint8Array(v);
        raw += b.length;
        c.add(p, b);
      }
      c.finish();
      const web = c.web();
      if (web.length > ${SITE_LIMIT}) throw new Error("the builder's site is " + web.length + " bytes, over the one-frame bound of ${SITE_LIMIT}: nothing was sent");
      const siteCode = new Uint8Array(await read("sdk/site.wasm"));
      const link = h.session.site_link(${JSON.stringify(BUILDER_APP)}, siteCode);
      const sent = h.session.publish_site(${JSON.stringify(BUILDER_APP)}, siteCode, web);
      if (sent !== link) throw new Error("the SDK published the site at " + sent + ", not the " + link + " it links");
      const info = JSON.parse(await read("build-info.json"));
      return { address: link, files: ${files.length}, rawBytes: raw, webBytes: web.length, builder: info.builder?.rev ?? null, sdk: info.sdkRev ?? null };`, { ms: STEP_MS });
    say(`packed ${sent.files} files (${sent.rawBytes} bytes -> ${sent.webBytes}) and sent the site ${sent.address}`, t);
    t = Date.now();
    // WHAT IS OPEN, said as it changes: the site's status and the request the page has waited on longest (the SDK's
    // `not_answering`); at a stall, the page's own op recording (`page_trace`) is kept beside the run's logs.
    const SITE_MS = Number(process.env.PB_SITE_MS ?? STEP_MS * 3);
    let st = null, last = "";
    const said = new Map();
    while (Date.now() - t < SITE_MS) {
      st = await tab.evaluate(`const s = globalThis.__pb.h.session; return { ...JSON.parse(s.site_status(${JSON.stringify(BUILDER_APP)})), waiting: JSON.parse(s.not_answering()), unusable: JSON.parse(s.take_unusable()) };`, { ms: 30_000 }).catch(e => ({ state: "unreadable", said: e.message }));
      // WHAT THE PAGE COULD NOT USE (the SDK's own lines, drained here): each distinct one said once, with its count.
      for (const u of st.unusable ?? []) { const n = (said.get(u) ?? 0) + 1; said.set(u, n); if (n === 1) console.log(`SAID  +${Date.now() - t} ms: ${u}`); }
      delete st.unusable;
      const now = JSON.stringify({ ...st, waiting: st.waiting ? { what: st.waiting.what, s: Math.floor(st.waiting.ms / 10_000) * 10 } : null });
      if (now !== last) { console.log(`SITE  +${Date.now() - t} ms: ${JSON.stringify(st)}`); last = now; }
      if (["published", "superseded", "refused", "cancelled", "none", "unreadable"].includes(st.state)) break;
      await new Promise(ok => setTimeout(ok, 2000));
    }
    if (st?.state !== "published") {
      const trace = await tab.evaluate(`return globalThis.__pb.h.session.page_trace();`, { ms: 30_000 }).catch(e => `unreadable: ${e.message}`);
      const out = join(process.env.RN_WIRE_DIR ?? process.env.TMPDIR ?? ".", "publish-builder.page-trace.txt");
      writeFileSync(out, String(trace));
      console.log(`TRACE the page's ops at the stall: ${out}\n${String(trace).split("\n").slice(-40).join("\n")}`);
      throw new Error(`the site did not end published: ${JSON.stringify(st)} after ${Math.round((Date.now() - t) / 1000)} s`);
    }
    const r = { ...sent, version: st.version };
    console.log(`PASS  the builder is published at ${r.address}, version ${r.version} (${Date.now() - t0} ms): ${r.files} files, ${r.rawBytes} bytes packed to ${r.webBytes}; builder ${r.builder ?? "?"}, sdk ${String(r.sdk ?? "?").slice(0, 12)}`);
    console.log(`ADDRESS ${r.address}`);
    console.log(`VERSION ${r.version}`);

    // A SERVES THIS VERSION: its build-info.json names the builder revision just published (read-only GETs).
    const tA = Date.now();
    let seen = null, reads = 0;
    while (Date.now() - tA < STEP_MS) {
      reads += 1;
      const bytes = await getThrough(A, r.address, "build-info.json");
      try { seen = bytes ? JSON.parse(new TextDecoder().decode(bytes)).builder?.rev ?? null : null; } catch { seen = null; }
      if (seen === r.builder) break;
      await new Promise(ok => setTimeout(ok, 2000));
    }
    const servedOk = seen === r.builder;
    console.log(`${servedOk ? "PASS" : "FAIL"}  A serves ${servedOk ? `THIS version (builder ${r.builder}) after ${Date.now() - tA} ms` : `${seen ? `builder ${seen}` : "nothing"} after ${Math.round((Date.now() - tA) / 1000)} s`} (${reads} read-only GET(s))`);
    // THE BUILDER LOADS through A: its page runs and draws its palette.
    let loads = false;
    if (servedOk) {
      const b = await openFreshBrowser("publish-builder: the published builder, through A");
      try {
        const view = await b.tab("builder-on-a");
        const tL = Date.now();
        await view.navigate(`http://127.0.0.1:${A}/v1/contract/web/${r.address}/`, { ms: STEP_MS });
        const frame = `127.0.0.1:${A}/v1/contract/web/${r.address}/?__sandbox=1`;
        const expr = `return ((document.getElementById("publish") && document.querySelectorAll("#palette .chip").length > 0) && document.title) || null;`;
        let title = null;
        while (!title && Date.now() - tL < STEP_MS) {
          title = await view.evaluateIn(frame, expr).catch(() => null);
          if (!title) await new Promise(ok => setTimeout(ok, 1000));
        }
        loads = !!title;
        console.log(`${loads ? "PASS" : "FAIL"}  the builder ${loads ? `LOADS through A ("${title}", its palette drawn) in ${Date.now() - tL} ms` : `did not load through A within ${STEP_MS / 1000} s`}`);
      } finally {
        await b.stop();
      }
    }
    failed = servedOk && loads ? 0 : 1;
  } catch (e) {
    console.log(`FAIL  the builder was not published: ${e.message}`);
  } finally {
    await host.done(failed);
  }
}
