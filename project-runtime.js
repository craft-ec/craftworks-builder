// WHO OWNS A PROJECT'S RUNTIME.
//
// Nothing did. The published backend, the in-flight mount, the publish phase
// and the mounted database were four page globals, each reset on some paths
// and not others (builder#54, #57, #58):
//
//   * `publishedDb` was assigned once and never reset, so after project A
//     published, project B read "Published" with nothing requested — and a
//     mount of B was handed A's backend, where a shared domain name reads A's
//     records;
//   * `mounting` was cleared only inside the publish-success path, so ANY
//     rejected mount, and any return to design, left Preview unable to mount
//     again until a reload;
//   * the publish session was never closed by anything, on failure or on a
//     project switch, so its socket, tick and listeners outlived both.
//
// Patching each global separately is how `mounting` came to be cleared only
// inside the publish path. So this is ONE object per project holding all of
// it, and a project switch DISPOSES it and makes a new one.
//
// THE GENERATION TOKEN. Every mount and every publish is asynchronous, and a
// completion can arrive after the world moved on: the definition was edited,
// the preview left, the project switched. Each of those bumps `gen`, and a
// completion that belongs to an older generation disposes what it produced
// instead of being adopted. That keeps what the old sentinel was for — a
// second render mid-mount must not mount twice — without the latch.
//
// DOM-free on purpose: `mount` and `publish` are injected, so every one of the
// paths above is testable without a page (tests/project-runtime.test.mjs).

import { appOf, draftWriter } from "./definition.js";

/** Close a session, and never let the cleanup replace the reason. */
const closeQuietly = h => { try { h?.close?.(); } catch (_) { /* the original error matters */ } };

/** The wait before re-opening a tree whose open failed: doubling from 1 s, never more than 30 s apart, never given up. */
export const reconnectDelay = attempt => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));

/**
 * THE OWNER'S TREE IS OPEN FROM CREATION (ARCHITECTURE §19, app-as-data P3, core dev's ruling): the project's
 * definition is records of its draft there, written on every edit, so the session is opened with the project and
 * not at its first Publish. `publish` (the injected opener, publish.js's `publish`) opens it once; `connect` shares
 * that one open between the project's creation and a Publish click, and Publish never opens a second.
 *
 * `fresh`: a project made in THIS tab (new, or imported): its canvas is the definition, and edits made before the
 * tree opens are written when it does. Otherwise the tree's draft is the definition: `onDraft(app)` hands the
 * canvas what it holds, and nothing is written until it has (an empty canvas diffed against a draft would delete it).
 */
