// THE PUBLISHED APP'S LOADER (builder#104).
//
// Served by a node at /v1/contract/web/<app address>/ from the app's web
// container. It carries NONE of the SDK's wasm: `artefacts.json` names each by
// hash and the SDK's artefacts container that holds them, on THIS node. So:
//
//   1. the SDK's wasm is fetched from the artefacts container and VERIFIED by
//      its hash before it runs — a mismatch is refused and the app does not
//      load; an artefact nobody serves fails naming which one and its hash;
//   2. this node's signer is ASKED whose it is (`openPublished`), and the
//      app opens as a NORMAL WEBSITE where everyone is a user: each
//      component shows its SOURCE -- the APP's data (the tree `app.json`'s
//      `publisher.head` names: editable only on the node that signs for it,
//      read-only anywhere else) or the USER's own tree (`mine`), which every
//      user writes (their key and tree are made on their first entry, through
//      the SDK's existing provision path);
//   3. which components show inputs is the SDK's one `canWrite` decision.
import { load } from "./sdk/index.js";
import { artefactBytes, servedText } from "./sdk/artefacts.js";
import { mountApp, sourceOf } from "./runtime.js";
import { openPublished } from "./runtime-logic.js";

const status = document.getElementById("status");
const say = (text, bad = false) => { status.textContent = text; status.className = bad ? "bad" : ""; };

// THE OPEN'S PHASES, for the tools that time it (a realnet step time is one
// number from navigate to rows, and cannot say where a slow open went): ms
// since this page's navigation began, stamped once as each phase ends —
// loader (the container served, this module running), files (app.json and
// artefacts.json), sdk (its wasm fetched, verified, loaded), opened (this
// node's signer asked, the app's tree and the user's own opened: the signer,
// block and register artefacts load in here), head (the app's tree has a head
// by the time the first rows came: stamped with them), rows (every
// component's first read answered). Read, never acted on.
const phases = (globalThis.__craftworksOpen = {});
const mark = k => { phases[k] ??= Math.round(performance.now()); };
mark("loader");

try {
  // This container's own files, through the SDK's one fetch: waited on (and
  // named while waiting), never ended by a status (rule 8, craftworks-sdk#340).
  const json = async f => JSON.parse(await servedText({ url: `./${f}` }, { onWait: w => say(`${w.says ?? "waiting"}: ${f}`) }));
  const [art, app] = await Promise.all([json("artefacts.json"), json("app.json")]);
  mark("files");
  const head = app?.publisher?.head;
  // Every artefact from the SDK's artefacts container on THIS node, by hash.
  // From `location.href`, never `location.origin`: a node serves an app in a
  // SANDBOXED iframe, whose origin is opaque — "null" — while its URL is the
  // node's own.
  const from = e => ({ urls: [new URL(`/v1/contract/web/${art.contract}/${e.file}`, location.href).href], sha256: e.sha256 });
  say("Loading the SDK…");
  // A file the node does not serve yet is WAITED on, never an end (rule 8):
  // the SDK re-asks on its RTO and says so, and the status names the file.
  const sdk = await load(await artefactBytes(from(art.sdk), { onWait: w => say(`${w.says}: ${art.sdk.file}`) }));
  mark("sdk");
  say("Connecting…");
  // The APP's id (craftworks-sdk#267): the space its data was written
  // under, which this view reads. Absent, the app predates app ids and names
  // nothing this SDK can open.
  // Both ids are checked by the SDK's own rules (`sdk.ids`), now it is loaded.
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
    artefacts: { signer: from(art.signer), block: from(art.block), register: from(art.register) },
    ownData: (app.components ?? []).some(c => sourceOf(c) === "mine"),
  });
  mark("opened");
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
  // THE FIRST THING A PERSON CAN SEND: which artefact, which hash, what failed.
  say(`This app could not open: ${e.message}`, true);
}
