import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { defaultSchema, toFields, display, headline, domainsOf, openApp, inputType, pageView, readsNewestFirst } from "../runtime-logic.js";

assert.deepStrictEqual(defaultSchema("tasks").type, "Task");
assert.deepStrictEqual(defaultSchema("blog-posts").type, "BlogPost"); // type names are PascalCase
assert.strictEqual(headline(defaultSchema("x")), "title");
assert.strictEqual(inputType("time"), "datetime-local");

const schema = { type: "T", fields: [
  { name: "title", kind: "text" }, { name: "n", kind: "int" }, { name: "x", kind: "float" },
  { name: "ok", kind: "bool" }, { name: "at", kind: "time" }] };
// blank → null (absent), never "" or NaN; unchecked box → false
assert.deepStrictEqual(toFields(schema, { title: "", n: "", x: "", at: "" }), { title: null, n: null, x: null, ok: false, at: null });
assert.deepStrictEqual(toFields(schema, { title: "a", n: "3", x: "1.5", ok: true, at: "2026-01-02T03:04" }),
  { title: "a", n: 3, x: 1.5, ok: true, at: Date.parse("2026-01-02T03:04") });
assert.throws(() => toFields(schema, { n: "1.5" }), /whole number/);
assert.throws(() => toFields(schema, { x: "abc" }), /must be a number/);
assert.strictEqual(display("bool", true), "✓");
assert.strictEqual(display("text", null), "");
assert.strictEqual(display("time", Date.UTC(2026, 0, 2, 3, 4)), "2026-01-02 03:04");

// Opening an app: two components on one domain define it once; seed rows load;
// a bad seed row is reported, not swallowed, and the good ones still load.
const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const app = { components: [{ type: "table", domain: "tasks" }, { type: "form", domain: "tasks" }, { type: "list", domain: "notes" }],
  schemas: { notes: { type: "Note", fields: [{ name: "text", kind: "text", required: true }] } },
  seed: { tasks: [{ title: "one" }, { title: 7 }, { title: "two", done: true }], notes: [{ text: "hi" }] } };
assert.deepStrictEqual(domainsOf(app), ["tasks", "notes"]);
const { db, problems } = await openApp(sdk, app);
assert.deepStrictEqual(await db.domains(), ["notes", "tasks"]);
assert.strictEqual(await db.count("tasks"), 2);
assert.strictEqual(await db.count("notes"), 1);
assert.strictEqual(problems.length, 1);
assert.match(problems[0], /tasks seed: .*must be text/);
// what a form saves is what a table reads back
const saved = await db.put("tasks", toFields(await db.schema("tasks"), { title: "from form", done: true }));
assert.deepStrictEqual((await db.scan("tasks", { reverse: true, limit: 1 }))[0], saved);
console.log("ok runtime logic");

// ---- A FULL PAGE IS A FLOOR, NOT A COUNT (builder#51) ----
{
  const r = n => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}` }));
  const none = { rows: [], ended: false };
  // short page: complete, and says nothing
  assert.deepStrictEqual(pageView(r(3), none, 5).footer, null, "a short page IS the whole domain");
  // full page, nothing past it read yet: "there may be more" — never "there are 5"
  assert.deepStrictEqual(pageView(r(5), none, 5).footer, { more: true, shown: 5 },
    "a full page was drawn as complete — 'there are 5' and 'at least 5' became one value");
  // full page, the read past it came back SHORT: provably the end
  const tail = { rows: r(7).slice(5), ended: true };
  assert.deepStrictEqual(pageView(r(5), tail, 5), { rows: r(7), footer: { more: false, shown: 7 } });
  // exactly a page of data: the read past it is EMPTY, and only then is it "all 5"
  assert.deepStrictEqual(pageView(r(5), { rows: [], ended: true }, 5).footer, { more: false, shown: 5 });
  // a read past it that came back FULL proves nothing about the end
  assert.strictEqual(pageView(r(5), { rows: r(10).slice(5), ended: false }, 5).footer.more, true);
  // a row fetched past the page and then shifted INTO it is shown once
  assert.strictEqual(pageView(r(5), { rows: r(6).slice(4), ended: true }, 5).rows.length, 6);
  // direction: a list is newest-first, a table is not
  assert.strictEqual(readsNewestFirst("list"), true);
  assert.strictEqual(readsNewestFirst("table"), false);
  console.log("ok runtime: a full page says 'at least', and only a short read says 'all'");
}
