// The component catalogue: what each builder component IS in the tree.
// Source of truth for the mapping shown to the developer. Architecture §1, §5, §8.
//
// `keys` are patterns in the identity's tree; `{domain}` is the component's domain.
// `sets` are cross-writer Sets owned by the TARGET (not in the author's tree).

/** The keyspace (§5). A key pattern must start with one of these ranges. */
export const RANGES = {
  d: { byte: "0x01", name: "records", is: "Record" },
  i: { byte: "0x02", name: "indexes", is: "Index (key existence)" },
  e: { byte: "0x03", name: "edges", is: "Edge" },
  f: { byte: "0x05", name: "files", is: "File / folder entry" },
  c: { byte: "0x06", name: "containers", is: "Container" },
  l: { byte: "0x07", name: "ledger", is: "Ledger block" },
};

export const PRIMITIVES = ["Record", "Edge", "Container", "Blob"];
export const SCHEMAS = ["stream", "directed tree", "block ring", "capability", "state-transition"];
export const CONTRACTS = ["Block", "Register", "Set", "Derived"];

/** What the consistency toggle changes underneath (§12). */
export const MODES = {
  owned: { label: "owned", writer: "you only", backing: "your device tree (Blocks) + your head (Register)", conflict: "none — single writer; devices overlaid, newest wins" },
  shared: { label: "shared", writer: "anyone you authorize", backing: "a Set keyed by record key", conflict: "per key, latest (time, signer, hash) wins" },
  document: { label: "document", writer: "co-editors", backing: "a Set of edit operations (CRDT)", conflict: "none — operations commute" },
  ledger: { label: "ledger", writer: "you only, in sequence", backing: "your account-chain + your head (Register)", conflict: "a fork voids both blocks and freezes the account" },
};

const own = "your own tree";
const ownPlusSet = "your own tree + a signed pointer in a Set the target owns";

