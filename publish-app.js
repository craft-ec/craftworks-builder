// PUTTING THE APP ON THE NETWORK (builder#104; loaded by parity pieces, craftworks-sdk#347).
//
// A published app is a TINY STARTER container (its address IS the app's address) plus the SDK's LOAD PIECES:
//
//   * the STARTER: the page, its loader, the decode-only wasm, and the three SDK files that run before the SDK
//     exists (the SDK names them: its artefacts.json `starter`, craftworks-sdk#408),
//     with `app.json` (the app, naming its data) and `artefacts.json` (the pieces, by address and sha256). Kept
//     small: it is the one fetch nothing can race (measured, #347: a single cold GET stalls; the pieces are raced);
//   * the CORE pieces: the SDK wasm, the SDK's other JavaScript and the runtime's, and the `webapp` code (for the
//     repair after load), as one bundle cut into k + m pieces (the SDK's `load-pieces`, at build time);
//   * the PROVISIONING pieces: the signer and the two contracts, raced only when a first write needs them.
//
// Every piece is its own content-addressed web container: the same SDK and builder build make the same pieces,
// shared by every app they publish. No DOM. `session` is the SDK's (`put_contract`/`put_status`), `sdk` the entry
// (`sdk.webapp`), `read` returns a builder file's bytes or text -- injected, so this is tested without a node.
import { packageApp } from "./package-app.js";

/** The builder's files the STARTER carries, by their path in it -> where the builder has them. */
export const STARTER_FILES = {
  "index.html": "app-loader/index.html",
  "loader.js": "app-loader/loader.js",
  // The decode-only wasm (craftworks-sdk#347): the only per-app storage the pieces add.
  "decoder.wasm": "sdk/decoder.wasm",
};


/** The runtime (the view a published app mounts), carried in the CORE pieces, by bundle path -> builder file. */
export const RUNTIME_FILES = {
  "runtime.js": "runtime.js",
  "catalogue.js": "catalogue.js",
  "runtime-logic.js": "runtime-logic.js",
  "publish-state.js": "publish-state.js",
  "handoff.js": "handoff.js",
};

/** The PROVISIONING pieces' files, by bundle path -> builder file: raced only at a first write. */
export const PROVISIONING_FILES = {
  "sdk/signer.wasm": "sdk/signer.wasm",
  "sdk/block.wasm": "sdk/block.wasm",
  "sdk/register.wasm": "sdk/register.wasm",
};

/** The STARTER's limit (craftworks-sdk#347, main's ruling): ONE container under 96 KiB, measured and printed by the
 * build (tools/cut-pieces.mjs), which fails above it. It is the one fetch nothing races. */
export const STARTER_LIMIT = 96 * 1024;

/** Bundle bytes per data piece, and parity pieces per bundle (craftworks-sdk#347; sized from F60's measurements). */
export const PIECE_PAYLOAD = 65536;
export const PIECE_M = 8;

/**
 * The SDK modules an app needs: EXACTLY the set the SDK's own build says is reachable from its entry
 * (`artefacts.json` `modules`). NOT a hand list: a copy of it went stale the day the SDK gained a module (`rto.js`),
 * and every published page then hung importing a file its container did not have.
 */
function sdkModules(manifest, ids) {
  const modules = manifest?.modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error("publish: the SDK's artefacts.json names no `modules` — which of its files an app needs is the SDK's to say; rebuild against an SDK that says it");
  }
  for (const m of modules) {
    if (typeof m !== "string" || !ids.module(m)) {
      throw new Error(`publish: the SDK's artefacts.json names ${JSON.stringify(m)} as a module, which is not a file beside its index.js`);
    }
  }
  return modules;
}

/**
 * The SDK's JavaScript the STARTER carries: what runs BEFORE the SDK exists, never also in the core bundle. The SDK's
 * build computes it from its starter entries and names it in `artefacts.json` `starter` (craftworks-sdk#408): the ONE
 * owner of the list. A hand copy here went stale in the same way `modules` once did.
 */
export function sdkStarter(manifest, ids) {
  sdkModules(manifest, ids);
  const starter = manifest?.starter;
  if (!Array.isArray(starter) || starter.length === 0) {
    throw new Error("publish: the SDK's artefacts.json names no `starter` — which of its files run before the SDK exists is the SDK's to say; rebuild against an SDK that says it (craftworks-sdk#408)");
  }
  for (const m of starter) {
    // Not necessarily one of `modules`: a starter ENTRY the SDK's index never imports (pieces.js) is the starter's alone.
    if (typeof m !== "string" || !ids.module(m)) {
      throw new Error(`publish: the SDK's artefacts.json names ${JSON.stringify(m)} in \`starter\`, which is not a file beside its index.js`);
    }
  }
  return starter;
}

