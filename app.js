import { loadSdk } from "./sdk-loader.js";
import { browserStorage, storageNote } from "./storage.js";
import { publishApp } from "./publish-app.js";
import { readBuilderFile, readSdkManifest } from "./builder-files.js";
import { mount as mountVersions, readBuildInfo } from "./versions-panel.js";
import { stamp, drift, short } from "./project-versions.js";
import { COMPONENTS, RANGES, byType, mapping, treeView } from "./catalogue.js";
import { mountApp, sourceOf } from "./runtime.js";
import { defaultSchema, KINDS, preloadManifest, schemasOf } from "./runtime-logic.js";
import { handoff } from "./handoff.js";
import { LIVE_NOTE, isLive, reconnectsOnOpen } from "./publish-state.js";
import { appIdOf, buttonFor, publish } from "./publish.js";
import { render as renderTrace } from "./trace-view.js";
import { treeStats, NO_ROOT } from "./tree-stats.js";
import { LocalDb } from "./local-db.js";
import { mountProjects } from "./projects-panel.js";
import { readDeviceSettings, writeDeviceSettings } from "./projects.js";
import { mountAssets } from "./assets-panel.js";
import { repairPass } from "./assets.js";
import { createProjectRuntime } from "./project-runtime.js";
import { draftChanged, keyOf, keyed } from "./definition.js";

// Capabilities built so far (ARCHITECTURE.md §21). A component is placeable one
// phase ahead, so an app can be designed before its substrate lands.
const BUILT_PHASE = 1;

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity)); return e; };

let app = { name: "", tree: { realm: "public", identity: null }, components: [], schemas: {}, seed: {} };
// AN APP IN THE URL (`#app=<json>`): shareable, and testable. It is IMPORTED — a new project whose draft starts as
// it — never laid over whatever project is open.
let importApp = null, importRaw = null;
try { const h = new URLSearchParams(location.hash.slice(1)).get("app"); if (h) { importApp = { name: "", components: [], schemas: {}, seed: {}, ...JSON.parse(h) }; importRaw = h; } } catch (_) {}
// WHERE THE LAST EDIT IS. The definition is the project's draft in its owner's tree (ARCHITECTURE §19): every edit
// goes to the canvas at once and to the runtime's draft writer, which WAITS for the tree (rule 9) and writes the
// latest of each record. The line below says what is not in the tree yet, and why; nothing else keeps a copy.
/** Keep the open project's tree binding and version stamp on this device's list (not its definition). */
const persistMeta = () =>
  Promise.resolve(projects?.persist?.()).catch(e => showStorageNotice({ kind: "not-saved", message: `this project's list entry: ${e.message}` }));
const save = () => {
  keyed(app.components);
  try { rt.edit(app); } catch (e) { showStorageNotice({ kind: "not-saved", message: e.message }); }
  persistMeta();
  renderSaveState();
};

// The reason as a person reads it: without a "not saved:" prefix the line already says, and without a trailing full
// stop to double.
const reasonOf = e => String(e?.message ?? e).replace(/^not saved:\s*/i, "").replace(/[.\s]+$/, "");
/** What the store reported about itself, shown until the page is reloaded. */
const storageNotices = [];
function showStorageNotice(n) {
  storageNotices.push(n);
  const host = document.getElementById("storage-note");
  if (!host) return;
  host.hidden = false;
  host.replaceChildren(...storageNotices.map(x => el("div", { className: `note-${x.kind}`, textContent: x.message })));
}
// NO BROWSER STORAGE HERE (a sandboxed document, e.g. the builder served from a freenet node): said, never a stop.
if (storageNote()) showStorageNotice({ kind: "no-storage", message: storageNote() });

/**
 * The unsaved line: shown only while the last edit is not in the owner's tree yet — the tree still opening, the
 * draft still being read, a write the SDK refused — and why. Derived from the runtime every time; never a flag.
 */
