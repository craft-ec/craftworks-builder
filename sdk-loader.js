// The one place the builder touches the SDK build. Everything else imports from here.
import { load } from "./sdk/index.js";

/** Load the SDK once. `wasm` is optional bytes/URL (tests pass bytes; the page lets it fetch). */
export const loadSdk = wasm => load(wasm);