export const COMPONENTS = [
  { type: "table", label: "Table", phase: 1, primitives: ["Record"], schema: "stream",
    keys: ["d/{domain}/<rkey>"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["owned", "shared"],
    note: "Rows are records under one domain, scanned as a key range." },
  { type: "form", label: "Form", phase: 1, primitives: ["Record"], schema: "stream",
    keys: ["d/{domain}/<rkey>"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["owned", "shared"],
    note: "Creates or edits one record; the record id is time-sortable." },
  { type: "list", label: "List", phase: 1, primitives: ["Record"], schema: "stream",
    keys: ["d/{domain}/<rkey>"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["owned", "shared"],
    note: "Newest-first scan of a domain." },
  { type: "profile", label: "Profile", phase: 6, primitives: ["Record"], schema: "stream",
    keys: ["d/profile/self"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["owned"],
    note: "One record; the identity entry in the directory points at it." },
  { type: "feed", label: "Feed", phase: 8, primitives: ["Record", "Edge"], schema: "stream",
    keys: ["d/{domain}/<rkey>", "e/follows/<me>/<them>"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["owned"],
    note: "Reads the same domain from every identity you follow; your follows are edges in your tree." },
  { type: "comments", label: "Comments", phase: 8, primitives: ["Record", "Edge"], schema: "stream",
    keys: ["d/{domain}/<rkey>", "e/annotates/<comment>/<target>"], sets: ["inbox(<target>, {domain}, <day>)"],
    contracts: ["Block", "Register", "Set"], writes: ownPlusSet, modes: ["owned"],
    note: "A comment lives in its author's tree. The thread is the target's Set of pointers, one bucket per day." },
  { type: "votes", label: "Votes", phase: 8, primitives: ["Edge"], schema: "stream",
    keys: ["e/votes/<me>/<target>"], sets: ["tally(<target>, votes)"], contracts: ["Block", "Register", "Set"], writes: ownPlusSet, modes: ["owned"],
    note: "Your vote is an edge in your tree; the count is a Set with one item per identity." },
  { type: "search", label: "Search", phase: 10, primitives: ["Record"], schema: "stream",
    keys: ["i/{domain}/<field>/<term>/<rkey>"], sets: ["idx/{domain}/<term-prefix>"], contracts: ["Set", "Derived"], writes: ownPlusSet, modes: ["owned"],
    note: "Local index keys in your tree; global listings are Sets reachable from the root." },
  { type: "vault", label: "Vault", phase: 7, primitives: ["Record"], schema: "capability",
    keys: ["d/{domain}/<rkey>  (sealed subtree)"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["owned"],
    note: "The whole subtree is encrypted node by node: keys, values and counts are hidden. Shared by capability." },
  { type: "files", label: "File explorer", phase: 5, primitives: ["Container", "Blob"], schema: "directed tree",
    keys: ["f/<dir-id>/<name>", "c/<dir-id>"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["owned", "shared"],
    note: "Entries are keyed by folder id, so moving a folder changes one entry." },
  { type: "media", label: "Media player", phase: 5, primitives: ["Blob"], schema: "block ring",
    keys: ["d/{domain}/<rkey>  → BlobRef"], sets: ["fragments(<blob>)"], contracts: ["Block", "Set"], writes: own, modes: ["owned"],
    note: "The record holds a pointer; the media is 256 KiB coded pieces fetched in a race." },
  { type: "pay", label: "Pay button", phase: 11, primitives: ["Record"], schema: "state-transition",
    keys: ["l/<seq>"], sets: [], contracts: ["Block", "Register"], writes: own, modes: ["ledger"],
    note: "A send is the next block of your account-chain; final once under a signed checkpoint." },
  { type: "chat", label: "Chat", phase: 13, primitives: ["Record"], schema: "stream",
    keys: ["d/{domain}/<rkey>"], sets: ["conversation(<room>, <day>)"], contracts: ["Block", "Register", "Set"], writes: ownPlusSet, modes: ["owned"],
    note: "Each message is in its sender's tree, sealed with the room key; the room is a Set of pointers." },
];

export const byType = Object.fromEntries(COMPONENTS.map(c => [c.type, c]));

/** Problems with one catalogue entry; empty = complete. */
export function validateComponent(c) {
  const bad = [];
  for (const f of ["type", "label", "schema", "writes", "note"]) if (!c[f]) bad.push(`missing ${f}`);
  if (!Number.isInteger(c.phase)) bad.push("missing phase");
  if (!c.primitives?.length || c.primitives.some(p => !PRIMITIVES.includes(p))) bad.push("bad primitives");
  if (!SCHEMAS.includes(c.schema)) bad.push(`unknown schema ${c.schema}`);
  if (!c.contracts?.length || c.contracts.some(k => !CONTRACTS.includes(k))) bad.push("bad contracts");
  if (!c.modes?.length || c.modes.some(m => !MODES[m])) bad.push("bad modes");
  if (!c.keys?.length) bad.push("no key patterns");
  for (const k of c.keys ?? []) if (!RANGES[k.split("/")[0]]) bad.push(`key outside the keyspace: ${k}`);
  if (c.sets?.length && !c.contracts?.includes("Set")) bad.push("uses a Set but does not list the Set contract");
  if (c.writes?.includes("Set") && !c.sets?.length) bad.push("says it writes to a Set but names none");
  return bad;
}

/** Concrete key patterns / Sets for a placed component. The consistency mode
 *  changes WHERE the records live: `shared` and `document` data is written by
 *  many people, so it lives in a Set, not in anyone's own tree (§9). */
export function mapping(instance) {
  const c = byType[instance.type];
  const d = instance.domain || "?";
  const fill = s => s.replaceAll("{domain}", d);
  const mode = MODES[instance.mode] ? instance.mode : c.modes[0];
  let keys = c.keys.map(fill), sets = c.sets.map(fill), contracts = [...c.contracts], writes = c.writes;
  if (mode === "shared" || mode === "document") {
    const set = mode === "shared" ? `shared(<owner>, ${d})` : `document(<owner>, ${d})`;
    keys = keys.filter(k => !k.startsWith("d/"));
    sets = [set, ...sets];
    if (!contracts.includes("Set")) contracts.push("Set");
    writes = "a Set its owner opens to authorized writers";
  }
  return { ...c, keys, sets, contracts, writes, mode: MODES[mode], modeName: mode };
}

/** The tree as this app uses it: range → path → component indexes. Pure. */
export function treeView(app) {
  const ranges = {};
  const sets = {};
  app.components.forEach((inst, i) => {
    const m = mapping(inst);
    for (const k of m.keys) {
      const r = k.split("/")[0];
      ((ranges[r] ??= {})[k] ??= []).push(i);
    }
    for (const s of m.sets) (sets[s] ??= []).push(i);
  });
  return { ranges, sets };
}
