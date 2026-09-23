// PACKAGING AN APP — what a published app IS, as bytes.
//
// `publish()` provisions a node and opens a database. It has never produced
// an app: no bundle, no bundle hash, no contract id. So "Publish" meant "set
// this node up", and the app itself lived only in the tab that built it —
// which is why nothing could roll one back (builder#47) and why an app could
// not be opened from anywhere else.
//
// # AN APP NAMES ITS ARTEFACTS AND CARRIES NONE OF THEM
//
// ARCHITECTURE §19, settled by the owner. The SDK wasm, the two contracts and
// the engine delegate are ordinary content-addressed blocks: the network
// hosts them under ordinary demand and interested keepers keep them, so there
// is no designated home to build. An app carries their HASHES.
//
// Measured on this build: the four wasm artefacts are 1,709,429 B and the
// JavaScript beside them is 109,300 B. So carrying them is 94% of an app's
// bytes, paid again by every app, to ship files every other app already has.
//
// # THE HASH IS THE POINT, NOT THE SIZE
//
// A bundle hash is what makes a publication a THING rather than an event: it
// can be compared, recorded, rolled back to, and asked for again. Rollback
// (builder#47) is blocked on exactly this, so the hash is deterministic by
// construction — the same app packages to the same bytes, and any difference
// in the bundle is a difference in the hash.
//
// No DOM and no network here: packaging is a pure function of an app
// definition and the SDK's manifest, which is what lets it be tested for
// determinism at all.

/** Files whose bytes an app must carry: the SDK's JavaScript, never its wasm. */
export const CARRIED = /\.(js|html|json)$/;

/** The artefacts an app NAMES rather than carries. */
export const NAMED = ["sdk", "signer", "block", "register"];

/**
 * Manifest entries that are the SDK's PUBLISHING tools, not an app's
 * artefacts (builder#104): the artefacts CONTAINER (the one web container
 * holding the app artefacts, with the address the node serves it under) and the
 * `webapp` contract's CODE a builder PUTs containers with. The node runs
 * them; an app never fetches them, so an app never names them.
 *
 * Kept apart from NAMED on purpose, and each by its SHAPE: an entry that
 * reads as an artefact here would be fetched by every app from an address
 * that holds no such file.
 */
export const PLATFORM = {
  container: e => typeof e?.address === "string" && e.address.length > 0 && /^[0-9a-f]{64}$/.test(e?.sha256 ?? ""),
  webapp: e => e?.file === "webapp.wasm" && /^[0-9a-f]{64}$/.test(e?.sha256 ?? ""),
  // The `site` contract's CODE (builder#117): what a published app's ONE
  // stable address runs; the builder PUTs its versions, an app never
  // fetches it.
  site: e => e?.file === "site.wasm" && /^[0-9a-f]{64}$/.test(e?.sha256 ?? ""),
  // The SDK's JavaScript an app CARRIES (its build's reachable set from
  // index.js): what goes into the container, never fetched by hash.
  modules: e => Array.isArray(e) && e.length > 0 && e.every(isModuleName),
};

/** A name `modules` may hold: one JavaScript file beside the SDK's index.js. */
export function isModuleName(m) {
  return typeof m === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(m);
}

/**
 * Artefacts the SDK ships that an app does NOT name yet, each with why.
 * EMPTY since the switch-over: the signer, listed here until then, is NAMED,
 * and the engine delegate it replaces is gone from the SDK. Kept, so the next
 * artefact that ships before an app names it is a one-line entry here rather
 * than a manifest this build refuses.
 */
export const NOT_YET_NAMED = {};

const enc = new TextEncoder();

