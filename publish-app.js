// PUTTING THE APP ON THE NETWORK (builder#104): a web container any node
// serves at /v1/contract/web/<address>/, opened by address from anywhere.
//
// Two containers, both under the `webapp` contract (content-addressed: its
// params are the hash of its state, so a container cannot change without its
// address changing):
//
//   * the SDK's ARTEFACTS container — built by the SDK, the same bytes for
//     every app of this SDK build, PUT here only so it is on this node's
//     network; a second PUT of it is the same contract;
//   * the APP's container — the loader, the runtime, the SDK's JavaScript,
//     `app.json` naming the publisher's head, and `artefacts.json` naming the
//     artefacts by hash. Its address IS the app's address.
//
// No DOM. `session` is the SDK's (`put_contract`/`put_status`), `sdk` the
// entry (`sdk.webapp`), `read` returns a file's bytes or text — injected, so
// this is tested without a node.
import { packageApp } from "./package-app.js";

/** The files an app container carries, by their path IN the container → where the builder has them. */
export const APP_FILES = {
  "index.html": "app-loader/index.html",
  "loader.js": "app-loader/loader.js",
  // The runtime and everything it imports (a view mounts the same module the
  // builder's preview does).
  "runtime.js": "runtime.js",
  "catalogue.js": "catalogue.js",
  "runtime-logic.js": "runtime-logic.js",
  "publish-state.js": "publish-state.js",
  "handoff.js": "handoff.js",
  // The SDK's JavaScript; its wasm is NAMED by hash, never carried.
  ...Object.fromEntries(["index.js", "craftworks_sdk.js", "wrap.js", "session.js", "connection.js", "engine-db.js", "artefacts.js"]
    .map(f => [`sdk/${f}`, `sdk/${f}`])),
};

const enc = new TextEncoder();
const bytesOf = v => (typeof v === "string" ? enc.encode(v) : v);

/**
 * Publish `app`, whose data is the tree `headId` names. Resolves once the node
 * has acknowledged BOTH containers; rejects naming which one was refused (in
 * the node's words), or went unanswered.
 */
export async function publishApp(app, {
  sdk, session, headId, appId, manifest, read, subtle,
  everyMs = 200, sleep = ms => new Promise(r => setTimeout(r, ms)), signal = null,
}) {
  if (!/^[0-9a-f]{64}$/.test(headId ?? "")) {
    throw new Error("publish: this session has no head yet, so the app would name no data");
  }
  // AND THE APP ID it is written under (craftworks-sdk#267): a visitor's
  // session must open the SAME app's space in the publisher's tree, or it
  // reads an empty one. Checked BEFORE anything is PUT: it used to be checked
  // after the artefacts container went out, so a refused publication had
  // already put something (its test sat after the file's exit and never ran).
  if (!/^[a-z0-9_-]{1,32}$/.test(appId ?? "")) {
    throw new Error("publish: no app id, so a visitor could not find this app's data in the publisher's tree");
  }
  const code = bytesOf(await read("sdk/webapp.wasm"));
  const put = state => session.put_contract(code, sdk.webapp.params(state), state);

  // 1. The SDK's artefacts container — its address must be the one the
  // manifest names, or every app of this build would point at nothing.
  const artefacts = bytesOf(await read("sdk/artefacts.webapp"));
  const artefactsKey = put(artefacts);
  if (artefactsKey !== manifest.container?.address) {
    throw new Error(`the SDK's artefacts container is ${artefactsKey}, not the ${manifest.container?.address} its manifest names`);
  }

  // 2. The app, naming its data: the publisher's head. A visitor opens it by
  // address and READS it (published data is readable by default).
  const sdkFiles = {};
  for (const [at, from] of Object.entries(APP_FILES)) sdkFiles[at] = await read(from);
  const published = { ...app, publisher: { head: headId, app: appId } };
  const { files, bundleHash, bytes: bundleBytes } = await packageApp(published, { sdkFiles, manifest, artefactsKey, subtle });

  // 3. Its container, built by the SDK (deterministic: the same app is the
  // same address), and PUT.
  const c = new sdk.webapp.AppContainer();
  for (const [p, v] of Object.entries(files)) c.add(p, bytesOf(v));
  const state = c.finish();
  const address = put(state);

  // 4. Both acknowledged, matched by KEY.
  await Promise.all([
    settled(session, artefactsKey, "the SDK's artefacts container", { everyMs, sleep, signal }),
    settled(session, address, "the app's container", { everyMs, sleep, signal }),
  ]);
  return { address, artefactsKey, bundleHash, bundleBytes, containerBytes: state.length, artefactsBytes: artefacts.length };
}

/**
 * Wait until the PUT of `key` ENDS on the node's ANSWER — `put`, or
 * `refused` in its words — or a person cancels (`signal`, named `cancelled`).
 * The SDK's page sender re-sends it until then; no time ends it (rule 8). No
 * budget and no re-PUT here: a second copy of those rules, with its own
 * numbers, is what stalled a real-network publish that the SDK would have
 * finished (2026-09-23). Never "published" on anything short of the ack.
 */
export async function settled(session, key, what, { everyMs, sleep, signal = null }) {
  for (;;) {
    // A person stopped the publish: the SDK ends the PUT, named `cancelled`.
    if (signal?.aborted) session.cancel_put?.(key);
    const { state, said } = JSON.parse(session.put_status(key));
    if (state === "put") return;
    if (state === "refused") throw new Error(`the node refused ${what}: ${said}`);
    if (state === "cancelled") throw new Error(`cancelled: ${what} was not published`);
    // The SDK's own end while it still has one (sdk#296's; #302 removes it).
    if (state === "failed") throw new Error(`${what} was not acknowledged: ${said}`);
    if (state === "none") throw new Error(`${what} was never sent`);
    await sleep(everyMs);
  }
}
