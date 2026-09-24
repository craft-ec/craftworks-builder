// A stand-in SCENARIO for the live runner's tests: one stub node, one arm of LIVE_STUB_N samples, each taking
// LIVE_STUB_MS, then `{ failed: LIVE_STUB_FAIL === "1" }`. It prints NODE-DIR so a test can find the node's dir.
export async function run(ctx) {
  const node = await ctx.nodes.start("S1", { readyMs: 10_000 });
  ctx.say(`NODE-DIR ${node.dir} PID ${node.pid}`);
  const n = Number(process.env.LIVE_STUB_N ?? 3), ms = Number(process.env.LIVE_STUB_MS ?? 10);
  const r = await ctx.arm("stub", n, async i => { await new Promise(res => setTimeout(res, ms)); return { value: 100 + i }; });
  ctx.say(`ARM   stub ${JSON.stringify(ctx.summarize(r.samples.map(s => s.value)))}`);
  return { failed: process.env.LIVE_STUB_FAIL === "1" };
}