const hex = bytes =>
  [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");

/**
 * The bundle for one app.
 *
 * `sdkFiles` is `{ path: contents }` for the SDK's shipped JavaScript —
 * whatever `build.sh` put beside the page, filtered by the caller to the
 * files an app actually needs. `manifest` is the SDK's `artefacts.json`,
 * which already carries every artefact's hash (sdk#107), so the names are
 * GENERATED from the build rather than written down a second time.
 *
 * Returns the files, their total size, and the bundle hash.
 */
export async function packageApp(app, { sdkFiles, manifest, artefactsKey, subtle }) {
  if (!artefactsKey) {
    // An app that names no contract has nowhere to fetch its artefacts from
    // and carries none of them, so it would be a bundle that cannot open.
    // The same reasoning as the SDK refusing a key with no origin: naming
    // them is a requirement, not a preference.
    throw new Error(
      "no artefacts contract key. A packaged app carries none of the four " +
        "artefacts, so it must name the contract that holds them.",
    );
  }
  // THE KEY SET MUST EQUAL `NAMED`, not merely contain it.
  //
  // A missing entry is a pin too old to name everything an app needs. An
  // EXTRA one is the direction that goes stale quietly: the SDK grew an
  // artefact, apps carry on naming the four they know about, and the new one
  // is simply never fetched — with nothing anywhere saying so. Both are
  // mismatches between what the SDK ships and what a bundle names, and only
  // one of them announces itself.
  const named = Object.keys(manifest ?? {}).filter(k => k !== "note");
  const missing = NAMED.filter(n => !manifest?.[n]?.sha256);
  const extra = named.filter(k => !NAMED.includes(k) && !(k in PLATFORM) && !(k in NOT_YET_NAMED));
  const misshapen = named.filter(k => k in PLATFORM && !PLATFORM[k](manifest[k]));
  if (misshapen.length) {
    throw new Error(
      `the SDK manifest's ${misshapen.join(", ")} entry is not the shape of a publishing ` +
        "tool (a container names its address; the webapp entry is webapp.wasm), so " +
        "this build cannot tell it from an app artefact — refused rather than guessed.",
    );
  }
  // THE ARTEFACTS KEY IS THE CONTAINER'S ADDRESS when the SDK names one: an
  // app naming any other key would fetch its artefacts from somewhere this
  // SDK build never published them.
  if (manifest?.container && artefactsKey !== manifest.container.address) {
    throw new Error(
      `artefacts key ${artefactsKey} is not this SDK build's artefacts container ` +
        `(${manifest.container.address}): the app would fetch its artefacts from an ` +
        "address this build never published.",
    );
  }
  if (missing.length) {
    throw new Error(
      `the SDK manifest has no hash for: ${missing.join(", ")}. ` +
        "A packaged app names all four artefacts, so this SDK build is too old for it.",
    );
  }
  if (extra.length) {
    throw new Error(
      `the SDK manifest carries artefacts this build does not name: ${extra.join(", ")}. ` +
        "An app would not fetch them, and nothing would say so — add them to NAMED " +
        "or say why they are not an app's to carry.",
    );
  }

  const files = {};
  for (const [path, contents] of Object.entries(sdkFiles)) {
    if (!CARRIED.test(path)) {
      // NOT SILENTLY DROPPED. A caller handing this a wasm file believes the
      // app will carry it; saying so is the difference between a smaller
      // bundle and a broken one.
      throw new Error(
        `${path} is not a file an app carries. The four wasm artefacts are ` +
          "NAMED by hash — pass only the JavaScript and static files.",
      );
    }
    files[path] = contents;
  }

  // WHAT THE APP IS, and what it needs. One file, so a reader can see an
  // app's whole dependency surface without unpacking anything.
  files["app.json"] = JSON.stringify(app, null, 2);
  files["artefacts.json"] = JSON.stringify(
    {
      contract: artefactsKey,
      ...Object.fromEntries(
        NAMED.map(n => [n, { file: manifest[n].file, sha256: manifest[n].sha256 }]),
      ),
      note: "named by hash, carried by nobody: the network hosts them (ARCHITECTURE §19)",
    },
    null,
    2,
  );

  // DETERMINISTIC. Sorted paths, and each entry contributes its path, its
  // length and its bytes — the length so that two files cannot be confused
  // for one by where they happen to join.
  const paths = Object.keys(files).sort();
  const parts = [];
  for (const p of paths) {
    const body = typeof files[p] === "string" ? enc.encode(files[p]) : files[p];
    parts.push(enc.encode(`${p}\n${body.length}\n`), body);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { joined.set(p, at); at += p.length; }

  if (!subtle) throw new Error("no crypto.subtle: cannot hash a bundle");
  const bundleHash = hex(await subtle.digest("SHA-256", joined));

  return {
    files,
    bundleHash,
    bytes: Object.values(files).reduce(
      (n, v) => n + (typeof v === "string" ? enc.encode(v).length : v.length),
      0,
    ),
  };
}

/** What the same app WOULD weigh carrying its artefacts — for the measurement. */
export function weightCarrying(bundleBytes, manifest) {
  return bundleBytes + NAMED.reduce((n, k) => n + (manifest?.[k]?.bytes ?? 0), 0);
}
