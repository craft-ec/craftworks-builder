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
const say = (text, bad = false) => { status.textContent = text; status.className = bad ? "bad" : ""; };
// From `location.href`, never `location.origin`: a node serves an app in a
// SANDBOXED iframe, whose origin is opaque — "null" — while its URL is the
// node's own.
const here = p => new URL(p, location.href).href;
const blobOf = bytes => URL.createObjectURL(new Blob([bytes]));

// THE OPEN'S PHASES, for the tools that time it (a realnet step time is one
// number from navigate to rows, and cannot say where a slow open went): ms
// since this page's navigation began, stamped once as each phase ends —
// loader (the container served, this module running), files (app.json,
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
  const [art, app, dec] = await Promise.all([
    json("artefacts.json"),
    json("app.json"),
    served({ url: "./decoder.wasm" }, { onWait: w => say(`${w.says ?? "waiting"}: decoder.wasm`) }).then(decoder),
  ]);
  mark("files");
  const head = app?.publisher?.head;

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
  const [core, provisioning] = await Promise.all([race("app", art.pieces.core), race("signer", art.pieces.provisioning)]);

  // 2. The modules, linked; the SDK's wasm verified by its hash on the way in.
  // The SDK modules the STARTER serves -- the SDK's own list, carried in this container's artefacts.json
  // (craftworks-sdk#408): a bundle module importing one gets this container's copy (one instance).
  if (!Array.isArray(art.starter) || art.starter.length === 0) throw new Error("this app's artefacts.json names no `starter`: republish it with a builder that carries the SDK's list");
  const starter = new Set(art.starter.map(m => `sdk/${m}`));
  const urls = linkModules(core.files, { external: p => (starter.has(p) ? here(`./${p}`) : null) });
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
  const [{ load }, { artefactBytes }, { mountApp, sourceOf }, { openPublished }] =
    await Promise.all(["sdk/index.js", "sdk/artefacts.js", "runtime.js", "runtime-logic.js"].map(moduleOf));
  say("Loading the SDK…");
  // Verified by its hash (never an end short of a mismatch: rule 8), the status naming it while it waits.
  const sdk = await load(await artefactBytes(artefact(core, "sdk"), { onWait: w => say(`${w.says}: ${art.sdk.file}`) }));
  mark("sdk");
  say("Connecting…");
  // The APP's id (craftworks-sdk#267): the space its data was written
  // under, which this view reads. Both ids are checked by the SDK's own rules
  // (`sdk.ids`), now it is loaded.
  if (!sdk.ids.hex32(head ?? "")) throw new Error("app.json names no publisher head, so there is nothing to show");
  const appId = app?.publisher?.app;
  try {
    sdk.ids.app(appId ?? "");
  } catch (e) {
    throw new Error(`app.json names no publisher app, so there is no space to read (${e?.message ?? e})`);
  }
  const opened = await openPublished(sdk, {
    head,
    // The version it was published at (craftworks-sdk#349); an app.json from
    // before it names none, and is read at whatever head the node has.
    seq: app.publisher.seq ?? 0,
    app: appId,
    port: Number(location.port),
    artefacts: { signer: artefact(provisioning, "signer"), block: artefact(provisioning, "block"), register: artefact(provisioning, "register") },
    ownData: (app.components ?? []).some(c => sourceOf(c) === "mine"),
  });
  mark("opened");

  // 4. Repair, in the background: a piece this load asked and did not get is
  // PUT back. Never in the way of the app, and a refusal is only logged.
  const webappCode = core.files.get("sdk/webapp.wasm");
  for (const b of [core, provisioning]) {
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
  const reading = mountApp(document.getElementById("app"), sdk, app, () => {}, opened.backends, "published", { alive: () => true, seed: false, canWrite: opened.canWrite });
  try { await reading; } finally { clearInterval(counting); }
  // No event says when the head arrives, and no timer watches for it (every
  // published app runs this): the head is stamped as known BY the first rows.
  if (opened.headId()) mark("head");
  mark("rows");
  // Mounted: a component whose read ENDED says so on the page (the runtime);
  // the status names it too, so the page is never quietly half-empty.
  const ended = [...document.querySelectorAll(".rt-read")].map(e => e.textContent);
  say(ended.length ? ended.join(" · ") : (app.name ?? ""), ended.length > 0);
} catch (e) {
  // THE FIRST THING A PERSON CAN SEND: which piece or artefact, which hash, what failed.
  say(`This app could not open: ${e.message}`, true);
}