export function createProjectRuntime({ mount, publish, onChange = () => {}, onDraft = () => {}, fresh = false, schedule = (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); } }) {
  let gen = 0;
  let disposed = false;
  // "none" → "mounting" → "mounted". A mount in progress and a mount that is
  // ACTIVE are different facts; the old sentinel collapsed them into one bool,
  // so nothing could tell "still starting" from "finished and then discarded".
  let mountState = "none";
  let mounted = null;          // { db, stop } of the live mount
  // The db a CURRENT mount has reported before its promise settled. `mountApp`
  // reports data (and the tree panel renders from it) before it returns, so
  // without this `db` would read null at exactly the moment it is first used.
  let reported = null;
  let session = null;          // the publish handle, OWNED once handed over
  let publishedDb = null;
  let phase = "idle", error = "";
  // Writes not yet PUBLISHED, as the session last said (craftworks-sdk#163).
  // Kept HERE, not only in the mount: the session starts reporting as soon as
  // it opens, before the published app is mounted, and a remount must show
  // the count as it stands rather than start from nothing.
  let saving = 0;
  // THE CONNECTION to the owner's tree, apart from `phase` (which is the publish's): "none" -> "connecting" ->
  // "provisioning" -> "opening" -> "open", or "failed" with its reason, and then a retry.
  let connection = "none", connectionError = "";
  let connecting = null;       // the one open in flight: shared by creation and a Publish
  let treeDb = null;           // the session's db: the owner's tree, where the draft lives
  let attempts = 0;
  let cancelRetry = null;
  let publishing = null;       // a publish's phase reporter, while one waits on the connection
  let draftLoaded = fresh;     // may the canvas be written? A fresh project's canvas IS the definition
  const writer = draftWriter({ onState: () => onChange() });

  const stopMounted = () => {
    const m = mounted;
    mounted = null;
    reported = null;
    try { m?.stop?.(); } catch (_) { /* a listener that fails to stop is not a reason to keep it */ }
  };

  const rt = {
    get phase() { return phase; },
    get error() { return error; },
    get publishedDb() { return publishedDb; },
    get session() { return session; },
    /** The database the canvas is mounted on, or null. */
    get db() { return mounted?.db ?? reported; },
    get mountState() { return mountState; },
    /** Writes not yet published, as the session last reported. */
    get saving() { return saving; },
    get disposed() { return disposed; },
    /** Where the connection to the owner's tree stands, and why it failed. */
    get connection() { return connection; },
    get connectionError() { return connectionError; },
    /** The owner's tree (the session's db), once open. */
    get treeDb() { return treeDb; },
    /** The draft writer's state: held edits, the wait, a refusal. */
    get draft() { return { ...writer.state(), loaded: draftLoaded }; },

    /**
     * The canvas as it now is: written to the draft (the writer waits for the tree). Refused until the draft has
     * been read into the canvas, for a project that was not made in this tab.
     */
    edit(app) {
      if (disposed) return null;
      if (!draftLoaded) throw new Error("this project's draft is still being read from your node; nothing is written until it is");
      return writer.sync(app);
    },

    /**
     * Open the owner's tree, once. Resolves to `{ session, db }`; a second call while one is in flight joins it,
     * and a call after it opened returns it. A failed open is retried on its own, doubling the wait (never given
     * up: rule 8); `deps` are the opener's (app id, port, artefacts).
     */
    connect(deps) {
      if (disposed) return Promise.reject(new Error("this project is no longer open"));
      if (session) return Promise.resolve({ session, db: treeDb });
      if (connecting) return connecting;
      cancelRetry?.(); cancelRetry = null;
      connection = "connecting"; connectionError = "";
      onChange();
      const onSaving = n => {
        if (disposed) return;
        saving = n;
        try { mounted?.setSaving?.(n); } catch (e) { error = e.message; }
        onChange();
      };
      const report = (p, e = "") => {
        if (disposed) return;
        if (p === "failed") { connection = "failed"; connectionError = e; }
        else connection = p;
        publishing?.(p, e);
        onChange();
      };
      connecting = (async () => {
        let res;
        try {
          res = await publish(null, { ...deps, onSaving }, report);
        } catch (e) {
          connecting = null;
          if (disposed) throw e;
          connection = "failed";
          if (!connectionError) connectionError = e.message;
          // Retried until it opens (rule 8): a node that is starting, or one started after this tab.
          const wait = reconnectDelay(attempts++);
          cancelRetry = schedule(() => { cancelRetry = null; rt.connect(deps).catch(() => {}); }, wait);
          onChange();
          throw e;
        }
        if (disposed) { closeQuietly(res?.session); throw new Error("this project is no longer open"); }
        session = res.session;
        treeDb = res.db;
        attempts = 0;
        // The draft: read it, hand it to the canvas (a project from before is its draft), then write what the
        // canvas holds from here on.
        const held = await writer.attach(treeDb);
        if (disposed) throw new Error("this project is no longer open");
        if (!draftLoaded) {
          draftLoaded = true;
          onDraft(appOf(held));
        }
        connection = "open";
        connecting = null;
        onChange();
        return { session, db: treeDb };
      })();
      return connecting;
    },

    /**
     * Start a mount if none is active or in progress.
     *
     * Returns the mount's promise, or null when there is nothing to do — a
     * second call while one is starting is a no-op, which is the protection
     * the old sentinel gave. A REJECTED mount returns the state to "none", so
     * the next render tries again rather than the preview staying dead.
     */
    ensureMounted() {
      if (disposed || mountState !== "none") return null;
      const my = gen;
      const alive = () => !disposed && my === gen;
      const adopt = db => { if (alive()) reported = db; };
      mountState = "mounting";
      return Promise.resolve()
        .then(() => mount({ backend: publishedDb, phase, alive, adopt }))
        .then(h => {
          if (!alive() || !h) { try { h?.stop?.(); } catch (_) {} return null; }
          mounted = h;
          mountState = "mounted";
          // A mount starts at 0; tell it where the count stands NOW.
          if (saving) h.setSaving?.(saving);
          onChange();
          return h.db;
        }, e => {
          // A stale mount's failure is nobody's business: the canvas it would
          // report into belongs to a later generation. A CURRENT one returns
          // to "none", so the next render retries instead of the preview
          // staying dead until a reload (builder#57).
          if (!alive()) return null;
          mountState = "none";
          throw e;
        });
    },

    /**
     * The mounted runtime no longer matches what should be shown — the
     * definition changed, or the preview was left. Its listeners stop now and
     * any mount still in flight is disowned; the next render mounts afresh.
     */
    invalidate() {
      gen += 1;
      stopMounted();
      mountState = "none";
    },

    /**
     * Publish THIS project, and own the session it produces.
     *
     * `after(db)` runs the steps that belong to the publish — recording it in
     * the project's history, the preload — and it runs ONLY while this runtime
     * is still the project's. A publish that finishes after a switch closes
     * its session and records nothing: history written by a late publish of A
     * would land in whichever project was open by then.
     */
    async publish(app, deps, { onPhase = () => {}, after, handoff } = {}) {
      // NO DEFAULTS for these two (builder#73). Each was `async () => {}`,
      // which made a safety step look DONE: without a handoff the publish
      // copied nothing, adopted the new backend and said Published while
      // Preview's records vanished; without `after` the publication was never
      // recorded. A caller that wants either to do nothing says so.
      // And the refusal is SHOWN, not only thrown: the phase becomes `failed`
      // with the reason, so the page says why rather than leaving the button
      // at Publish as if nothing had been pressed. Nothing else is started.
      const missing = typeof handoff !== "function"
        ? "publish: no `handoff` — publishing without one would adopt the new backend with none of Preview's records on it"
        : typeof after !== "function"
          ? "publish: no `after` — the publication would never be recorded in the project's history"
          : null;
      if (missing) {
        phase = "failed"; error = missing;
        onPhase("failed", missing);
        onChange();
        throw new Error(missing);
      }
      if (disposed) throw new Error("this project is no longer open");
      const report = (p, e = "") => {
        if (disposed) return;
        phase = p; error = e;
        onPhase(p, e);
      };
      error = "";
      // THE ONE CONNECTION, opened at creation (or now, if it has not opened yet): a Publish never opens a second.
      // While it is still opening, the button says how far it got.
      if (connection !== "open") report(connection === "none" || connection === "failed" ? "connecting" : connection);
      publishing = report;
      let res;
      try {
        res = await rt.connect(deps);
      } catch (e) {
        // A project switched away while its tree was opening: the open closed what it produced, and nothing of
        // this publish runs.
        if (disposed) return null;
        phase = "failed"; error = connectionError || e.message; onPhase("failed", error); onChange();
        throw e;
      } finally {
        publishing = null;
      }
      if (disposed) return null;

      // THE HANDOFF, and it is FATAL. The records a person made in Preview are
      // copied to the new backend and must be acknowledged there before
      // anything calls this published (builder#52). On failure the preview
      // stays mounted and in use, nothing claims the data moved, and a retry
      // lands on the same slots and copies only what is missing (builder#83).
      //
      // `publishedDb` is adopted only AFTER it succeeds. Adopted before, any
      // edit during a failed handoff would remount the preview onto a
      // half-copied backend.
      report("migrating");
      try {
        await handoff({ source: rt.db, target: res.db });
      } catch (e) {
        if (disposed) return null;
        phase = "failed"; error = e.message;
        onPhase("failed", e.message);
        onChange();
        throw e;
      }
      if (disposed) return null;
      publishedDb = res.db;
      try { await after(res.db, res); } catch (e) { if (!disposed) error = e.message; }
      if (disposed) return null;
      phase = "published";
      // REMOUNT on the new backend. The old mount is on the preview db.
      rt.invalidate();
      onChange();
      return res;
    },

    /** The project is closing: nothing it started may act after this. */
    dispose() {
      if (disposed) return;
      disposed = true;
      gen += 1;
      stopMounted();
      mountState = "none";
      cancelRetry?.(); cancelRetry = null;
      writer.dispose();
      closeQuietly(session);
      session = null;
      treeDb = null;
      publishedDb = null;
      saving = 0;
    },
  };
  return rt;
}
