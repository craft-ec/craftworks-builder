// A publish larger than the target's room WAITS for room; it never drops a
// row and never fails for being large (builder#94's room half).
//
// The SDK's copy holds at most 256 writes the node has not confirmed, and
// refuses the next one `NO_ROOM` — retryable, by name, with the cap
// (craftworks-sdk#180; measured live: 300 rows → 256 published, 46 refused).
// The handoff must wait for the node to confirm a record, which frees room,
// and make THAT row again.
//
// Driven through the REAL engine surface — the SDK's own `engineDb` wrapper,
// so a refusal arrives exactly as a page sees it (a `DbError` with `code`,
// `retryable`, `cap`) — over a session that behaves as the copy does: a cap
// of unconfirmed writes, and a node confirming them in order, one per 300 ms
// of a fake clock that moves 5 ms per READ — and the handoff reads only when
// it polls for confirmations. Making a row takes no time on this clock, so a
// burst meets the cap as it would.
import assert from "node:assert";
import { engineDb } from "../sdk/engine-db.js";
import { handoff } from "../handoff.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

const SCHEMA = { type: "Note", fields: [{ name: "title", kind: "text", required: true }] };
const PID = "r0projectid0000";
const SEED_MS = Date.now() - 86_400_000;
const slotFrom = (ms, ns, id) => `${String(ms).padStart(12, "0")}${ns}${id}`.replace(/[^0-9a-z]/g, "").slice(-32).padStart(32, "0");

/**
 * A session with the copy's room rule. `cap` unconfirmed writes at most; the
 * node confirms one every `confirmMs` of the clock, oldest first, or never
 * once `stopAt` writes are confirmed.
 */
function roomySession({ cap = 256, confirmMs = 300, stopAt = Infinity } = {}) {
  let clock = 0;
  const order = [];                 // keys in the order written
  const rows = new Map();           // key → { fields }
  const schemas = new Map();
  let refusals = 0;
  const confirmedCount = () => Math.min(order.length, Math.floor(clock / confirmMs), stopAt);
  const unconfirmed = () => order.length - confirmedCount();
  const stateOf = key => (order.indexOf(key) < confirmedCount() ? "CLEAN" : "PENDING");
  const noRoom = () => {
    refusals += 1;
    // EXACTLY the shape the SDK's session throws (web/src/session.rs `db_err`).
    return { code: "NO_ROOM", message: `not written: ${cap} writes are already waiting for an answer`, transient: false, retryable: true, cap };
  };
  const write = key => {
    if (unconfirmed() >= cap) throw noRoom();
    order.push(key);
  };
  const record = (d, id) => ({ id, created: 1, updated: 1, fields: rows.get(`${d}/${id}`).fields, state: stateOf(`${d}/${id}`) });
  const session = {
    take_loads: () => "[]",
    define(d, schema) { write(`schema/${d}`); schemas.set(d, JSON.parse(schema)); },
    schema: d => JSON.stringify(schemas.get(d) ?? null),
    get(d, id) {
      clock += 5;
      return JSON.stringify(rows.has(`${d}/${id}`) ? record(d, id) : null);
    },
    create_at(d, slot, fields) {
      const key = `${d}/${slot}`;
      if (rows.has(key)) return JSON.stringify({ outcome: "exists", record: record(d, slot) });
      write(key);
      rows.set(key, { fields: JSON.parse(fields) });
      return JSON.stringify({ outcome: "created", record: record(d, slot) });
    },
    update(d, id, patch) { write(`${d}/${id}#u${order.length}`); Object.assign(rows.get(`${d}/${id}`).fields, JSON.parse(patch)); return JSON.stringify(record(d, id)); },
    delete(d, id) { write(`${d}/${id}#d`); return rows.delete(`${d}/${id}`); },
  };
  return {
    session,
    now: () => clock,
    clock: () => clock,
    refusals: () => refusals,
    stored: d => [...rows.keys()].filter(k => k.startsWith(`${d}/`)).length,
  };
}

/** A Preview-shaped source of `n` rows, with nothing deleted and no seed. */
function source(n) {
  const list = Array.from({ length: n }, (_, i) => ({ id: `row${String(i).padStart(4, "0")}`, created: SEED_MS + i, fields: { title: `note ${i}` } }));
  return { scan: async () => list, deleted: async () => [], seedOf: () => undefined };
}

const app = { components: [{ type: "table", domain: "notes", mode: "owned" }], schemas: { notes: SCHEMA } };
const run = (node, n, over = {}) => {
  const heard = [];
  const go = handoff({
    source: source(n), target: engineDb({ session: node.session }), app, schemas: { notes: SCHEMA },
    slotFrom, namespace: PID, seedMs: SEED_MS, onNotice: () => {},
    onProgress: p => heard.push(p), confirm: { everyMs: 0, now: node.now }, ...over,
  });
  return { go, heard };
};

await t("**300 rows against a target with room for 256: all 300 land, none refused-and-dropped, progress reaches 300 of 300**", async () => {
  const node = roomySession();
  const { go, heard } = run(node, 300);
  await go;
  assert.ok(node.refusals() > 0, "the target never refused for room, so this tested nothing about waiting for it");
  assert.strictEqual(node.stored("notes"), 300, `only ${node.stored("notes")} of 300 rows reached the target`);
  assert.deepStrictEqual(heard.at(-1), { confirmed: 300, total: 300 }, `progress ended at ${JSON.stringify(heard.at(-1))}`);
  const counts = heard.map(p => p.confirmed);
  assert.deepStrictEqual(counts, [...counts].sort((a, b) => a - b), "progress went backwards");
  process.stdout.write(`  300 rows, room for 256: ${node.refusals()} NO_ROOM answers waited out; done at ${node.clock() / 1000} s of the fake clock\n`);
});

await t("**a target that has no room and confirms nothing more fails on NO PROGRESS, naming how far it got**", async () => {
  // Room for 20; the node confirms 5 and then stops.
  const node = roomySession({ cap: 20, stopAt: 5 });
  const { go } = run(node, 60);
  await assert.rejects(go, e => {
    assert.match(e.message, /has room for no more records and has confirmed none in 30 s — \d+ of \d+ made so far are confirmed; your data is still here/);
    return true;
  });
  assert.ok(node.stored("notes") < 60, "it cannot have made every row");
});

await t("THE CONTROL: a refusal that is NOT retryable is thrown at once, not waited on", async () => {
  const node = roomySession();
  node.session.create_at = () => { throw { code: "TOO_LARGE_TO_SEND", message: "too large", transient: false, retryable: false }; };
  const { go } = run(node, 3);
  const before = node.clock();
  await assert.rejects(go, e => e.code === "TOO_LARGE_TO_SEND");
  assert.ok(node.clock() - before < 1000, "a refusal that waiting cannot fix was waited on");
});
