// Publishing a project: switching its backend from this tab to the network.
//
// The app code does not change. `openApp` takes whichever database it is
// given, every call on both is awaited, and the SDK's own gate
// (`surfaces_agree`) fails if the two ever offer different methods. So what
// this module does is narrow: get a session, provision the node if it needs
// it, and hand back the engine-backed database.
//
// NOTHING HERE DECIDES ANYTHING ABOUT THE PROTOCOL. What to send, in what
// order, whether the node is already provisioned, whether an install would
// destroy a key — all of that is in Rust, and the delegate refuses a second
// install whatever this file does.

import { UNPUBLISHED } from "./publish-state.js";

/** Where a publish has got to. `error` is set only in "failed". */
export const PHASES = ["idle", "connecting", "provisioning", "opening", "published", "failed"];

/**
 * What the button says, and whether it can be pressed.
 *
 * Separated from the DOM so it is testable without a browser — and so the
 * three "working" phases cannot collapse into one spinner, which is the same
 * rule the row states follow.
 */
export function buttonFor(phase, { error = "", progress = null } = {}) {
  switch (phase) {
    case "idle":
      return { label: "Publish", enabled: true, tone: "", hint:
        "Put this project on the network. Until then everything is in this tab only, and closing it loses the lot." };
    case "connecting":
      return { label: "Connecting…", enabled: false, tone: "working", hint:
        "Opening a connection to the node on this machine." };
    case "provisioning":
      return { label: "Setting the node up…", enabled: false, tone: "working", hint:
        "Installing the engine and the contracts. This happens once per node, not once per project." };
    case "opening":
      // This used to say "Moving the data…" while nothing moved any data: the
      // preview's records were dropped and the button went on to Published
      // (builder#52). The claim belongs to the phase that now keeps it.
      return { label: "Opening…", enabled: false, tone: "working", hint:
        "Connected; opening this project's database on the node." };
    case "migrating":
      // HOW FAR, because a large publish takes as long as the node's pace
      // makes it — about 3.4 records a second — and a label that never moves
      // reads as stuck (builder#94).
      return { label: progress ? `Moving your records… ${progress.confirmed} of ${progress.total} confirmed` : "Moving your records…", enabled: false, tone: "working", hint:
        "Copying what you made in Preview to the node, and waiting for it to confirm each one." };
    case "published":
      return { label: "Published", enabled: false, tone: "ok", hint:
        "On the network. Each row now says what its own write is doing." };
    case "failed":
      // ENABLED, because the failures that get here are the ones a retry can
      // fix — a node that was not running, a connection that dropped. The
      // delegate refuses a second install on its own, so pressing this again
      // cannot cost a signing key however many times it is pressed.
      return { label: "Try publishing again", enabled: true, tone: "bad", hint: error };
    default:
      return { label: "Publish", enabled: true, tone: "", hint: "" };
  }
}

/**
 * The row state for a project in this phase.
 *
 * Until a project is actually published every row says so, because its data
 * is in this tab and nowhere else. Saying "saved" would claim the exact thing
 * Publish is for, and the person would find out by closing the tab.
 */
export const rowStateFor = phase => (phase === "published" ? null : UNPUBLISHED);

/**
 * Publish, reporting each phase as it starts.
 *
 * `deps` is injected so this is testable without a node: `openSession` and
 * `engineDb` come from the SDK in the page, and from fakes in the tests.
 */
/**
 * Ports this must never publish to.
 *
 * 7509 and 7609 are the OWNER'S nodes on this machine. Publishing installs a
 * delegate and hands over a signing key, so pointing a development build at
 * one of them writes to somebody's real node because of a default nobody
 * chose. It happened: a screenshot run meant to capture "there is no node"
 * connected to 7509 and began provisioning it.
 *
 * A refusal, not a warning. The right port for development is an isolated
 * node of your own, and naming one is a decision rather than an accident.
 */
export const RESERVED_PORTS = [7509, 7609];

