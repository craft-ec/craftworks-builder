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

try {
  // This container's own files, through the SDK's one fetch: waited on (and
  // named while waiting), never ended by a status (rule 8, craftworks-sdk#340).
  const json = async f => JSON.parse(await servedText({ url: `./${f}` }, { onWait: w => say(`${w.says ?? "waiting"}: ${f}`) }));
  const [art, app] = await Promise.all([json("artefacts.json"), json("app.json")]);
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
  // "Reading…" is never SILENT: it says how long, and a read that ENDS is
  // shown on its component by the runtime, by name.
  const t0 = Date.now();
  say("Reading…");
  // Below the published version the status says so, in the SDK's words
  // (craftworks-sdk#349): the view waits for it, never shows an older one.
  const counting = setInterval(() => say(opened.waitingFor() || `Reading… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
  const reading = mountApp(document.getElementById("app"), sdk, app, () => {}, opened.backends, "published", { alive: () => true, seed: false, canWrite: opened.canWrite });
  try { await reading; } finally { clearInterval(counting); }
  // Mounted: a component whose read ENDED says so on the page (the runtime);
  // the status names it too, so the page is never quietly half-empty.
  const ended = [...document.querySelectorAll(".rt-read")].map(e => e.textContent);
  say(ended.length ? ended.join(" · ") : (app.name ?? ""), ended.length > 0);
} catch (e) {
  // THE FIRST THING A PERSON CAN SEND: which artefact, which hash, what failed.
  say(`This app could not open: ${e.message}`, true);
}
