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
// What decides an EXISTING copy that differs from Preview is whether the
// TARGET DOMAIN IS LIVE — a publish into it has completed (builder#86).
//   - Not live: Preview is the truth, so the copy is updated. A failed
//     publish, an edit, and the retry carries the edit.
//   - Live: people are using it, so a handoff still holding a Preview (a
//     stale tab, another browser, another project on the same domain name)
//     is CREATE-ONLY. A differing row is kept, counted, and the person told
//     once; nothing is deleted; and NO SEED is written into it.
//
// The fact lives where it is true: in the target, per domain — the target's
// real scope is (node, bare domain name) — as a marker row written with
// `createAt` after a publish is acknowledged, so a second completion lands on
// the first. It was read from this browser's own history, per project: a
// second browser, a cleared site, or a second project using the same domain
// name read "never published" about a live domain, and re-seeded it.
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
import { sameRows } from "./sdk/engine-db.js";

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

/**
 * The same fields, STRUCTURALLY: key order anywhere, nested included, is not
 * a difference. `JSON.stringify` per field read a nested value's key order as
 * one, which meant a needless update — or, on a live domain, a false "kept as
 * published" and a notice (builder#86). The SDK's `sameRows` is the one
 * definition of "the same" (craftworks-sdk#129).
 */
export const sameFields = (a, b) => sameRows([a ?? {}], [b ?? {}]);

/**
 * The reserved domain the "is this domain live?" markers live in, in the
 * target. Never a domain an app may have: an app that names it is refused.
 */
export const PUBLISHED_DOMAIN = "craftworks.published";
const PUBLISHED_SCHEMA = { type: "Published", fields: [] };
const markerSlot = (slotFrom, d) => slotFrom(0, "domain", d);

/** Is domain `d` live in `target`: has a publish into it completed? Reads only. */
async function isLive(target, slotFrom, d) {
  if (!(await target.schema(PUBLISHED_DOMAIN))) return false;
  return Boolean(await target.get(PUBLISHED_DOMAIN, markerSlot(slotFrom, d)));
}

