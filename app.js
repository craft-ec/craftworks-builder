import { loadSdk } from "./sdk-loader.js";
import { mount as mountVersions, readBuildInfo } from "./versions-panel.js";
import { stamp, drift, short } from "./project-versions.js";
import { COMPONENTS, RANGES, byType, mapping, treeView } from "./catalogue.js";
import { mountApp } from "./runtime.js";
import { defaultSchema, KINDS, preloadManifest } from "./runtime-logic.js";
import { LIVE_NOTE, isLive } from "./publish-state.js";
import { buttonFor, publish } from "./publish.js";
import { render as renderTrace } from "./trace-view.js";

// Capabilities built so far (ARCHITECTURE.md §21). A component is placeable one
// phase ahead, so an app can be designed before its substrate lands.
const BUILT_PHASE = 1;

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity)); return e; };

let app = { name: "Untitled app", tree: { realm: "public", identity: null }, components: [], schemas: {}, seed: {} };
try { const s = localStorage.getItem("craftec.builder.app.v2"); if (s) app = JSON.parse(s); } catch (_) {}
// An app definition can arrive in the URL (`#app=<json>`): shareable, and testable.
try { const h = new URLSearchParams(location.hash.slice(1)).get("app"); if (h) app = { ...app, ...JSON.parse(h) }; } catch (_) {}
const save = () => { try { localStorage.setItem("craftec.builder.app.v2", JSON.stringify(app)); } catch (_) {} };
app.schemas ??= {}; app.seed ??= {};
let sel = app.components.length ? 0 : -1, hoverPath = null;
let sdkReady = null, preview = new URLSearchParams(location.hash.slice(1)).get("preview") === "1", liveDb = null;
// The engine-backed database, once Publish has switched the backend, and a
// sentinel so an async mount cannot be started twice.
let publishedDb = null, mounting = false;
// Where publishing has got to, and what went wrong if it did.
let publishPhase = "idle", publishError = "";

// The panel's baked half renders at once; the SDK's self-report is filled in
// when the wasm arrives. It does NOT force a load: a panel that pulled in the
// wasm on every page view to read one string would cost more than it tells.
let versionsPanel = null, sdkSelfReport = null, bakedInfo = null;
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
  },
  err => { $("sdk").textContent = "SDK failed to load — run ./build.sh and ./serve.sh"; $("sdk").title = String(err); },
);

