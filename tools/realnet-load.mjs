// A NODE PAGE'S LOAD IN THE DEMO, waited for with the STEP's own budget -- never the CDP call's 30 s. A fresh node's
// first GET of an app runs to 60+ s (F60; #153 measured a 65 s join), so a 30 s cut-off was smaller than the thing
// it measured, and a step "broke" on it with no SDK code run (sdk#440's realnet, step 12). The load's time is said
// as a TIME line: a measurement, never the verdict -- the step's own check decides.
/** Navigate `tab` to `url` (or reload it, when `url` is null), waiting at most `ms` for the load; say how long. */
export async function loadPage(tab, url, { ms, what, say = console.log }) {
  if (!(ms > 0)) throw new Error(`loadPage: no budget for ${what}`);
  const t0 = Date.now();
  if (url === null) await tab.reload({ ms });
  else await tab.navigate(url, { ms });
  const took = Date.now() - t0;
  say(`TIME  ${what}: page load ${took} ms (budget ${ms} ms)`);
  return took;
}
