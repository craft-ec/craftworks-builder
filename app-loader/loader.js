// THE PUBLISHED APP'S LOADER (builder#104).
//
// Served by a node at /v1/contract/web/<app address>/ from the app's web
// container. It carries NONE of the SDK's wasm: `artefacts.json` names each by
// hash and the SDK's artefacts container that holds them, on THIS node. So:
//
//   1. the SDK's wasm is fetched from the artefacts container and VERIFIED by
//      its hash before it runs — a mismatch is refused and the app does not
//      load; an artefact nobody serves fails naming which one and its hash;
//   2. this node's signer is ASKED whose it is, registering nothing: on the
//      PUBLISHER's node the app opens EDITABLE, through the same session the
//      builder uses (`openPublished`); anywhere else nothing is provisioned —
//      a visitor who only reads leaves no trace on the node they read from —
//   3. and the publisher's tree (`app.json`'s `publisher.head`) is opened by
//      address — the same read path as a person's own — and mounted as a VIEW:
//      published data is readable by default, and writing is access control.
import { load } from "./sdk/index.js";
import { artefactBytes } from "./sdk/artefacts.js";
import { mountApp } from "./runtime.js";
import { openPublished } from "./runtime-logic.js";

const status = document.getElementById("status");
const say = (text, bad = false) => { status.textContent = text; status.className = bad ? "bad" : ""; };

try {
  const json = async f => {
    const r = await fetch(`./${f}`);
    if (!r.ok) throw new Error(`this app's ${f} could not be read (${r.status})`);
    return r.json();
  };
  const [art, app] = await Promise.all([json("artefacts.json"), json("app.json")]);
  const head = app?.publisher?.head;
  if (!/^[0-9a-f]{64}$/.test(head ?? "")) throw new Error("app.json names no publisher head, so there is nothing to show");
  // Every artefact from the SDK's artefacts container on THIS node, by hash.
  // From `location.href`, never `location.origin`: a node serves an app in a
  // SANDBOXED iframe, whose origin is opaque — "null" — while its URL is the
  // node's own.
  const from = e => ({ urls: [new URL(`/v1/contract/web/${art.contract}/${e.file}`, location.href).href], sha256: e.sha256 });
  say("Loading the SDK…");
  const sdk = await load(await artefactBytes(from(art.sdk)));
  say("Connecting…");
  // The publisher's APP (craftworks-sdk#267): the space its data was written
  // under, which this view reads. Absent, the app predates app ids and names
  // nothing this SDK can open.
  const appId = app?.publisher?.app;
  if (!/^[a-z0-9_-]{1,32}$/.test(appId ?? "")) throw new Error("app.json names no publisher app, so there is no space to read");
  const opened = await openPublished(sdk, {
    head,
    app: appId,
    port: Number(location.port),
    artefacts: { signer: from(art.signer), block: from(art.block), register: from(art.register) },
  });
  // "Reading…" is never SILENT: it says how long, and a read that ENDS is
  // shown on its component by the runtime, by name.
  const t0 = Date.now();
  say("Reading…");
  const counting = setInterval(() => say(`Reading… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
  const reading = mountApp(document.getElementById("app"), sdk, app, () => {}, opened.db, "published", { alive: () => true, seed: false, readOnly: opened.readOnly });
  try { await reading; } finally { clearInterval(counting); }
  // Mounted: a component whose read ENDED says so on the page (the runtime);
  // the status names it too, so the page is never quietly half-empty.
  const ended = [...document.querySelectorAll(".rt-read")].map(e => e.textContent);
  say(ended.length ? ended.join(" · ") : (app.name ?? ""), ended.length > 0);
} catch (e) {
  // THE FIRST THING A PERSON CAN SEND: which artefact, which hash, what failed.
  say(`This app could not open: ${e.message}`, true);
}
