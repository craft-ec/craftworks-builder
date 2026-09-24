// Fixed header readers for the live runner's tests: no git, no sdk/, no machine reads. A test sets
// LIVE_UNREADABLE=<field> to make one of them throw, and LIVE_LOAD / LIVE_CORES for the machine.
const unreadable = process.env.LIVE_UNREADABLE ?? "";
const field = (name, v) => () => { if (name === unreadable) throw new Error(`${name}: unreadable in this test`); return v; };
export const readers = {
  builder: field("builder", "b".repeat(40)),
  builder_dirty: field("builder_dirty", 0),
  sdk_rev: field("sdk_rev", "5".repeat(40)),
  sdk_wasm_sha256: field("sdk_wasm_sha256", "a".repeat(64)),
  block_wasm_sha256: field("block_wasm_sha256", "c".repeat(64)),
  register_wasm_sha256: field("register_wasm_sha256", "d".repeat(64)),
  load_pieces: field("load_pieces", { core: "k=25+m=8" }),
  freenet: field("freenet", "0.2.136 (test)"),
  machine: field("machine", { cores: Number(process.env.LIVE_CORES ?? 14), load1: Number(process.env.LIVE_LOAD ?? 1), free_mem_mb: 1, free_disk_gb: 1 }),
  co_tenants: field("co_tenants", { realnet_lock: null, freenet_processes: 0, chrome_processes: 0 }),
};