/** The CORE bundle's files, by bundle path -> builder file: the runtime, the SDK modules not in the starter, the
 * SDK wasm, and the `webapp` code. What `tools/cut-pieces.mjs` cuts at build time. */
export function coreFiles(manifest, ids) {
  const starter = sdkStarter(manifest, ids);
  const modules = sdkModules(manifest, ids).filter(m => !starter.includes(m));
  return {
    ...RUNTIME_FILES,
    ...Object.fromEntries(modules.map(m => [`sdk/${m}`, `sdk/${m}`])),
    "sdk/craftworks_sdk_bg.wasm": "sdk/craftworks_sdk_bg.wasm",
    "sdk/webapp.wasm": "sdk/webapp.wasm",
  };
}

/** Every file the STARTER carries, by its path in it -> builder file. */
export function starterFiles(manifest, ids) {
  return { ...STARTER_FILES, ...Object.fromEntries(sdkStarter(manifest, ids).map(m => [`sdk/${m}`, `sdk/${m}`])) };
}

const enc = new TextEncoder();
const bytesOf = v => (typeof v === "string" ? enc.encode(v) : v);

/**
 * Publish `app`, whose data is the tree `headId` names, at the version `headSeq` (the seq of the head this session
 * has PUBLISHED, craftworks-sdk#349). Resolves once the node has acknowledged EVERY piece and the starter; rejects
 * naming which one was refused (in the node's words) or went unanswered.
 */
export async function publishApp(app, {
  sdk, session, headId, headSeq, appId, manifest, read, subtle,
  everyMs = 200, sleep = ms => new Promise(r => setTimeout(r, ms)), signal = null,
  last = null, sdkVersion = null,
}) {
  if (!sdk.ids.hex32(headId ?? "")) {
    throw new Error("publish: this session has no head yet, so the app would name no data");
  }
  // THE PUBLISHED VERSION (craftworks-sdk#349): a view opened from this app waits until its node has a head at least
  // this new, instead of showing an older one the node still holds. A whole number, or the app would name a floor no
  // view can read.
  if (!Number.isSafeInteger(headSeq) || headSeq < 0) {
    throw new Error(`publish: the published head's seq is ${JSON.stringify(headSeq)}, not a whole number, so a view could not tell an older version from this one`);
  }
  // AND THE APP ID it is written under (craftworks-sdk#267), checked BEFORE anything is PUT.
  try {
    sdk.ids.app(appId ?? "");
  } catch (e) {
    throw new Error(`publish: no app id, so a user could not find this app's data in its tree (${e?.message ?? e})`);
  }
  const code = bytesOf(await read("sdk/webapp.wasm"));
  const put = state => session.put_contract(code, sdk.webapp.params(state), state);
  // THE APP'S LINK (builder#117): the starter is published as the app's SITE,
  // under the person's own authority relabelled `site:<app>` — the same link
  // for every publication, whatever the app's structure. Derived by the SDK.
  const siteCode = bytesOf(await read("sdk/site.wasm"));
  const link = session.site_link(appId, siteCode);

  // 1. The PIECES, as this build cut them: every one's address must be the one the pieces manifest names, or an
  // app would race pieces nobody published. COMPUTED, not learned from a PUT: content-addressed.
  const pieces = JSON.parse(await read("sdk/pieces.json"));
  const pieceStates = [];
  for (const b of ["core", "provisioning"]) {
    const shape = pieces?.[b];
    if (!shape || !Array.isArray(shape.pieces) || shape.pieces.length !== shape.k + shape.m) {
      throw new Error(`publish: sdk/pieces.json has no well-formed ${b} bundle; rebuild (build.sh cuts them)`);
    }
    for (const [i, p] of shape.pieces.entries()) {
      const state = bytesOf(await read(`sdk/pieces/${b}/piece-${i}.webapp`));
      const key = sdk.webapp.address(code, state);
      if (key !== p.address) throw new Error(`the ${b} piece ${i} is ${key}, not the ${p.address} sdk/pieces.json names`);
      pieceStates.push({ what: `the ${b} piece ${i}`, key, state });
    }
  }

  // 2. The STARTER, naming its data (the head of the tree it was built on, at the published version) and the pieces.
  // `seq` null: an app.json from before the published version (its address is the one it had, and it names no floor).
  const piecesBytes = pieceStates.reduce((n, p) => n + p.state.length, 0);
  const build = async seq => {
    const s = await starterOf(app, { sdk, headId, appId, seq, manifest, pieces, read, subtle, code });
    return { web: s.web, result: { address: link, bundleHash: s.bundleHash, bundleBytes: s.bundleBytes, containerBytes: s.state.length, pieces: pieceStates.length, piecesBytes, seq } };
  };

  // NOTHING CHANGED, NOTHING SENT: the same starter BUNDLE at the same link on the same SDK means the pieces
  // (content-addressed) and the site are already on the network. Re-PUTting a container was measured to make the
  // node serve it 404 for a moment (1 run in 3), which the owner hit as "could not resolve artefact"; a site
  // published again would be a new version of the same bytes.
  //
  // THE SAME APP is compared at the LAST publication's seq, never this one's (craftworks-sdk#349, the core dev's
  // ruling): the bundle changes when the APP changes, never when its data does. The seq is refreshed only by a
  // publication that PUTs. The LINK never changes (builder#117).
  if (last?.app_contract_id === link && !!last?.bundle_hash && !!sdkVersion && last?.sdk_version === sdkVersion) {
    const same = await build(last.head_seq ?? null);
    if (same.result.bundleHash === last.bundle_hash) return { ...same.result, put: false };
  }
  const { web, result } = await build(headSeq);

  // 4. PUT every piece, each acknowledged and matched by KEY; and publish the starter as the app's SITE: read,
  // signed as the next version, PUT and read back by the SDK -- ended by the read-back, a refusal or a cancel.
  for (const { what, key, state: bytes } of pieceStates) {
    const k = put(bytes);
    if (k !== key) throw new Error(`the node keyed ${what} ${k}, not the ${key} its content names`);
  }
  const published = session.publish_site(appId, siteCode, web);
  if (published !== link) throw new Error(`the SDK published the site at ${published}, not the ${link} it links`);
  const [, version] = await Promise.all([
    Promise.all(pieceStates.map(({ what, key }) => settled(session, key, what, { everyMs, sleep, signal }))),
    sited(session, appId, { everyMs, sleep, signal }),
  ]);
  return { ...result, version, put: true };
}

