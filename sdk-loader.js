// The one place the builder touches the SDK build. Everything else imports from here.
import init, * as sdk from "./sdk/craftworks_sdk.js";

let ready;
/** Load the SDK once. `wasm` is optional bytes/URL (tests pass bytes; the page lets it fetch). */
export function loadSdk(wasm) {
  ready ??= init(wasm === undefined ? undefined : { module_or_path: wasm }).then(() => sdk);
  return ready;
}
