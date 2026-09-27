// THE BUILDER'S OWN FILES, read through the SDK's one fetch (`served`,
// craftworks-sdk#340): waited on until the builder's server answers, never
// ended by a status. One reader, for the page and for the tools that drive it.
import { served, servedText } from "./sdk/served.js";

// THE BUILDER'S OWN FILES WHEN A LOADER STARTED IT (§19 P5: the builder published as an app): its `f/` records,
// handed over by its entry. Read from here first; a file not among them is fetched as before.
let own = null;
export const useOwnFiles = files => { own = files instanceof Map ? files : null; };
/** An own file's TEXT when the loader handed it over, else null. */
export const ownText = path => (own?.has(path) ? new TextDecoder().decode(own.get(path)) : null);

/** A file the builder serves, for the app container: text, or bytes for wasm and containers. */
export async function readBuilderFile(path) {
  if (own?.has(path)) return /\.(js|html|json)$/.test(path) ? ownText(path) : own.get(path);
  const source = { url: `./${path}` };
  return /\.(js|html|json)$/.test(path) ? servedText(source) : served(source);
}

/** The SDK's manifest as this builder ships it (`sdk/artefacts.json`). */
export async function readSdkManifest() {
  return JSON.parse(await servedText({ url: "./sdk/artefacts.json" }));
}
