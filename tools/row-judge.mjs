// JUDGE A ROW BY ITS RECORD, NEVER ITS TEXT (builder#172; the architect's builder sweep). The gates used to decide
// "saved" from the page's words -- `tr.textContent.includes("saved")` (which a user's TITLE also matches) or a chip's
// text `=== "saved + backed up"` -- a check that can pass on a word nobody meant as a state. A row's state is its
// RECORD's code (`record.state`), which the runtime writes on the row's chip as `data-row-state`, and what a code
// MEANS is the SDK's (`rowSaved` / `rowBackedUp`, the one owner, exposed on the app frame as
// `globalThis.__craftworks`). Every gate reads rows through this file and nothing else; a one-home test holds it.
//
// Page-side scripts (strings a tab evaluates in the app frame).

/**
 * An EXPRESSION: the rows under `scope` (a page-script expression for an element; the whole document by default),
 * each `{ cell, code, saved, backedUp }` -- its first cell, its record's state code, and the SDK's judgement of it.
 */
export const rowsExpr = (scope = "document") => `(() => {
  const k = globalThis.__craftworks;
  return [...((${scope})?.querySelectorAll("tbody tr") ?? [])].filter(tr => tr.querySelector(".rt-state")).map(tr => {
    const code = tr.querySelector(".rt-state").dataset.rowState ?? "";
    return { cell: tr.querySelector("td")?.textContent ?? null, code, saved: !!k?.rowSaved?.(code), backedUp: !!k?.rowBackedUp?.(code) };
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
