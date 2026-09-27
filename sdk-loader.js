// The one place the builder touches the SDK build. Everything else imports from here.
import { load } from "./sdk/index.js";

// THE SDK A LOADER ALREADY LOADED (§19 P5: the builder published as an app): its entry hands it here before the
// builder's modules run, so the page uses the loader's one instance instead of loading a second from ./sdk/.
// With it, the node that SERVED the builder's page (`port`): the person's own node, the one the builder writes through
// when no `#node=` names another.
// And the contract code the loader rebuilt from its pieces (`{ urls, sha256 }` each): an SDK linked from pieces has
// no `SHIPPED_ARTEFACTS` (nothing is beside it), so these are what the builder opens and provisions with.
let loaded = null, served = 0, pieceArtefacts = null;
export const useLoaded = (sdk, { port = 0, artefacts = null } = {}) => {
  loaded = sdk;
  served = Number.isInteger(port) && port > 0 ? port : 0;
  pieceArtefacts = artefacts;
};
/** The SDK's contract code: shipped beside it, or -- loaded from pieces -- the loader's. */
export const artefactsOf = sdk => sdk?.SHIPPED_ARTEFACTS ?? pieceArtefacts;
/** The node that served this page, when a loader started the builder; 0 otherwise. */
export const servedPort = () => served;

/** Load the SDK once. `wasm` is optional bytes/URL (tests pass bytes; the page lets it fetch). */
export const loadSdk = wasm => (loaded ? Promise.resolve(loaded) : load(wasm));