/**
 * The slot seed row `i` of domain `d` is published at. `seedMs` is the project
 * record's `created`.
 *
 * Stated residual: the key is the POSITION, so editing the app's seed list
 * between publishes shifts it. A row moved to another index lands on that
 * index's slot, and a SHORTER list leaves its old last slot published — the
 * handoff never deletes a seed slot it was not told was deleted.
 */
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
 * - Whether each domain is LIVE is read from the target itself, never passed
 *   in: see `isLive`.
 * - `seedMs`: the project record's `created`, for seed slots.
 * - `onNotice(text)`: told once when published rows were kept.
 * - `onProgress({ confirmed, total })`: the rows' confirmations as they come,
 *   for the publish panel (builder#94).
 */
export async function handoff({ source, target, app, schemas, slotFrom, namespace, seedMs, onNotice, onProgress = () => {}, confirm = {} }) {
  need(typeof slotFrom === "function", "slotFrom");
  need(typeof namespace === "string" && namespace.length > 0, "namespace");
  need(Number.isSafeInteger(seedMs) && seedMs >= 0, "seedMs");
  need(typeof onNotice === "function", "onNotice");
  need(!source || typeof source.deleted === "function", "source.deleted — a Preview that cannot say what was deleted in it");
  need(!source || typeof source.seedOf === "function", "source.seedOf — a Preview that cannot say which rows are the seed");
  const did = { copied: 0, updated: 0, kept: 0, removed: 0, seeded: 0 };
  const domains = domainsIn(app, schemas);
  if (domains.includes(PUBLISHED_DOMAIN)) {
    throw new Error(`\`${PUBLISHED_DOMAIN}\` is reserved for the builder's own records; rename that domain to publish`);
  }

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
    plan.push({ d, copies, deletes, live: await isLive(target, slotFrom, d) });
  }

  // ONE LOOP, TWO CONDITIONS: room and progress (builder#94). The target
  // holds a bounded number of writes it has not had confirmed — the SDK's copy
  // refuses the next one `NO_ROOM`, retryable, by name (sdk#180). A publish
  // larger than that is not a failure: the handoff waits for the node to
  // confirm a record, which frees room, and makes THAT row again — never
  // skipping it, never counting it failed. The one deadline is progress: no
  // record newly confirmed, and no row made, for `stallMs`.
  const total = plan.reduce((n, { copies, live }) => n + copies.filter(c => !(live && c.row.seed !== undefined)).length, 0);
  const confirmRows = [];
  const progress = tracker(target, confirmRows, { ...confirm, onProgress }, total);
  const withRoom = fn => roomFor(fn, progress, confirmRows);
  for (const { d, copies, deletes, live } of plan) {
    await withRoom(() => target.define(d, schemas[d]));
    for (const { slot, row } of copies) {
      // A SEED is what a NEW app starts with. A live domain is not new: the
      // person may have edited those rows away, and writing them again brings
      // them back. So it is never written there — but a live copy that
      // differs from it is still counted as kept, and the person told.
      if (live && row.seed !== undefined) {
        const pf = schemas[d]?.parent;
        const held = await target.get(d, pf ? `${row.fields[pf]}${slot}` : slot);
        if (held && !sameFields(held.fields, row.fields)) did.kept += 1;
        continue;
      }
      const r = await withRoom(() => target.createAt(d, slot, row.fields));
      if (r.outcome === "created") {
        did[row.seed !== undefined ? "seeded" : "copied"] += 1;
      } else if (!sameFields(r.record.fields, row.fields)) {
        if (live) {
          did.kept += 1;
        } else {
          await withRoom(() => target.update(d, r.record.id, patchFor(r.record.fields, row.fields)));
          did.updated += 1;
        }
      }
      confirmRows.push({ domain: d, id: r.record.id });
      // PROGRESS WHILE MAKING (builder#94, live): the make loop IS the
      // publish — at ~2.6 rows a second, 300 rows take ~2 minutes — and
      // nothing polled during it, so the panel said "Moving your records…"
      // with no number for 111–125 s and then jumped to 298 of 300.
      await progress.pollIfDue();
    }
    // Create-only once live: a stale Preview deletes nothing live.
    if (!live) {
      for (const slot of deletes) {
        if (await withRoom(() => target.delete(d, slot))) did.removed += 1;
      }
    }
  }

  if (did.kept) {
    onNotice(`${did.kept} ${did.kept === 1 ? "record differs" : "records differ"} from the published app and ${did.kept === 1 ? "was" : "were"} kept as published.`);
  }
  await settled(progress);
  // THE PUBLISH COMPLETED: every domain it touched is live from now on. By
  // `createAt`, so a second completion lands on the first marker. A crash
  // before these are written is benign: the retry runs in not-live mode from
  // the same Preview, finds every copy equal, and writes them then.
  //
  // And a marker is a write like any other: ACKNOWLEDGED before this returns
  // (builder#88). Unconfirmed, the node may still roll it back, and a publish
  // reported done would leave its domains reading "not live" — the re-seed
  // and overwrite #86 closed, reopened by one lost write. Written only AFTER
  // the rows confirm, so a domain is never marked live over rows that may
  // yet be lost; a marker that does not confirm fails the publish exactly as
  // an unconfirmed row does, and the retry writes it once (`createAt`).
  const markers = [];
  const marking = tracker(target, markers, confirm, plan.length);
  const markerRoom = fn => roomFor(fn, marking, markers);
  await markerRoom(() => target.define(PUBLISHED_DOMAIN, PUBLISHED_SCHEMA));
  for (const { d } of plan) {
    const m = await markerRoom(() => target.createAt(PUBLISHED_DOMAIN, markerSlot(slotFrom, d), {}));
    markers.push({ domain: PUBLISHED_DOMAIN, id: m.record.id });
  }
  await settled(marking);
  return did;
}

/**
 * What the node has confirmed of `rows`, and the one deadline: PROGRESS.
 *
 * A deadline on progress, not on the total (builder#94). "Not confirmed yet"
 * can last for ever on a node that has gone away, and waiting on it would
 * leave the button saying Publishing… with nothing to act on. But the node
 * confirms one write per commit, about 3.4 a second: 100 rows took 27–29 s of
 * a 30 s total, and 300 rows could not fit at any speed. A publish that is
 * still ADVANCING — a record newly confirmed, or a row made — is never failed
 * for being large; one that has stalled for `stallMs` fails as promptly as
 * before, and says how far it got.
 *
 * `rows` may grow while this is in use: the handoff adds each row it makes.
 * `onProgress({ confirmed, total })` is told each time the count moves.
 */
