// What the tree panel may SAY about the tree, and what it must not.
//
// No DOM, so it is testable without a browser — and the rule it enforces is
// one the builder got wrong three times in a row against a real node.
//
// `db.stats()` does not answer the same questions on both backends, and that
// is the SDK being correct rather than a gap to fill. Once a project is
// published the TREE IS ON THE NODE: its height, its block count and its byte
// size are not facts this tab holds, so the SDK returns null for all three and
// gives the client the ones it can state for itself — what it is holding, and
// what it has not yet shipped.
//
// What the builder did with that: printed them. `null.toLocaleString()` threw,
// and because the throw came out of `onData` inside `mountApp`, the catch
// there replaced THE WHOLE CANVAS with the exception text. The app vanished
// and the publish button still said "Published". The other two would have
// rendered "height null" and "null blocks" — no crash, just a lie on screen.
//
// So: a figure is shown only when this build can really state it, and the
// ones that belong to the node say where they live instead of printing a
// placeholder that reads like a measurement.

const num = v => typeof v === "number" && Number.isFinite(v);

/**
 * The stat chips for a `stats()` answer, as `{ text, tone?, title? }`.
 *
 * Pure: the caller turns them into elements. Returning data rather than DOM
 * is what lets the decision be tested against the shape the ENGINE really
 * returns, which is the shape no test in this repo had ever seen.
 */
export function treeStats(s = {}) {
  const out = [];
  if (num(s.height)) out.push({ text: `height ${s.height}` });
  if (num(s.blocks)) out.push({ text: `${s.blocks} blocks` });
  if (num(s.bytes)) out.push({ text: `${s.bytes.toLocaleString()} B` });
  // This client's own facts, available on either backend.
  if (num(s.heldBytes)) out.push({ text: `${s.heldBytes.toLocaleString()} B here` });
  if (num(s.pendingWrites) && s.pendingWrites > 0) {
    out.push({
      text: `${s.pendingWrites} not yet on the network`,
      tone: "warn",
      title: "Written in this tab and not yet confirmed. Closing now would lose them.",
    });
  }
  // Said once, and only when the tree's own size is genuinely not ours to
  // state — never as a fallback for a figure that merely failed to arrive.
  if (!num(s.blocks) && !num(s.height) && !num(s.bytes)) {
    out.push({
      text: "tree size: on the node",
      tone: "muted",
      title: "The tree lives on the node. This tab holds a copy of the parts it has read.",
    });
  }
  return out;
}

/** What the root row shows when the store cannot state a root yet. */
export const NO_ROOT = "not read yet";
