// THE BUILDER'S OWN FILES, read through the SDK's one fetch (`served`,
// craftworks-sdk#340): waited on until the builder's server answers, never
// ended by a status. One reader, for the page and for the tools that drive it.
import { served, servedText } from "./sdk/artefacts.js";

/** A file the builder serves, for the app container: text, or bytes for wasm and containers. */
export async function readBuilderFile(path) {
  const source = { url: `./${path}` };
  return /\.(js|html|json)$/.test(path) ? servedText(source) : served(source);
}

/** The SDK's manifest as this builder ships it (`sdk/artefacts.json`). */
export async function readSdkManifest() {
  return JSON.parse(await servedText({ url: "./sdk/artefacts.json" }));
}