function renderSaveState() {
  const host = document.getElementById("save-state");
  if (!host) return;
  const d = rt.draft;
  const why = rt.connection === "failed" && rt.connectionError ? ` — ${reasonOf(rt.connectionError)}; trying again` : "";
  const secs = since => (since === null ? "" : ` (${Math.max(0, Math.round((Date.now() - since) / 1000))} s)`);
  // [what, why]: the bold words, then the rest of the line.
  const line = !d.loaded ? ["Opening this project:", ` reading it from your node${secs(openedAt)}${why}.`]
    : d.error ? ["Not saved:", ` ${reasonOf(d.error)}. Your work is still here in this tab — `]
      : d.pending && !d.attached ? ["Not saved yet:", ` waiting for your node${secs(d.waitingSince)}${why}. Your work is still here in this tab — `]
        // The draft's watch could not re-read it after a change (another tab or device): what is shown may be behind.
        : d.watchError ? ["Not current:", ` the draft could not be re-read from your node (${reasonOf(d.watchError)}); it is read again at its next change.`]
          : null;
  host.hidden = !line;
  if (!line) { host.replaceChildren(); return; }
  const retry = el("button", { type: "button", id: "save-retry", textContent: "Retry", onclick: () => { connectTree(); save(); } });
  const exp = el("button", { type: "button", id: "save-export", textContent: "Export", onclick: () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(app, null, 2)], { type: "application/json" }));
    const a = el("a", { href: url, download: `${(app.name || "app").replace(/[^\w.-]+/g, "_")}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  host.replaceChildren(
    el("b", { textContent: line[0] }),
    el("span", { id: "save-reason", textContent: line[1] }),
    ...(d.loaded && line[0] !== "Not current:" ? ["retry, or export it to a file before closing. ", retry, " ", exp] : []),
  );
}
// "N s" moves while something waits.
setInterval(() => { const d = rt?.draft; if (d && (!d.loaded || (d.pending && !d.attached))) renderSaveState(); }, 1000);
let openedAt = null;
app.schemas ??= {}; app.seed ??= {};
let sel = app.components.length ? 0 : -1, hoverPath = null;
let sdkReady = null, preview = new URLSearchParams(location.hash.slice(1)).get("preview") === "1";
// THE OPEN PROJECT'S RUNTIME: its mount, its publish session and phase, and
// the backend it publishes to. These were four page globals — `publishedDb`,
// `mounting`, `publishPhase`, `liveDb` — each reset on some paths and not
// others, so project B inherited A's "Published" and A's backend, a rejected
// mount left Preview dead until a reload, and no path ever closed a session
// (builder#54, #57, #58). One object per project now, disposed on a switch.
// THE OPEN PROJECT'S id and created time: what the handoff's slots derive
// from (builder#83). Set when a project is opened (there is always one).
let openedProject = null;
const mountCanvas = ({ backend, phase, alive, adopt }) =>
  mountApp($("canvas"), sdkReady, app, db => {
    adopt(db);
    renderTree();
    // The counts the panel just rendered without. Resolved after, and the
    // panel is drawn again with them — one extra pass, and the number is a
    // number.
    refreshCounts(db, app).then(renderTree);
  }, backend, phase, { alive }).then(h => {
    // The acceptance seam the tools read also carries the session now that
    // something owns one.
    if (h && globalThis.__craftworks) globalThis.__craftworks.session = rt?.session ?? null;
    return h;
  });
/**
 * A project's runtime: its mount, its publish, and — from creation — its owner's tree and draft writer. `fresh`: the
 * project was made in this tab, so the canvas is its definition. Otherwise the tree's draft is, and it is handed to
 * the canvas when read (`onDraft`).
 */
const newRuntime = ({ fresh = false } = {}) => {
  const r = createProjectRuntime({
    mount: mountCanvas, publish, fresh,
    onChange: () => { renderSaveState(); renderPublish(); renderAddr(); refreshChanged(); },
    onDraft: held => {
      if (r !== rt) return;
      app.name = held.name; app.components = held.components; app.schemas = held.schemas; app.seed = held.seed;
      sel = app.components.length ? 0 : -1;
      rt.invalidate();
      render();
      projects?.refresh?.();
    },
  });
  return r;
};
let rt = newRuntime();

/** Open the open project's owner's tree (the runtime shares one open with a Publish). Needs the SDK and the project. */
function connectTree() {
  if (!sdkReady || !openedProject) return;
  rt.connect(treeDeps).catch(() => { /* said on the unsaved line; the runtime retries */ });
}
/** What opening the owner's tree needs: this project's app id, the SDK's opener and artefacts, the named node. */
const treeDeps = () => ({
  // ONE PROJECT, ONE APP (craftworks-sdk#267): the space in the person's tree this project's data lives in.
  appId: appIdOf(openedProject?.id, sdkReady?.ids), ids: sdkReady?.ids,
  open: sdkReady.open,
  artefacts: sdkReady.SHIPPED_ARTEFACTS,
  // NAMED, never defaulted. The node is a decision: it gets a delegate installed and a signing key handed to it.
  port: nodePort(),
});

/**
 * CHANGED SINCE PUBLISH is derived: the draft against the published definition (`draftChanged`), asked whenever the
 * runtime moves. `publishedApp` (the app's JSON kept in memory at publish) is gone: it was a second copy.
 */
let changedSincePublish = false, askingChanged = null;
function refreshChanged() {
  const db = rt.treeDb;
  if (!db || rt.phase !== "published" || askingChanged) return;
  const mine = rt;
  askingChanged = rt.draft.pending ? Promise.resolve(true) : draftChanged(db).catch(() => changedSincePublish);
  askingChanged.then(v => {
    askingChanged = null;
    if (mine !== rt || v === changedSincePublish) return;
    changedSincePublish = v;
    renderPublish();
  });
}
/**
 * Record counts per domain, resolved asynchronously and READ synchronously.
 *
 * The tree panel renders in one pass, and `db.count` is a round trip on the
 * engine-backed backend. So the round trip happens where the db tells us
 * something changed, and the panel reads what it produced.
 */
const counts = {};
async function refreshCounts(db, app) {
  if (!db) return;
  for (const d of new Set(app.components.map(c => c.domain))) {
    try { counts[d] = await db.count(d); } catch (_) { delete counts[d]; }
  }
}

// The panel's baked half renders at once; the SDK's self-report is filled in
// when the wasm arrives. It does NOT force a load: a panel that pulled in the
// wasm on every page view to read one string would cost more than it tells.
let versionsPanel = null, sdkSelfReport = null, bakedInfo = null;
// PROJECTS. Stored as records — the project plus one per component — in a db
// that survives a reload. Which db is a backend decision, not a shape
// decision: the same records go to the engine-backed one when there is a node.
let projects = null;
/**
 * OPEN A PROJECT in this page: the old runtime is disposed before anything of the new one exists (its listeners stop,
 * its session closes, a mount or publish of it still in flight disowns itself); the new one opens the owner's tree at
 * once. A FRESH project's canvas is what it starts as and is written to its draft; any other is read from its draft.
 */
function openInPage(project, { fresh = false, from = null } = {}) {
  rt.dispose();
  openedProject = { id: project.id, created: project.created, published: reconnectsOnOpen(project), publication: project.publication ?? null };
  rt = newRuntime({ fresh });
  openedAt = Date.now();
  changedSincePublish = false;
  appAddress = null;
  // THE PROJECT'S OWN DEFINITION, never the one that was open before (builder#53).
  const start = fresh ? structuredClone(from ?? {}) : {};
  app = {
    name: start.name ?? "",
    components: keyed(start.components ?? []),
    schemas: start.schemas ?? {},
    seed: start.seed ?? {},
    tree: project.tree ?? { realm: "public", identity: null },
    ...(project.versions ? { versions: project.versions } : {}),
  };
  sel = app.components.length ? 0 : -1;
  // A project with no stamp yet is stamped with what it is being made with NOW.
  stampIfNew();
  versionsPanel?.refresh();
  offerUpgrade();
  if (fresh) save(); else renderSaveState();
  render();
  connectTree();
  reconnect();
}

mountProjects($("projects"), {
  // THIS DEVICE's list: what identifies each project, and its publications. Notices are what the store knows that
  // is not the fault of any one write, and a person can act on each.
  db: new LocalDb(undefined, undefined, { onNotice: n => showStorageNotice(n) }),
  open: openInPage,
  // Each row's name and count: its `meta`, read from its draft in the owner's tree (the open project's from the
  // canvas). "…" until the tree is open.
  metaOf: async pid => {
    if (pid === openedProject?.id && rt.draft.loaded) return { name: app.name, order: app.components.map(keyOf) };
    const db = rt.treeDb;
    if (!db || !sdkReady) return undefined;
    const rows = await db.definition("draft", appIdOf(pid, sdkReady.ids));
    return rows.find(r => r.key === "meta")?.body ?? null;
  },
  getProjectMeta: () => ({ tree: app.tree, versions: app.versions ?? null }),
  getApp: () => ({ name: app.name, components: app.components, schemas: app.schemas, seed: app.seed }),
  onChange: () => render(),
}).then(async p => {
  projects = p;
  // THERE IS ALWAYS AN OPEN PROJECT: an app in the URL is imported as a new one; otherwise what this device had open
  // reopens; otherwise a new, empty one.
  //
  // IMPORTED ONCE. The link's `app=` is recorded as imported (`importedFrom`, beside `lastOpened` in this device's
  // settings), so the same link on a reload REOPENS the project it became instead of importing it again as another;
  // and the page drops `app=` from its own URL (the rest of the hash kept). In freenet's sandboxed frame (origin
  // null) rewriting the URL is REFUSED (a SecurityError): the import stands, startup goes on, and the record alone
  // keeps a reload from importing twice. (With no browser storage at all the record lives only as long as the tab.)
  let opened = false;
  if (importApp && readDeviceSettings(browserStorage).importedFrom === importRaw) opened = await p.reopen();
  if (!opened && importApp) {
    await p.create({ from: importApp });
    writeDeviceSettings(browserStorage, { importedFrom: importRaw });
  }
  else if (!opened && !(await p.reopen())) await p.create();
  if (importApp) {
    try {
      const h = new URLSearchParams(location.hash.slice(1));
      h.delete("app");
      const rest = h.toString();
      history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
    } catch (_) { /* refused (a sandboxed frame): `importedFrom` keeps a reload from importing twice */ }
  }
}).catch(e => {
  // Storage refused at load: the list cannot be kept on this device, and the person needs to know before editing.
  showStorageNotice({ kind: "not-saved", message: `this device's project list: ${reasonOf(e)}` });
});

