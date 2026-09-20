// What this builder is running, as a model. No DOM, no fetch, no defaults.
//
// Two rules shape everything here, and both come from the failure this panel
// exists to prevent — a live-node test that ran against a contract two versions
// old, which only a printed hash exposed:
//
//   1. Every value comes from an artefact. Nothing in this file supplies a
//      fallback that looks like a value. A version display that can be
//      confidently wrong is worse than none, so a missing input produces the
//      state `unknown` and says why, never a plausible-looking string.
//   2. A check that has not run is not a check that passed. The SDK can only
//      report what it is once its wasm is loaded, so verification has THREE
//      states — verified, mismatched, and not yet verified — and diagnostics
//      copied before the SDK loads say so.

import { appSection } from "./project-versions.js";

/** Compare two revisions that may be short, long, or marked dirty. */
export function sameRev(a, b) {
  if (!a || !b) return false;
  const norm = r => String(r).trim().toLowerCase().replace(/-dirty$/, "");
  const [x, y] = [norm(a), norm(b)];
  if (!x || !y) return false;
  const n = Math.min(x.length, y.length, 40);
  // Seven is what every tool here prints; refuse to "match" on less, because a
  // one-character agreement is not evidence of anything.
  if (n < 7) return false;
  return x.slice(0, n) === y.slice(0, n);
}

export const isDirty = rev => typeof rev === "string" && rev.trim().endsWith("-dirty");

/**
 * How the loaded SDK compares with the revision this build pinned.
 * `sdk` is null until the wasm has loaded.
 */
export function verification({ sdkRev, sdk, profile = "dev" }) {
  if (!sdk || !sdk.rev) {
    return { state: "unverified", text: "SDK not loaded — nothing has been verified yet" };
  }
  if (sdk.rev === "unknown") {
    // The SDK's own stamping failed. It cannot name itself, so nothing here can
    // certify it either — and this must not read as a match.
    return { state: "mismatch", text: "the loaded SDK cannot name its own revision (rev: unknown)" };
  }
  if (!sameRev(sdk.rev, sdkRev)) {
    return {
      state: "mismatch",
      text: `the loaded SDK says it is ${sdk.rev}, but this builder was built against ${sdkRev} — sdk/ holds the wrong build`,
    };
  }
  if (isDirty(sdk.rev)) {
    // A dev tree is always dirty. A standing alarm here trains people to ignore
    // the panel, so it is neutral until a build claims to be a release.
    return {
      state: profile === "release" ? "warn" : "info",
      text: `matches ${sdkRev}, but that SDK was built from a modified tree`,
    };
  }
  return { state: "ok", text: `matches the pinned revision ${sdkRev}` };
}

/**
 * The label for one contract hash: released under an epoch, or a build.
 * Parsed from `released.toml`, never hardcoded — a hardcoded "not released"
 * keeps lying the day an epoch lands.
 */
export function releaseLabel(hash, released) {
  if (!hash) return { state: "unknown", text: "not available in this build" };
  for (const epoch of released ?? []) {
    for (const h of Object.values(epoch.code ?? {})) {
      if (h && normHash(h) === normHash(hash)) {
        return { state: "ok", text: `released as epoch ${epoch.number}` };
      }
    }
  }
  return { state: "info", text: "current build, not released" };
}

const normHash = h => String(h).trim().toLowerCase().replace(/^sha256:/, "");

/** `sha256:1611ba5f…` → `1611ba5f` for display; the full value stays in diagnostics. */
export const shortHash = h => (h ? normHash(h).slice(0, 8) : "");

/**
 * The whole panel as data.
 *
 * `baked` is what `build.sh` wrote; `sdk` is what the loaded wasm reports, or
 * null. Nothing else is consulted, so this function is the entire behaviour and
 * a test of it is a test of the panel.
 */
