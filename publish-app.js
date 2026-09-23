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
//     `app.json` naming the head of the app's tree, and `artefacts.json` naming the
//     artefacts by hash. Its address IS the app's address.
//
// No DOM. `session` is the SDK's (`put_contract`/`put_status`), `sdk` the
// entry (`sdk.webapp`), `read` returns a file's bytes or text — injected, so
// this is tested without a node.
import { packageApp, isModuleName } from "./package-app.js";

/**
 * The BUILDER's files an app container carries, by their path IN the
 * container → where the builder has them. The SDK's modules are not listed
 * here: they are the SDK manifest's (`appFiles`).
 */
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
};

/**
 * Every file an app container carries: the builder's (`APP_FILES`) and the
 * SDK's JavaScript modules — EXACTLY the set the SDK's own build says is
 * reachable from its entry (`artefacts.json` `modules`, written by the step
 * that checks them). Its wasm is NAMED by hash, never carried.
 *
 * NOT a hand list: a copy of the SDK's module list here went stale the day
 * the SDK gained a module (`rto.js`), and every published page then hung on
 * "Loading…" importing a file its container did not have. No `modules`, no
 * publication: said by name, never a guess.
 */
export function appFiles(manifest) {
  const modules = manifest?.modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error("publish: the SDK's artefacts.json names no `modules` — which of its files an app needs is the SDK's to say; rebuild against an SDK that says it");
  }
  for (const m of modules) {
    // A module is a file beside index.js: a path out of sdk/ is not one.
    if (!isModuleName(m)) {
      throw new Error(`publish: the SDK's artefacts.json names ${JSON.stringify(m)} as a module, which is not a file beside its index.js`);
    }
  }
  return { ...APP_FILES, ...Object.fromEntries(modules.map(m => [`sdk/${m}`, `sdk/${m}`])) };
}

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
  last = null, sdkVersion = null,
}) {
  if (!/^[0-9a-f]{64}$/.test(headId ?? "")) {
    throw new Error("publish: this session has no head yet, so the app would name no data");
  }
  // AND THE APP ID it is written under (craftworks-sdk#267): every user's
  // session must open the SAME app's space in the app's tree, or it
  // reads an empty one. Checked BEFORE anything is PUT: it used to be checked
  // after the artefacts container went out, so a refused publication had
  // already put something (its test sat after the file's exit and never ran).
  if (!/^[a-z0-9_-]{1,32}$/.test(appId ?? "")) {
    throw new Error("publish: no app id, so a user could not find this app's data in its tree");
  }
  const code = bytesOf(await read("sdk/webapp.wasm"));
  const put = state => session.put_contract(code, sdk.webapp.params(state), state);

  // 1. The SDK's artefacts container — its address must be the one the
  // manifest names, or every app of this build would point at nothing.
  // COMPUTED, not learned from a PUT: both containers are content-addressed,
  // so their addresses are known before anything is sent.
  const artefacts = bytesOf(await read("sdk/artefacts.webapp"));
  const artefactsKey = sdk.webapp.address(code, artefacts);
  if (artefactsKey !== manifest.container?.address) {
    throw new Error(`the SDK's artefacts container is ${artefactsKey}, not the ${manifest.container?.address} its manifest names`);
  }

  // 2. The app, naming its data: the head of the tree it was built on. Any
  // user opens it by address and READS it (published data is readable by
  // default).
  const sdkFiles = {};
  for (const [at, from] of Object.entries(appFiles(manifest))) sdkFiles[at] = await read(from);
  const published = { ...app, publisher: { head: headId, app: appId } };
  const { files, bundleHash, bytes: bundleBytes } = await packageApp(published, { sdkFiles, manifest, artefactsKey, subtle });

  // 3. Its web part, as the SDK builds it: the framing is the SDK's to know
  // (the site frames it with its own metadata), never counted here.
  const c = new sdk.webapp.AppContainer();
  for (const [p, v] of Object.entries(files)) c.add(p, bytesOf(v));
  const state = c.finish();
  const web = c.web();
  const result = { artefactsKey, bundleHash, bundleBytes, containerBytes: state.length, artefactsBytes: artefacts.length };

  // NOTHING CHANGED, NOTHING SENT. A published project reopening (the
  // builder's reconnect) whose BUNDLE is the one its last acknowledged
  // publication carried, on the same SDK: that version is on the network at
  // the site's address already. (The address itself no longer changes with
  // the content: a site is updated in place, builder#117.)
  if (last?.app_contract_id && last?.bundle_hash === bundleHash && !!sdkVersion && last?.sdk_version === sdkVersion) {
    return { ...result, address: last.app_contract_id, put: false };
  }

  // 4. The artefacts container (content-addressed, PUT as it is), and the
  // app as the next VERSION of its SITE (builder#117): one stable address —
  // this identity's, for this app — updated in place. Both end on the
  // node's answers, never on a clock (rule 8).
  const k = put(artefacts);
  if (k !== artefactsKey) throw new Error(`the node keyed the artefacts container ${k}, not the ${artefactsKey} its content names`);
  const address = session.publish_site(appId, bytesOf(await read("sdk/site.wasm")), web);
  const [, version] = await Promise.all([
    settled(session, artefactsKey, "the SDK's artefacts container", { everyMs, sleep, signal }),
    siteSettled(session, address, { everyMs, sleep, signal }),
  ]);
  return { ...result, address, version, put: true };
}

/**
 * Wait until the SITE's version is published — the node acknowledged its PUT —
 * or refused, in the signer's or the node's words, or a person cancels. The
 * SDK reads the version, has it signed and PUTs it, each step on its page's
 * sender; nothing here ends it on a clock (rule 8). Resolves to the version.
 *
 * A cancel ends only the PUT. While the site is still being read or signed
 * there is nothing to cancel, so the loop keeps polling until the signer
 * answers — that answer ends it (rule 8), never a clock.
 */
export async function siteSettled(session, address, { everyMs, sleep, signal = null }) {
  for (;;) {
    if (signal?.aborted) session.cancel_put?.(address);
    const { state, version, key, said } = JSON.parse(session.site_status());
    if (key && key !== address) throw new Error(`the site being published is ${key}, not ${address}`);
    if (state === "published") return version;
    if (state === "refused") throw new Error(`the app's site was not published: ${said}`);
    if (state === "cancelled") throw new Error("cancelled: the app's site was not published");
    if (state === "none") throw new Error("the app's site was never sent");
    await sleep(everyMs);
  }
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