function tracker(target, rows, { everyMs = 250, stallMs = 30_000, now = () => Date.now(), sleep = pause, onProgress = () => {}, ...rest } = {}, total = null) {
  // The old TOTAL budget, passed by a caller that was not updated, would be
  // silently ignored and wait 30 s of no progress instead. Refused by name.
  if ("budgetMs" in rest) throw new Error("handoff: `budgetMs` is gone — the deadline is on progress now; pass `stallMs` (builder#94)");
  let best = -1;
  let movedAt = now();
  let polledAt = null;
  // The fewest writes the target has held unconfirmed — ANY of this page's,
  // not only these rows. The node confirming someone else's write is the node
  // making progress: behind 255 of them, these rows wait 77 s on a healthy
  // node, and counting only our own confirmations called that a stall.
  let fewest = null;
  const t = {
    everyMs, stallMs, now, sleep, rows,
    get best() { return best; },
    /** Something moved that is not a confirmation: a row was made. */
    moved: () => { movedAt = now(); },
    /**
     * REPORT progress if `everyMs` has passed since the last poll. Only
     * reports: a row lost is judged where it always was — in the room wait
     * and once every row is made — so a failed attempt leaves exactly what
     * it left before this existed.
     */
    async pollIfDue() {
      if (polledAt !== null && now() - polledAt < everyMs) return;
      await t.poll({ judge: false });
    },
    stalled: () => now() - movedAt > stallMs,
    /** Read every row's state; throw on anything lost. */
    async poll({ judge = true } = {}) {
      polledAt = now();
      let waiting = 0;
      let lost = 0;
      for (const row of rows) {
        const r = await target.get(row.domain, row.id);
        // NO STATE IS UNKNOWN, NOT CONFIRMED. It used to default to CLEAN,
        // which let the handoff say Published on the strength of a field that
        // was not there — the opposite of the builder's own rule that a
        // record with no state is unpublished, not saved. Unknown waits.
        const state = r?.state ?? "UNKNOWN";
        if (!r || state === "ROLLED_BACK") lost += 1;
        else if (state !== "CLEAN") waiting += 1;
      }
      if (lost && judge) throw new Error(`${lost} of ${rows.length} records did not reach the node; your data is still here`);
      // The engine surface says how many writes it holds unconfirmed
      // (`stats().pendingWrites`); a store with nothing to wait on does not.
      const unconfirmed = typeof target.stats === "function" ? (await target.stats())?.pendingWrites : undefined;
      if (Number.isInteger(unconfirmed)) {
        if (fewest !== null && unconfirmed < fewest) movedAt = now();
        if (fewest === null || unconfirmed < fewest) fewest = unconfirmed;
      }
      // A LOST row is not confirmed, whether or not this poll judges it.
      const confirmed = rows.length - waiting - lost;
      // PROGRESS is a record newly confirmed — the HIGHEST count so far
      // moving up, so a count that dips and recovers is not mistaken for it.
      if (confirmed > best) {
        best = confirmed;
        movedAt = now();
        onProgress({ confirmed, total: total ?? rows.length });
      }
      return { waiting, confirmed };
    },
  };
  return t;
}

const pause = ms => new Promise(r => setTimeout(r, ms));

/**
 * Make one write, and when the target has NO ROOM for it, wait for room.
 *
 * `NO_ROOM` is the SDK saying it already holds as many unconfirmed writes as
 * it will (sdk#180) — retryable, and marked so by Rust (`retryable`), not
 * recognised here by a list of codes. Room comes back as the node confirms
 * ANY write this page made — the handoff's, or writes it did not make — so
 * this looks again every `everyMs` and makes the SAME write again as soon as
 * there is room. It does NOT wait for a confirmation of its own rows: with
 * 255 other writes ahead of them, that is 77 s of freed room left unused and
 * a false stall. It gives up only when nothing has moved — no record of ours
 * newly confirmed, no row made — for `stallMs`. Anything that is not
 * retryable is thrown as it came.
 */
async function roomFor(fn, t, rows) {
  for (;;) {
    try {
      const r = await fn();
      t.moved();
      return r;
    } catch (e) {
      if (!(e && e.retryable === true)) throw e;
      await t.sleep(t.everyMs);
      const { confirmed } = await t.poll();
      if (t.stalled()) {
        throw new Error(`the node has room for no more records and has confirmed none in ${Math.round(t.stallMs / 1000)} s — ${confirmed} of ${rows.length} made so far are confirmed; your data is still here`);
      }
    }
  }
}

/** Wait until every row `t` tracks reads CLEAN; fail on anything lost, or on no progress. */
async function settled(t) {
  for (;;) {
    const { waiting, confirmed } = await t.poll();
    if (!waiting) return;
    if (t.stalled()) {
      throw new Error(`${waiting} of ${t.rows.length} records are not confirmed by the node yet — ${confirmed} confirmed, and none newly in ${Math.round(t.stallMs / 1000)} s; your data is still here`);
    }
    await t.sleep(t.everyMs);
  }
}

/**
 * Wait until every copy reads CLEAN, and fail on anything lost — or when
 * `stallMs` passes with no record newly confirmed (see `tracker`).
 *
 * A LOST copy needs no forgetting: the next attempt's `createAt` finds its
 * slot empty and copies it again, and a copy merely PENDING at the deadline is
 * found there and not copied twice.
 */
export async function acknowledged(target, rows, opts = {}) {
  await settled(tracker(target, rows, opts));
}
