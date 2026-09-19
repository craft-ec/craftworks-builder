// The vendored SDK must be the revision this repo pins. Without this, `sdk/`
// could be anything a previous build or a hand copy left behind — and `sdk/` is
// gitignored, so nothing else would notice.
import assert from "node:assert";
import { readFileSync } from "node:fs";
const at = p => new URL(p, import.meta.url);
const pinned = readFileSync(at("../SDK_REV"), "utf8").trim();
const built = readFileSync(at("../sdk/REV"), "utf8").trim();
assert.match(pinned, /^[0-9a-f]{7,40}$/, "SDK_REV must be a revision");
assert.strictEqual(built, pinned, "sdk/ was built from a different revision — run ./build.sh");
console.log(`ok sdk pinned at ${pinned}`);
