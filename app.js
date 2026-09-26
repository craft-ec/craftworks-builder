import { loadSdk } from "./sdk-loader.js";
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
import { mountAssets } from "./assets-panel.js";
import { createProjectRuntime } from "./project-runtime.js";

// Capabilities built so far (ARCHITECTURE.md §21). A component is placeable one
// phase ahead, so an app can be designed before its substrate lands.
const BUILT_PHASE = 1;

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity)); return e; };

let app = { name: "Untitled app", tree: { realm: "public", identity: null }, components: [], schemas: {}, seed: {} };
try { const s = localStorage.getItem("craftec.builder.app.v2"); if (s) app = JSON.parse(s); } catch (_) {}
// An app definition can arrive in the URL (`#app=<json>`): shareable, and testable.
try { const h = new URLSearchParams(location.hash.slice(1)).get("app"); if (h) app = { ...app, ...JSON.parse(h) }; } catch (_) {}
// WHETHER THE LAST EDIT IS ON THIS DEVICE (builder#56).
//
// Both writes below used to swallow their failure — `.catch(() => {})` at the
// one place a refused save could surface — so a full quota or denied storage
// turned every edit into a silent loss on reload. The edit itself must still
// not be taken away from the person who made it: the canvas keeps it. What
// changes is that the page SAYS it is unsaved, why, and offers a retry and an
// export, until a save succeeds.
//
// Only the LATEST save's outcome counts. Each save writes the whole canvas, so
// a later success covers everything, and an earlier failure that happens to
// finish after it must not flag a state that is in fact saved.
let saveGen = 0, unsaved = null;
const markSaved = gen => { if (gen === saveGen && unsaved) { unsaved = null; renderSaveState(); } };
// The reason as a person reads it: without LocalDb's own "not saved:" prefix,
// which the line already says, and without a trailing full stop to double.
const reasonOf = e => String(e?.message ?? e).replace(/^not saved:\s*/i, "").replace(/[.\s]+$/, "");
const markUnsaved = (gen, e) => { if (gen === saveGen) { unsaved = { reason: reasonOf(e) }; renderSaveState(); } };
const save = () => {
  const gen = ++saveGen;
  let refused = null;
  try { localStorage.setItem("craftec.builder.app.v2", JSON.stringify(app)); } catch (e) { refused = e; }
  // And into the open project's RECORDS, if one is open.
  Promise.resolve(projects?.persist?.()).then(
    () => (refused ? markUnsaved(gen, refused) : markSaved(gen)),
    e => markUnsaved(gen, e),
  );
};

/** What the store reported about itself, shown until the page is reloaded. */
const storageNotices = [];
function showStorageNotice(n) {
  storageNotices.push(n);
  const host = document.getElementById("storage-note");
  if (!host) return;
  host.hidden = false;
  host.replaceChildren(...storageNotices.map(x => el("div", { className: `note-${x.kind}`, textContent: x.message })));
}

