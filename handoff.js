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
// DETERMINISTIC, not remembered (builder#83). A copy's key is a FUNCTION of
// its source — `slotFrom(row.created, project id, row.id)` — and it is written
// with `createAt`, which creates and never overwrites. So a retry, a reload, a
// second tab, two handoffs at once, a second publication: every one lands on
// the same keys and finds the copies already there. Nothing is remembered
// between runs, so nothing can be stale, half-written or raced. It replaced a
// ledger kept in the runtime, which a reload or a second tab started empty —
// and the published backend then held every row twice.
//
// What decides an EXISTING copy that differs from Preview is a fact already
// recorded: whether this project has COMPLETED a publish.
//   - Never: Preview is the truth, so the copy is updated. A failed publish,
//     an edit, and the retry carries the edit.
//   - Once it has: the published backend is live and the builder runs on it,
//     so a handoff still holding a Preview (a stale second tab) is CREATE-ONLY.
//     The published row is kept, counted, and the person is told once.
//
// A DELETION IS PROVED BY A TOMBSTONE, never by an absence. Preview is a
// fresh in-memory db per mount, so a row missing from it may simply be a row
// this mount never had — read as "deleted", a reload between two handoffs
// emptied the published backend. Only a delete made in THIS Preview, which
// `previewDb` records, removes a copy. Stated residual: a row deleted in
// Preview and then reloaded away before a publish stays published.
//
// A SEED ROW IS ITS PLACE IN THE DEFINITION, not its Preview id. Every mount
// seeds a fresh Preview with freshly minted ids, so keyed by id a reload's
// seed rows were new rows and were copied again. `previewDb` records which
// rows are seed row `i` of their domain, and those are handed off at
// `seed/<domain>/<i>` — the same slot a never-previewed project's seed takes,
// and the same whether the project existed when this Preview was mounted or
// was created by the publish itself.
//
// Pure: both databases are passed in, so every path is testable without a
// page or a node (tests/handoff.test.mjs, tests/handoff-across-runtimes.test.mjs).

/** Every domain this app defines or reads, each once. */
const domainsIn = (app, schemas) =>
  [...new Set([...Object.keys(schemas), ...(app.components ?? []).map(c => c.domain)])];

/** A patch that turns `from` into `to`, with `null` removing a field. */
function patchFor(from, to) {
  const p = { ...to };
  for (const k of Object.keys(from ?? {})) if (!(k in to)) p[k] = null;
  return p;
}

/** Field-by-field, independent of key order. */
const sameFields = (a, b) => {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
  return ka.length === kb.length && ka.every(k => JSON.stringify(a[k]) === JSON.stringify(b?.[k]));
};

/** The slot seed row `i` of domain `d` is published at. `seedMs` is the project record's `created`. */
export const seedSlot = (slotFrom, namespace, seedMs, d, i) => slotFrom(seedMs, namespace, `seed/${d}/${i}`);

/** Two Preview rows derive one slot. Nothing is copied. */
export class SlotCollision extends Error {
  constructor(domain, a, b) {
    super(`two records in \`${domain}\` would be published to the same place (${a}, ${b}); nothing was published`);
    this.name = "SlotCollision";
  }
}

/**
 * The Preview db, with its deletes and its seed rows RECORDED.
 *
 * What the handoff reads as proof that a person deleted a row, and as which
 * rows are the definition's seed. In memory, and that is the point: it lives
 * exactly as long as the Preview it describes.
 */
export function previewDb(db) {
  const tombs = new Map();   // domain → [{ id, created, seed }]
  const seeds = new Map();   // "domain\0id" → i
  const seedOf = (d, id) => seeds.get(`${d}\0${id}`);
  return new Proxy(db, {
    get(o, k) {
      if (k === "deleted") return async d => [...(tombs.get(d) ?? [])];
      if (k === "seedOf") return seedOf;
      if (k === "markSeed") return (d, id, i) => { seeds.set(`${d}\0${id}`, i); };
      const v = Reflect.get(o, k);
      if (k === "delete") {
        return async (d, id) => {
          const had = await o.get(d, id);
          const gone = await v.call(o, d, id);
          if (had) tombs.set(d, [...(tombs.get(d) ?? []), { id, created: had.created, seed: seedOf(d, id) }]);
          return gone;
        };
      }
      return typeof v === "function" ? v.bind(o) : v;
    },
  });
}

/** A required input, missing: refused by NAME, never defaulted (builder#73). */
function need(ok, what) {
  if (!ok) throw new Error(`handoff: no \`${what}\``);
}

/**
 * Copy `source` into `target`, then wait for every copy to be acknowledged.
 *
 * `source` is null when the project was never previewed: there are no rows a
 * person made, and the seed is written straight to the target at the slots a
 * Preview's seed would have reached — so the two paths never double it.
 *
 * - `slotFrom`: the SDK's, the one derivation of a slot.
 * - `namespace`: the PROJECT id, not a publication. A second publication
 *   derives the same slots and copies nothing again.
 * - `published`: whether this project has completed a publish.
 * - `seedMs`: the project record's `created`, for seed slots.
 * - `onNotice(text)`: told once when published rows were kept.
 */
