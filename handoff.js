// THE HANDOFF: what Publish owes the records a person made before publishing.
//
// Publish swapped the backend and dropped the preview database, so every row
// entered in Preview vanished — and the button said Published (builder#52).
// The comment above the swap said "Nothing in the app changes, which is the
// whole promise of Publish": true of the definition, false of the user's data.
//
// So before the preview db is let go, its schemas and records are copied to
// the new backend, and the handoff is complete only when the SDK reports every
// copied write ACKNOWLEDGED — row state CLEAN. `PENDING` is accepted and not
// yet published ("closing the tab now loses it"); `ROLLED_BACK` is lost. A
// handoff that ends in either is a failure, and the source stays in use.
//
// IDEMPOTENT across retries, through a LEDGER the project's runtime keeps:
// source record → the copy made of it, and the version copied. A retry after a
// partial failure copies only what is missing, re-applies what was edited in
// the preview since, and removes copies of rows the preview has since deleted.
// Running it twice never makes two copies.
//
// Pure: both databases are passed in, so every path is testable without a
// page or a node (tests/handoff.test.mjs).

/** Every domain this app defines or reads, each once. */
const domainsIn = (app, schemas) =>
  [...new Set([...Object.keys(schemas), ...(app.components ?? []).map(c => c.domain)])];

/** A patch that turns `from` into `to`, with `null` removing a field. */
function patchFor(from, to) {
  const p = { ...to };
  for (const k of Object.keys(from ?? {})) if (!(k in to)) p[k] = null;
  return p;
}

export function newLedger() {
  // `rows`: "domain/sourceId" → { id, updated } of the copy.
  // `seeded`: domains whose seed was written with no preview to copy from.
  return { rows: new Map(), seeded: new Set() };
}

/**
 * Copy `source` into `target`, then wait for every copy to be acknowledged.
 *
 * `source` is null when the project was never previewed: there are no rows a
 * person made, and the seed is written straight to the target — once, per the
 * ledger, since a mount of a published backend does not seed.
 */
export async function handoff({ source, target, app, schemas, ledger, confirm = {} }) {
  const did = { copied: 0, updated: 0, removed: 0, seeded: 0 };
  const domains = domainsIn(app, schemas);

  for (const d of domains) {
    await target.define(d, schemas[d]);

    if (!source) {
      if (ledger.seeded.has(d)) continue;
      for (const row of app.seed?.[d] ?? []) {
        const t = await target.put(d, row);
        ledger.rows.set(`${d}/seed:${did.seeded}`, { id: t.id, updated: t.updated });
        did.seeded += 1;
      }
      ledger.seeded.add(d);
      continue;
    }

    const rows = await source.scan(d);
    const present = new Set();
    for (const r of rows) {
      const key = `${d}/${r.id}`;
      present.add(key);
      const copy = ledger.rows.get(key);
      if (!copy) {
        const t = await target.put(d, r.fields);
        ledger.rows.set(key, { id: t.id, updated: r.updated, fields: r.fields });
        did.copied += 1;
      } else if (JSON.stringify(copy.fields) !== JSON.stringify(r.fields)) {
        // By CONTENT, not by `updated`. An edit made in the same millisecond as
        // the write it follows leaves `updated` unchanged — the SDK takes the
        // max of now and the previous value — so comparing timestamps missed
        // it and a retry left the target holding the stale copy. Measured: 10
        // of 20 runs of the partial-failure test lost the edit that way.
        await target.update(d, copy.id, patchFor(copy.fields, r.fields));
        Object.assign(copy, { updated: r.updated, fields: r.fields });
        did.updated += 1;
      }
    }
    // Rows the preview has deleted since an earlier, partial attempt.
    for (const [key, copy] of [...ledger.rows]) {
      if (!key.startsWith(`${d}/`) || key.startsWith(`${d}/seed:`) || present.has(key)) continue;
      await target.delete(d, copy.id);
      ledger.rows.delete(key);
      did.removed += 1;
    }
  }

  await acknowledged(target, domains, ledger, confirm);
  return did;
}

/**
 * Wait until every copy reads CLEAN, and fail on anything lost.
 *
 * A deadline, because "not confirmed yet" can last for ever on a node that has
 * gone away — and waiting on it would leave the button saying Publishing…
 * with nothing to act on.
 */
export async function acknowledged(target, domains, ledger, { everyMs = 250, budgetMs = 30_000, now = () => Date.now() } = {}) {
  const started = now();
  const rows = [...ledger.rows]
    .filter(([key]) => domains.some(d => key.startsWith(`${d}/`)))
    .map(([key, copy]) => ({ key, domain: key.slice(0, key.indexOf("/")), id: copy.id }));
  for (;;) {
    let waiting = 0;
    const lost = [];
    for (const row of rows) {
      const r = await target.get(row.domain, row.id);
      // NO STATE IS UNKNOWN, NOT CONFIRMED. It used to default to CLEAN, which
      // let the handoff say Published on the strength of a field that was not
      // there — the opposite of the builder's own rule that a record with no
      // state is unpublished, not saved. Unknown waits, like PENDING.
      const state = r?.state ?? "UNKNOWN";
      if (!r || state === "ROLLED_BACK") lost.push(row);
      else if (state !== "CLEAN") waiting += 1;
    }
    if (lost.length) {
      // A COPY THE NODE LOST IS FORGOTTEN, so the next attempt copies it again.
      // Left in the ledger, a retry saw it as already copied, skipped it, asked
      // the node for the same dead id and failed the same way — every Publish,
      // until a reload destroyed the very preview the message says is still
      // here (found in review of builder#61).
      //
      // Only LOST copies. One still PENDING at the deadline is not lost — it
      // may yet land — and forgetting it would copy it twice on a slow node.
      for (const row of lost) ledger.rows.delete(row.key);
      throw new Error(`${lost.length} of ${rows.length} records did not reach the node; your data is still here`);
    }
    if (!waiting) return;
    if (now() - started > budgetMs) {
      throw new Error(`${waiting} of ${rows.length} records are not confirmed by the node yet; your data is still here`);
    }
    await new Promise(r => setTimeout(r, everyMs));
  }
}