/** The unsaved line: shown only while the last edit is not on this device. */
function renderSaveState() {
  const host = document.getElementById("save-state");
  if (!host) return;
  host.hidden = !unsaved;
  if (!unsaved) { host.replaceChildren(); return; }
  const retry = el("button", { type: "button", id: "save-retry", textContent: "Retry", onclick: () => save() });
  const exp = el("button", { type: "button", id: "save-export", textContent: "Export", onclick: () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(app, null, 2)], { type: "application/json" }));
    const a = el("a", { href: url, download: `${(app.name || "app").replace(/[^\w.-]+/g, "_")}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  host.replaceChildren(
    el("b", { textContent: "Not saved on this device. " }),
    el("span", { id: "save-reason", textContent: `${unsaved.reason}. Your work is still here in this tab — ` }),
    "retry, or export it to a file before closing. ",
    retry, " ", exp,
  );
}
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
// from (builder#83). Set when a project is loaded or adopted.
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
const newRuntime = () => createProjectRuntime({ mount: mountCanvas, publish, onChange: () => render() });
let rt = newRuntime();
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
mountProjects($("projects"), {
  // Notices are what the store knows that is not the fault of any one save —
  // another tab running an older builder, a legacy store it cannot read —
  // and a person can act on each, so each is shown.
  db: new LocalDb(undefined, undefined, { onNotice: n => showStorageNotice(n) }),
  getCanvas: () => app.components,
  getDefinition: () => ({ schemas: app.schemas, seed: app.seed, tree: app.tree, versions: app.versions ?? null }),
  setCanvas: (components, project) => {
    // A DIFFERENT PROJECT, so a different runtime. The old one is disposed
    // before anything of the new one exists: its listeners stop, its session
    // closes, and a mount or publish of it still in flight disowns itself.
    rt.dispose();
    // Its newest publication too: a reconnect whose app is unchanged sends
    // nothing (publishApp's `last`).
    openedProject = { id: project.id, created: project.created, published: reconnectsOnOpen(project), publication: project.publication ?? null };
    rt = newRuntime();
    // The address belonged to the project being left.
    appAddress = null;
    app.components = components;
    app.name = project.title;
    // THE PROJECT'S OWN DEFINITION, not the shared one's leftovers (builder#53).
    // Every one of these used to survive a switch: open Project 1 and you read
    // the schemas Project 2 last set, and a new project took the previous
    // one's version stamp as its own.
    app.schemas = project.schemas ?? {};
    app.seed = project.seed ?? {};
    app.tree = project.tree ?? { realm: "public", identity: null };
    if (project.versions) app.versions = project.versions; else delete app.versions;
    sel = app.components.length ? 0 : -1;
    // A project with no stamp yet is stamped with what it is being made with
    // NOW — the same rule as a new app, and never another project's stamp.
    stampIfNew();
    versionsPanel?.refresh();
    offerUpgrade();
    save();
    render();
    reconnect();
  },
  onChange: () => render(),
  // Two tabs changed one component; this tab's version was kept. Said once
  // per conflict, in the same line storage notices use.
  onConflict: message => showStorageNotice({ kind: "conflict", message }),
}).then(p => { projects = p; }).catch(e => {
  // Storage refused at load. The builder still works — but nothing is being
  // kept, and that is exactly what the person needs to know before editing.
  markUnsaved(saveGen, e);
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
  save();
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
    save();
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
  const b = buttonFor(rt.phase, { error: rt.error, progress: handoffProgress, changed: appChanged(), republishing });
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

/** The app as it was last put on the network (its JSON): what "Publish changes" compares against. */
let publishedApp = null;
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
    publishedApp = JSON.stringify(app);
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

/** The app's STRUCTURE changed since it was last put on the network. */
const appChanged = () => rt.phase === "published" && publishedApp !== null && JSON.stringify(app) !== publishedApp;

/**
 * PUBLISH CHANGES (builder#117): a published project whose structure changed
 * puts the new app at the SAME link — the site's next version. Nothing else
 * of the publish runs again: the data is already on the node.
 */
async function publishChanges() {
  const handle = rt.session;
  if (!handle || !appChanged()) return;
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
  // NO PROJECT OPEN — an app opened from a link, say. A publish is keyed by
  // its project (builder#83), so the app on screen is kept as one first, and
  // published under its id. Pressing Publish on an app you can see should not
  // send you off to do a step the builder can do.
  let adopted = null;
  if (!openedProject && projects?.adopt) {
    try {
      adopted = await projects.adopt({ title: app.name });
      if (adopted) openedProject = { id: adopted.id, created: adopted.created };
    } catch (e) {
      showStorageNotice({ kind: "not-saved", message: `Could not keep this app as a project, so it was not published: ${e.message}` });
      return;
    }
  }
  // Published by THIS project's runtime. If the project is switched while the
  // publish is in flight, the runtime closes the session it produced and runs
  // none of `after` — so a late publish of A cannot record its history into B.
  try {
    await rt.publish(app, {
      // ONE PROJECT, ONE APP (craftworks-sdk#267): the space in the person's
      // tree this project's data lives in.
      appId: appIdOf(openedProject?.id, sdkReady?.ids), ids: sdkReady?.ids,
      open: sdkReady.open,
      artefacts: sdkReady.SHIPPED_ARTEFACTS,
      // NAMED, never defaulted. The node to publish to is a decision: it
      // gets a delegate installed and a signing key handed to it. A default
      // points at whatever is listening, and what was listening here was the
      // owner's own node.
      port: nodePort(),
    }, {
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
    if (adopted && rt.phase === "published") {
      showStorageNotice({ kind: "saved-as", message: `Saved as project “${adopted.title}” and published.` });
    }
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

// ---- THE ASSETS TAB (builder#164; KEEPER.md §1, §3) ----------------------------------------------------------------
// A header button that swaps the main area for the assets view. The view reads the SDK's keep API on the session
// handle. Until that API is in the pinned SDK, the tab runs on `assets-keep-stub.js` and SAYS so on the page -- the
// stub is deleted in the PR that switches to the real surface (the architect's condition), and nothing it shows is
// presented as measured.
{
  const button = $("assets"), view = $("assets-view"), mainEl = document.querySelector("main");
  let mounted = null;
  const labels = () => {
    const m = new Map();
    const id = openedProject?.publication?.app_contract_id;
    if (id) m.set(id, app.name);
    return m;
  };
  button.onclick = async () => {
    const on = view.hidden;
    view.hidden = !on;
    mainEl.hidden = on;
    button.classList.toggle("on", on);
    if (!on) return;
    const handle = rt?.session;
    const real = typeof handle?.keepAssets === "function";
    const api = real ? handle : (await import("./assets-keep-stub.js")).keepStub();
    const host = document.createElement("div");
    view.replaceChildren(...(real ? [] : [Object.assign(document.createElement("div"), { className: "stubbed", textContent: "Sample data: this SDK build has no keep API yet (the audit is engineer2's SDK step). Nothing below was measured." })]), host);
    mounted = mountAssets(host, { api, labels });
  };
}
