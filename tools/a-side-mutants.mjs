// THE A-SIDE CHECK'S RED-PROOF, offline (core dev: the mutants deliberately
// fail, so they never run in a batch's realnet): the SAME capture
// (wire-capture.mjs, every target of the browser) and the SAME decoder
// (`probe classify-frames`) must SEE a view's user-data write — and see none
// when the view only reads.
//
//   RN_CLASSIFY=<classify-frames> RN_FRAME_PUT=<frame-put> node tools/a-side-mutants.mjs
//
// Its own isolated private node (openPageHost({ node }): free ports, its own
// dirs, killed by recorded PID) — never B, never A, no lock. The builder
// publishes two apps there; a FRESH browser opens them by address, as A does:
//   read      the app without the user's own data, opened and read: 0 writes (the CONTROL)
//   write     a user's guestbook entry typed on the opened app: > 0 (MUTANT view-write)
//   register  a Register PUT (frame-put: the SDK's own encoder) sent from the app's frame: > 0 (MUTANT view-register-put)
import { openPageHost, openFreshBrowser, tcpFree, udpFree } from "../tests/page-host.mjs";
import { captureWire } from "./wire-capture.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(async () => ok((await udpFree(p)) && (await tcpFree(p)) ? p : freePort())); });
});
const until = async (tab, expr, ms, frame) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await (frame ? tab.evaluateIn(frame, expr) : tab.evaluate(expr)).catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  return null;
};
const WS = await freePort(), NET = await freePort();
const host = await openPageHost("a-side-mutants", { node: { ws: WS, net: NET }, budgetMs: Number(process.env.BUDGET_MS ?? 600_000) });
const out = mkdtempSync(join(tmpdir(), "a-side-mutants-"));
const wire = join(out, "wire.jsonl");
let window_ = "setup";
let failed = 0;
const line = (ok, what, evidence) => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${what}${evidence === undefined ? "" : `  — ${JSON.stringify(evidence)}`}`); };
const comp = (label, domain) => `[...document.querySelectorAll(".rt-comp")].find(s => (s.querySelector("h4")?.textContent ?? "").startsWith(${JSON.stringify(`${label} · ${domain}`)}))`;
const schemas = { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] }, guests: { type: "Guest", fields: [{ name: "title", kind: "text", required: true }] } };

// Each app from its OWN builder profile: an app's site address is one per (identity, app id), and one profile is
// one project — a second publish from the same profile would update the first app in place.
async function publish(app, browser) {
  const tab = await browser.tab(`builder ${app.name}`);
  await tab.navigate(`http://127.0.0.1:${host.port}/#node=${WS}&preview=1&app=` + encodeURIComponent(JSON.stringify(app)));
  await until(tab, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 60_000);
  await tab.evaluate(`const f = ${comp("Form", "notes")}; const i = f.querySelector("input[name=title]"); i.value = "alpha"; i.dispatchEvent(new Event("input", { bubbles: true })); f.querySelector("button.pri").click(); return 1;`);
  await sleep(1500);
  await tab.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(tab, `return window.__craftworksPublished ?? null;`, 240_000);
  if (!pub?.address) throw new Error(`${app.name} did not publish`);
  return pub.address;
}