readBuildInfo().then(baked => {
  bakedInfo = baked;
  versionsPanel = mountVersions($("versions"), {
    baked,
    getSdk: () => sdkSelfReport,
    getProject: () => app.versions ?? null,
  });
  stampIfNew();
  offerUpgrade();
});

// A project records the versions it was MADE with (ARCHITECTURE §19), because
// the builder opens and republishes it against THOSE and not against whatever
// is newest. Stamped once, when there is something to stamp it from — and
// never overwritten, or the record would silently become "whatever I opened it
// with last" and the guarantee would be unobservable.
function stampIfNew() {
  // BOTH halves, or nothing. Stamping from build-info alone — which is what
  // the first version did, because it ran before the wasm had loaded —
  // recorded prollyRev and formatTag as null and called the project stamped.
  // A record with holes in it is worse than an unstamped project, because the
  // unstamped one says so.
  if (app.versions || !bakedInfo || !sdkSelfReport) return;
  app.versions = stamp({ baked: bakedInfo, sdk: sdkSelfReport });
  persistMeta();
  versionsPanel?.refresh();
}

// An upgrade is OFFERED and never applied on its own. This is the offer: it
// says what moved and waits. Accepting it re-stamps the project; declining
// leaves it on the versions it was built against, which keep working.
function offerUpgrade() {
  // Both halves, or the offer is wrong rather than absent: with build-info
  // missing, `drift` still compares the SDK and silently skips every contract,
  // so the bar said "1 component moved on" when two had. An incomplete
  // comparison presented as a complete one is the failure this panel exists to
  // prevent, one level up.
  if (!bakedInfo || !sdkSelfReport) return;
  const rows = drift(app.versions, { baked: bakedInfo, sdk: sdkSelfReport });
  const host = $("upgrade");
  if (!host) return;
  if (rows.length === 0) { host.replaceChildren(); return; }
  // `short` and not slice(0,8): the raw values carry a `sha256:` prefix, so
  // slicing printed "sha256:a → sha256:1" — two different hashes rendered
  // identically but for their last character.
  const list = rows.map(r => `${r.what} ${short(r.was)} → ${short(r.is)}`).join(" · ");
  const btn = el("button", { id: "upgrade-accept", textContent: "Update this project" });
  btn.onclick = () => {
    app.versions = stamp({ baked: bakedInfo, sdk: sdkSelfReport });
    persistMeta();
    offerUpgrade();
    versionsPanel?.refresh();
  };
  host.replaceChildren(
    el("span", { className: "up-what", textContent: `${rows.length} component${rows.length > 1 ? "s" : ""} moved on: ${list}` }),
    btn,
  );
}

