// The one place the builder touches the SDK build. Everything else imports from here.
import { load } from "./sdk/index.js";

// THE SDK A LOADER ALREADY LOADED (§19 P5: the builder published as an app): its entry hands it here before the
// builder's modules run, so the page uses the loader's one instance instead of loading a second from ./sdk/.
let loaded = null;
export const useLoaded = sdk => { loaded = sdk; };

/** Load the SDK once. `wasm` is optional bytes/URL (tests pass bytes; the page lets it fetch). */
export const loadSdk = wasm => (loaded ? Promise.resolve(loaded) : load(wasm));
