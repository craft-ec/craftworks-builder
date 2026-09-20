// The versions panel's whole behaviour, as data.
//
// These tests pin the COMPARISONS. The other half — that every value really
// comes from an artefact — is pinned by tests/versions-provenance.test.mjs,
// which reads the real build-info.json: a constant typed into versions.js
// would pass everything here and fail there.
import assert from "node:assert";
import { model, diagnostics, sameRev, releaseLabel, verification } from "../versions.js";

const baked = {
  builder: { version: "0.1.0", rev: "cbb46c7", built: "2026-09-20T00:00:00+00:00", profile: "dev" },
  sdkRev: "99e9f22",
  contracts: {
    rev: "ef2c610",
    code: {
      block: "sha256:1611ba5f9096b67a0000000000000000000000000000000000000000000000ff",
      register: "sha256:e273be8c6f35a7390000000000000000000000000000000000000000000000ff",
    },
  },
  released: [],
};
const sdk = { version: "0.1.0", rev: "99e9f22", prollyRev: "afcada3", formatTag: "PT01" };

const rowsOf = (m, title) => m.sections.find(s => s.title === title).rows;
const row = (m, title, label) => rowsOf(m, title).find(r => r.label === label);

// ---- the comparison this panel exists for ----------------------------------
{
  const v = model({ baked, sdk }).verification;
  assert.strictEqual(v.state, "ok", `a matching build verifies: ${v.text}`);
}
{
  // The failure the issue was written for: sdk/ holds a build from elsewhere.
  const v = model({ baked, sdk: { ...sdk, rev: "deadbee" } }).verification;
  assert.strictEqual(v.state, "mismatch");
  assert.match(v.text, /deadbee/);
  assert.match(v.text, /99e9f22/, "the warning names BOTH revisions, or it cannot be acted on");
}
{
  // Three states, not two. A check that has not run is not a check that passed.
  const v = model({ baked, sdk: null }).verification;
  assert.strictEqual(v.state, "unverified");
  assert.match(v.text, /not loaded/);
}
{
  // An SDK that cannot name itself must not read as a match.
  const v = model({ baked, sdk: { ...sdk, rev: "unknown" } }).verification;
  assert.strictEqual(v.state, "mismatch");
}

// ---- dirty: neutral in a dev tree, an alarm in a release build --------------
{
  const dev = verification({ sdkRev: "99e9f22", sdk: { ...sdk, rev: "99e9f22-dirty" }, profile: "dev" });
  assert.strictEqual(dev.state, "info", "a dev tree is always dirty; a standing alarm trains people to ignore the panel");
  const rel = verification({ sdkRev: "99e9f22", sdk: { ...sdk, rev: "99e9f22-dirty" }, profile: "release" });
  assert.strictEqual(rel.state, "warn");
  // But a MISMATCH is an alarm in both profiles.
  for (const profile of ["dev", "release"]) {
    assert.strictEqual(verification({ sdkRev: "99e9f22", sdk: { ...sdk, rev: "deadbee" }, profile }).state, "mismatch");
  }
}

// ---- revision comparison ----------------------------------------------------
assert.ok(sameRev("99e9f22", "99e9f2248d0a1b2c"), "a short rev matches its long form");
assert.ok(sameRev("99e9f22-dirty", "99e9f22"), "dirtiness is judged separately, not by the comparison");
assert.ok(!sameRev("99e9f22", "99e9f23"));
assert.ok(!sameRev("9", "9"), "a one-character agreement is not evidence");
assert.ok(!sameRev("99e9f22", null));

// ---- per-hash release labels, parsed, never hardcoded -----------------------
{
  const m = model({ baked, sdk });
  assert.strictEqual(row(m, "contracts", "block").note, "current build, not released");
  const released = [{ number: 1, code: { block: baked.contracts.code.block } }];
  const m2 = model({ baked: { ...baked, released }, sdk });
  assert.strictEqual(row(m2, "contracts", "block").note, "released as epoch 1",
    "the label follows the file, so it stops lying the day an epoch lands");
  // ...and only for the hash that is actually in it.
  assert.strictEqual(row(m2, "contracts", "register").note, "current build, not released");
}
{
  // A DIFFERENT hash under the same name is not released.
  const released = [{ number: 1, code: { block: "sha256:" + "a".repeat(64) } }];
  assert.strictEqual(releaseLabel(baked.contracts.code.block, released).text, "current build, not released");
}

// ---- honest absence, never a plausible default ------------------------------
{
  const m = model({ baked: { ...baked, contracts: { reason: "hashes.toml was not found" } }, sdk });
  const r = row(m, "contracts", "hashes");
  assert.strictEqual(r.state, "unknown");
  assert.strictEqual(r.value, "—");
  assert.match(r.note, /not found/);
}
{
  const m = model({ baked: null, sdk: null });
  assert.strictEqual(row(m, "builder", "commit").state, "unknown");
  assert.match(row(m, "builder", "commit").note, /build\.sh/, "it says what to DO about the absence");
  assert.ok(!JSON.stringify(m).includes("0.0.0"), "nothing invents a version");
}

// ---- diagnostics -------------------------------------------------------------
{
  const text = diagnostics({ baked, sdk: null });
  assert.match(text, /SDK verification: UNVERIFIED/,
    "a report taken before the SDK loads must SAY so, not read as a clean bill of health");
}
{
  const text = diagnostics({ baked, sdk });
  assert.match(text, /SDK verification: OK/);
  // The full hash, not the eight characters on screen: a diagnostics block that
  // shortened them could not be compared against released.toml by hand.
  assert.ok(text.includes("1611ba5f9096b67a0000000000000000000000000000000000000000000000ff"),
    "diagnostics carry the FULL hash");
}
{
  const text = diagnostics({ baked, sdk: { ...sdk, rev: "deadbee" } });
  assert.match(text, /SDK verification: MISMATCH/);
}

console.log("ok versions panel: comparisons, three states, per-hash labels, honest absence");