loadSdk().then(
  sdk => {
    $("sdk").textContent = `SDK ${sdk.version()}`;
    window.craftec = sdk;
    sdkReady = sdk;
    // `buildInfo` arrived with craftworks-sdk#16; an older vendored build has
    // no such function, which is itself a version fact and is reported as one
    // rather than crashing the panel.
    try {
      sdkSelfReport = typeof sdk.buildInfo === "function" ? sdk.buildInfo() : { rev: "unknown", version: sdk.version() };
    } catch (_) {
      sdkSelfReport = { rev: "unknown", version: sdk.version() };
    }
    stampIfNew();
    offerUpgrade();
    versionsPanel?.refresh();
    render();
    connectTree();
    reconnect();
  },
  err => { $("sdk").textContent = "SDK failed to load — run ./build.sh and ./serve.sh"; $("sdk").title = String(err); },
);


/** The published app's address, once its container is on the network. */
let appAddress = null;

/**
 * A PUBLISHED project reopens CONNECTED: the same Publish a click runs, once
 * the SDK is here, so the canvas writes to the published tree (the decision:
 * `reconnectsOnOpen`). If the node cannot be reached the publish fails, and
 * the address bar says so by name.
 */
function reconnect() {
  if (!sdkReady || !openedProject?.published || rt.phase !== "idle") return;
  doPublish();
}

function renderAddr() {
  const { realm, identity } = app.tree;
  // The address bar stops saying "in-memory, not published" when the project
  // IS published — and not a moment before. It is the one line a person reads
  // to decide whether closing the tab loses their work, so it tracks what the
  // node has actually confirmed rather than what was asked for.
  const note = rt.phase === "published" ? ""
    // Published before: it is connecting, or it could not — said by name,
    // never "not published" about an app that is.
    : openedProject?.published ? (rt.phase === "failed" ? `  · published — not connected: ${rt.error}` : "  · published — connecting…")
    : "  · in-memory, not published";
  $("tree-addr").replaceChildren(
    "craftec://", el("b", { textContent: realm }), "/", el("b", { textContent: identity ?? "‹you›" }), "/",
    el("span", { textContent: note }),
    // WHERE IT OPENS: this node's own web path for the app's container. Any
    // node serves the same address.
    ...(rt.phase === "published" && appAddress ? ["  · ", el("a", {
      id: "app-address", href: `http://127.0.0.1:${nodePort()}/v1/contract/web/${appAddress}/`, target: "_blank",
      textContent: `app ${appAddress.slice(0, 10)}…`, title: appAddress,
    })] : []),
  );
}

/**
 * Which node this builder publishes to.
 *
 * From `#node=<port>` in the URL, and from nowhere else. There is no default:
 * publishing installs code and hands over a signing key, and a default would
 * eventually point at a node somebody else is running. A development build
 * should say which node it means.
 */
function nodePort() {
  const p = Number(new URLSearchParams(location.hash.slice(1)).get("node"));
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0;
}

/** The handoff's "confirmed k of n", for the button while records move. */
let handoffProgress = null;

function renderPublish() {
  const b = buttonFor(rt.phase, { error: rt.error, progress: handoffProgress, changed: changedSincePublish, republishing });
  const btn = $("publish");
  btn.textContent = b.label;
  btn.disabled = !b.enabled;
  btn.title = b.hint;
  btn.className = `pri ${b.tone}`.trim();

  // The reason is SHOWN, not hidden in the tooltip. It was in `title` only,
  // which renders as nothing in a screenshot and needs a hover to find — so
  // the one thing that makes a failure fixable was the one thing invisible.
  const note = $("publish-note");
  if (note) note.textContent = rt.phase === "failed" ? rt.error : republishError;
}

/** A "Publish changes" in flight, and what the last one said went wrong ("" when nothing). */
let republishing = false, republishError = "";

/**
 * PUT THE APP ON THE NETWORK at its one link (builder#117) through `handle`
 * (the runtime's publish session), and record the publication. Returns what
 * went wrong, in words, or "" — never throws: the data is on the node either
 * way. The ONE path for a first publish's `after` and for "Publish changes".
 */