export async function publish(app, deps, onPhase = () => {}) {
  const { open, artefacts, port = 0 } = deps;
  const phase = p => { onPhase(p); return p; };

  if (!port || RESERVED_PORTS.includes(port)) {
    const why = port
      ? `port ${port} is a node this machine already runs for somebody else. ` +
        "Publishing installs code and hands over a signing key, so it needs a node of this project's own."
      : "no node port was given. Publishing needs one, and there is no safe default: " +
        "a default would eventually point at somebody else's node.";
    onPhase("failed", why);
    throw new Error(why);
  }

  // Whether the socket has EVER opened.
  //
  // A socket that cannot connect retries with a backoff, for ever, which is
  // right for a connection that dropped and wrong for one that was never
  // there. Without this the provisioning wait runs its full budget while a
  // person watches "Setting the node up…" for a minute, and then learns the
  // node was never running. A short timeout on PROGRESS beats a long one on
  // the run.
  let connected = false, refusals = 0;

  let handle;
  try {
    phase("connecting");
    // ONE call. It wires message -> on_inbound -> drain and tick -> drain
    // itself, so a cold read resolves without this file knowing that any of
    // those exist. A page that wired them by hand would have a screen that
    // never fills the first time it forgot one.
    handle = await open({
      port,
      artefacts,
      onEvent: e => {
        if (e.kind === "open") { connected = true; refusals = 0; }
        if (e.kind === "closed" || e.kind === "error") refusals += 1;
      },
    });
  } catch (e) {
    onPhase("failed", nodeAdvice(e));
    throw e;
  }

  try {
    phase("provisioning");
    await waitFor(handle, { neverConnected: () => !connected && refusals >= 2 });
  } catch (e) {
    // THE HANDLE IS OURS UNTIL IT IS HANDED OVER, so a failed handoff closes
    // it. It owns a reconnecting socket, a tick interval and page-lifecycle
    // listeners; the caller gets no handle on a rejection and so cannot, and
    // every retry used to open another one alongside the last (builder#58).
    closeQuietly(handle);
    onPhase("failed", e.message);
    throw e;
  }

  phase("opening");
  // Handed over: from here the caller owns the session and must close it.
  return { session: handle, db: handle.db };
}

/**
 * Close a session, and never let the cleanup replace the reason.
 *
 * A close that throws while reporting a failure would surface the close's
 * error instead of the one that explains what went wrong, so it is swallowed
 * here — the ORIGINAL error is what the caller rethrows.
 */
export function closeQuietly(handle) {
  try { handle?.close?.(); } catch (_) { /* the original error is the one that matters */ }
}

/**
 * Wait until the node says it is provisioned — or until it says it cannot be.
 *
 * Three distinct ends, never one timeout: `provisioned` is done, `refused`
 * is the node declining and says why, `exhausted` is everything having been
 * accepted while the delegate still cannot write a head. Collapsing them
 * into "it did not work" is what makes a page unfixable.
 */
export async function waitFor(session, {
  everyMs = 250,
  budgetMs = 60_000,
  now = () => Date.now(),
  // "The socket has never opened, and has been refused more than once."
  // Default false so `waitFor` behaves as before for a caller that cannot
  // observe the socket. Traced for builder#73: `publish` always passes its own,
  // so this default only reaches a direct caller of `waitFor`, and `false`
  // means "do not fail fast" — the wait runs its whole budget and then fails
  // LOUDLY. A default that makes a feature absent or loud is the safe kind; it
  // cannot make anything look done.
  neverConnected = () => false,
} = {}) {
  const started = now();
  for (;;) {
    if (session.provisioned()) return "provisioned";
    // A node that is not there is a FACT available in a second, not one to
    // wait a minute for. Checked after `provisioned` so a node that answered
    // is never reported unreachable because of an earlier retry.
    if (neverConnected()) {
      throw new Error(
        "there is no node answering on this machine. Publishing needs one " +
        "running locally — it holds your key, and it is the only place this tab will send it.");
    }
    const refused = session.refused?.();
    if (refused) throw new Error(`the node refused to set up: ${refused}`);
    if (session.exhausted?.()) {
      throw new Error(
        "the node accepted everything and still cannot write; its engine may be a different build");
    }
    if (now() - started > budgetMs) {
      throw new Error("the node did not finish setting up in time; is it still running?");
    }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** What to tell someone when the connection itself did not happen. */
function nodeAdvice(e) {
  return `could not reach a node on this machine (${e.message}). ` +
    "Publishing needs one running locally — it holds your key, and it is the only place this tab will send it.";
}
