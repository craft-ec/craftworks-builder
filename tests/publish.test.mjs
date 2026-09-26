// Publishing: the phases, what the button says, and what a failure says.
//
// No node and no browser. The point of keeping the decisions out of the DOM
// is that they can be checked like this, on any machine, every run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
import { appIdOf, buttonFor, rowStateFor, publish, PHASES, RESERVED_PORTS } from "../publish.js";
import { UNPUBLISHED } from "../publish-state.js";

// The REAL SDK's id rules (sdk.ids): appIdOf checks by them, never by a copy.
const { ids } = await loadSdk(readFileSync(fileURLToPath(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url))));

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`ok ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`FAIL ${name}\n  ${e.message}\n`); }
};

await t("every phase has a button, and no two working phases share a label", () => {
  const labels = PHASES.map(p => buttonFor(p).label);
  assert.equal(new Set(labels).size, labels.length,
    "two phases show the same label, so a person cannot tell them apart: " + labels.join(" / "));
  for (const p of PHASES) {
    const b = buttonFor(p, { error: "why" });
    assert.ok(b.label, `${p} has no label`);
    assert.ok(b.hint, `${p} has no hint saying what it MEANS`);
  }
});

await t("only idle and failed can be pressed", () => {
  assert.equal(buttonFor("idle").enabled, true);
  assert.equal(buttonFor("failed").enabled, true, "a failure a retry can fix must be retryable");
  for (const p of ["connecting", "provisioning", "opening", "published"]) {
    assert.equal(buttonFor(p).enabled, false, `${p} is pressable`);
  }
});

await t("**a published app whose STRUCTURE changed can publish its changes (builder#117): pressable, then working, then Published again**", () => {
  const changed = buttonFor("published", { changed: true });
  assert.equal(changed.enabled, true, "a changed published app cannot publish its changes");
  assert.equal(changed.label, "Publish changes");
  assert.match(changed.hint, /link stays the same/, "the hint does not say the link is kept");
  const going = buttonFor("published", { changed: true, republishing: true });
  assert.equal(going.enabled, false, "publishing changes can be pressed twice");
  assert.equal(going.label, "Publishing changes…");
  // THE CONTROL: unchanged, it is Published and not pressable.
  assert.deepEqual([buttonFor("published").label, buttonFor("published").enabled], ["Published", false]);
});

await t("an unpublished project's rows say so; a published one's do not", () => {
  for (const p of ["idle", "connecting", "provisioning", "opening", "failed"]) {
    assert.equal(rowStateFor(p), UNPUBLISHED,
      `${p} rows claim to be saved while the data is in this tab only`);
  }
  assert.equal(rowStateFor("published"), null, "a published row must carry its OWN write state");
});

// ---- ONE WAIT, THE SDK'S (builder#173) ----
//
// `open()` returns once the node says it is provisioned, and ends only on an
// answer; its ends (refused, never there, no time end, cancel) are the SDK's
// and are tested there (craftworks-sdk tests/js/open-provisioned.test.mjs).
// What is the builder's: the phases it derives, and what it says on a failure.

/** An `open()` that fires `events` (socket events) and then resolves, or rejects with `fail`. */
const fakeOpen = ({ events = ["open"], fail = null } = {}) => async ({ onEvent }) => {
  for (const kind of events) onEvent({ kind });
  if (fail) throw new Error(fail);
  return { db: { marker: "engine" } };
};
const P = { appId: "proj1", ids, onSaving: () => {}, port: 17509 };

await t("publish reports each phase, in order, and hands back the engine db", async () => {
  const seen = [];
  const { db } = await publish({}, { ...P, open: fakeOpen() }, p => seen.push(p));
  assert.deepEqual(seen, ["connecting", "provisioning", "opening"]);
  assert.equal(db.marker, "engine", "publish did not switch the backend");
});

await t("\"provisioning\" is DERIVED from the socket: said once, at its FIRST open, never on a re-open", async () => {
  const seen = [];
  await publish({}, { ...P, open: fakeOpen({ events: ["error", "closed", "open", "closed", "open"] }) }, p => seen.push(p));
  assert.deepEqual(seen, ["connecting", "provisioning", "opening"]);
});

await t("a node that is not there fails with advice, not a stack trace", async () => {
  const seen = [];
  await assert.rejects(() => publish({}, { ...P, open: fakeOpen({ events: ["error", "closed"], fail: "ECONNREFUSED" }) }, (p, e) => seen.push([p, e])));
  const failed = seen.find(([p]) => p === "failed");
  assert.ok(failed, "no failed phase was reported");
  assert.match(failed[1], /needs one running locally/, "the failure does not say what to do about it");
});

await t("**a failure AFTER the socket opened is said in the SDK's own words** (the node's refusal), not as \"could not reach\"", async () => {
  const seen = [];
  await assert.rejects(() => publish({}, { ...P, open: fakeOpen({ fail: "the node refused to set up: no room" }) }, (p, e) => seen.push([p, e])),
    /refused to set up: no room/);
  assert.deepEqual(seen.at(-1), ["failed", "the node refused to set up: no room"]);
});

await t("**ONE HOME: publish.js keeps no wait of its own** -- no budget, no clock, no timer, no refusal count, no `exhausted`; control: each planted copy is caught", async () => {
  const code = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const copies = src => [/budgetMs/, /Date\.now|now\(\)/, /setTimeout|setInterval/, /refusals\s*\+=/, /exhausted/, /\bwaitFor\b/]
    .filter(re => re.test(code(src))).map(String);
  const src = readFileSync(new URL("../publish.js", import.meta.url), "utf8");
  assert.deepEqual(copies(src), [], "publish.js waits (or counts refusals) a second time beside the SDK");
  for (const planted of ["const budgetMs = 60_000;", "if (Date.now() > t) throw 0;", "await new Promise(r => setTimeout(r, 250));",
    "refusals += 1;", "session.exhausted?.();", "await waitFor(handle);"]) {
    assert.equal(copies(src + "\n" + planted).length, 1, `THE CONTROL: the planted \`${planted}\` was not caught`);
  }
  assert.equal(copies(src + "\n// budgetMs setTimeout Date.now()").length, 0, "a COMMENT naming them is not a copy");
});


