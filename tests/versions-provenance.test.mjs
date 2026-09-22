// Where each value in build-info.json CAME FROM.
//
// tests/versions.test.mjs pins the comparisons and says nothing about the
// operands: a constant typed into versions.js or into tools/build-info.py would
// pass every one of them. This reads the real generated file and checks each
// field against the artefact it is supposed to have been read from, looked up
// independently here — which is the whole rule the issue states ("every value
// comes from the artefact itself, never typed into the UI by hand").
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = p => fileURLToPath(new URL(p, import.meta.url));
const root = at("../");

if (!existsSync(at("../build-info.json"))) {
  console.log("skip versions provenance: build-info.json absent — run ./build.sh");
  process.exit(0);
}
const info = JSON.parse(readFileSync(at("../build-info.json"), "utf8"));

// ---- builder rev: git, read here --------------------------------------------
const head = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim().length > 0;
assert.strictEqual(info.builder.rev, dirty ? `${head}-dirty` : head,
  "the builder rev is this repo's HEAD, with -dirty when the tree is modified");

// ---- builder version: package.json ------------------------------------------
assert.strictEqual(info.builder.version, JSON.parse(readFileSync(at("../package.json"), "utf8")).version);

// ---- sdkRev: the SDK_REV file, not a copy of it ------------------------------
assert.strictEqual(info.sdkRev, readFileSync(at("../SDK_REV"), "utf8").trim());

// ---- contracts: COPIED from freenet-contracts, never recomputed --------------
// WHERE THE CONTRACTS ARE, or a LOUD failure. A path that silently falls back
// to a guess reads "no hashes.toml" off a directory that is not the contracts
// repo at all — a could-not-check that reports like a check (it did: a run
// without CRAFTWORKS_CONTRACTS failed on the honest-absence assertion, naming
// neither the variable nor the path it had guessed).
export function contractsRepoOf(env, exists, fallback) {
  if (env.CRAFTWORKS_CONTRACTS) return env.CRAFTWORKS_CONTRACTS;
  if (exists(fallback)) return fallback;
  throw new Error(
    `CRAFTWORKS_CONTRACTS is not set and ${fallback} does not exist: set it to the ` +
    "freenet-contracts checkout whose hashes build-info.json was made from");
}
// THE CONTROLS for the resolver itself, both ways, before it is used.
assert.throws(() => contractsRepoOf({}, () => false, "/nowhere/freenet-contracts"), /CRAFTWORKS_CONTRACTS is not set and \/nowhere\/freenet-contracts does not exist/);
assert.strictEqual(contractsRepoOf({}, () => true, "/here"), "/here");
assert.strictEqual(contractsRepoOf({ CRAFTWORKS_CONTRACTS: "/set" }, () => false, "/here"), "/set");
const contractsRepo = contractsRepoOf(process.env, existsSync, at("../../freenet-contracts"));
const hashesToml = `${contractsRepo}/build/hashes.toml`;
if (existsSync(hashesToml)) {
  const toml = readFileSync(hashesToml, "utf8");
  for (const [name, value] of Object.entries(info.contracts.code ?? {})) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, "m").exec(toml);
    assert.ok(m, `${name} must appear in ${hashesToml}`);
    assert.strictEqual(value, m[1], `${name} is copied from hashes.toml, not recomputed`);
  }
  // And the digest really is the wasm's — the point of copying rather than
  // re-hashing is that these agree; if they ever do not, the copy is stale.
  const { createHash } = await import("node:crypto");
  for (const [name, value] of Object.entries(info.contracts.code ?? {})) {
    const wasm = `${contractsRepo}/build/${name}.wasm`;
    if (!existsSync(wasm)) continue;
    const real = createHash("sha256").update(readFileSync(wasm)).digest("hex");
    assert.strictEqual(value.replace(/^sha256:/, ""), real,
      `${name}: hashes.toml disagrees with build/${name}.wasm — the table is stale`);
  }
  console.log(`ok contract hashes copied from ${hashesToml}`);
} else {
  // The honest-absence path is itself a requirement: it must carry a reason and
  // must NOT carry values.
  assert.ok(info.contracts.reason, "an absent hashes.toml must produce a reason");
  assert.ok(!info.contracts.code, "and no hashes at all");
  console.log("ok contracts absent, reported as absent with a reason");
}

// ---- released: parsed from released.toml, not assumed empty -------------------
const releasedToml = `${contractsRepo}/released.toml`;
if (existsSync(releasedToml)) {
  const declared = (readFileSync(releasedToml, "utf8").match(/^\s*\[\[epoch\]\]/gm) ?? []).length;
  assert.strictEqual(info.released.length, declared,
    "every [[epoch]] in released.toml is carried across, and no others are invented");
}

console.log(`ok versions provenance: builder ${info.builder.rev}, sdk pinned ${info.sdkRev}`);
