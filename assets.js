// THE ASSETS TAB'S VIEW (KEEPER.md §1, §3; builder#164's design). No DOM: `assets-panel.js` paints what this returns.
//
// The tab is a VIEW of the SDK's keep API and derives nothing the audit knows (one owner per fact):
//   - the list is `keepAssets()` (the identity's own tree + every keep record, KEEPER §2) -- never a second list;
//   - the health word, the warning and the counts are the SDK's (`health`, `warning`, the report's numbers);
//   - "not answering" is `notAnswering({ lane: "background" })`, the one function over the page's waits.
// What this file adds is only presentation: a row's NAME (the builder's own projects label the apps it published; any
// other asset is named by its address, since a keep record carries no name), and the words a person reads.

/** The repair policy as a person reads it. */
export const repairWords = r => (r === "always" ? "always (keep backed up)" : r === "off" ? "off (watch only)" : `below ${r.below}`);

const short = id => `${String(id).slice(0, 12)}…`;

/** "2 min ago" from a whole-seconds `audited_at` (0 = never) and the page's clock in ms. */
export function ago(auditedAt, nowMs) {
  if (!auditedAt) return "never";
  const s = Math.max(0, Math.round(nowMs / 1000 - auditedAt));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return s < 172_800 ? "yesterday" : `${Math.round(s / 86_400)} days ago`;
}

/**
 * The tab's rows. `assets`: `keepAssets()`. `reports`: target → `keepReport(target)` (null when no pass ran this
 * session). `labels`: target → the builder's own name for an app it published. `waiting`: `notAnswering({ lane:
 * "background" })`. Returns `{ running, rows }`.
 */
export function assetsView({ assets, reports = new Map(), labels = new Map(), waiting = null, nowMs }) {
  const rows = assets.map(a => {
    const report = reports.get(a.target) ?? null;
    const running = report?.state === "running";
    const unmeasured = report?.state === "unmeasured" || a.health?.word === "unmeasured";
    // The word: the live pass's when it finished this session, else the record's last full pass (both the SDK's).
    const done = report?.state === "done" ? report : null;
    const word = running ? "auditing" : unmeasured ? "unmeasured" : (done?.health ?? a.health?.word ?? "never audited");
    const counts = done ?? (a.health?.word ? a.health : null);
    const notes = [];
    if (running) notes.push({ kind: "progress", text: `${report.asked} of ${report.of} blocks asked` });
    if (unmeasured) notes.push({ kind: "mute", text: "this node has no signer for you yet — nothing was asked, nothing assumed missing" });
    const warning = done?.warning ?? (running ? null : a.warning);
    if (!running && !unmeasured && warning) notes.push({ kind: "warn", text: warning });
    for (const g of done?.damaged ?? []) notes.push({ kind: "damaged", text: `group ${short(g)}: fewer than k blocks anywhere — cannot be rebuilt` });
    const rejected = done?.rejected?.length ?? 0;
    if (rejected) notes.push({ kind: "damaged", text: `${rejected} block${rejected === 1 ? "" : "s"} refused by the node (encoding, or a node on another contract epoch)` });
    const pending = done?.pending ?? 0;
    return {
      target: a.target,
      name: labels.get(a.target) ?? (a.kind === "identity" ? "Your data" : short(a.target)),
      sub: a.kind === "identity" ? "your identity's tree" : labels.has(a.target) ? "your published app" : "an app you keep",
      word,
      notes,
      groups: counts && !running ? `${counts.whole} · ${counts.degraded} · ${counts.damaged?.length ?? counts.damaged}` : "— · — · —",
      last: ago(a.audited_at, nowMs),
      lastNote: running && a.health?.word ? `last result: ${a.health.word}` : pending ? `${pending} block${pending === 1 ? "" : "s"} pending (silent) — asked again next pass` : null,
      repair: repairWords(a.policy.repair),
      warnBelow: a.policy.warn_below,
      canAudit: !running && !unmeasured,
    };
  });
  const live = assets.map(a => [a, reports.get(a.target)]).find(([, r]) => r?.state === "running");
  const running = live && {
    target: live[0].target,
    name: rows.find(r => r.target === live[0].target).name,
    pass: live[1].pass,
    asked: live[1].asked,
    of: live[1].of,
    waiting: waiting && /assets audit/.test(waiting.what) ? `node not answering the assets audit for ${Math.round(waiting.ms / 1000)} s — asked again, still waiting` : null,
  };
  return { running: running ?? null, rows };
}