await t("**the OWNER'S node ports are REFUSED**, not published to", async () => {
  // Publishing installs a delegate and hands over a signing key. A default
  // that eventually points at somebody else's node is how a development
  // build writes to a real one. This is not hypothetical: a screenshot run
  // meant to capture "there is no node" connected to 7509, which is the
  // owner's, and began provisioning it.
  for (const port of RESERVED_PORTS) {
    let opened = false;
    await assert.rejects(() => publish({}, { appId: "proj1", ids, onSaving: () => {},
      port,
      open: async () => { opened = true; return {}; },
    }), e => {
      assert.match(e.message, /somebody else|node of this project/);
      return true;
    });
    assert.equal(opened, false, `port ${port}: it opened a connection before refusing`);
  }
});

await t("no port at all is refused too — there is no safe default", async () => {
  let opened = false;
  await assert.rejects(() => publish({}, { appId: "proj1", ids, onSaving: () => {}, open: async () => { opened = true; return {}; } }),
    e => { assert.match(e.message, /no safe default|no node port/); return true; });
  assert.equal(opened, false);
});

await t("THE CONTROL: an ordinary port is NOT refused", async () => {
  // Without this, a `publish` that refused every port would pass the two
  // tests above and nothing could ever be published.
  const session = { provisioned: () => true, refused: () => "", exhausted: () => false };
  const { db } = await publish({}, { appId: "proj1", ids, onSaving: () => {},
    port: 17509,
    open: async () => ({ ...session, db: { marker: "engine" } }),
  });
  assert.equal(db.marker, "engine");
});


await t("**no app id is refused BEFORE anything opens** — the SDK would refuse it as a failed connection (craftworks-sdk#267)", async () => {
  for (const appId of [undefined, "", "Not Valid", "x".repeat(33)]) {
    let opened = false;
    const phases = [];
    await assert.rejects(() => publish({}, { appId, onSaving: () => {}, ids, port: 18080, open: async () => { opened = true; return {}; } }, (p, why) => phases.push([p, why])),
      /no app id/, `app id ${JSON.stringify(appId)} was accepted`);
    assert.ok(!opened, `a session was opened for app id ${JSON.stringify(appId)}`);
    assert.strictEqual(phases.at(-1)?.[0], "failed", "the refusal did not reach the publish button");
  }
});

await t("THE CONTROL: a valid app id reaches open() as `app`", async () => {
  let given;
  await publish({}, { appId: "proj1", onSaving: () => {}, ids, port: 18080,
    open: async o => { given = o.app; throw new Error("stop here"); } }).catch(() => {});
  assert.strictEqual(given, "proj1", "open() was not told which app this is");
});

await t("**one project, one app**: its id comes from the project's own id, the same every time; a 64-hex id is its own 128-bit prefix; anything else that does not fit is REFUSED, never bent", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  assert.strictEqual(appIdOf(hex, ids), hex);
  assert.strictEqual(appIdOf(hex + hex, ids), hex, "a 64-hex project id was not taken at its first 32 (its own 128-bit prefix)");
  assert.strictEqual(appIdOf(hex, ids), appIdOf(hex, ids), "the same project gave two app ids");
  for (const bad of [undefined, null, "", "ABC", "has.dot", "has space"]) {
    assert.throws(() => appIdOf(bad, ids), /gives no app id: app id .* must be 1–32/, `${JSON.stringify(bad)} was bent into an id`);
  }
  assert.throws(() => appIdOf(hex), /SDK is not loaded/, "an unchecked id was accepted with no SDK to check it");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
