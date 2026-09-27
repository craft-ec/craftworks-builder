// WHAT ws-lose's OWN LOG SAYS HAPPENED (the realnet lose-data step, builder#176/#179): read from the proxy's JSON lines
// (craftworks-sdk probe::lose -- `chosen`, `not_found`, `answered`), and the two things an arm needs before its outcome
// counts. Kept apart from the demo so the judgement is tested offline on the lines a run would log.

/** The proxy's lines (`lines`: its parsed JSON values) as the evidence the step reads. */
export function evidence(lines) {
  const c = lines.find(x => x.chosen) ?? null;
  const distinct = new Set(lines.filter(x => x.not_found).map(x => x.not_found));
  const notFound = lines.reduce((n, x) => Math.max(n, x.not_found_total ?? 0), 0);
  const answered = new Set(lines.filter(x => x.answered).map(x => x.answered));
  return {
    chosen: c && { group: c.chosen, k: c.k, lost: c.lost, lostData: c.lost_data ?? [], survivors: c.survivors ?? null },
    notFound,
    distinct: [...distinct],
    answered: [...answered],
  };
}

// NON-VACUITY (the architect on #179): the loss HAPPENED -- every lost DATA member was asked and answered NotFound (so a
// row read is a decode), and nothing outside the lost set was. Not every lost PARITY block need be asked: a repair ends
// at k, and the page withdraws its GETs still queued. Otherwise the arm proves nothing: VOID, never a pass.
export const happened = ev =>
  !!ev.chosen && ev.chosen.lostData.length > 0 && ev.chosen.lostData.every(id => ev.distinct.includes(id)) && ev.distinct.every(id => ev.chosen.lost.includes(id));

// AND THE READER HELD EVERYTHING THE NETWORK HAS (the architect on #541, every arm): each SURVIVING slot was asked and
// answered with BYTES. Then with m + 1 lost, not reading is the true outcome -- not a repair that never reached for
// parity (Codex: asking all k data members and no parity reached "asked >= k") -- and with m lost the read decoded from
// exactly the survivors. Otherwise VOID. A run where this is never reached is a finding about repair, never a reason
// to weaken it.
export const held = ev =>
  Array.isArray(ev.chosen?.survivors) && ev.chosen.survivors.length > 0 && ev.chosen.survivors.every(id => ev.answered.includes(id));

/** The VOID line for an arm that did not hold every survivor. */
export const voidHeld = (name, ev) =>
  `LOSE ${name}: VOID -- the reader was answered with bytes for ${ev.chosen?.survivors?.filter(id => ev.answered.includes(id)).length ?? 0} of the group's ${ev.chosen?.survivors?.length ?? "(unnamed)"} surviving slots: it did not hold everything the network has`;
