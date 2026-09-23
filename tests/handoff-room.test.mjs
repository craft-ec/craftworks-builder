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
// of a FAKE clock the handoff is handed as its `now` and `sleep`: it waits
// `everyMs` (250) between polls exactly as a page does, in fake time. A WRITE
// costs 5 ms; reading the page's own copy costs nothing, as in a page; every
// read of the clock costs 1 ms — so time passes however the handoff waits,
// and a loop that never gives up shows up as a stall, never as a hang.
import assert from "node:assert";
import { engineDb } from "../sdk/engine-db.js";
import { handoff } from "../handoff.js";
// The handoff asks the SDK what a row state means (`row_saved`): load it.
{ const { readFileSync } = await import("node:fs"); const { loadSdk } = await import("../sdk-loader.js");
  await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url))); }

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
function roomySession({ cap = 256, confirmMs = 300, stopAt = Infinity, foreign = 0, lose = null, loseAllAfter = Infinity } = {}) {
  let clock = 0;
  // Writes that are NOT the handoff's, made before it starts and holding room.
  const order = Array.from({ length: foreign }, (_, i) => `foreign/${i}`);
  const rows = new Map();           // key → { fields }
  const schemas = new Map();
  let refusals = 0;
  const confirmedCount = () => Math.min(order.length, Math.floor(clock / confirmMs), stopAt);
  // Past `loseAllAfter` the node ANSWERS every write still waiting: rolled
  // back. An answered write holds no room.
  const answeredLost = () => clock > loseAllAfter;
  const unconfirmed = () => (answeredLost() ? 0 : order.length - confirmedCount());
  // `lose`: the n-th row the handoff makes is ROLLED BACK by the node.
  let made = 0, lost = null;
  const stateOf = key => (key === lost ? "ROLLED_BACK" : order.indexOf(key) < confirmedCount() ? "CLEAN" : answeredLost() ? "ROLLED_BACK" : "PENDING");
  const noRoom = () => {
    refusals += 1;
    // EXACTLY the shape the SDK's session throws (web/src/session.rs `db_err`).
    return { code: "NO_ROOM", message: `not written: ${cap} writes are already waiting for an answer`, transient: false, retryable: true, cap };
  };
  const write = key => {
    clock += 5;
    if (unconfirmed() >= cap) throw noRoom();
    order.push(key);
  };
  const record = (d, id) => ({ id, created: 1, updated: 1, fields: rows.get(`${d}/${id}`).fields, state: stateOf(`${d}/${id}`) });
  const session = {
    take_loads: () => "[]",
    // What the SDK's session reports: every write held unconfirmed, the page's own and others'.
    stats: () => JSON.stringify({ blocks: null, bytes: null, height: null, heldBytes: 0, pendingWrites: unconfirmed(), pendingBytes: 0 }),
    define(d, schema) { write(`schema/${d}`); schemas.set(d, JSON.parse(schema)); },
    schema: d => JSON.stringify(schemas.get(d) ?? null),
    get(d, id) {
      return JSON.stringify(rows.has(`${d}/${id}`) ? record(d, id) : null);
    },
    create_at(d, slot, fields) {
      const key = `${d}/${slot}`;
      if (rows.has(key)) return JSON.stringify({ outcome: "exists", record: record(d, slot) });
      write(key);
      made += 1;
      if (lose !== null && made === lose) lost = key;
      rows.set(key, { fields: JSON.parse(fields) });
      return JSON.stringify({ outcome: "created", record: record(d, slot) });
    },
    update(d, id, patch) { write(`${d}/${id}#u${order.length}`); Object.assign(rows.get(`${d}/${id}`).fields, JSON.parse(patch)); return JSON.stringify(record(d, id)); },
    delete(d, id) { write(`${d}/${id}#d`); return rows.delete(`${d}/${id}`); },
  };
  return {
    session,
    now: () => (clock += 1),
    sleep: async ms => { clock += ms; },
    clock: () => clock,
    refusals: () => refusals,
    stored: d => [...rows.keys()].filter(k => k.startsWith(`${d}/`)).length,
    /** Rows of `d` that read CLEAN right now — what "confirmed" must equal. */
    clean: d => [...rows.keys()].filter(k => k.startsWith(`${d}/`) && stateOf(k) === "CLEAN").length,
  };
}

/** A Preview-shaped source of `n` rows, with nothing deleted and no seed. */
function source(n) {
  const list = Array.from({ length: n }, (_, i) => ({ id: `row${String(i).padStart(4, "0")}`, created: SEED_MS + i, fields: { title: `note ${i}` } }));
  return { scan: async () => list, deleted: async () => [], seedOf: () => undefined };
}