try {
  const builder2 = await openFreshBrowser("a-side-mutants: a second builder profile");
  const readOnly = await publish({ name: "Read only", components: [{ type: "table", domain: "notes", mode: "owned" }, { type: "form", domain: "notes", mode: "owned" }], schemas: { notes: schemas.notes } }, host);
  const withMine = await publish({ name: "With mine", components: [{ type: "table", domain: "notes", mode: "owned" }, { type: "form", domain: "notes", mode: "owned" }, { type: "form", domain: "guests", source: "mine" }, { type: "table", domain: "guests", source: "mine" }], schemas }, builder2);
  if (withMine === readOnly) throw new Error(`the two apps share one address (${readOnly}): the check would read one app twice`);
  const fresh = await openFreshBrowser("a-side-mutants: a view");
  const cap = await captureWire(fresh.debug, { out: wire, windowOf: () => window_, label: "view" });
  const view = await fresh.tab("view");
  const frameOf = addr => `127.0.0.1:${WS}/v1/contract/web/${addr}/?__sandbox=1`;
  const open = async addr => {
    await view.navigate(`http://127.0.0.1:${WS}/v1/contract/web/${addr}/`);
    return until(view, `return [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr td:first-child") ?? [])].some(td => td.textContent === "alpha") || null;`, 180_000, frameOf(addr));
  };
  // THE CONTROL: open and read — nothing but reads.
  window_ = "read";
  line(!!(await open(readOnly)), "the read-only app opens by address and shows its row");
  await sleep(5000);
  // The second app: opening it is its own window (a key-holding node may commit here, sdk#350; not measured).
  window_ = "open-mine";
  line(!!(await open(withMine)), "the app with the user's own guestbook opens by address");
  const guestForm = await until(view, `return (${comp("Form", "guests")}?.querySelector("input[name=title]") && 1) || null;`, 180_000, frameOf(withMine));
  line(!!guestForm, "its guestbook (the user's own data) is writable", guestForm ? undefined : await view.evaluateIn(frameOf(withMine), `return { status: document.getElementById("status")?.textContent, headings: [...document.querySelectorAll(".rt-comp h4")].map(h => h.textContent) };`).catch(e => e.message));
  if (!guestForm) throw new Error("no guestbook to write: the view-write mutant cannot run");
  await sleep(10_000);
  // MUTANT view-write: a user's entry, typed on the opened app.
  window_ = "write";
  await view.evaluateIn(frameOf(withMine), `const f = ${comp("Form", "guests")}; const i = f.querySelector("input[name=title]"); i.value = "mutant"; i.dispatchEvent(new Event("input", { bubbles: true })); f.querySelector("button.pri").click(); return 1;`);
  await sleep(15_000);
  // MUTANT view-register-put: the SDK's own Register PUT, sent from the app's frame on a socket of its own.
  window_ = "register";
  const framed = spawnSync(process.env.RN_FRAME_PUT, [join(process.cwd(), "sdk/register.wasm"), "01", "02"], { encoding: "utf8" });
  if (framed.status !== 0) throw new Error(`frame-put: ${framed.stderr}`);
  const b64 = framed.stdout.trim().split("\n");
  await view.evaluateIn(frameOf(withMine), `const ws = new WebSocket("ws://127.0.0.1:${WS}/v1/contract/command?encodingProtocol=native"); ws.binaryType = "arraybuffer"; await new Promise(ok => ws.onopen = ok); for (const f of ${JSON.stringify(b64)}) ws.send(Uint8Array.from(atob(f), c => c.charCodeAt(0))); await new Promise(ok => setTimeout(ok, 1000)); ws.close(); return 1;`);
  await sleep(3000);
  window_ = "done";
  cap.stop();
  const r = spawnSync(process.env.RN_CLASSIFY, ["--block-code", join(process.cwd(), "sdk/block.wasm"), "--pieces", join(process.cwd(), "sdk/pieces.json"), "--webapp-code", join(process.cwd(), "sdk/webapp.wasm")], { input: readFileSync(wire, "utf8"), encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`classify-frames: ${r.stderr}`);
  const rows = r.stdout.split("\n").filter(Boolean).map(l => JSON.parse(l));
  const writes = w => rows.filter(x => x.window === w && x.verdict === "fail");
  const stats = cap.stats();
  line(stats.unresumed.length === 0, `every target the capture paused was resumed`, stats.unresumed.length ? stats.unresumed : undefined);
  line(stats.unpaused.length === 0, `no frame or worker started unpaused (${stats.targets} target(s), ${stats.sockets} socket(s))`, stats.unpaused.length ? stats.unpaused : undefined);
  line(rows.some(x => x.window === "read") && writes("read").length === 0, `THE CONTROL — read: ${writes("read").length} user-data writes over ${rows.filter(x => x.window === "read").length} request(s)`, writes("read").slice(0, 4));
  line(writes("write").length > 0, `MUTANT view-write — write: ${writes("write").length} user-data write(s) SEEN`, writes("write").slice(0, 4).map(x => `${x.op}${x.signer ? ":" + x.signer : ""}${x.code ? ":" + x.code : ""}`));
  line(writes("register").length > 0, `MUTANT view-register-put — register: ${writes("register").length} user-data write(s) SEEN`, writes("register").slice(0, 4).map(x => `${x.op}:${x.code}`));
  console.log(`NOTE  open-mine: ${writes("open-mine").length} user-data write(s) on opening the app with the user's own data (sdk#350; not a verdict here)`);
  await fresh.stop();
  await builder2.stop();
} catch (e) {
  console.log(`FAIL  ${e.message}`);
  failed += 1;
}
console.log(failed ? `A-SIDE MUTANTS: breaks — ${failed}` : "A-SIDE MUTANTS: passes — the check sees a view's write, and none when it only reads");
await host.done(failed ? 1 : 0);
