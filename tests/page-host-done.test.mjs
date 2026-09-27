// `done(code)` EXITS THE PROCESS WITH ITS STATUS, so how a page test calls it decides whether a failure is red.
//
// A page test that ended in `finally { done() }` exited 0 on a failing assertion: green, the failure printed and
// read by nothing (found when a new test's known-red mutant exited 0 too). Two controls:
//   1. page-host's `done` fails CLOSED: anything but a status is 1 (`statusOf`), so a bare `done()` is red on every
//      run and is found the first time it runs;
//   2. no page-host caller (tests/, tools/) calls its `done` with no status inside a `finally` -- a source scan,
//      with a planted file it must catch.
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { statusOf } from "./page-host.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

await t("**a status is a status; anything else is a failure** (statusOf)", () => {
  for (const [given, want] of [[0, 0], [1, 1], [2, 2], [undefined, 1], [null, 1], [true, 1], [false, 1], ["0", 1], [-1, 1], [0.5, 1]]) {
    assert.strictEqual(statusOf(given), want, `statusOf(${JSON.stringify(given)})`);
  }
});

await t("**page-host's done applies it before anything else**, so `done()` exits 1", () => {
  const src = readFileSync(join(ROOT, "tests/page-host.mjs"), "utf8");
  const body = src.slice(src.indexOf("const done = async code => {"));
  assert.ok(body.length > 0, "page-host has no `done` of that shape: this check names nothing");
  const first = body.split("\n").slice(1).find(l => l.trim() && !l.trim().startsWith("//"));
  assert.strictEqual(first.trim(), "code = statusOf(code);", `done's first statement is not the status rule: ${first}`);
});

/** A page-host caller's bare `done()` (its own `done`, or `host.done`) inside a `finally { ... }`: [line, text]. */
export function bareDoneInFinally(text) {
  // Comments blanked to spaces (line numbers kept): prose that QUOTES the shape is not code that has it.
  const src = text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, c => " ".repeat(c.length));
  if (!/\bopenPageHost\s*\(/.test(src)) return [];
  const hits = [];
  const re = /finally\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    // The block's extent by brace depth from its `{`.
    let depth = 0, end = m.index + m[0].length - 1;
    for (let i = end; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}" && (depth -= 1) === 0) { end = i; break; }
    }
    const block = src.slice(m.index, end + 1);
    for (const d of block.matchAll(/(?<![\w.])(?:host\.)?done\(\s*\)/g)) {
      hits.push([src.slice(0, m.index + d.index).split("\n").length, d[0]]);
    }
  }
  return hits;
}

const files = dir => readdirSync(join(ROOT, dir)).filter(f => f.endsWith(".mjs")).map(f => join(dir, f));

await t("**no page-host caller ends a run with a bare done() in a finally**", () => {
  // Not page-host itself (it defines `done`), and not this file (its planted cases are the control below).
  const self = new Set(["tests/page-host.mjs", "tests/page-host-done.test.mjs"]);
  const callers = [...files("tests"), ...files("tools")].filter(f => !self.has(f) && /\bopenPageHost\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.ok(callers.length >= 4, `only ${callers.length} page-host callers found: the scan reads the wrong place`);
  const found = callers.flatMap(f => bareDoneInFinally(readFileSync(join(ROOT, f), "utf8")).map(([l, s]) => `${f}:${l} ${s}`));
  assert.deepStrictEqual(found, [], `a failure there exits 0:\n  ${found.join("\n  ")}`);
  process.stdout.write(`  ${callers.length} page-host callers scanned\n`);
});

await t("THE CONTROL: a planted caller with `finally { done() }` is caught; an unpack cleanup `u.done()` and `done(1)` are not", () => {
  const planted = `const { done } = await openPageHost("x");\ntry { run(); } finally { await done(); }\n`;
  assert.deepStrictEqual(bareDoneInFinally(planted), [[2, "done()"]]);
  assert.deepStrictEqual(bareDoneInFinally(planted.replace("done()", "host.done()")), [[2, "host.done()"]]);
  const fine = `const h = await openPageHost("x");\ntry { run(); done(0); } catch { done(1); } finally { u.done(); cleanup(); }\n`;
  assert.deepStrictEqual(bareDoneInFinally(fine), [], "a cleanup's own done() was taken for page-host's");
  assert.deepStrictEqual(bareDoneInFinally(`try {} finally { done(); }`), [], "a file that never opens a page host was scanned");
  assert.deepStrictEqual(bareDoneInFinally(`await openPageHost("x");\n// never finally { done() }\n`), [], "a comment quoting the shape was taken for code");
});
