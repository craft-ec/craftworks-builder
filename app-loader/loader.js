// THE PUBLISHED APP'S LOADER (builder#104; loaded from parity pieces, craftworks-sdk#347).
//
// Served by a node at /v1/contract/web/<app address>/ from the app's STARTER
// container, which carries only what runs before the SDK exists: this file,
// the decode-only wasm and the SDK's fetch/race/decode modules. Everything
// else — the SDK, the runtime and the provisioning artefacts — is k + m parity
// pieces, each its own container, named in `artefacts.json`. So:
//
//   1. both bundles' pieces are RACED (`raceK`: the page's window, each piece
//      checked by its sha256, the rest dropped at the k-th), and any k of them
//      rebuild the bundle (`openPieces`, in the decoder wasm);
//   2. the bundle's modules are linked as blob: modules (`linkModules`), and
//      the SDK's wasm is VERIFIED by its own hash before it runs, like every
//      artefact the session is handed;
//   3. this node's signer is ASKED whose it is (`openPublished`), and the app
//      opens as a NORMAL WEBSITE where everyone is a user (the APP's data,
//      editable only where its key is; the USER's own tree, `mine`);
//   4. every piece this load ASKED and did not get is PUT back, re-derived
//      from the rebuilt bundle (`repairPieces`): the next load finds it.
import { raceK, served, servedText } from "./sdk/served.js";
import { decoder, linkModules, openPieces, repairPieces } from "./sdk/pieces.js";


const status = document.getElementById("status");
// An app's own code may replace the page (the builder does): the status line is put back if so, so what the loader
// says -- a failure above all -- is never said to a detached element (rule 8: never silent).
const say = (text, bad = false) => { if (status.isConnected === false) document.body.prepend(status); status.textContent = text; status.className = bad ? "bad" : ""; };
// From `location.href`, never `location.origin`: a node serves an app in a
// SANDBOXED iframe, whose origin is opaque — "null" — while its URL is the
// node's own.
const here = p => new URL(p, location.href).href;
const blobOf = bytes => URL.createObjectURL(new Blob([bytes]));

// THE OPEN'S PHASES, for the tools that time it (a realnet step time is one
// number from navigate to rows, and cannot say where a slow open went): ms
// since this page's navigation began, stamped once as each phase ends —
// loader (the container served, this module running), files (pointer.json,
// artefacts.json and the decoder), sdk (both bundles raced, decoded, linked, the
// SDK's wasm verified and loaded), opened (this node's signer asked, the app's
// tree and the user's own opened), head (the app's tree has a head by the time
// the first rows came: stamped with them), rows (every component's first read
// answered). Read, never acted on.
const phases = (globalThis.__craftworksOpen = {});
const mark = k => { phases[k] ??= Math.round(performance.now()); };
mark("loader");

