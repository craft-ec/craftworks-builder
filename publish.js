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
export function buttonFor(phase, { error = "" } = {}) {
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
      return { label: "Moving the data…", enabled: false, tone: "working", hint:
        "Writing this project's records through the engine." };
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
export async function publish(app, deps, onPhase = () => {}) {
  const { open, artefacts, port = 7509 } = deps;
  const phase = p => { onPhase(p); return p; };

  let handle;
  try {
    phase("connecting");
    // ONE call. It wires message -> on_inbound -> drain and tick -> drain
    // itself, so a cold read resolves without this file knowing that any of
    // those exist. A page that wired them by hand would have a screen that
    // never fills the first time it forgot one.
    handle = await open({ port, artefacts });
  } catch (e) {
    onPhase("failed", nodeAdvice(e));
    throw e;
  }

  try {
    phase("provisioning");
    await waitFor(handle);
  } catch (e) {
    onPhase("failed", e.message);
    throw e;
  }

  phase("opening");
  return { session: handle, db: handle.db };
}

/**
 * Wait until the node says it is provisioned — or until it says it cannot be.
 *
 * Three distinct ends, never one timeout: `provisioned` is done, `refused`
 * is the node declining and says why, `exhausted` is everything having been
 * accepted while the delegate still cannot write a head. Collapsing them
 * into "it did not work" is what makes a page unfixable.
 */
export async function waitFor(session, { everyMs = 250, budgetMs = 60_000, now = () => Date.now() } = {}) {
  const started = now();
  for (;;) {
    if (session.provisioned()) return "provisioned";
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
