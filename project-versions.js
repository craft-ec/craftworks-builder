// What a project was MADE with, and what has happened to those versions since.
//
// ARCHITECTURE §19: every published version keeps working until it is evicted.
// An app published against SDK version N — its schema Blocks, the SDK blocks it
// references, the contract code it names — stays live while anyone uses it. So
// the builder opens, builds and republishes a project against the versions it
// was MADE with, offers the upgrade, and never applies one silently.
//
// Two kinds of state, and they are not the same kind of claim:
//
//   CODE (SDK, contracts) is current or SUPERSEDED, authoritatively, because
//   the released-code table says which epoch is current. Superseded does not
//   mean broken: it means a newer epoch exists and this one is still served.
//
//   The app's OWN BLOCKS get "reachable" or "not reachable within T" and
//   nothing else. Eviction is unannounced, so no probe can prove absence; a
//   bounded GET that missed is a bounded GET that missed. The panel never says
//   "gone", and never issues an unbounded GET to try to find out.

/** Strip `sha256:` and case so two spellings of one digest compare equal. */
const norm = (h) => String(h ?? "").trim().toLowerCase().replace(/^sha256:/, "");

/** The versions a project is stamped with when it is created or saved. */
export function stamp({ baked, sdk = null, now = new Date() }) {
  return {
    recorded: now.toISOString(),
    // What the loaded wasm SAYS it is, falling back to what the build pinned.
    // The runtime answer is preferred because it is the one that can disagree.
    sdkRev: sdk?.rev ?? baked?.sdkRev ?? null,
    prollyRev: sdk?.prollyRev ?? null,
    formatTag: sdk?.formatTag ?? null,
    contracts: baked?.contracts?.code ? { ...baked.contracts.code } : null,
    builder: baked?.builder?.rev ?? null,
  };
}

/**
 * Has anything the project was made with moved on?
 *
 * Returns one row per component that DIFFERS, never a row for agreement: the
 * question a developer is asking is "what changed", and a list where most rows
 * say "same" buries the answer.
 */
export function drift(stamped, { baked, sdk = null } = {}) {
  if (!stamped) return [];
  const now = stamp({ baked, sdk });
  const rows = [];
  const cmp = (what, was, is) => {
    if (was && is && norm(was) !== norm(is)) rows.push({ what, was, is });
  };
  cmp("SDK", stamped.sdkRev, now.sdkRev);
  cmp("freenet-prolly", stamped.prollyRev, now.prollyRev);
  cmp("tree format", stamped.formatTag, now.formatTag);
  for (const [name, was] of Object.entries(stamped.contracts ?? {})) {
    cmp(name, was, now.contracts?.[name]);
  }
  return rows;
}

/**
 * The state of one CODE version against the released table.
 *
 * `released` is the parsed `released.toml` epochs. The table is authoritative:
 * it is what a reader resolves keys through, so "superseded" here is a fact
 * about the network and not a guess.
 */
export function codeState(hash, released, currentHash = null) {
  if (!hash) return { state: "unknown", text: "not recorded in this project" };
  const epochs = released ?? [];
  if (epochs.length === 0) {
    // Nothing has been released, so nothing can be superseded. But "current
    // build, not released" is a claim about THIS hash, and a project pinned to
    // an older one was getting that label too — which the screenshot showed,
    // sitting under a hash that was visibly not the current build.
    if (currentHash && norm(hash) !== norm(currentHash)) {
      return {
        state: "info",
        text: `an earlier build (${short(currentHash)} is current) — no released table to say whether it is still served`,
      };
    }
    return { state: "info", text: "current build, not released" };
  }
  let mine = null;
  let newest = null;
  for (const e of epochs) {
    for (const h of Object.values(e.code ?? {})) {
      if (norm(h) === norm(hash)) mine = e;
    }
    if (newest === null || (e.number ?? 0) > (newest.number ?? 0)) newest = e;
  }
  if (!mine) {
    return {
      state: "warn",
      text: "not in the released table — a build, or an epoch that has been dropped",
    };
  }
  if ((mine.number ?? 0) === (newest.number ?? 0)) {
    return { state: "ok", text: `current — epoch ${mine.number}` };
  }
  return {
    state: "info",
    text: `superseded by epoch ${newest.number}, still served — released as epoch ${mine.number}`,
  };
}