async function putOnNetwork(handle, db) {
  let warn = "", put = null;
  try {
    put = await publishApp(app, {
      sdk: sdkReady, session: handle.session, headId: handle.headId(), headSeq: handle.headSeq(), appId: appIdOf(openedProject?.id, sdkReady?.ids),
      manifest: await readSdkManifest(),
      read: readBuilderFile, subtle: crypto.subtle,
      // Unchanged since the last acknowledged publication (same bundle at
      // the same link, same SDK): nothing is published again.
      last: openedProject?.publication ?? null,
      sdkVersion: sdkSelfReport?.sdkRev ?? bakedInfo?.sdkRev ?? null,
    });
    appAddress = put.address;
    // THE PUBLISHED DEFINITION follows what was put: the draft, in ONE write, made after the handoff's rows are
    // saved (this runs in `after`). "Changed since publish" is the draft against it (§19 P3; P5 makes this write
    // the whole of Publish).
    // REQUIRED, never a silent no-op: without the door the published definition would stay behind the site.
    if (typeof rt.treeDb?.publishDefinition !== "function") throw new Error("publish: the owner's tree has no `publishDefinition` door, so the published definition cannot follow the app");
    await rt.treeDb.publishDefinition();
    changedSincePublish = false;
    // The acceptance seam: what was published, for the tools that open it
    // elsewhere. ITS OWN global: `__craftworks` belongs to the MOUNT, and the
    // remount right after a publish replaces it (builder#104's
    // open-by-address acceptance).
    globalThis.__craftworksPublished = { ...put, head: handle.headId(), app: appIdOf(openedProject?.id, sdkReady?.ids) };
  } catch (e) { warn = `the app was not put on the network: ${e.message}`; }
  try {
    const rec = await projects?.published?.({
      sourceRoot: db?.root?.() ?? null,
      sdkVersion: sdkSelfReport?.sdkRev ?? bakedInfo?.sdkRev ?? null,
      ...(put ? { bundleHash: put.bundleHash, appContractId: put.address, head: handle.headId(), headSeq: put.seq } : {}),
    });
    if (rec && openedProject && put) openedProject.publication = { app_contract_id: put.address, bundle_hash: put.bundleHash, sdk_version: sdkSelfReport?.sdkRev ?? bakedInfo?.sdkRev ?? null, head_seq: put.seq };
  } catch (e) { warn = warn || `history: ${e.message}`; }
  return warn;
}


/**
 * PUBLISH CHANGES (builder#117): a published project whose structure changed
 * puts the new app at the SAME link — the site's next version. Nothing else
 * of the publish runs again: the data is already on the node.
 */
async function publishChanges() {
  const handle = rt.session;
  if (!handle || !changedSincePublish) return;
  republishing = true;
  renderPublish();
  const warn = await putOnNetwork(handle, rt.db);
  republishing = false;
  republishError = warn;
  renderPublish(); renderAddr();
}
/**
 * Publish this project: move it off this tab and onto the node.
 *
 * Every decision below this call is in Rust — what to send, whether the node
 * is already set up, whether an install would destroy a key. The delegate
 * refuses a second install on its own, so pressing this twice cannot cost a
 * signing key however many times it is pressed.
 */
async function doPublish() {
  if (!sdkReady) return;
  if (rt.phase === "published") return publishChanges();
  // Published by THIS project's runtime. If the project is switched while the
  // publish is in flight, the runtime closes the session it produced and runs
  // none of `after` — so a late publish of A cannot record its history into B.
  try {
    await rt.publish(app, treeDeps, {
      onPhase: () => { renderPublish(); renderAddr(); },
      // What Publish owes the records made in Preview: copied, and confirmed
      // by the node, before anything says Published (builder#52).
      //
      // Keyed by the PROJECT (builder#83); whether each domain is already
      // live is read from the TARGET by the handoff itself (builder#86).
      // Each input is required: with no project open the handoff refuses by
      // name rather than publishing rows it could not key.
      handoff: async ({ source, target }) => {
        const p = openedProject;
        handoffProgress = null;
        return handoff({
          source, target, app, schemas: schemasOf(app), slotFrom: sdkReady.slotFrom,
          namespace: p?.id, seedMs: p?.created,
          onNotice: message => showStorageNotice({ kind: "kept", message }),
          onProgress: progress => { handoffProgress = progress; renderPublish(); },
        });
      },
      // The publication is RECORDED before the preload, because the publish
      // has already succeeded by this point: a failed preload is not a failed
      // publish, and history that omitted it would be wrong about what
      // happened.
      //
      // PRELOAD before the first frame, so a read the canvas is about to make
      // is answered from memory instead of from a round trip. Generated from
      // the canvas: a domain nobody has placed a component for is not read on
      // open. Naming DOMAINS and not key ranges is deliberate — what a range
      // is, is the SDK's business (craftworks-sdk#66). A preload that fails is
      // not a failed publish; the first read simply pays for it.
      after: async (db, res) => {
        // THE APP ON THE NETWORK (builder#104, #117): its site at the app's
        // one link, opened from any node as a VIEW of this project's data. A
        // failure here is not a failed publish — the data is on the node — so
        // it is reported, and the publication is recorded without an address.
        let warn = await putOnNetwork(res.session, db);
        try { await db.preload(preloadManifest(app)); }
        catch (e) { warn = `preload: ${e.message}`; }
        if (warn) throw new Error(warn);
      },
    });
    // The runtime has switched its backend and invalidated its mount, so this
    // render REMOUNTS on the new database: definition, components and
    // bindings rebuilt against it.
    render();
  } catch (_) {
    // `publish` reported a reason through `onPhase`, and its reason says what
    // to DO; the runtime keeps it rather than the raw exception.
    renderPublish(); renderAddr();
  }
}

