# craftworks-builder

Drag-and-drop app builder. Components bind to paths in the tree; each is enabled
the phase its substrate capability lands. 
    ../craftworks-sdk/build.sh && ./build.sh    # bring in the SDK
    ./serve.sh                                  # http://127.0.0.1:8088
    npm test

The builder reaches the platform only through the SDK (`sdk-loader.js`).

The builder always shows the data structure: the tree address, the key ranges the
app uses (left), and for the selected component its primitive, schema, key
patterns, contracts and where writes go (right). `catalogue.js` is the source of
that mapping and is validated by `tests/catalogue.test.mjs`. An app definition can
be passed in the URL: `#app=<json>`.

**Preview** runs the app inside the builder over the SDK (`runtime.js`; the published app will use the same module). Table, Form and List are live; the tree panel shows real record counts; an app's `schemas` and `seed` rows are part of its definition. `npm test` includes a real-browser test that drives headless Chrome (set `CHROME` if it lives elsewhere).

## Versions panel

A chip at the bottom-left opens what this builder is actually running: the
builder's own commit, the SDK revision it was built against beside the revision
the loaded wasm says it is, the tree library and format tag that wasm links, the
four contract hashes, and a Copy-diagnostics button.

Every value is read from an artefact. `./build.sh` writes `build-info.json` from
git, `SDK_REV`, and `freenet-contracts`; the SDK's own half comes from
`buildInfo()` inside the wasm at runtime. Nothing is typed into the UI, and
nothing that cannot be read is given a plausible-looking default — a missing
input shows as `—` with the reason, because a version display that can be
confidently wrong is worse than none.

| value | read from |
|---|---|
| builder commit, `-dirty` | `git` in this repo, at build time |
| SDK pinned rev | `SDK_REV` |
| what the loaded SDK says | `buildInfo().rev` from the wasm, at runtime |
| freenet-prolly rev, format tag | `buildInfo()` |
| contract hashes | `freenet-contracts/build/hashes.toml`, COPIED — never re-hashed here, because the number that matters is the one Freenet keys the contract by |
| released as epoch N | matched per hash against `freenet-contracts/released.toml` |

The comparison the panel exists for is **the loaded SDK's own revision against
`SDK_REV`**, which catches `sdk/` holding a build from somewhere else. It has
three states, not two: verified, MISMATCH, and not-yet-verified — the SDK can
only report what it is once its wasm has loaded, and a check that has not run is
not a check that passed. Diagnostics copied before the SDK loads say so.

A `-dirty` revision is neutral in a dev tree, where everything is always dirty,
and becomes a warning when `BUILDER_PROFILE=release` or `CI` is set. A mismatch
is an alarm in every profile.

`tests/versions.test.mjs` pins the comparisons; `tests/versions-provenance.test.mjs`
pins where each value came from, by reading the same artefacts independently. The
second one is what a constant typed into `versions.js` would fail.

## Screenshots of the palette

| file | state |
|---|---|
| `palette-phases-no-drift.png` | every component's phase chip, as §21 defines them |
| `palette-phases-drift.png` | the same palette with the drift banner |
| `palette-phase-14-chat.png` | after Phase 13 (Compute — craftvm) was inserted: Chat reads **phase 14** |

## Screenshots of the versions panel

In `docs/`, committed rather than described, because the screenshot is a gate
for a REVIEWER and a path on the author's machine renders as nothing for anyone
else.

| file | state |
|---|---|
| `versions-panel-verified.png` | the normal state: the loaded SDK matches the pinned revision |
| `versions-panel-mismatch.png` | `sdk/` holding one build while `SDK_REV` names another — the failure the panel exists for, reproduced rather than mocked |
| `versions-panel-contracts.png` | the four contract hashes, read from `freenet-contracts/build/hashes.toml` |
| `versions-panel-no-drift.png` | a project on the versions it records |
| `versions-panel-drift.png` | a project pinned to an older SDK and contract, with the upgrade offer |
