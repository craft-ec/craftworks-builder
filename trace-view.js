// The call tree of the last operation, as a person reads it.
//
// No DOM here — the shaping is testable without a browser, and the renderer
// below is the only part that touches the page.
//
// WHAT CROSSES THIS BOUNDARY IS THE INSTRUMENT'S VOCABULARY AND NOTHING ELSE:
// a step name from a fixed list, a depth, a count, a coarse offset. No key, no
// value, no domain name. The same recording ships in a user's app and is what
// a support bundle is made of, so a viewer that reached for "which record was
// that" would put the answer in every bundle, and no grep would find it.

/** What each step means, in words rather than in jargon. */
export const MEANS = {
  Began: "the operation started",
  Effects: "the engine decided what had to happen",
  Put: "blocks were written",
  ReadBack: "a write was read back and found — this is what makes it durable",
  Head: "the head was written",
  HeadConfirmed: "the head was read back at the sequence it was written at",
  Reached: "it reached a state this tab can see",
  Fetch: "blocks were fetched",
};

/**
 * Rows for the viewer: one per step, with its indent and what it means.
 *
 * `n` is a COUNT or a sequence, never an identifier — that is a property of
 * the vocabulary and not of this function, but it is the reason this can be
 * shown at all.
 */
export function rows(trace) {
  if (!trace || !Array.isArray(trace.steps)) return [];
  return trace.steps.map(s => ({
    step: s.step,
    depth: s.depth ?? 0,
    n: s.n ?? 0,
    atMs: s.atMs ?? 0,
    // A step this build does not know the words for is SHOWN, with its name.
    // Hiding it would make a newer engine's trace look shorter than it is.
    means: MEANS[s.step] ?? "(this build has no description for this step)",
  }));
}

/**
 * The one-line summary above the tree.
 *
 * Says when a trace is TRUNCATED. A cut-off tree read as a complete one is a
 * diagnosis of the wrong thing, which is the whole reason the engine reports
 * it rather than letting a short tree imply it.
 */
export function summary(trace) {
  if (!trace) return "No operation has been traced yet. Turn tracing on, then write something.";
  const n = trace.steps?.length ?? 0;
  const ms = trace.totalMs ?? 0;
  const cut = trace.truncated ? " — TRUNCATED: the operation had more steps than the engine keeps" : "";
  return `${n} step${n === 1 ? "" : "s"} over ${ms} ms${cut}`;
}

/** Render into `root`. `el` is the host's element helper. */
export function render(root, trace, el) {
  root.replaceChildren(
    el("p", { className: "note", textContent: summary(trace) }),
    ...rows(trace).map(r =>
      el("div", { className: "tr-step", style: `margin-left:${r.depth * 14}px`, title: r.means },
        el("b", { textContent: r.step }),
        el("span", { className: "tr-n", textContent: ` ×${r.n}` }),
        el("span", { className: "tr-at", textContent: ` +${r.atMs}ms` }))),
  );
}