function renderPalette() {
  $("palette").replaceChildren(...COMPONENTS.map(c => {
    const ready = c.phase <= BUILT_PHASE + 1;
    const b = el("button", { className: "chip", disabled: !ready, title: `${c.primitives.join(" + ")} · ${c.schema} — ${c.note}${ready ? "" : ` (lands in phase ${c.phase})`}` },
      c.label, el("small", { textContent: ready ? c.schema : `phase ${c.phase}` }));
    // A NEW component shows each user's OWN data (DATA-SOURCE `mine`): a
    // published site is a normal website, where everyone is a user and adds
    // their own. A component with no `source` (a project from before) shows
    // the app's data (`publisher`).
    b.onclick = () => { app.components.push({ type: c.type, domain: `${c.type}s`, mode: c.modes[0], source: "mine" }); sel = app.components.length - 1; rt.invalidate(); save(); render(); };
    return b;
  }));
}

function usesPath(i, path) { const m = mapping(app.components[i]); return m.keys.includes(path) || m.sets.includes(path); }

function renderCanvas() {
  if (preview) {
    if (!sdkReady) { $("canvas").replaceChildren(el("p", { className: "empty", textContent: "Loading the SDK…" })); return; }
    // Mounting is async, and a second render arriving before the first
    // finished would mount the app twice — two engines, two sets of writes,
    // one canvas. The runtime refuses a second mount while one is starting or
    // active, and a REJECTED one returns it to idle so the next render retries.
    rt.ensureMounted()
      ?.catch(e => $("canvas").replaceChildren(el("p", { className: "empty", textContent: e.message })));
    return;
  }
  $("canvas").replaceChildren(...(app.components.length ? app.components.map((inst, i) => {
    const m = mapping(inst);
    const d = el("div", { className: "comp" + (i === sel || (hoverPath && usesPath(i, hoverPath)) ? " sel" : "") },
      el("div", { className: "t", textContent: m.label }),
      el("div", { className: "b", textContent: `${m.keys[0] ?? m.sets[0]} · ${m.modeName}` }));
    d.onclick = () => { sel = i; render(); };
    return d;
  }) : [el("p", { className: "empty", textContent: "Add a component. Each one is a view over a range of keys in the tree." })]));
}

function pathRow(path, idxs, isSet) {
  const hl = sel >= 0 && usesPath(sel, path);
  const m = !isSet && /^d\/([^/]+)\//.exec(path);
  let live = "";
  // FROM THE RESOLVED MAP, never by calling the db here.
  //
  // `count` is synchronous on the in-memory backend and ASYNC on the
  // engine-backed one, and this row is rendered synchronously. Calling it
  // here put a Promise in the string: once a project was published the tree
  // panel read "— [object Promise] records", which is a wrong number shown to
  // a person rather than a crash, so nothing would have reported it.
  const n = counts[m?.[1]];
  if (preview && m && n !== undefined) live = ` — ${n} record${n === 1 ? "" : "s"}`;
  const row = el("span", { className: "path" + (isSet ? " set" : "") + (hl ? " hl" : "") }, path,
    el("small", { textContent: idxs.map(i => byType[app.components[i].type].label).join(" · ") + live }));
  row.onmouseenter = () => { hoverPath = path; renderCanvas(); };
  row.onmouseleave = () => { hoverPath = null; renderCanvas(); };
  row.onclick = () => { sel = idxs[0]; render(); };
  return row;
}

// The root the panel last showed. `#stale-root=1` freezes it: the negative
// control for the e2e, which must fail when the panel stops following the tree.
let shownRoot = null;
const freezeRoot = () => location.hash.includes("stale-root=1");

/** The real tree behind the preview: its root, and what it holds. */
function renderRoot() {
  const liveDb = rt.db;
  if (!liveDb) { $("tree-root").replaceChildren(); shownRoot = null; return; }
  const root = liveDb.root();
  if (!freezeRoot() || shownRoot === null) shownRoot = root;
  const s = liveDb.stats();
  // NO ROOT YET IS A FACT, NOT A BLANK.
  //
  // `root()` answers "" when the store cannot state its root — deliberately,
  // because a zero root would render as a real tree that happens to be empty,
  // which is the NotLoaded-versus-empty confusion the SDK exists to keep
  // apart. It is the ORDINARY state for the first moments after a publish,
  // before any range has landed.
  //
  // `parseBlockId("")` throws. Unguarded, that throw came out of `onData`
  // inside `mountApp` and the catch there replaced the whole canvas with the
  // exception text — the app gone, the publish button still saying Published.
  if (!root) {
    $("tree-root").replaceChildren(
      el("div", { className: "h" }, el("code", { textContent: "root" }), "this tree, in 32 bytes"),
      el("div", { className: "root" }, el("span", { className: "muted", textContent: NO_ROOT })),
      el("div", { className: "rootstats", id: "root-stats" }, ...rootStats(s)));
    return;
  }
  // A root is a block id: `node:<64 hex>`. The SDK splits it, rather than this
  // file splitting on ":" — the format belongs to the SDK, and an app that
  // takes a copy of it is how the tag and the hex drift apart.
  const { tag, hex } = sdkReady.parseBlockId(shownRoot);
  // The tag is a label, so the 12 characters of hash on screen are 12
  // characters of HASH. Copy and the tooltip carry the whole tagged id,
  // because that is the thing that can be pasted back and checked.
  const copy = el("button", { className: "copy", textContent: "copy", title: "Copy the full block id" });
  copy.dataset.copy = shownRoot;
  copy.onclick = () => navigator.clipboard?.writeText(shownRoot);
  $("tree-root").replaceChildren(
    el("div", { className: "h" }, el("code", { textContent: "root" }), "this tree, in 32 bytes"),
    el("div", { className: "root" },
      el("span", { className: "tag", id: "root-tag", textContent: tag, title: "the kind of block this id names" }),
      el("code", { id: "root-hash", textContent: hex.slice(0, 12) + "\u2026", title: shownRoot }),
      copy),
    el("div", { className: "rootstats", id: "root-stats" }, ...rootStats(s)));
}