const app = { components: [{ type: "table", domain: "notes", mode: "owned" }], schemas: { notes: SCHEMA } };
/** A deadline on the REAL clock, so a handoff that never ends fails by name instead of hanging the suite. */
const within = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: the handoff never ended (10 s real time)`)), 10_000).unref())]);

const run = (node, n, over = {}) => {
  const heard = [];
  const go = within(handoff({
    source: source(n), target: engineDb({ session: node.session }), app, schemas: { notes: SCHEMA },
    slotFrom, namespace: PID, seedMs: SEED_MS, onNotice: () => {},
    onProgress: p => heard.push(p), confirm: { now: node.now, sleep: node.sleep }, ...over,
  }), `${n} rows`);
  return { go, heard };
};

await t("**300 rows against a target with room for 256: all 300 land, none refused-and-dropped, progress reaches 300 of 300**", async () => {
  const node = roomySession();
  const { go, heard } = run(node, 300);
  await go;
  assert.ok(node.refusals() > 0, "the target never refused for room, so this tested nothing about waiting for it");
  assert.strictEqual(node.stored("notes"), 300, `only ${node.stored("notes")} of 300 rows reached the target`);
  assert.deepStrictEqual(heard.at(-1), { confirmed: 300, total: 300 }, `progress ended at ${JSON.stringify(heard.at(-1))}`);
  // The TOTAL is the whole publish from the first report on — never "120 of 256" becoming "… of 300".
  const totals = [...new Set(heard.map(p => p.total))];
  assert.deepStrictEqual(totals, [300], `the total changed while the person watched: ${JSON.stringify(totals)}`);
  const counts = heard.map(p => p.confirmed);
  assert.deepStrictEqual(counts, [...counts].sort((a, b) => a - b), "progress went backwards");
  process.stdout.write(`  300 rows, room for 256: ${node.refusals()} NO_ROOM answers waited out; done at ${node.clock() / 1000} s of the fake clock\n`);
});

await t("**no room and nothing confirmed: the handoff WAITS (no timer) until the node answers — here, the rest rolled back — and fails naming it**", async () => {
  // Room for 20; the node confirms 5, then says nothing for ten minutes of
  // the fake clock, then answers every waiting write lost.
  const node = roomySession({ cap: 20, stopAt: 5, loseAllAfter: 600_000 });
  const { go } = run(node, 60);
  await assert.rejects(go, e => {
    assert.match(e.message, /records did not reach the node; your data is still here/);
    return true;
  });
  assert.ok(node.clock() > 600_000, `it gave up at ${node.clock()} ms of the fake clock, before the node answered`);
});

await t("**the room is held by writes that are NOT the handoff's: once they confirm, the refused rows are made and the publish completes**", async () => {
  // Every one of the 256 places is taken before the handoff starts, by
  // writes it did not make. It has nothing of its own waiting to be
  // confirmed — so it must look again, not wait for a confirmation of ITS
  // OWN that can never come.
  const node = roomySession({ foreign: 256 });
  const { go, heard } = run(node, 20);
  await go;
  assert.ok(node.refusals() > 0, "the foreign writes held no room, so this tested nothing");
  assert.strictEqual(node.stored("notes"), 20, `only ${node.stored("notes")} of 20 rows reached the target`);
  assert.deepStrictEqual(heard.at(-1), { confirmed: 20, total: 20 });
});

await t("**progress is reported WHILE the rows are made, not only after: a target that never refuses shows a number before the last row exists**", async () => {
  // Live (builder#94): the make loop IS the publish — ~2 minutes at 300 rows
  // — and with no NO_ROOM nothing polled during it: "Moving your records…"
  // with no number for 111–125 s, then 298 of 300. Room for everything here,
  // so only the make loop's own polling can report.
  const node = roomySession({ cap: 100_000 });
  const madeAtReport = [];
  const { go } = run(node, 300, { onProgress: p => madeAtReport.push([node.stored("notes"), p.confirmed, p.total]) });
  await go;
  assert.strictEqual(node.refusals(), 0, "the target refused, so this is the room test again");
  const first = madeAtReport[0];
  assert.ok(first && first[0] < 300, `the first numbered report came only after all 300 rows were made: ${JSON.stringify(first)}`);
  const during = madeAtReport.filter(([made]) => made < 300).length;
  assert.ok(madeAtReport.every(([, , total]) => total === 300), "a report carried a total other than 300");
  process.stdout.write(`  ${during} reports while rows were still being made; first at ${first[0]} rows made, ${first[1]} confirmed\n`);
});

await t("**while the handoff is going WRONG the count says so: a row the node lost is never counted confirmed**", async () => {
  // Reported during the make loop, before the loss is judged (at the end):
  // what the person reads while a publish is failing must not show a
  // rolled-back row as confirmed.
  const node = roomySession({ cap: 100_000, confirmMs: 10, lose: 2 });
  const reports = [];
  const { go } = run(node, 60, { onProgress: p => reports.push({ ...p, made: node.stored("notes"), clean: node.clean("notes") }) });
  await assert.rejects(go, /did not reach the node/, "a lost row must still fail the handoff");
  const during = reports.filter(r => r.made >= 2 && r.made < 60);
  assert.ok(during.length > 0, "no report was taken while rows were being made, after the loss — this tested nothing");
  for (const r of during) {
    // Exactly the rows the node has CONFIRMED — the lost one is not among them.
    assert.strictEqual(r.confirmed, r.clean, `a report counted the LOST row as confirmed: ${JSON.stringify(r)}`);
  }
});

await t("THE CONTROL: a refusal that is NOT retryable is thrown at once, not waited on", async () => {
  const node = roomySession();
  node.session.create_at = () => { throw { code: "TOO_LARGE_TO_SEND", message: "too large", transient: false, retryable: false }; };
  const { go } = run(node, 3);
  const before = node.clock();
  await assert.rejects(go, e => e.code === "TOO_LARGE_TO_SEND");
  assert.ok(node.clock() - before < 1000, "a refusal that waiting cannot fix was waited on");
});
