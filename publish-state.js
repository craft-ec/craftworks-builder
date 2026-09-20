// What a record's write is doing, and what a row says about it.
//
// No DOM, so it is testable without a browser — and the vocabulary is the
// SDK's, not a second one invented here. A write moves accepted → published →
// parity-complete, and `Conflict`, `Failed` and `Busy` are things that happen
// rather than variations of "loading".
//
// The rule this module exists to enforce: **a row never shows a spinner that
// means three different things.** "Saving", "saved here but not yet on the
// network", and "on the network and redundantly stored" are three different
// facts about a record, and a user deciding whether it is safe to close the
// tab needs the second one distinguished from the first.

/** The states the SDK reports, in the order a write moves through them. */
export const ORDER = ["accepted", "published", "parity-complete"];

/** Terminal states — nothing more is coming. */
export const TERMINAL = ["parity-complete", "conflict", "failed"];

/**
 * How a row shows a write state.
 *
 * `label` is what a person reads; `hint` is the tooltip that says what it
 * MEANS, because "published" is jargon until someone tells you it is the
 * moment the data survives the tab closing. `tone` picks the styling.
 */
export const STATES = {
  "in-memory": {
    label: "in this tab only",
    tone: "warn",
    hint: "This project is not published. Nothing here has left the tab, and closing it loses everything.",
  },
  accepted: {
    label: "saving",
    tone: "working",
    hint: "In this tab's copy of the tree. Not on the network yet — closing now would lose it.",
  },
  published: {
    label: "saved",
    tone: "ok",
    hint: "On the network. It survives closing this tab.",
  },
  "parity-complete": {
    label: "saved + backed up",
    tone: "ok",
    hint: "On the network, and its redundancy is stored too.",
  },
  busy: {
    label: "queued",
    tone: "working",
    hint: "The engine is finishing another write. This one goes next, by itself.",
  },
  conflict: {
    label: "not applied",
    tone: "warn",
    hint: "Someone else changed the same record first, and their version is newer. Nothing was overwritten.",
  },
  failed: {
    label: "failed",
    tone: "bad",
    hint: "This write will not be applied. Sending it again would fail the same way.",
  },
  lost: {
    label: "not applied",
    tone: "warn",
    hint: "The engine never published this write. It is safe to make the change again.",
  },
};

/** What to show for a state. Unknown states are shown AS THEMSELVES. */
export function show(state) {
  const s = STATES[state];
  if (s) return s;
  // Not a fallback to "saving". A state this build does not know is a state
  // it must not describe: guessing produces a row that claims the data is
  // safe when nobody checked. Showing the raw word is honest and is also how
  // anyone finds out that the SDK grew a state the builder has not learnt.
  return {
    label: String(state),
    tone: "unknown",
    hint: "This version of the builder does not know what this state means.",
  };
}

/**
 * What a row shows when the project has not been published.
 *
 * Not "saved". An unpublished project's data lives in this tab and nowhere
 * else, so a row that said "saved" would be claiming exactly the thing
 * Publish is for — and the person would find out by closing the tab. The
 * address bar says "in-memory, not published" for the project; this says the
 * same thing per row, where the decision to close is actually made.
 */
export const UNPUBLISHED = "in-memory";

/** Is this write finished, one way or another? */
export const settled = state => TERMINAL.includes(state);

/**
 * Is the data safe if the tab closes now?
 *
 * The question a person actually has, answered by one function so that no
 * screen has to work it out from a label. `accepted` is NOT safe, which is
 * the whole reason the two states are shown separately.
 */
export const durable = state => state === "published" || state === "parity-complete";

/**
 * ONE LINE saying what LIVE costs and what it is for.
 *
 * One line as it RENDERS, not as it is written. The first version said the
 * same things in sixty words and filled six lines of the properties panel —
 * every word true, and the effect was a wall of text beside a checkbox, which
 * is how a panel teaches people to stop reading it. A screenshot showed that;
 * no assertion could have.
 *
 * What it has to carry: the cost (a standing connection), and the shape of
 * data worth spending it on (things that change while you are looking). What
 * it must not carry: the word subscription, or anything else a person would
 * have to already know.
 */
export const LIVE_NOTE =
  "Costs a standing connection — worth it for a chat, a feed or a counter, " +
  "not for a list that is read when it is opened.";

/**
 * Is this binding live? Default OFF, and absence is not liveness.
 *
 * A separate function because `inst.live` is read in several places and an
 * `undefined` treated as truthy anywhere would make every existing project
 * live on upgrade — with a standing subscription per component and nobody
 * having asked for one.
 */
export const isLive = inst => inst?.live === true;
