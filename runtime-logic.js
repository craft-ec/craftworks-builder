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
 * Open the app's data: define every domain, load seed records. Returns the db and
 * anything that went wrong (a refused schema or seed row), so the UI can say so.
 */
export function openApp(sdk, app) {
  const db = new sdk.Db();
  const problems = [];
  for (const d of domainsOf(app)) {
    try { db.define(d, app.schemas?.[d] ?? defaultSchema(d)); } catch (e) { problems.push(`${d}: ${e.message}`); }
  }
  for (const [d, rows] of Object.entries(app.seed ?? {})) {
    for (const row of rows) {
      try { db.put(d, row); } catch (e) { problems.push(`${d} seed: ${e.message}`); }
    }
  }
  return { db, problems };
}