export async function handoff({ source, target, app, schemas, slotFrom, namespace, published, seedMs, onNotice, confirm = {} }) {
  need(typeof slotFrom === "function", "slotFrom");
  need(typeof namespace === "string" && namespace.length > 0, "namespace");
  need(typeof published === "boolean", "published");
  need(Number.isSafeInteger(seedMs) && seedMs >= 0, "seedMs");
  need(typeof onNotice === "function", "onNotice");
  need(!source || typeof source.deleted === "function", "source.deleted — a Preview that cannot say what was deleted in it");
  need(!source || typeof source.seedOf === "function", "source.seedOf — a Preview that cannot say which rows are the seed");
  const did = { copied: 0, updated: 0, kept: 0, removed: 0, seeded: 0 };
  const domains = domainsIn(app, schemas);

  // EVERY SLOT FIRST. Only two SOURCE rows can collide with each other — the
  // same namespace, the same millisecond, the same eight hash bytes — so a
  // clash is found from the input alone, before anything is written.
  const slotOf = (d, r) => (r.seed !== undefined ? seedSlot(slotFrom, namespace, seedMs, d, r.seed) : slotFrom(r.created, namespace, r.id));
  const plan = [];
  for (const d of domains) {
    const rows = source
      ? (await source.scan(d)).map(r => ({ ...r, seed: source.seedOf(d, r.id) }))
      : (app.seed?.[d] ?? []).map((fields, i) => ({ id: `seed/${d}/${i}`, fields, seed: i }));
    const bySlot = new Map();
    const copies = [];
    for (const r of rows) {
      const slot = slotOf(d, r);
      if (bySlot.has(slot)) throw new SlotCollision(d, bySlot.get(slot), r.id);
      bySlot.set(slot, r.id);
      copies.push({ slot, row: r });
    }
    const deletes = source ? (await source.deleted(d)).map(t => slotOf(d, t)).filter(slot => !bySlot.has(slot)) : [];
    plan.push({ d, copies, deletes });
  }

  const confirmRows = [];
  for (const { d, copies, deletes } of plan) {
    await target.define(d, schemas[d]);
    for (const { slot, row } of copies) {
      const r = await target.createAt(d, slot, row.fields);
      if (r.outcome === "created") {
        did[row.seed !== undefined ? "seeded" : "copied"] += 1;
      } else if (!sameFields(r.record.fields, row.fields)) {
        if (published) {
          did.kept += 1;
        } else {
          await target.update(d, r.record.id, patchFor(r.record.fields, row.fields));
          did.updated += 1;
        }
      }
      confirmRows.push({ domain: d, id: r.record.id });
    }
    // Create-only once published: a stale Preview deletes nothing live.
    if (!published) {
      for (const slot of deletes) {
        if (await target.delete(d, slot)) did.removed += 1;
      }
    }
  }

  if (did.kept) {
    onNotice(`${did.kept} ${did.kept === 1 ? "record differs" : "records differ"} from the published app and ${did.kept === 1 ? "was" : "were"} kept as published.`);
  }
  await acknowledged(target, confirmRows, confirm);
  return did;
}

/**
 * Wait until every copy reads CLEAN, and fail on anything lost.
 *
 * A deadline, because "not confirmed yet" can last for ever on a node that has
 * gone away — and waiting on it would leave the button saying Publishing…
 * with nothing to act on.
 *
 * A LOST copy needs no forgetting: the next attempt's `createAt` finds its
 * slot empty and copies it again, and a copy merely PENDING at the deadline is
 * found there and not copied twice.
 */
export async function acknowledged(target, rows, { everyMs = 250, budgetMs = 30_000, now = () => Date.now() } = {}) {
  const started = now();
  for (;;) {
    let waiting = 0;
    let lost = 0;
    for (const row of rows) {
      const r = await target.get(row.domain, row.id);
      // NO STATE IS UNKNOWN, NOT CONFIRMED. It used to default to CLEAN, which
      // let the handoff say Published on the strength of a field that was not
      // there — the opposite of the builder's own rule that a record with no
      // state is unpublished, not saved. Unknown waits, like PENDING.
      const state = r?.state ?? "UNKNOWN";
      if (!r || state === "ROLLED_BACK") lost += 1;
      else if (state !== "CLEAN") waiting += 1;
    }
    if (lost) throw new Error(`${lost} of ${rows.length} records did not reach the node; your data is still here`);
    if (!waiting) return;
    if (now() - started > budgetMs) {
      throw new Error(`${waiting} of ${rows.length} records are not confirmed by the node yet; your data is still here`);
    }
    await new Promise(r => setTimeout(r, everyMs));
  }
}
