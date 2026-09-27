// A TARGET THAT WAKES ITS BINDINGS (builder#175): the handoff no longer polls on a clock -- it binds each domain it
// writes and is woken by the SDK when one of this client's writes changes state (engine-db.js `reloadOwnStates`).
// The fakes in these tests change a row's state AS IT IS READ, so each read may be a change: this gives a fake the
// SDK's binding surface (`bind(domain)` -> `{ subscribe, stop }`) and wakes every subscriber after each read, as the
// engine would after a state change. Not a test file (the runner runs *.test.mjs only).

/** `target`, with `bind()` whose subscribers are woken (on the next turn) after every `get`. */
export function wakingOnRead(target) {
  const subs = new Set();
  const wake = () => setImmediate(() => { for (const cb of [...subs]) cb(); });
  return new Proxy(target, {
    get(o, k) {
      if (k === "bind") return () => ({ subscribe: cb => { subs.add(cb); return () => subs.delete(cb); }, stop() {} });
      const v = Reflect.get(o, k);
      if (k === "get") return async (...a) => { const r = await v.apply(o, a); wake(); return r; };
      return typeof v === "function" ? v.bind(o) : v;
    },
  });
}
