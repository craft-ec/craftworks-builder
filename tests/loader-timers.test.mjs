// THE LOADER'S PHASE STAMPS COST NO TIMER (builder#140, the core dev): every
// published app runs app-loader/loader.js, so a diagnostic in it must not poll.
// The REAL loader.js runs here, beside stub modules (the SDK, the runtime and
// the published tree), with every timer it makes counted:
//   - an app whose head NEVER comes (its read never answers): the only timer
//     alive is the status line's own "Reading… N s" counter (1 s, from before
//     the stamps) — nothing faster, nothing for the stamps;
//   - an app whose rows come: no timer is left, and every phase is stamped in
//     the order the loader runs them, head stamped as known by the rows.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownTmp } from "./page-host.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
const tick = () => new Promise(r => setImmediate(r));

// Every interval the page makes, and which are still live.
const live = new Map();
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(() => {}, 1 << 30); live.set(id, { kind: "interval", ms }); return id; };
globalThis.clearInterval = id => { live.delete(id); realClearInterval(id); };
const status = { textContent: "", className: "" };
globalThis.document = { getElementById: id => (id === "status" ? status : {}) };
globalThis.location = { href: "http://127.0.0.1:7509/v1/contract/web/app/", port: "7509" };

/** A copy of the REAL loader in its own directory, beside stubs; `rows` says whether the app's first read ever answers. */
function page(name, { rows, head }) {
  const dir = join(ownTmp(`loader-timers-${name}-`));
  mkdirSync(join(dir, "sdk"));
  copyFileSync(join(ROOT, "app-loader/loader.js"), join(dir, "loader.js"));
  writeFileSync(join(dir, "sdk/index.js"), `export const load = async () => ({ ids: { hex32: s => /^[0-9a-f]{64}$/.test(s), app: () => true } });\n`);
  writeFileSync(join(dir, "sdk/artefacts.js"), `export const artefactBytes = async () => new Uint8Array(0);
export const servedText = async ({ url }) => url.endsWith("app.json") ? JSON.stringify({ name: "T", components: [], publisher: { head: "a".repeat(64), app: "t" } }) : JSON.stringify({ contract: "c", sdk: { file: "s", sha256: "0" }, signer: {}, block: {}, register: {} });\n`);
  writeFileSync(join(dir, "runtime.js"), `export const sourceOf = () => "publisher";
export const mountApp = () => ${rows ? "Promise.resolve()" : "new Promise(() => {})"};\n`);
  writeFileSync(join(dir, "runtime-logic.js"), `export const openPublished = async () => ({ backends: {}, canWrite: () => ({ answer: "no" }), waitingFor: () => "", headId: () => ${JSON.stringify(head)} });\n`);
  return dir;
}

await t("**an app whose head NEVER comes holds no timer but the status line's own 1 s counter** — nothing polls for the stamps", async () => {
  live.clear();
  const dir = page("nohead", { rows: false, head: "" });
  try {
    // NOT awaited: the loader's top-level await never settles while its read waits.
    import(pathToFileURL(join(dir, "loader.js")).href);
    for (let i = 0; i < 50; i++) await tick();
    const timers = [...live.values()];
    assert.deepEqual(timers, [{ kind: "interval", ms: 1000 }], `timers alive while the head never comes: ${JSON.stringify(timers)}`);
    assert.equal(globalThis.__craftworksOpen.head, undefined, "a head was stamped that never came");
    assert.ok(Number.isInteger(globalThis.__craftworksOpen.opened), "THE SETUP: the loader did not reach its read");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await t("an app whose rows come leaves NO timer, and stamps every phase in order — head as known by the rows", async () => {
  live.clear();
  delete globalThis.__craftworksOpen;
  const dir = page("rows", { rows: true, head: "b".repeat(64) });
  try {
    await import(pathToFileURL(join(dir, "loader.js")).href);
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual([...live.values()], [], "a timer outlived the open");
    const p = globalThis.__craftworksOpen;
    const order = ["loader", "files", "sdk", "opened", "head", "rows"];
    assert.ok(order.every(k => Number.isInteger(p[k])), `a phase is missing: ${JSON.stringify(p)}`);
    assert.ok(order.every((k, i) => i === 0 || p[order[i - 1]] <= p[k]), `phases out of order: ${JSON.stringify(p)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
