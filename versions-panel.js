// The versions panel: a footer chip that opens what this builder is running.
//
// All of the judgement lives in versions.js, which has no DOM and is tested on
// its own. This file only paints, so a disagreement between the panel and the
// tests cannot hide in here.

import { model, diagnostics } from "./versions.js";

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.flat(Infinity));
  return e;
};

/** Baked values, or null — a missing file is reported, never defaulted. */
export async function readBuildInfo(fetchFn = fetch) {
  try {
    const r = await fetchFn("./build-info.json", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

const DOT = { ok: "●", info: "●", warn: "▲", mismatch: "▲", unverified: "○", unknown: "○" };

export function mount(host, { baked, getSdk }) {
  let open = false;
  const chip = el("button", { className: "ver-chip", type: "button", id: "versions-chip" });
  const pop = el("div", { className: "ver-pop", id: "versions-pop", hidden: true });
  host.replaceChildren(chip, pop);

  const paint = () => {
    const sdk = getSdk();
    const m = model({ baked, sdk });
    const v = m.verification;
    chip.className = `ver-chip s-${v.state}`;
    chip.textContent = `${DOT[v.state] ?? "○"} versions`;
    chip.title = v.text;
    chip.setAttribute("aria-expanded", String(open));

    pop.replaceChildren(
      el("div", { className: `ver-verdict s-${v.state}` },
        el("b", { textContent: label(v.state) }), " ", el("span", { textContent: v.text })),
      ...m.sections.map(s =>
        el("section", {},
          el("h4", { textContent: s.title }),
          el("dl", { className: "ver-kv" },
            ...s.rows.flatMap(r => [
              el("dt", { textContent: r.label }),
              el("dd", { className: `s-${r.state}` },
                el("code", { textContent: r.value }),
                r.note ? el("small", { textContent: r.note }) : []),
            ])))),
      el("div", { className: "ver-actions" },
        Object.assign(el("button", { type: "button", id: "versions-copy", textContent: "Copy diagnostics" }), {
          onclick: async () => {
            const text = diagnostics({ baked, sdk: getSdk() });
            try {
              await navigator.clipboard.writeText(text);
              flash("copied");
            } catch (_) {
              // Clipboard is blocked in plenty of contexts. Show the text
              // rather than claim a copy that did not happen.
              flash("clipboard blocked — the text is below");
              pop.append(el("pre", { className: "ver-diag", textContent: text }));
            }
          },
        })),
    );
  };

  const flash = text => {
    const n = pop.querySelector(".ver-flash") ?? el("span", { className: "ver-flash" });
    n.textContent = text;
    pop.querySelector(".ver-actions")?.append(n);
  };

  chip.onclick = () => { open = !open; pop.hidden = !open; paint(); };
  document.addEventListener("click", e => {
    if (open && !host.contains(e.target)) { open = false; pop.hidden = true; paint(); }
  });

  paint();
  return { refresh: paint };
}

const label = s => ({
  ok: "verified",
  info: "verified",
  warn: "check this",
  mismatch: "MISMATCH",
  unverified: "not verified yet",
}[s] ?? s);
