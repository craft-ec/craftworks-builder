// AN APP'S OWN CODE (ARCHITECTURE §19, "an app is DATA in its owner's tree"; app-as-data P5): its modules are
// `f/<path>` records of its published definition, and `meta.entry` names the one the loader starts. An app with no
// entry is a definition, mounted by the runtime. Whether the entry is one of its files is the SDK's rule at publish.

/** The app's code: `{ files: Map<path, bytes>, entry: path }` from its definition records, or null for none. */
export function codeOf(records) {
  const meta = records.find(r => r.key === "meta")?.body;
  const entry = typeof meta?.entry === "string" ? meta.entry : null;
  if (!entry) return null;
  const files = new Map(records.filter(r => r.key.startsWith("f/")).map(r => [r.key.slice(2), r.bytes]));
  return { files, entry: entry.replace(/^f\//, "") };
}
