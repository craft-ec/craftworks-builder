// PUTTING AN APP'S SITE ON THE NETWORK (ARCHITECTURE §19, the bootstrap; app-as-data P5). An app is DATA in its
// owner's tree: its definition, written by the builder's draft doors and published by ONE `publishDefinition`. A
// site holds only what freenet needs to serve a page -- the build's STARTER (index.html, the loader, the
// decode-only wasm, the SDK's pre-SDK modules and `artefacts.json` naming the build's ONE piece set) plus the SDK's
// pointer to the owner's tree -- so it is written at an app's FIRST publish and when the build changes, never per
// app version, through the SDK's `publish_app` (pieces first, the site at k).
//
// The piece set: the SDK wasm, the SDK's other JavaScript, the runtime and the contract code, as ONE bundle cut
// into k + m pieces (the SDK's `load-pieces`, at build time); each piece its own content-addressed container.
import { packageStarter } from "./package-app.js";

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
  // The loader reads the app from its owner's tree (§19): a definition as the runtime's app, or its own code.
  "definition.js": "definition.js",
  "app-code.js": "app-code.js",
};

/** The PROVISIONING pieces' files, by bundle path -> builder file: raced only at a first write. */
export const PROVISIONING_FILES = {
  "sdk/signer.wasm": "sdk/signer.wasm",
  "sdk/block.wasm": "sdk/block.wasm",
  "sdk/register.wasm": "sdk/register.wasm",
  // The site code: the loader recomputes its own link from the pointer with it (sdk.openPointer).
  "sdk/site.wasm": "sdk/site.wasm",
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

/** THE build's ONE bundle (its piece set, `app`): the core files and the contract code, by bundle path -> file. */
export function appBundleFiles(manifest, ids) {
  return { ...coreFiles(manifest, ids), ...PROVISIONING_FILES };
}

/** Every file the STARTER carries, by its path in it -> builder file. */
export function starterFiles(manifest, ids) {
  return { ...STARTER_FILES, ...Object.fromEntries(sdkStarter(manifest, ids).map(m => [`sdk/${m}`, `sdk/${m}`])) };
}

const enc = new TextEncoder();
const bytesOf = v => (typeof v === "string" ? enc.encode(v) : v);

/**
 * The build's STARTER as an SDK container (`sdk.webapp.AppContainer`), and its bundle hash: the same build is the same
 * bytes, so "the site is current" is a hash compare. `container` is what `publish_app` takes; `state` is its framed
 * size, which the build measures against `STARTER_LIMIT`.
 */
export async function starterOf({ sdk, manifest, pieces, read, subtle }) {
  const carried = {};
  for (const [at, from] of Object.entries(starterFiles(manifest, sdk.ids))) carried[at] = await read(from);
  const { files, bundleHash, bytes } = await packageStarter({ carried, manifest, pieces, subtle, ids: sdk.ids });
  const container = () => {
    const c = new sdk.webapp.AppContainer();
    for (const [p, v] of Object.entries(files)) c.add(p, bytesOf(v));
    return c;
  };
  return { container, bundleHash, bundleBytes: bytes, state: container().finish() };
}

/**
 * PUBLISH `appId` (ARCHITECTURE §19): its definition, in ONE write (`db.publishDefinition`), and -- only at its first
 * publish, or when this BUILD differs from the one its site carries (`last`: the project's recorded publication; same
 * link, same starter bundle, same SDK) -- its SITE, in the same call (`publishDefinition({ site })`, sdk#560: the
 * build's piece set PUT, then the starter + the SDK's pointer to this tree at k). Resolves only once the site reads
 * PUBLISHED (`app_publish_status`), never when the call returns: a link that does not open yet is never handed out.
 */
export async function publishSite(appId, {
  sdk, db, session, manifest, read, subtle, last = null, sdkVersion = null,
  everyMs = 200, sleep = ms => new Promise(r => setTimeout(r, ms)), signal = null,
}) {
  try {
    sdk.ids.app(appId ?? "");
  } catch (e) {
    throw new Error(`publish: no app id, so the app has no site to create (${e?.message ?? e})`);
  }
  const siteCode = bytesOf(await read("sdk/site.wasm"));
  const link = session.site_link(appId, siteCode);
  const pieces = JSON.parse(await read("sdk/pieces.json"));
  const set = pieces?.app;
  if (!set || !Array.isArray(set.pieces) || set.pieces.length !== set.k + set.m) {
    throw new Error("publish: sdk/pieces.json has no well-formed `app` piece set; rebuild (build.sh cuts it)");
  }
  const starter = await starterOf({ sdk, manifest, pieces, read, subtle });
  const result = { address: link, bundleHash: starter.bundleHash, bundleBytes: starter.bundleBytes, pieces: set.pieces.length };
  // THE SITE IS CURRENT: the same starter at the same link on the same SDK -- nothing is sent.
  if (last?.app_contract_id === link && last?.bundle_hash === starter.bundleHash && !!sdkVersion && last?.sdk_version === sdkVersion) {
    await db.publishDefinition();
    return { ...result, put: false };
  }
  const webappCode = bytesOf(await read("sdk/webapp.wasm"));
  const states = [];
  for (const i of set.pieces.keys()) states.push(bytesOf(await read(`sdk/pieces/app/piece-${i}.webapp`)));
  const sent = await db.publishDefinition({ site: { set: { name: "app", ...set }, webappCode, pieceStates: states, siteCode, starter: starter.container() } });
  if (sent?.link !== link) throw new Error(`the SDK published the site at ${sent?.link}, not the ${link} it links`);
  for (;;) {
    if (signal?.aborted) session.cancel_app_publish?.(appId);
    const { state, version, said } = JSON.parse(session.app_publish_status(appId));
    if (state === "published" || state === "backed_up" || state === "backup_abandoned") return { ...result, version, put: true };
    if (state === "refused") throw new Error(`the app's site was refused: ${said}`);
    if (state === "superseded") throw new Error(`another publication of this app's site is live: version ${version}`);
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
