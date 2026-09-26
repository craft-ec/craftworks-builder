// THE CONTROL FOR "EVERY PUBLISH ASSERTS BACKED_UP" (stock-take proposal 4): the same publish, through a proxy that
// WITHHOLDS the node's answers to parity-block PUTs (craftworks-sdk probe `ws-withhold`). The data is answered, so the
// publish reaches Published; the parity never is, so it can never reach BACKED_UP -- and page.mjs's publish must
// throw NotBackedUp. This scenario PASSES only when it does, after a real Published, with parity answers actually
// withheld. If the rows read "saved + backed up" anyway, the assertion is blind and this FAILS.
//
// Needs `ws-withhold`: LIVE_WITHHOLD=<path> until the builder's pinned SDK carries it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { NotBackedUp, publish } from "../page.mjs";
import { freePort } from "../runner.mjs";

const APP = {
  name: "live withheld-parity",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } },
};

export async function run(ctx) {
  const { say } = ctx;
  const bin = process.env.LIVE_WITHHOLD;
  if (!bin || !existsSync(bin)) throw new Error(`LIVE_WITHHOLD must name the ws-withhold binary (craftworks-sdk probe); got ${bin ?? "unset"}`);
  const P = await ctx.nodes.start("P");
  const port = freePort("tcp");
  const proxy = spawn(bin, [String(port), String(P.ws)], { stdio: ["ignore", "ignore", "pipe"] });
  ctx.onEnd(() => { try { process.kill(proxy.pid, "SIGKILL"); } catch {} });
  let withheld = 0, parityPuts = 0, log = "";
  proxy.stderr.on("data", d => {
    log += d;
    for (const l of String(d).split("\n").filter(Boolean)) {
      try { const j = JSON.parse(l); if (j.withheld_total) { withheld = j.withheld_total; parityPuts = j.parity_puts_seen; } } catch {}
    }
  });
  for (let i = 0; i < 40 && !log.includes("listening"); i++) await new Promise(r => setTimeout(r, 250));
  if (!log.includes("listening")) throw new Error(`ws-withhold did not start: ${log.slice(-200)}`);
  say(`PROXY :${port} -> P :${P.ws}, withholding the answers to parity-block PUTs`);
  try {
    const pub = await publish(ctx, { ...P, ws: port }, { app: APP, rows: ["alpha", "beta"], label: "withheld-parity publisher" });
    say(`FAIL  the rows read "saved + backed up" (${pub.backed_up_ms} ms) with ${withheld} parity answer(s) withheld: the BACKED_UP assertion is BLIND`);
    return { failed: true };
  } catch (e) {
    if (!(e instanceof NotBackedUp)) { say(`FAIL  the publish did not reach Published, so this says nothing about BACKED_UP: ${e.message}`); return { failed: true }; }
    if (!withheld) { say(`FAIL  NotBackedUp, but the proxy withheld NO parity answer (parity PUTs seen ${parityPuts}): the failure is not the one planted`); return { failed: true }; }
    say(`PASS  the assertion caught it: published ${e.address} in ${e.published_ms} ms, then NOT backed up (rows read ${JSON.stringify(e.states)}); ${withheld} parity answer(s) withheld of ${parityPuts} parity PUT(s) seen`);
    return { failed: false };
  }
}
