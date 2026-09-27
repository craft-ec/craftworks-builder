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
export function buttonFor(phase, { error = "", progress = null, changed = false, republishing = false } = {}) {
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
      // THE APP CHANGED since it went out (builder#117): its structure is put
      // at the SAME link, as the site's next version — the person's act.
      if (republishing) return { label: "Publishing changes…", enabled: false, tone: "working", hint:
        "Putting the changed app at the same link: read, signed, put and read back by the node." };
      if (changed) return { label: "Publish changes", enabled: true, tone: "", hint:
        "The app's structure changed since it was published. Its link stays the same; people see the new version when they open or reload it." };
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

/**
 * THE APP ID A PROJECT PUBLISHES UNDER (craftworks-sdk#267).
 *
 * A person's tree is divided by app, and `open()` refuses to start without
 * one: every domain an app names is stored as `<app>.<name>`, so an app has
 * no name for another app's data and cannot write it. In the builder a
 * PROJECT is an app, so its id comes from the project's own id — stable for
 * the project's life, the same at every publish, and the same one the
 * published app is opened under by anybody who visits it (`app.json`'s
 * `publisher.app`). Derived, never typed, so two projects cannot share a
 * space by being given the same name.
 *
 * The SDK's rule: 1–32 of a-z 0-9 _ -. An id longer than 32 is taken at its
 * FIRST 32 — deliberately: a project id is lowercase hex, 32 or 64
 * characters, so that is 128 bits, a prefix of the project's OWN id, and the
 * same prefix every time. Anything else that does not fit (a character outside the rule, an
 * empty or missing id) is REFUSED by name rather than bent into something
 * that fits, because a bent id could be another project's.
 */
export const appIdOf = (projectId, ids) => {
  const id = String(projectId ?? "").slice(0, 32);
  // The rule is the SDK's one statement (`sdk.ids.app`, craftworks-sdk#340),
  // refused in its words; the builder never writes it again.
  if (!ids?.app) throw new Error("publish: the SDK is not loaded, so no app id can be checked");
  try {
    ids.app(id);
  } catch (e) {
    throw new Error(`publish: project id \`${projectId}\` gives no app id: ${e?.message ?? e}`);
  }
  return id;
};

export async function publish(app, deps, onPhase = () => {}) {
  const { open, artefacts, port = 0, served = false, onSaving, appId, ids } = deps;
  const phase = p => { onPhase(p); return p; };

  // NO DEFAULT (builder#73). Without a listener the session's "saving N"
  // would go nowhere and the page would look saved while writes that are not
  // yet published are still in this tab only (craftworks-sdk#163). A caller
  // that shows no saving line says so with an explicit `() => {}`.
  if (typeof onSaving !== "function") {
    const why = "publish: no `onSaving` — without it the page would look saved while writes are still unpublished";
    onPhase("failed", why);
    throw new Error(why);
  }

  // WHICH APP (craftworks-sdk#267): `open()` refuses without one, and a
  // refusal from inside the SDK would arrive as "could not connect". Said
  // here, by name, before anything is opened.
  // By the SDK's one rule (`ids.app`), refused here by name.
  let bad = null;
  if (!ids?.app) bad = "the SDK is not loaded, so the app id cannot be checked";
  else {
    try { ids.app(appId ?? ""); } catch (e) { bad = e?.message ?? String(e); }
  }
  if (bad) {
    const why = `publish: no app id for this project (${JSON.stringify(appId)}) — its data would have no place in the person's tree: ${bad}`;
    onPhase("failed", why);
    throw new Error(why);
  }

  // A reserved port is refused unless it SERVED this page: then it is the node the person opened the builder on.
  if (!port || (RESERVED_PORTS.includes(port) && !served)) {
    const why = port
      ? `port ${port} is a node this machine already runs for somebody else. ` +
        "Publishing installs code and hands over a signing key, so it needs a node of this project's own."
      : "no node port was given. Publishing needs one, and there is no safe default: " +
        "a default would eventually point at somebody else's node.";
    onPhase("failed", why);
    throw new Error(why);
  }

  // THE ARTEFACTS ARE LOAD-BEARING (builder#173, the architect). `open()`
  // waits for the node to be provisioned only when it is given the artefacts
  // to provision it with (the SDK's `untilProvisioned` runs `if
  // (opts.artefacts && ...)`), and this file keeps no wait of its own. So
  // without them publish would say "opening" at once over a node that cannot
  // write: the builder#73 shape. NO DEFAULT: refused by name, before
  // anything opens. `sdk.SHIPPED_ARTEFACTS` is null when nothing is beside
  // the SDK (a module linked from load pieces).
  const missing = ["signer", "block", "register"].filter(n => typeof artefacts?.[n] !== "string" || !artefacts[n]);
  if (missing.length) {
    const why = `publish: no ${missing.join(", ")} artefact${missing.length > 1 ? "s" : ""} -- without them the node is never set up, and the page would say published over a node that cannot write`;
    onPhase("failed", why);
    throw new Error(why);
  }

  // ONE WAIT, THE SDK'S (builder#173). `open()` returns only once the node says
  // it is provisioned (the SDK's `untilProvisioned`), and it ends only on an
  // ANSWER: the node's refusal, a node that is not there (two refused
  // ATTEMPTS, never opened -- counted once per attempt, since a refused socket
  // fires both `error` and `closed`), or a cancel. There is no time cut-off
  // (rule 8), and a failed `open()` closes its own session, so the builder
  // holds no handle until it has one to hand over. This file used to wait a
  // second time with a 60 s budget and count each refused socket twice; both
  // copies are gone, and a source test keeps them gone.
  //
  // The phase is DERIVED from the socket: "connecting" until it first opens,
  // "provisioning" after.
  let opened = false;
  try {
    phase("connecting");
    // ONE call. It wires message -> on_inbound -> drain and tick -> drain
    // itself, so a cold read resolves without this file knowing that any of
    // those exist. A page that wired them by hand would have a screen that
    // never fills the first time it forgot one.
    const handle = await open({
      app: appId,
      port,
      artefacts,
      onEvent: e => {
        if (e.kind === "open" && !opened) { opened = true; phase("provisioning"); }
        // Every write not yet PUBLISHED, held ones included (sdk#188).
        if (e.kind === "saving") onSaving(e.count);
      },
    });
    phase("opening");
    // Handed over: from here the caller owns the session and must close it.
    return { session: handle, db: handle.db };
  } catch (e) {
    // Before the socket ever opened, say what to check; after, the SDK's own
    // words (the node's refusal, or a cancel) are the reason.
    onPhase("failed", opened ? e.message : nodeAdvice(e));
    throw e;
  }
}

/** What to tell someone when the connection itself did not happen. */
function nodeAdvice(e) {
  return `could not reach a node on this machine (${e.message}). ` +
    "Publishing needs one running locally — it holds your key, and it is the only place this tab will send it.";
}