function renderAddr() {
  const { realm, identity } = app.tree;
  // The address bar stops saying "in-memory, not published" when the project
  // IS published — and not a moment before. It is the one line a person reads
  // to decide whether closing the tab loses their work, so it tracks what the
  // node has actually confirmed rather than what was asked for.
  const note = publishPhase === "published" ? "" : "  · in-memory, not published";
  $("tree-addr").replaceChildren(
    "craftec://", el("b", { textContent: realm }), "/", el("b", { textContent: identity ?? "‹you›" }), "/",
    el("span", { textContent: note }),
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

function renderPublish() {
  const b = buttonFor(publishPhase, { error: publishError });
  const btn = $("publish");
  btn.textContent = b.label;
  btn.disabled = !b.enabled;
  btn.title = b.hint;
  btn.className = `pri ${b.tone}`.trim();

  // The reason is SHOWN, not hidden in the tooltip. It was in `title` only,
  // which renders as nothing in a screenshot and needs a hover to find — so
  // the one thing that makes a failure fixable was the one thing invisible.
  const note = $("publish-note");
  if (note) note.textContent = publishPhase === "failed" ? publishError : "";
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
  publishError = "";
  try {
    const { db } = await publish(app, {
      open: sdkReady.open,
      artefacts: sdkReady.SHIPPED_ARTEFACTS,
      // NAMED, never defaulted. The node to publish to is a decision: it
      // gets a delegate installed and a signing key handed to it. A default
      // points at whatever is listening, and what was listening here was the
      // owner's own node.
      port: nodePort(),
    }, (phase, err = "") => {
      publishPhase = phase;
      publishError = err;
      renderPublish(); renderAddr();
    });
    // PRELOAD before the first frame, so a read the canvas is about to make
    // is answered from memory instead of from a round trip. Generated from
    // the canvas: a domain nobody has placed a component for is not read on
    // open, and fetching it would spend the first frame on data nothing
    // shows. Naming DOMAINS and not key ranges is deliberate — what a range
    // is, is the SDK's business (craftworks-sdk#66).
    //
    // A preload that fails is not a failed publish. The data is all still
    // reachable; the first read simply pays for it. So it is recorded and
    // the publish goes on.
    try { await db.preload(preloadManifest(app)); }
    catch (e) { publishError = `preload: ${e.message}`; }

    // The backend is switched by REMOUNTING on the new database: the app
    // definition, the components and the bindings are all rebuilt against it.
    // Nothing in the app changes, which is the whole promise of Publish.
    publishedDb = db;
    liveDb = null; mounting = false;
    publishPhase = "published";
    render();
  } catch (e) {
    publishPhase = "failed";
    // `publish` already reported a reason through `onPhase`, and its reason
    // says what to DO. Overwriting it with the raw exception replaced advice
    // a person can act on with a message they cannot — which is what this
    // line used to do.
    if (!publishError) publishError = e.message;
    renderPublish(); renderAddr();
  }
}

function renderPalette() {
  $("palette").replaceChildren(...COMPONENTS.map(c => {
    const ready = c.phase <= BUILT_PHASE + 1;
    const b = el("button", { className: "chip", disabled: !ready, title: `${c.primitives.join(" + ")} · ${c.schema} — ${c.note}${ready ? "" : ` (lands in phase ${c.phase})`}` },
      c.label, el("small", { textContent: ready ? c.schema : `phase ${c.phase}` }));
    b.onclick = () => { app.components.push({ type: c.type, domain: `${c.type}s`, mode: c.modes[0] }); sel = app.components.length - 1; liveDb = null; save(); render(); };
    return b;
  }));
}

function usesPath(i, path) { const m = mapping(app.components[i]); return m.keys.includes(path) || m.sets.includes(path); }

function renderCanvas() {
  if (preview) {
    if (!sdkReady) { $("canvas").replaceChildren(el("p", { className: "empty", textContent: "Loading the SDK…" })); return; }
    // Guarded by a SENTINEL rather than by `liveDb`: mounting is async now,
    // and a second render arriving before the first finished would mount the
    // app twice — two engines, two sets of writes, one canvas.
    if (!mounting) {
      mounting = true;
      mountApp($("canvas"), sdkReady, app, db => { liveDb = db; renderTree(); }, publishedDb, publishPhase)
        .then(db => { liveDb = db; })
        .catch(e => $("canvas").replaceChildren(el("p", { className: "empty", textContent: e.message })));
    }
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
  if (preview && liveDb && m) { try { const n = liveDb.count(m[1]); live = ` — ${n} record${n === 1 ? "" : "s"}`; } catch (_) {} }
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
  if (!liveDb) { $("tree-root").replaceChildren(); shownRoot = null; return; }
  const root = liveDb.root();
  if (!freezeRoot() || shownRoot === null) shownRoot = root;
  const s = liveDb.stats();
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
    el("div", { className: "rootstats", id: "root-stats" },
      el("span", { textContent: `height ${s.height}` }),
      el("span", { textContent: `${s.blocks} blocks` }),
      el("span", { textContent: `${s.bytes.toLocaleString()} B` })));
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
  domain.oninput = () => { inst.domain = domain.value.trim(); liveDb = null; save(); renderCanvas(); renderTree(); renderMap(); renderDef(); };
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
    liveDb = null; save(); render();
  };
  const liveRow = el("label", { className: "live" }, live,
    el("span", { textContent: "Live — updates by itself" }));
  const liveWhy = el("p", { className: "note", id: "live-note", textContent: LIVE_NOTE });

  const rm = el("button", { textContent: "Remove", style: "margin-top:12px" });
  rm.onclick = () => { app.components.splice(sel, 1); sel = -1; liveDb = null; save(); render(); };
  $("props").replaceChildren(el("label", { textContent: "Domain" }), domain, el("label", { textContent: "Consistency" }), mode,
    liveRow, liveWhy,
    el("label", { textContent: `Schema of “${inst.domain}” — shared by every component on it` }), schemaEditor(inst.domain), rm);
  renderMap();
}

function schemaEditor(domain) {
  const schema = (app.schemas[domain] ??= defaultSchema(domain));
  const touch = () => { save(); liveDb = null; renderDef(); };
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
$("clear").onclick = () => { app.components = []; app.seed = {}; sel = -1; liveDb = null; save(); render(); };
$("preview").onclick = () => { preview = !preview; liveDb = null; render(); };
render();