try {
  // This container's own files, through the SDK's one fetch: waited on (and
  // named while waiting), never ended by a status (rule 8, craftworks-sdk#340).
  const json = async f => JSON.parse(await servedText({ url: `./${f}` }, { onWait: w => say(`${w.says ?? "waiting"}: ${f}`) }));
  // THE POINTER (ARCHITECTURE §19, the bootstrap): whose tree the app is in -- the app itself is data there, never in
  // this site. Read as bytes: its one reader is the SDK's (`openPointer`), which also checks it is THIS site's.
  const [art, pointer, dec] = await Promise.all([
    json("artefacts.json"),
    served({ url: "./pointer.json" }, { onWait: w => say(`${w.says ?? "waiting"}: pointer.json`) }),
    served({ url: "./decoder.wasm" }, { onWait: w => say(`${w.says ?? "waiting"}: decoder.wasm`) }).then(decoder),
  ]);
  mark("files");

  // 1. Both bundles raced at once, neither waiting on the other: the session
  // needs the provisioning artefacts when it OPENS. The signer's bytes only
  // for its delegate KEY (the Register query is sent to it; `openAsked`
  // registers and installs nothing), the Block code to read the app's tree,
  // the Register code for a user's own tree (craftworks-sdk#347).
  const progress = {};
  const shown = () => say(`Loading… ${Object.entries(progress).map(([b, w]) => `${b} ${w}`).join(" · ")}`);
  const race = async (b, shape) => {
    const spec = { ...shape, pieces: shape.pieces.map(p => ({ url: here(`/v1/contract/web/${p.address}/piece`), sha256: p.sha256 })) };
    const raced = await raceK(spec, { onWait: w => { progress[b] = `${w.verified}/${w.k}${w.says ? ` (${w.says})` : ""}`; shown(); } });
    progress[b] = "done";
    shown();
    return { spec: { ...shape }, raced, ...openPieces(dec, shape, raced.pieces) };
  };
  // THE BUILD'S ONE PIECE SET (ARCHITECTURE §19): the SDK, the runtime and the contract code, one bundle.
  if (!art.pieces?.app) throw new Error("this site's artefacts.json names no `app` piece set: it was published by a builder from before app-as-data");
  const bundle = await race("app", art.pieces.app);

  // 2. The modules, linked; the SDK's wasm verified by its hash on the way in.
  // The SDK modules the STARTER serves -- the SDK's own list, carried in this container's artefacts.json
  // (craftworks-sdk#408): a bundle module importing one gets this container's copy (one instance).
  if (!Array.isArray(art.starter) || art.starter.length === 0) throw new Error("this app's artefacts.json names no `starter`: republish it with a builder that carries the SDK's list");
  const starter = new Set(art.starter.map(m => `sdk/${m}`));
  const urls = linkModules(bundle.files, { external: p => (starter.has(p) ? here(`./${p}`) : null) });
  const moduleOf = p => {
    if (!urls.has(p)) throw new Error(`the app's pieces hold no ${p}`);
    return import(urls.get(p));
  };
  const artefact = (bundle, name) => {
    const e = art[name];
    const bytes = bundle.files.get(`sdk/${e.file}`);
    if (!bytes) throw new Error(`the ${name} artefact (${e.file}) is not in the app's pieces`);
    return { urls: [blobOf(bytes)], sha256: e.sha256 };
  };
  // The content-hash cache (`artefactBytes`) is the SDK's, in the bundle: it verifies each artefact by its own hash.
  const [{ load }, { artefactBytes }, { mountApp, sourceOf }, { openPublished }, { appOf }, { codeOf }] =
    await Promise.all(["sdk/index.js", "sdk/artefacts.js", "runtime.js", "runtime-logic.js", "definition.js", "app-code.js"].map(moduleOf));
  say("Loading the SDK…");
  // Verified by its hash (never an end short of a mismatch: rule 8), the status naming it while it waits.
  const sdk = await load(await artefactBytes(artefact(bundle, "sdk"), { onWait: w => say(`${w.says}: ${art.sdk.file}`) }));
  mark("sdk");
  say("Connecting…");
  // WHOSE TREE, WHICH APP: the pointer, checked against this page's own link and read by the SDK (`openPointer`,
  // sdk#558) -- a pointer copied from another site is refused, never read.
  const code = name => {
    const bytes = bundle.files.get(`sdk/${name}`);
    if (!bytes) throw new Error(`the ${name} contract code is not in the app's pieces`);
    return bytes;
  };
  const { app: appId, registerId: head } = sdk.openPointer(pointer, location.pathname, code("site.wasm"), code("register.wasm"));
  const opened = await openPublished(sdk, {
    head,
    // THE FLOOR: the site exists, so the app was published at least once (§19: floored from the site's existence).
    seq: 1,
    app: appId,
    port: Number(location.port),
    artefacts: { signer: artefact(bundle, "signer"), block: artefact(bundle, "block"), register: artefact(bundle, "register") },
    ownData: false,
  });
  // THE APP: its published definition, read from its owner's tree by the one head walk. The node may answer an OLDER
  // head of that tree than the one the app was published at (the floor is only "the site exists"): then there is no
  // published definition in what it read, and the loader SAYS so and FOLLOWS the tree -- a live binding of the
  // definition (the head subscription, no timer) -- until one arrives. Never an empty page with nothing said.
  const tree = opened.backends.publisher;
  let records = await tree.definition("app");
  if (!records.some(r => r.key === "meta")) {
    say("Waiting for this app's published definition: the node has an older version of its owner's tree…");
    const live = tree.bind("craftworks.app", { live: true });
    try {
      records = await new Promise((ok, no) => {
        const again = () => tree.definition("app").then(r => { if (r.some(x => x.key === "meta")) ok(r); }, no);
        live.subscribe(again);
        again();
      });
    } finally { live.stop?.(); }
  }
  mark("opened");
  // THE OPENER'S PAGE RECORDINGS (builder#160): `__craftworksOpen.pageTrace()` returns ONE STRING, the dump of each
  // page this open runs (`== asked`, `== view`; `openPublished`), read when asked. READ-ONLY by type: a string is all
  // that leaves, so no session, db or handle is reachable from it. Not enumerable, so the phase stamps above stay
  // plain data for whoever reads them by value. STATED PROPERTY: it lives in the APP's frame, so the published app's
  // own code can call it too -- acceptable because the recording is vocabulary only (sites, send-order labels and
  // numbers, no user content: the instrument's rule, OBSERVABILITY §2). Anything publishable added to what the page
  // records must pass the publish filter's review first.
  Object.defineProperty(phases, "pageTrace", {
    enumerable: false,
    value: () => {
      const p = opened.pageTrace();
      return `== asked\n${p.asked}\n== view\n${p.view}\n`;
    },
  });

  // 4. Repair, in the background: a piece this load asked and did not get is
  // PUT back. Never in the way of the app, and a refusal is only logged.
  const webappCode = bundle.files.get("sdk/webapp.wasm");
  for (const b of [bundle]) {
    repairPieces({ spec: b.spec, bundle: b.bundle, raced: b.raced, sdk, session: opened.asked.session, webappCode, subtle: crypto.subtle })
      .then(r => { if (r.length) console.info("craftworks: load pieces repaired", r); })
      .catch(e => console.warn("craftworks: load piece repair failed", e));
  }

  // "Reading…" is never SILENT: it says how long, and a read that ENDS is
  // shown on its component by the runtime, by name.
  const t0 = Date.now();
  say("Reading…");
  // Below the published version the status says so, in the SDK's words
  // (craftworks-sdk#349): the view waits for it, never shows an older one.
  const counting = setInterval(() => say(opened.waitingFor() || `Reading… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
  // AN APP WITH CODE OF ITS OWN (`meta.entry`, its `f/` records): its modules linked as the pieces' are, and its
  // entry STARTED with the SDK this loader loaded; otherwise a definition, mounted by the runtime.
  const own = codeOf(records);
  const app = own ? null : appOf(records);
  if (app && (app.components ?? []).some(c => sourceOf(c) === "mine")) await opened.openMine();
  const reading = own
    ? (async () => {
        const codeUrls = linkModules(own.files, { external: p => (urls.has(p) ? urls.get(p) : starter.has(p) ? here(`./${p}`) : null) });
        if (!codeUrls.has(own.entry)) throw new Error(`the app's entry ${own.entry} is not one of its code files`);
        const m = await import(codeUrls.get(own.entry));
        if (typeof m.start !== "function") throw new Error(`the app's entry ${own.entry} exports no start()`);
        await m.start({ sdk, opened, root: document.getElementById("app"), files: own.files, urls: codeUrls });
      })()
    : mountApp(document.getElementById("app"), sdk, app, () => {}, opened.backends, "published", { alive: () => true, seed: false, canWrite: opened.canWrite });
  try { await reading; } finally { clearInterval(counting); }
  // No event says when the head arrives, and no timer watches for it (every
  // published app runs this): the head is stamped as known BY the first rows.
  if (opened.headId()) mark("head");
  mark("rows");
  // Mounted: a component whose read ENDED says so on the page (the runtime);
  // the status names it too, so the page is never quietly half-empty.
  const ended = [...document.querySelectorAll(".rt-read")].map(e => e.textContent);
  // NEVER an empty status (rule 8): what was read, by name, when nothing is shown.
  const finalLine = app && (app.components ?? []).length === 0 ? `${app.name || "This app"} has no components yet` : (app?.name || "");
  say(ended.length ? ended.join(" · ") : finalLine, ended.length > 0);
} catch (e) {
  // THE FIRST THING A PERSON CAN SEND: which piece or artefact, which hash, what failed.
  say(`This app could not open: ${e.message}`, true);
}