/** The stat chips, decided in `tree-stats.js` and rendered here. */
function rootStats(s) {
  return treeStats(s).map(c => el("span", {
    className: c.tone ?? "",
    textContent: c.text,
    ...(c.title ? { title: c.title } : {}),
  }));
}

function renderTree() {
  renderRoot();
  const { ranges, sets } = treeView(app);
  const blocks = Object.entries(RANGES).filter(([r]) => ranges[r]).map(([r, info]) =>
    el("div", { className: "rng" },
      el("div", { className: "h" }, el("code", { textContent: `${r}/` }), `${info.name} · ${info.byte}`),
      Object.entries(ranges[r]).map(([p, idxs]) => pathRow(p, idxs, false))));
  if (Object.keys(sets).length) blocks.push(el("div", { className: "rng" },
    el("div", { className: "h" }, el("code", { textContent: "Sets" }), "written by many — not in any one tree"),
    Object.entries(sets).map(([s, idxs]) => pathRow(s, idxs, true))));
  $("tree").replaceChildren(...(blocks.length ? blocks : [el("p", { className: "note", textContent: "Empty. Ranges appear as components claim them." })]));
}

function renderProps() {
  const inst = app.components[sel];
  if (!inst) { $("props").replaceChildren(el("p", { className: "note", textContent: "Select a component." })); $("map").replaceChildren(); return; }
  const c = byType[inst.type];
  const domain = el("input", { value: inst.domain });
  domain.oninput = () => { inst.domain = domain.value.trim(); rt.invalidate(); save(); renderCanvas(); renderTree(); renderMap(); renderDef(); };
  const mode = el("select");
  c.modes.forEach(m => mode.append(el("option", { value: m, textContent: m, selected: m === inst.mode })));
  mode.onchange = () => { inst.mode = mode.value; save(); render(); };
  // LIVE, per binding, DEFAULT OFF. A subscription is a standing cost paid
  // continuously, so it is the app author who says which of their data is
  // worth it — nothing turns it on by inference, and an existing project
  // opened in a newer builder stays off because `isLive` requires exactly
  // `true` rather than anything truthy.
  const live = el("input", { type: "checkbox", id: "live", checked: isLive(inst) });
  live.onchange = () => {
    // Written only when ON. An `inst.live = false` on every component would
    // put a key in every project definition to say the default, which is how
    // a definition stops being readable.
    if (live.checked) inst.live = true; else delete inst.live;
    rt.invalidate(); save(); render();
  };
  const liveRow = el("label", { className: "live" }, live,
    el("span", { textContent: "Live — updates by itself" }));
  const liveWhy = el("p", { className: "note", id: "live-note", textContent: LIVE_NOTE });

  // WHOSE DATA this component shows once published (DATA-SOURCE): each
  // user's own (`mine`: everyone adds to their own tree, made on their first
  // entry), or the app's data (`publisher`: changed only from the identity
  // that owns the app — the one that built and published it).
  const source = el("select", { id: "source" });
  for (const [v, label] of [["mine", "Each user's own data (everyone adds their own)"], ["publisher", "The app's data (only you, its owner, change it)"]]) {
    source.append(el("option", { value: v, textContent: label, selected: v === sourceOf(inst) }));
  }
  source.onchange = () => { inst.source = source.value; rt.invalidate(); save(); render(); };

  const rm = el("button", { textContent: "Remove", style: "margin-top:12px" });
  rm.onclick = () => { app.components.splice(sel, 1); sel = -1; rt.invalidate(); save(); render(); };
  $("props").replaceChildren(el("label", { textContent: "Domain" }), domain, el("label", { textContent: "Data" }), source, el("label", { textContent: "Consistency" }), mode,
    liveRow, liveWhy,
    el("label", { textContent: `Schema of “${inst.domain}” — shared by every component on it` }), schemaEditor(inst.domain), rm);
  renderMap();
}

