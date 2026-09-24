// Publishing: the phases, what the button says, and the three ways it ends.
//
// No node and no browser. The point of keeping the decisions out of the DOM
// is that they can be checked like this, on any machine, every run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
import { appIdOf, buttonFor, rowStateFor, publish, waitFor, PHASES, RESERVED_PORTS } from "../publish.js";
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

// ---- waitFor: three distinct ends, never one timeout ----

const fakeSession = over => ({
  provisioned: () => false, refused: () => "", exhausted: () => false, ...over,
});

await t("waitFor returns when the node says it is provisioned", async () => {
  let asked = 0;
  const s = fakeSession({ provisioned: () => ++asked > 2 });
  assert.equal(await waitFor(s, { everyMs: 1 }), "provisioned");
});

await t("a REFUSAL ends it with the node's own words, not a timeout", async () => {
  const s = fakeSession({ refused: () => "delegate code rejected" });
  await assert.rejects(() => waitFor(s, { everyMs: 1 }), e => {
    assert.match(e.message, /delegate code rejected/);
    return true;
  });
});

await t("EXHAUSTED ends it as its own fact, not as a refusal or a timeout", async () => {
  const s = fakeSession({ exhausted: () => true });
  await assert.rejects(() => waitFor(s, { everyMs: 1 }), e => {
    assert.match(e.message, /accepted everything and still cannot write/);
    return true;
  });
});

await t("a node that never answers ends on the BUDGET and says what to check", async () => {
  let clock = 0;
  const s = fakeSession({});
  await assert.rejects(
    () => waitFor(s, { everyMs: 1, budgetMs: 10, now: () => (clock += 8) }),
    e => {
      assert.match(e.message, /still running/);
      return true;
    });
});

await t("THE CONTROL: the budget does not fire on a node that answers", async () => {
  let clock = 0;
  const s = fakeSession({ provisioned: () => true });
  assert.equal(
    await waitFor(s, { everyMs: 1, budgetMs: 10, now: () => (clock += 8) }),
    "provisioned",
    "the budget fired on a healthy node, so the test above proves nothing about timing");
});

// ---- publish: the phases happen in order ----

await t("publish reports each phase, in order, and hands back the engine db", async () => {
  const seen = [];
  const session = { provisioned: () => true, refused: () => "", exhausted: () => false };
  const { db } = await publish({}, { appId: "proj1", ids, onSaving: () => {},
    port: 17509,
    open: async () => ({ ...session, db: { marker: "engine" } }),
  }, p => seen.push(p));
  assert.deepEqual(seen, ["connecting", "provisioning", "opening"]);
  assert.equal(db.marker, "engine", "publish did not switch the backend");
});

await t("a node that is not there fails with advice, not a stack trace", async () => {
  const seen = [];
  await assert.rejects(() => publish({}, { appId: "proj1", ids, onSaving: () => {},
    port: 17509,
    open: async () => { throw new Error("ECONNREFUSED"); },
  }, (p, e) => seen.push([p, e])));
  const failed = seen.find(([p]) => p === "failed");
  assert.ok(failed, "no failed phase was reported");
  assert.match(failed[1], /node running locally|running locally|needs one running/,
    "the failure does not say what to do about it");
});

await t("a node that was NEVER there fails in a second, not after the budget", async () => {
  // A socket that cannot connect retries for ever, which is right for a
  // connection that dropped and wrong for one that was never there. Without
  // this a person watches "Setting the node up…" for a minute and then
  // learns the node was not running.
  let clock = 0;
  const s = fakeSession({});
  await assert.rejects(
    () => waitFor(s, {
      everyMs: 1,
      budgetMs: 60_000,
      now: () => (clock += 10),
      neverConnected: () => true,
    }),
    e => {
      assert.match(e.message, /no node answering/);
      return true;
    });
  assert.ok(clock < 1_000, `it waited ${clock}ms for a fact available at once`);
});

await t("THE CONTROL: a node that DOES answer is never called unreachable", async () => {
  // Checked after `provisioned`, so a node that answered is not reported
  // unreachable because of an earlier retry on the way up.
  const s = fakeSession({ provisioned: () => true });
  assert.equal(
    await waitFor(s, { everyMs: 1, neverConnected: () => true }),
    "provisioned",
    "a provisioned node was reported unreachable because the socket had retried");
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
