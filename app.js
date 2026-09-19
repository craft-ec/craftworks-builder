import { loadSdk } from "./sdk-loader.js";
import { COMPONENTS, RANGES, MODES, byType, mapping, treeView } from "./catalogue.js";

// Capabilities built so far (ARCHITECTURE.md §21). A component is placeable one
// phase ahead, so an app can be designed before its substrate lands.
const BUILT_PHASE = 0;

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat()); return e; };

let app = { name: "Untitled app", tree: { realm: "public", identity: null }, components: [] };
try { const s = localStorage.getItem("craftec.builder.app.v2"); if (s) app = JSON.parse(s); } catch (_) {}
// An app definition can arrive in the URL (`#app=<json>`): shareable, and testable.
try { const h = new URLSearchParams(location.hash.slice(1)).get("app"); if (h) app = { ...app, ...JSON.parse(h) }; } catch (_) {}
const save = () => { try { localStorage.setItem("craftec.builder.app.v2", JSON.stringify(app)); } catch (_) {} };
let sel = app.components.length ? 0 : -1, hoverPath = null;

loadSdk().then(
  sdk => { $("sdk").textContent = `SDK ${sdk.version()}`; window.craftec = sdk; },
  err => { $("sdk").textContent = "SDK failed to load — run ./build.sh and ./serve.sh"; $("sdk").title = String(err); },
);

function renderAddr() {
  const { realm, identity } = app.tree;
  $("tree-addr").replaceChildren(
    "craftec://", el("b", { textContent: realm }), "/", el("b", { textContent: identity ?? "‹you›" }), "/",
    el("span", { textContent: identity ? "" : "  · in-memory, not published" }),
  );
}

function renderPalette() {
  $("palette").replaceChildren(...COMPONENTS.map(c => {
    const ready = c.phase <= BUILT_PHASE + 1;
    const b = el("button", { className: "chip", disabled: !ready, title: `${c.primitives.join(" + ")} · ${c.schema} — ${c.note}${ready ? "" : ` (lands in phase ${c.phase})`}` },
      c.label, el("small", { textContent: ready ? c.schema : `phase ${c.phase}` }));
    b.onclick = () => { app.components.push({ type: c.type, domain: `${c.type}s`, mode: c.modes[0] }); sel = app.components.length - 1; save(); render(); };
    return b;
  }));
}

function usesPath(i, path) { const m = mapping(app.components[i]); return m.keys.includes(path) || m.sets.includes(path); }

function renderCanvas() {
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
  const row = el("span", { className: "path" + (isSet ? " set" : "") + (hl ? " hl" : "") }, path,
    el("small", { textContent: idxs.map(i => byType[app.components[i].type].label).join(" · ") }));
  row.onmouseenter = () => { hoverPath = path; renderCanvas(); };
  row.onmouseleave = () => { hoverPath = null; renderCanvas(); };
  row.onclick = () => { sel = idxs[0]; render(); };
  return row;
}

function renderTree() {
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
  domain.oninput = () => { inst.domain = domain.value.trim(); save(); renderCanvas(); renderTree(); renderMap(); renderDef(); };
  const mode = el("select");
  c.modes.forEach(m => mode.append(el("option", { value: m, textContent: m, selected: m === inst.mode })));
  mode.onchange = () => { inst.mode = mode.value; save(); render(); };
  const rm = el("button", { textContent: "Remove", style: "margin-top:12px" });
  rm.onclick = () => { app.components.splice(sel, 1); sel = -1; save(); render(); };
  $("props").replaceChildren(el("label", { textContent: "Domain" }), domain, el("label", { textContent: "Consistency" }), mode, rm);
  renderMap();
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
function render() { renderAddr(); renderPalette(); renderCanvas(); renderTree(); renderProps(); renderDef(); }

$("clear").onclick = () => { app.components = []; sel = -1; save(); render(); };
render();
