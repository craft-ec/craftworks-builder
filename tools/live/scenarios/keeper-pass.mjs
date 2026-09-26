// KEEPER §11 (b): THE COST OF A FULL PASS. One real app's tree (the realnet demo's app: notes + a guestbook, its two
// rows) is published from a fresh node P, with the builder's wire captured; every Block-contract PUT of that publish
// (the SDK's one decoder, classify-frames) is a block of the tree. Then, on P alone, `live-held` asks `Held` for
// every one of them -- one per op, as the page asks today, and batched (MAX_HELD per op) -- `--repeats` times.
// Per block and in total. The run's load is recorded per sample (the runner's contamination rule applies).
//
// Needs `live-held` (craftworks-sdk probe, KEEPER §11): LIVE_HELD=<path> until the builder's pinned SDK carries it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "../runner.mjs";
import { publishRecording } from "../page.mjs";

// The realnet demo's app (tools/realnet-demo.mjs step 1): the app's notes and a guestbook of each user's own.
const APP = {
  name: "live keeper-pass",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" },
    { type: "form", domain: "guests", source: "mine" }, { type: "table", domain: "guests", source: "mine" }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] }, guests: { type: "Guest", fields: [{ name: "title", kind: "text", required: true }] } },
};

export async function run(ctx) {
  const { say } = ctx;
  const held = process.env.LIVE_HELD;
  if (!held || !existsSync(held)) throw new Error(`LIVE_HELD must name the live-held binary (craftworks-sdk probe); got ${held ?? "unset"}`);
  const pinned = readFileSync(join(ROOT, "SDK_REV"), "utf8").trim();
  const classify = join(ROOT, ".sdk-build", pinned, "target/release/classify-frames");
  if (!existsSync(classify)) throw new Error(`no classify-frames at ${classify}: build the pinned SDK's probe (tools/realnet.sh does)`);

  const P = await ctx.nodes.start("P");
  say(`NODE  P :${P.ws} ready in ${P.ready_ms} ms`);
  const { mkdirSync } = ctx.fs;
  mkdirSync(ctx.logsOf("P"), { recursive: true });
  const wire = join(ctx.logsOf("P"), "publish-wire.jsonl");
  // A publish that is not BACKED_UP FAILS this run, but its tree was published: the pass over it is still measured.
  const { notBacked } = await publishRecording(ctx, P, { app: APP, rows: ["alpha", "beta"], capture: wire });

  // The tree's blocks: every Block-contract PUT the publish sent, by the SDK's one decoder.
  const c = spawnSync(classify, ["--block-code", join(ROOT, "sdk/block.wasm")], { input: readFileSync(wire), encoding: "utf8", maxBuffer: 1 << 28 });
  if (c.status !== 0 && !c.stdout) throw new Error(`classify-frames: ${c.stderr.slice(0, 300)}`);
  const puts = c.stdout.split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.op === "put");
  const blocks = [...new Set(puts.filter(r => r.code === "block").map(r => r.contract))];
  const others = new Set(puts.filter(r => r.code !== "block").map(r => r.contract)).size;
  if (!blocks.length) throw new Error("the publish PUT no Block contract: nothing to pass over");
  const list = join(ctx.logsOf("P"), "tree-contracts.txt");
  writeFileSync(list, `${blocks.join("\n")}\n`);
  say(`TREE  ${blocks.length} Block contracts in the publish (${others} other contract(s): pieces and the app's container, not the tree)`);

  const ws = `ws://127.0.0.1:${P.ws}/v1/contract/command?encodingProtocol=native`;
  const arm = await ctx.arm("pass", ctx.args.repeats, async i => {
    const r = spawnSync(held, [ws, "-", join(ROOT, "sdk/signer.wasm"), join(ROOT, "sdk/block.wasm"), "--contracts", list], { encoding: "utf8", timeout: 20 * 60_000 });
    const line = r.stdout.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(x => x?.pass);
    if (!line) throw new Error(`live-held gave no pass line (exit ${r.status}): ${(r.stderr || r.stdout).slice(-300)}`);
    const p = line.pass;
    const s = { i, blocks: p.blocks, present: p.present, one_per_op_ms: p.one_per_op.total_ms, per_block_us: p.one_per_op.per_block_us, batched_ops: p.batched.ops, batched_ms: p.batched.total_ms };
    say(`PASS  #${i}: ${p.blocks} blocks, ${p.present} present; one per op: ${p.blocks} ops in ${p.one_per_op.total_ms} ms (per block median ${p.one_per_op.per_block_us.median} µs, min ${p.one_per_op.per_block_us.min}, max ${p.one_per_op.per_block_us.max}); batched: ${p.batched.ops} op(s) in ${p.batched.total_ms} ms`);
    return s;
  });
  const clean = arm.samples.filter(s => !s.contaminated);
  say(`ARM   one per op, total ms: ${JSON.stringify(ctx.summarize(clean.map(s => s.one_per_op_ms)))}; batched, total ms: ${JSON.stringify(ctx.summarize(clean.map(s => s.batched_ms)))}${arm.verdict ? `; ${arm.verdict}` : ""}`);
  const missing = arm.all.some(s => s.present !== s.blocks);
  if (missing) say("FAIL  a block P published was not present on P");
  return { failed: missing || arm.contaminated || !!notBacked };
}