export function model({ baked, sdk = null, project = null, probes = {}, probeMs = 1500 }) {
  const profile = baked?.builder?.profile ?? "dev";
  const v = verification({ sdkRev: baked?.sdkRev, sdk, profile });
  const sections = [];

  sections.push({
    title: "builder",
    rows: [
      row("version", baked?.builder?.version, "no build-info.json — run ./build.sh"),
      revRow("commit", baked?.builder?.rev, profile),
      row("built", baked?.builder?.built),
      row("profile", profile),
    ],
  });

  sections.push({
    title: "SDK",
    rows: [
      row("pinned rev", baked?.sdkRev, "SDK_REV was not read at build time"),
      {
        label: "loaded build says",
        value: sdk?.rev ?? "—",
        state: v.state,
        // The verdict banner sits directly above with the full sentence, so
        // this row carries only the judgement. Repeating it cost three lines
        // of the popover and told the reader nothing twice.
        note: {
          ok: "",
          info: "built from a modified tree",
          warn: "built from a modified tree",
          mismatch: "does NOT match the pinned revision — see above",
          unverified: "the SDK has not been loaded yet",
        }[v.state] ?? "",
      },
      row("version", sdk?.version, "the SDK has not been loaded yet"),
    ],
  });

  sections.push({
    title: "tree library",
    rows: [
      row("freenet-prolly", sdk?.prollyRev, "read from the SDK when it loads"),
      row("format tag", sdk?.formatTag, "read from the SDK when it loads"),
    ],
  });

  const code = baked?.contracts?.code;
  sections.push({
    title: "contracts",
    rows: code
      ? Object.entries(code).map(([name, hash]) => {
          const lab = releaseLabel(hash, baked?.released);
          return { label: name, value: shortHash(hash), state: lab.state, note: lab.text };
        })
      : [
          {
            label: "hashes",
            value: "—",
            state: "unknown",
            note:
              baked?.contracts?.reason ??
              "not available in this build — freenet-contracts/build/hashes.toml was not found",
          },
        ],
  });

  // What THIS PROJECT was made with, which is a different question from what
  // the builder is running: §19 says an app keeps working on the versions it
  // was published against, so those are the ones a developer needs to see.
  sections.push(appSection(project, { baked, sdk, probes, tMs: probeMs }));

  sections.push({
    title: "node",
    rows: [{ label: "connection", value: "—", state: "unknown", note: "the builder connects to a node in phase 3" }],
  });

  return { sections, verification: v, profile };
}

function row(label, value, missing = "not available in this build") {
  return value
    ? { label, value: String(value), state: "ok", note: "" }
    : { label, value: "—", state: "unknown", note: missing };
}

/** A revision row, which carries the dirty judgement rather than a bare value. */
function revRow(label, rev, profile) {
  if (!rev) return row(label, null, "no build-info.json — run ./build.sh");
  if (rev === "unknown") {
    return { label, value: rev, state: "warn", note: "this build cannot name its own commit" };
  }
  if (isDirty(rev)) {
    return {
      label,
      value: rev,
      state: profile === "release" ? "warn" : "info",
      note: "built from a modified tree",
    };
  }
  return { label, value: rev, state: "ok", note: "" };
}

/**
 * One text block for Copy diagnostics.
 *
 * It records the FULL hashes, not the shortened ones on screen, and it states
 * the verification state in words — including "unverified", because a report
 * that silently omitted it would read as a clean bill of health.
 */
export function diagnostics({ baked, sdk = null, project = null, now = new Date() }) {
  const m = model({ baked, sdk, project });
  const lines = [
    `craftec builder diagnostics — ${now.toISOString()}`,
    `SDK verification: ${m.verification.state.toUpperCase()} — ${m.verification.text}`,
    "",
  ];
  for (const s of m.sections) {
    lines.push(`[${s.title}]`);
    for (const r of s.rows) {
      const full =
        s.title === "contracts" && baked?.contracts?.code?.[r.label]
          ? normHash(baked.contracts.code[r.label])
          : r.value;
      lines.push(`  ${r.label}: ${full}${r.note ? `   (${r.note})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
