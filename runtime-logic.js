// The parts of running an app that need no DOM: schemas, form values, columns.

/** Schema given to a domain nobody has described yet. */
export function defaultSchema(domain) {
  const base = domain.replace(/[^a-z0-9]+/gi, " ").trim().replace(/s$/i, "") || "Record";
  return {
    type: base.replace(/(^|\s)(\w)/g, (_, _s, c) => c.toUpperCase()),
    fields: [{ name: "title", kind: "text", required: true }, { name: "done", kind: "bool" }],
  };
}

export const KINDS = ["text", "int", "float", "bool", "time", "bytes", "ref"];

/** HTML input type for a field kind. */
export const inputType = kind =>
  ({ int: "number", float: "number", bool: "checkbox", time: "datetime-local" })[kind] ?? "text";

/** Raw form values → record fields. Blank means absent (null), never "" or NaN. */
export function toFields(schema, raw) {
  const out = {};
  for (const f of schema.fields) {
    const v = raw[f.name];
    if (f.kind === "bool") { out[f.name] = !!v; continue; }
    if (v === undefined || v === null || v === "") { out[f.name] = null; continue; }
    if (f.kind === "int") { const n = Number(v); if (!Number.isInteger(n)) throw new Error(`${f.name} must be a whole number`); out[f.name] = n; }
    else if (f.kind === "float") { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${f.name} must be a number`); out[f.name] = n; }
    else if (f.kind === "time") { const t = typeof v === "number" ? v : Date.parse(v); if (!Number.isFinite(t)) throw new Error(`${f.name} must be a date and time`); out[f.name] = t; }
    else out[f.name] = String(v);
  }
  return out;
}

/** Record field → what a form input or table cell shows. */
export function display(kind, v) {
  if (v === undefined || v === null) return "";
  if (kind === "bool") return v ? "✓" : "";
  if (kind === "time") return new Date(v).toISOString().slice(0, 16).replace("T", " ");
  return String(v);
}

/** The field a list shows as each record's headline: first text field, else first field. */
export const headline = schema => (schema.fields.find(f => f.kind === "text") ?? schema.fields[0])?.name;

/** Every domain the app's components use, each once. */
export const domainsOf = app => [...new Set(app.components.map(c => c.domain).filter(Boolean))];

/**
 * The schema of every domain this app opens: its declared one, or the default.
 *
 * ONE definition, used by `openApp` to define a backend and by the publish
 * handoff to define the one it copies into. Two copies of this rule would be
 * two backends disagreeing about what a domain is.
 */
export const schemasOf = app =>
  Object.fromEntries(domainsOf(app).map(d => [d, app.schemas?.[d] ?? defaultSchema(d)]));

/**
 * Open the app's data: define every domain, load seed records. Returns the db
 * and anything that went wrong (a refused schema or seed row), so the UI can
 * say so.
 *
 * `db` is supplied rather than constructed, because the SAME function opens an
 * app on either backend. That is what Publish switches, and it is why every
 * call here is awaited even though the in-memory backend answers at once:
 * writing it synchronous now and async later is how one surface becomes two,
 * and the divergence would appear exactly at the moment a project is published.
 *
 * A problem is RECORDED and the rest of the app still opens. One refused seed
 * row must not leave a person staring at a blank canvas with no idea which
 * row it was.
 */
export async function openApp(sdk, app, db = new sdk.Db(), { seed = true } = {}) {
  const problems = [];
  // THE SCHEMAS THIS APP IS OPENED WITH, returned rather than read back.
  //
  // These are the exact values handed to `define`, so they are what the
  // domains ARE. Reading them back from the db was a round trip to learn
  // something already in hand, and over the engine-backed backend it was a
  // round trip that can legitimately answer "not loaded yet" — which a
  // renderer then had to turn into either a wrong screen or a wait.
  //
  // Measured: it answered exactly that, against a real node, moments after a
  // publish. Both components rendered "No schema for “notes”." for a domain
  // whose schema was three lines above in the app definition.
  const schemas = schemasOf(app);
  for (const [d, schema] of Object.entries(schemas)) {
    try { await db.define(d, schema); }
    catch (e) { problems.push(`${d}: ${e.message}`); }
  }
  // THE SEED IS WHAT A NEW, EMPTY APP STARTS WITH, so it goes into the preview
  // database — a fresh one on every mount — and NOT into a published backend.
  // That one persists: seeding it on every mount put the rows in again each
  // time, and brought back seed rows the person had deleted in Preview. What
  // reaches a published backend is the HANDOFF (handoff.js), once (builder#52).
  //
  // Each seed row is MARKED as seed row `i` of its domain where the db can
  // record it (the Preview's, `previewDb`): a seed row's identity is its
  // position in the definition, not the id this mount happened to mint, so a
  // reload's fresh Preview and a second tab hand off the SAME seed rows
  // (builder#83).
  if (seed) for (const [d, rows] of Object.entries(app.seed ?? {})) {
    for (const [i, row] of rows.entries()) {
      try {
        const r = await db.put(d, row);
        if (typeof db.markSeed === "function") db.markSeed(d, r.id, i);
      } catch (e) { problems.push(`${d} seed: ${e.message}`); }
    }
  }
  return { db, problems, schemas };
}

/**
 * The domains this app will read on open, each once.
 *
 * Handed to the engine before the first frame so a cold read is answered
 * from memory rather than from a round trip. It names DOMAINS and not key
 * ranges: what a range is, is the SDK's business, and a builder that encoded
 * one would pin a layout that could then never change (craftworks-sdk#66).
 *
 * Derived from the CANVAS, not from the schemas: a domain nobody has placed a
 * component for is not read on open, and loading it would spend the first
 * frame's bandwidth on data nothing is going to show.
 */
export const preloadManifest = app => domainsOf(app);

/**
 * Which end of a domain a component shows, and so which end its page reads.
 *
 * Record ids are time-ordered, so the first rows of a FORWARD scan are the
 * OLDEST. A list shows newest-first; a list that read a forward page and
 * reversed it showed the oldest `PAGE` records upside down, and a person's
 * 51st note never appeared at all (builder#51). So the direction is decided
 * HERE, per component type, and the read carries it. A table stays
 * oldest-first, deliberately: it is a ledger, read top to bottom.
 */
export const readsNewestFirst = type => type === "list";

/**
 * THE SAVING LINE (craftworks-sdk#163): what the page says while writes are
 * unsaved, from the session's `{ kind: "saving", count }`. `count` is every
 * write not yet PUBLISHED — sent, Accepted and held alike — so the line stays
 * until the LAST one publishes, never at `Accepted` (a tab closed after it can
 * still lose the edit). `null` means say nothing: only 0 clears it.
 */
export function savingLabel(count) {
  if (!Number.isInteger(count) || count < 0) throw new Error(`savingLabel: a count of unsaved writes, not ${count}`);
  return count === 0 ? null : `saving ${count}…`;
}

/**
 * What a paged view holds, and what it is allowed to SAY about itself.
 *
 * `page` is the binding's snapshot — at most `size` rows. `more` is what the
 * person has asked for past it: `{ rows, ended }`, where `ended` means a read
 * with `after` came back short, so there is provably nothing further.
 *
 * THE POINT: a full page is a FLOOR, not a count. Fifty rows back from a
 * fifty-row read means "at least fifty", and a view that drew them with no
 * mark said "there are fifty" — the same value meaning two things. So:
 *   * `page` short of `size`        → complete; nothing to say (`footer: null`);
 *   * full, and not proven ended    → `{ more: true }`  — "there may be more";
 *   * full, and a later read ended  → `{ more: false }` — "all N shown".
 * Only a read that came back SHORT proves the end; nothing else may.
 */
export function pageView(page, more, size) {
  const seen = new Set(page.map(r => r.id));
  const rows = [...page, ...more.rows.filter(r => !seen.has(r.id))];
  if (page.length < size) return { rows, footer: null };
  return { rows, footer: { more: !more.ended, shown: rows.length } };
}