/**
 * The state of one of the APP'S OWN blocks.
 *
 * `probe` is the result of a BOUNDED read: `true` it came back, `false` it did
 * not come back within T, `null` nothing asked. There is deliberately no
 * "gone": a miss within T is a miss within T, and the difference matters
 * because eviction is unannounced and a bounded GET cannot tell the two apart.
 */
export function blockState(probe, tMs) {
  if (probe === null || probe === undefined) {
    return { state: "unknown", text: "not checked — the builder connects to a node in phase 3" };
  }
  return probe
    ? { state: "ok", text: `reachable within ${tMs} ms` }
    : { state: "warn", text: `NOT reachable within ${tMs} ms — which is not the same as gone` };
}

/**
 * The per-app versions section: what it was made with, what each is now.
 *
 * Every row carries the recorded value, so a reader can see what the project
 * names even when nothing can be said about its state yet.
 */
export function appSection(stamped, { baked, sdk = null, probes = {}, tMs = 1500 } = {}) {
  if (!stamped) {
    return {
      title: "this project",
      rows: [
        {
          label: "versions",
          value: "—",
          state: "unknown",
          note: "this project predates version stamping; save it to record what it is built against",
        },
      ],
    };
  }
  const rows = [
    { label: "made", value: (stamped.recorded ?? "—").replace(/\.\d+Z$/, "Z"), state: "ok", note: "" },
    { label: "SDK", value: stamped.sdkRev ?? "—", ...sdkState(stamped.sdkRev, sdk) },
  ];
  for (const [name, hash] of Object.entries(stamped.contracts ?? {})) {
    const s = codeState(hash, baked?.released, baked?.contracts?.code?.[name]);
    rows.push({ label: name, value: short(hash), state: s.state, note: s.text });
  }
  rows.push(ownBlocksRow(stamped, probes, tMs));
  const d = drift(stamped, { baked, sdk });
  rows.push(
    d.length === 0
      ? { label: "drift", value: "none", state: "ok", note: "the builder is on the versions this project records" }
      : {
          label: "drift",
          value: `${d.length} changed`,
          state: "info",
          note: d.map((r) => `${r.what} ${short(r.was)} → ${short(r.is)}`).join(", ") +
            " — offered, never applied on its own",
        },
  );
  return { title: "this project", rows };
}

/**
 * The SDK is CODE, so it is current or superseded — but there is no released
 * table for it yet, only the revision the builder is on. Saying "current"
 * from that would claim the released table had been consulted when no such
 * table exists, so the note says which comparison was actually made.
 */
function sdkState(was, sdk) {
  const is = sdk?.rev ?? null;
  if (!was) return { state: "unknown", note: "not recorded in this project" };
  if (!is) return { state: "unknown", note: "the SDK has not been loaded, so nothing is compared" };
  if (norm(was) === norm(is)) {
    return { state: "ok", note: "the version the builder is on (no released table for the SDK yet)" };
  }
  return {
    state: "info",
    note: `superseded by ${short(is)}, and still what this project builds against`,
  };
}

/**
 * The app's OWN blocks — its schema Blocks and its data.
 *
 * A project with no components has none, which is a different thing from
 * having some that were not checked, and the row says which.
 */
function ownBlocksRow(stamped, probes, tMs) {
  const ids = Object.keys(probes ?? {});
  if (ids.length === 0) {
    return {
      label: "own blocks",
      value: "—",
      state: "unknown",
      note: "none to check yet — an app's schema and data blocks appear once it has components and has been published",
    };
  }
  const missing = ids.filter((k) => probes[k] === false);
  const unchecked = ids.filter((k) => probes[k] === null || probes[k] === undefined);
  if (unchecked.length === ids.length) {
    return { label: "own blocks", value: `${ids.length}`, ...pick(blockState(null, tMs)) };
  }
  if (missing.length === 0) {
    return { label: "own blocks", value: `${ids.length}`, ...pick(blockState(true, tMs)) };
  }
  return {
    label: "own blocks",
    value: `${ids.length - missing.length}/${ids.length}`,
    state: "warn",
    note: `${missing.length} NOT reachable within ${tMs} ms — which is not the same as gone`,
  };
}

const pick = (s) => ({ state: s.state, note: s.text });

export const short = (h) => {
  const n = norm(h);
  return n.length > 12 ? n.slice(0, 8) : n || "—";
};