/**
 * Wait until the SITE's publication of `appId` ENDS on the network's answer:
 * `published` (the read-back shows this version: resolves to it), or
 * `superseded` (another publication of this site is live — reported, never
 * overwritten: publishing again is the person's act), `refused` in the
 * signer's or node's words, or a person's cancel (`signal`). No time ends it
 * (rule 8); while it waits the SDK says on what (`said`).
 */
export async function sited(session, appId, { everyMs, sleep, signal = null }) {
  for (;;) {
    if (signal?.aborted) session.cancel_site?.(appId);
    const { state, version, said } = JSON.parse(session.site_status(appId));
    if (state === "published") return version;
    if (state === "superseded") throw new Error(`another publication of this app is live: version ${version} — publish again to replace it`);
    if (state === "refused") throw new Error(`the app's site was refused: ${said}`);
    if (state === "cancelled") throw new Error("cancelled: the app's site was not published");
    if (state === "none") throw new Error("the app's site was never sent");
    await sleep(everyMs);
  }
}

/**
 * The STARTER of `app` whose data is the tree `headId` names under `appId`: built by the SDK (deterministic: the same
 * app is the same bytes), never PUT here. Its WEB part is what publish publishes as the app's site (builder#117); its
 * framed `state` is what the build measures against `STARTER_LIMIT`.
 */
export async function starterOf(app, { sdk, headId, appId, seq = null, manifest, pieces, read, subtle, code }) {
  const carried = {};
  for (const [at, from] of Object.entries(starterFiles(manifest, sdk.ids))) carried[at] = await read(from);
  const published = { ...app, publisher: { head: headId, app: appId, ...(seq === null ? {} : { seq }) } };
  const { files, bundleHash, bytes: bundleBytes } = await packageApp(published, { carried, manifest, pieces, subtle, ids: sdk.ids });
  const c = new sdk.webapp.AppContainer();
  for (const [p, v] of Object.entries(files)) c.add(p, bytesOf(v));
  const state = c.finish();
  return { state, web: c.web(), address: sdk.webapp.address(code, state), bundleHash, bundleBytes };
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
