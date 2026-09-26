// STUB of the SDK's keep API for the Assets tab (builder#164), in the shapes agreed with engineer2.
//
// THIS FILE IS A SECOND DEFINITION OF THE SESSION SURFACE AND MUST NOT OUTLIVE THE REAL ONE (the architect's condition):
// it is DELETED in the same PR that switches the tab to engineer2's `keepAssets` / `keepReport` / `keepSet` /
// `keepAudit` / `notAnswering({ lane })`, and the tab's tests then run against the real surface. The PR is not
// mergeable while this file exists.
//
// It holds the design's rows (docs/mock/assets-tab.html) so the tab can be built and looked at before the SDK side
// lands. Nothing here is a node, and nothing it says is measured.

const NOW_S = () => Math.floor(Date.now() / 1000);

export function keepStub() {
  const now = NOW_S();
  const assets = [
    { target: "7bb29b3b2fcae053aa", kind: "identity", policy: { repair: "always", warn_below: 2 }, audited_at: now - 120, health: { word: "whole", groups: 14, whole: 14, degraded: 0, damaged: 0 }, warning: null },
    { target: "2uhMr27dFXXWk9AgvWvQ", kind: "app", policy: { repair: { below: 2 }, warn_below: 2 }, audited_at: now - 300, health: { word: "degraded", groups: 13, whole: 12, degraded: 1, damaged: 0 }, warning: "1 group has fewer than 2 blocks to spare (lowest: 1)" },
    { target: "71XasNUMRjJwZLjZehbe", kind: "app", policy: { repair: "always", warn_below: 2 }, audited_at: now - 720, health: { word: "damaged", groups: 10, whole: 9, degraded: 0, damaged: 1 }, warning: null },
    { target: "9D9bAjjKSVoHRTtBk41m", kind: "app", policy: { repair: { below: 3 }, warn_below: 2 }, audited_at: now - 26 * 3600, health: { word: "whole", groups: 3, whole: 3, degraded: 0, damaged: 0 }, warning: null },
    { target: "4BgcWjAqDWBNzjDgykdx", kind: "app", policy: { repair: "off", warn_below: 0 }, audited_at: 0, health: null, warning: null },
  ];
  const reports = new Map([
    ["71XasNUMRjJwZLjZehbe", { state: "done", pass: "full", health: "damaged", whole: 9, degraded: 0, damaged: ["8c1f00aa11223344"], rejected: ["b1"], pending: 0, warning: null }],
    ["9D9bAjjKSVoHRTtBk41m", { state: "running", pass: "full", asked: 212, of: 318 }],
    ["4BgcWjAqDWBNzjDgykdx", { state: "unmeasured" }],
  ]);
  const writes = [];
  return {
    writes,
    keepAssets: () => assets.map(a => ({ ...a })),
    keepReport: target => reports.get(target) ?? null,
    keepSet: (address, policy) => {
      writes.push({ address, policy });
      const a = assets.find(x => x.target === address);
      if (a) a.policy = { ...a.policy, ...policy };
      else if (!/^[1-9A-HJ-NP-Za-km-z]{12,}$/.test(String(address).replace(/^craftec:\/\//, ""))) return { refused: "BAD_ADDRESS", said: `could not read "${address}" as an address` };
      else assets.push({ target: address, kind: "app", policy: { repair: "always", warn_below: 2, ...policy }, audited_at: 0, health: null, warning: null });
      return { ok: true };
    },
    keepAudit: target => { writes.push({ audit: target }); },
    notAnswering: ({ lane } = {}) => (lane === "background" ? { what: "the assets audit", ms: 14_200 } : null),
  };
}