function schemaEditor(domain) {
  const schema = (app.schemas[domain] ??= defaultSchema(domain));
  const touch = () => { save(); rt.invalidate(); renderDef(); };
  const type = el("input", { value: schema.type, title: "Record type name" });
  type.oninput = () => { schema.type = type.value.trim(); touch(); };
  const rows = schema.fields.map((f, i) => {
    const name = el("input", { value: f.name });
    name.oninput = () => { f.name = name.value.trim(); touch(); };
    const kind = el("select");
    KINDS.forEach(k => kind.append(el("option", { value: k, textContent: k, selected: k === f.kind })));
    kind.onchange = () => { f.kind = kind.value; touch(); };
    const req = el("input", { type: "checkbox", checked: !!f.required, title: "required" });
    req.onchange = () => { f.required = req.checked; touch(); };
    const del = el("button", { textContent: "×", title: "Remove field" });
    del.onclick = () => { schema.fields.splice(i, 1); touch(); renderProps(); };
    return el("div", { className: "frow" }, name, kind, req, del);
  });
  const add = el("button", { textContent: "+ field" });
  add.onclick = () => { schema.fields.push({ name: `field${schema.fields.length + 1}`, kind: "text" }); touch(); renderProps(); };
  return el("div", { className: "schema" }, type, rows, add);
}

function renderMap() {
  const inst = app.components[sel];
  if (!inst) return;
  const m = mapping(inst);
  const tags = xs => xs.map(x => el("span", { className: "tag", textContent: x }));
  const codes = xs => xs.map(x => el("div", {}, el("code", { textContent: x })));
  const rows = [
    ["Primitive", tags(m.primitives)], ["Schema", tags([m.schema])],
    ...(m.keys.length ? [["Keys", codes(m.keys)]] : []),
    ...(m.sets.length ? [["Sets", codes(m.sets)]] : []),
    ["Contracts", tags(m.contracts)], ["Writes to", [m.writes]],
    ["Writer", [m.mode.writer]], ["Backed by", [m.mode.backing]], ["Conflicts", [m.mode.conflict]],
  ];
  $("map").replaceChildren(
    el("dl", { className: "kv" }, rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", {}, v)])),
    el("p", { className: "note", textContent: m.note }),
    ...(m.phase > BUILT_PHASE ? [el("p", { className: "note", textContent: `Substrate lands in phase ${m.phase}; this is the design view.` })] : []));
}

const renderDef = () => { $("def").textContent = JSON.stringify(app, null, 2); };

/**
 * The call tree of the last operation.
 *
 * Only meaningful over the engine — an in-memory write has no call tree
 * because there is nothing to call — so before Publish it says so rather
 * than showing an empty box, which is indistinguishable from a broken one.
 */
function renderTracePanel() {
  const box = $("trace");
  if (!box) return;
  const publishedDb = rt.publishedDb;
  if (!publishedDb) {
    box.replaceChildren(el("p", { className: "note", textContent:
      "Traces show what an operation actually did on the network. Publish this project first." }));
    return;
  }
  let t = null;
  try { t = publishedDb.trace(); } catch (_) {}
  renderTrace(box, t, el);
}
function render() {
  // WHILE A PROJECT'S DRAFT IS BEING READ from its node, nothing can be edited: an edit then would be replaced by the
  // draft when it arrives (and written, it would overwrite it). A fresh project's canvas is its definition at once.
  for (const id of ["palette", "canvas", "props", "clear"]) { const e = $(id); if (e) e.inert = !rt.draft.loaded; }
  $("preview").textContent = preview ? "Back to design" : "Preview";
  document.body.classList.toggle("previewing", preview);
  renderAddr(); renderPublish(); renderPalette(); renderCanvas(); renderTree(); renderProps(); renderDef(); renderTracePanel();
}

$("publish").onclick = doPublish;
// Emptied IN PLACE: the canvas array carries the base set of what this tab
// held (builder#78), and a fresh `[]` would throw it away — after which the
// save could not tell a record this tab cleared from one another tab added.
$("clear").onclick = () => { app.components.length = 0; app.seed = {}; sel = -1; rt.invalidate(); save(); render(); };
$("preview").onclick = () => { preview = !preview; rt.invalidate(); render(); };
render();

// ---- THE ASSETS TAB (the owner's first repair goal) -----------------------------------------------------------------
// A header button that swaps the main area for the tab: this person's tree, Repair now and Cancel. A pass runs on a
// COLD page of the owner's own tree (`handle.tree(headId)`: its own page, holding none of the tree), so every block is
// asked of the node -- the project's own page wrote the tree and holds it, and would ask the node nothing. The page is
// closed when the pass ends. The words are the SDK's (`sdk.status`); an SDK without `repairAll()` says so.
{
  const button = $("assets"), view = $("assets-view"), mainEl = document.querySelector("main");
  button.onclick = async () => {
    const on = view.hidden;
    view.hidden = !on;
    mainEl.hidden = on;
    button.classList.toggle("on", on);
    if (!on) return;
    const handle = rt?.session ?? null;
    const say = text => view.replaceChildren(Object.assign(document.createElement("div"), { className: "stubbed", textContent: text }));
    if (!handle?.headId?.()) return say("Publish this project first: repair reads its tree from your node.");
    if (!sdkReady?.status?.repairOutcome) return say("This SDK build has no repairAll(): nothing to show.");
    const repair = () => repairPass(handle, { cancelled: sdkReady.status.repairOutcome.CANCELLED });
    const host = document.createElement("div");
    view.replaceChildren(host);
    mountAssets(host, {
      repair,
      words: { repairOutcome: Object.values(sdkReady.status.repairOutcome), groupHealth: Object.values(sdkReady.status.groupHealth) },
      tree: () => ({ name: app.name || "Your data", address: `register ${handle.headId()}` }),
    });
  };
}
