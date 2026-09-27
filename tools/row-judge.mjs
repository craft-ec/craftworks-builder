// JUDGE A ROW BY ITS RECORD, NEVER ITS TEXT (builder#172; the architect's builder sweep). The gates used to decide
// "saved" from the page's words -- `tr.textContent.includes("saved")` (which a user's TITLE also matches) or a chip's
// text `=== "saved + backed up"` -- a check that can pass on a word nobody meant as a state. A row's state is its
// RECORD's code (`record.state`), which the runtime writes on the row's chip as `data-row-state`, and what a code
// MEANS is the SDK's (`rowSaved` / `rowBackedUp`, the one owner, exposed on the app frame as
// `globalThis.__craftworks`). Every gate reads rows through this file and nothing else; a one-home test holds it.
//
// Page-side scripts (strings a tab evaluates in the app frame).

/**
 * THE WORDS A FRAME WITHOUT THE SDK'S JUDGE THROWS (builder#177, the architect on #174): no `rowSaved`/`rowBackedUp`
 * on the app frame is a harness failure, never "not saved yet" -- a gate that read it as "not saved" waited out its
 * whole budget and then blamed the node.
 */
export const NO_JUDGE = "row-judge: no SDK judge on this frame";

/**
 * FOR EVERY `until`'s CATCH (one home): a missing judge ENDS the wait, named; any other evaluation failure is "not yet"
 * (`null`). The wait loops swallow a script's errors by design (a page mid-load throws), so this is where a missing
 * judge gets out.
 */
export function stopOnNoJudge(e) {
  const said = String(e?.message ?? e);
  if (said.includes(NO_JUDGE)) throw new Error(`${NO_JUDGE}: globalThis.__craftworks has no rowSaved/rowBackedUp (the app frame did not load the SDK's runtime)`);
  return null;
}

/**
 * An EXPRESSION: the rows under `scope` (a page-script expression for an element; the whole document by default),
 * each `{ cell, code, saved, backedUp }` -- its first cell, its record's state code, and the SDK's judgement of it.
 */
export const rowsExpr = (scope = "document") => `(() => {
  const k = globalThis.__craftworks;
  if (typeof k?.rowSaved !== "function" || typeof k?.rowBackedUp !== "function") throw new Error(${JSON.stringify(NO_JUDGE)});
  return [...((${scope})?.querySelectorAll("tbody tr") ?? [])].filter(tr => tr.querySelector(".rt-state")).map(tr => {
    const code = tr.querySelector(".rt-state").dataset.rowState ?? "";
    return { cell: tr.querySelector("td")?.textContent ?? null, code, saved: !!k.rowSaved(code), backedUp: !!k.rowBackedUp(code) };
  });
})()`;

/** A script: the rows (for a `return`). */
export const ROWS = `return ${rowsExpr()};`;

/** A script: is the row whose first cell is `title`, under `scope`, SAVED (by its record)? `true`, or `null` to wait. */
export const savedRow = (scope, title) => `return ${rowsExpr(scope)}.some(r => r.cell === ${JSON.stringify(title)} && r.saved) || null;`;

/**
 * THE BACKED_UP ASSERTION, one home: are the rows titled `titles` (at least one) ALL backed up, by their records? A
 * title with no row is not backed up. `rows` is `ROWS`'s answer.
 */
export function backedUp(rows, titles) {
  if (!titles.length) throw new Error("backedUp: no row named, so nothing would be asserted");
  return titles.every(t => rows.some(r => r.cell === t && r.backedUp));
}
