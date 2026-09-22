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

/** Close a session, and never let the cleanup replace the reason. */
const closeQuietly = h => { try { h?.close?.(); } catch (_) { /* the original error matters */ } };

export function createProjectRuntime({ mount, publish, onChange = () => {} }) {
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
      // The session's saving count, to this runtime and whatever is mounted.
      const onSaving = n => {
        if (disposed) return;
        saving = n;
        try { mounted?.setSaving?.(n); } catch (e) { error = e.message; }
        onChange();
      };
      let res;
      try {
        res = await publish(app, { ...deps, onSaving }, report);
      } catch (e) {
        if (!disposed) { phase = "failed"; if (!error) error = e.message; onChange(); }
        throw e;
      }
      if (disposed) { closeQuietly(res?.session); return null; }
      // Owned from here: `dispose` closes it.
      closeQuietly(session !== res.session ? session : null);
      session = res.session;

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
      closeQuietly(session);
      session = null;
      publishedDb = null;
      saving = 0;
    },
  };
  return rt;
}
