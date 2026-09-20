// The write-state vocabulary: what a row says, and what it must never say.
import assert from "node:assert/strict";
import { STATES, ORDER, show, settled, durable, isLive, LIVE_NOTE, UNPUBLISHED } from "../publish-state.js";

// Every state a write can reach has a description. A state the SDK reports
// and this table has never heard of is the failure mode being guarded.
for (const s of ORDER) {
  assert.ok(STATES[s], `no description for ${s}`);
  assert.ok(STATES[s].hint.length > 20, `${s} has no explanation, only a label`);
}

// The distinction the whole panel exists for: "saving" is NOT safe to close.
assert.equal(durable("accepted"), false, "accepted was reported as durable — a user told that will close the tab");
assert.equal(durable("published"), true);
assert.equal(durable("parity-complete"), true);
assert.equal(durable("failed"), false);

// Three different facts, three different labels. A row that showed the same
// word for "saving" and "saved" would be the spinner this replaces.
const labels = ORDER.map(s => STATES[s].label);
assert.equal(new Set(labels).size, labels.length, `two states share a label: ${labels}`);

// And the two that are NOT terminal must not read as finished.
assert.equal(settled("accepted"), false);
assert.equal(settled("published"), false, "published is not the end — parity is still owed");
assert.equal(settled("parity-complete"), true);
assert.equal(settled("failed"), true);
assert.equal(settled("conflict"), true);

// An unknown state is shown AS ITSELF, never as a guess.
const unknown = show("some-future-state");
assert.equal(unknown.label, "some-future-state", "an unknown state was given a made-up label");
assert.equal(unknown.tone, "unknown");
assert.notEqual(unknown.label, STATES.accepted.label, "an unknown state was shown as 'saving', which claims a fact nobody checked");

// LIVE is off unless it was turned on. Absence is not liveness — an
// `undefined` read as truthy would make every existing project live on
// upgrade, with a standing subscription per component nobody asked for.
assert.equal(isLive(undefined), false);
assert.equal(isLive({}), false, "a component with no `live` key was treated as live");
assert.equal(isLive({ live: false }), false);
assert.equal(isLive({ live: "yes" }), false, "a truthy non-true value was treated as live");
assert.equal(isLive({ live: true }), true);

// The note says what it costs and what it is for, in words with no jargon —
// and is SHORT. "One line" is about what renders beside a checkbox, not about
// how it is written: the first version was sixty words, every one of them
// true, and it filled six lines of the properties panel. A screenshot showed
// that and no assertion could have, so the length is pinned here too.
assert.ok(/[Cc]osts/.test(LIVE_NOTE), "the live note does not say what it costs");
assert.ok(LIVE_NOTE.length <= 160, `the live note is ${LIVE_NOTE.length} chars; it renders as a paragraph, not a line`);
assert.ok(/chat|feed|counter/i.test(LIVE_NOTE), "the note does not say what kind of data this is for");
assert.ok(!/subscri|delta|engine|binding/i.test(LIVE_NOTE.replace("standing connection", "")),
  `the live note uses jargon: ${LIVE_NOTE}`);

// An UNPUBLISHED project's rows must not say "saved". The data is in one tab
// and nowhere else; a row claiming otherwise is claiming the exact thing
// Publish is for, and the person finds out by closing the tab.
assert.ok(STATES[UNPUBLISHED], "no description for the unpublished state");
assert.equal(durable(UNPUBLISHED), false, "an unpublished row was reported as durable");
assert.notEqual(STATES[UNPUBLISHED].label, STATES.published.label);
assert.match(STATES[UNPUBLISHED].hint, /clos/i, "the unpublished hint does not say what closing the tab costs");

console.log("ok publish-state");

// ---- the SDK's row state, as a person reads it ----
{
  const { rowState, FROM_ROW_STATE, STATES, show, UNPUBLISHED } =
    await import("../publish-state.js");
  const t = (name, fn) => { try { fn(); console.log("ok", name); } catch (e) { console.log("FAIL", name, "\n  " + e.message); process.exitCode = 1; } };

  t("before publishing, every row says so whatever the record claims", () => {
    for (const phase of ["idle", "connecting", "provisioning", "opening", "failed"]) {
      assert.strictEqual(rowState(phase, { state: "CLEAN" }), UNPUBLISHED,
        `${phase}: a row claimed to be saved while the data is in this tab only`);
    }
  });

  t("once published, a row shows ITS OWN write's state", () => {
    assert.strictEqual(rowState("published", { state: "CLEAN" }), "published");
    assert.strictEqual(rowState("published", { state: "PENDING" }), "accepted");
    assert.strictEqual(rowState("published", { state: "QUEUED" }), "busy");
    assert.strictEqual(rowState("published", { state: "ROLLED_BACK" }), "lost");
  });

  t("every mapped state is one this build can actually show", () => {
    for (const [code, state] of Object.entries(FROM_ROW_STATE)) {
      assert.ok(STATES[state], `${code} maps to ${state}, which has no wording`);
    }
  });

  t("the three in-flight states are DISTINGUISHABLE to a person", () => {
    // The whole point: "saving", "saved here but not on the network" and "on
    // the network" must not collapse into one spinner.
    const labels = ["CLEAN", "PENDING", "QUEUED"].map(c => show(rowState("published", { state: c })).label);
    assert.strictEqual(new Set(labels).size, 3, `these read the same: ${labels.join(" / ")}`);
  });

  t("UNKNOWN is NOT turned into 'saved'", () => {
    // It means this client has not loaded the key, so it cannot say. A row
    // that claimed "saved" would be asserting something nobody checked.
    const s = show(rowState("published", { state: "UNKNOWN" }));
    assert.notStrictEqual(s.label, STATES.published.label,
      "a row this client cannot see claimed to be on the network");
    assert.strictEqual(s.tone, "unknown");
  });

  t("a state the SDK grows later is shown as itself, not guessed", () => {
    const s = show(rowState("published", { state: "SOMETHING_NEWER" }));
    assert.strictEqual(s.label, "SOMETHING_NEWER");
    assert.strictEqual(s.tone, "unknown");
  });

  t("a record with no state at all is treated as unpublished, not as saved", () => {
    assert.strictEqual(rowState("published", {}), UNPUBLISHED);
    assert.strictEqual(rowState("published", null), UNPUBLISHED);
  });
}
