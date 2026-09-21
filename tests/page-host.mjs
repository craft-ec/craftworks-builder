// THE PAGE HOST every page test uses: a static server and a headless Chrome
// that are PROVABLY this run's and this tree's (builder#70).
//
// Every page test used to bind FIXED ports with `stdio: "ignore"`. Three
// sessions run this suite in three worktrees on one machine, so when another
// run held 8098/9334 the second server failed to bind with nobody listening —
// and the test carried on against the FIRST run's server and Chrome, which
// serve a different tree. A page check could go GREEN on code it never
// loaded. Three things close that, each on its own:
//
//   1. PORT 0, READ BACK. Both children bind a port the OS picks and SAY which
//      (python prints it, Chrome prints its DevTools address). No constant, and
//      no probe-then-bind race.
//   2. A CHILD THAT DIES IS A FAILURE with its own words: its output is kept
//      and printed, never sent to /dev/null.
//   3. THE TREE PROVES ITSELF. A random nonce file is written under this tree's
//      `.page-nonce/` (git-ignored) and must come back through the server —
//      and, once the page is loaded, through the PAGE. That check does not
//      depend on 1 and 2 being right.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Resolve with the first match of `re` in a child's output, or fail naming the child. */
function announced(child, streams, re, what, ms) {
  return new Promise((ok, bad) => {
    let seen = "";
    const timer = setTimeout(() => bad(new Error(`${what} did not say where it listens within ${ms} ms; it said: ${seen.slice(-400) || "(nothing)"}`)), ms);
    const read = chunk => {
      seen += chunk;
      const m = seen.match(re);
      if (m) { clearTimeout(timer); ok(Number(m[1])); }
    };
    for (const s of streams) s.setEncoding("utf8"), s.on("data", read);
    child.once("exit", code => { clearTimeout(timer); bad(new Error(`${what} exited (${code}) before listening; it said: ${seen.slice(-400) || "(nothing)"}`)); });
    child.once("error", e => { clearTimeout(timer); bad(new Error(`${what} could not start: ${e.message}`)); });
  });
}

/**
 * Start this run's server and Chrome. `label` names the test in every message.
 * Returns the ports, the nonce, `done(code)` (kills both, removes the nonce,
 * exits) and `pageProof`, an expression the test evaluates in the page once it
 * has navigated — it must return the nonce.
 */
export async function openPageHost(label, { windowSize = "1280,800", budgetMs = 90_000 } = {}) {
  const kids = [];
  const nonceDir = join(ROOT, ".page-nonce");
  const nonce = randomUUID();
  const done = code => {
    for (const k of kids) k.kill();
    rmSync(join(nonceDir, nonce), { force: true });
    process.exit(code);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => done(1));
  setTimeout(() => { console.error(`${label} FAILED: the run exceeded its ${budgetMs / 1000} s budget`); done(1); }, budgetMs).unref();

  try {
    const server = spawn("python3", ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    kids.push(server);
    const port = await announced(server, [server.stdout, server.stderr], /port (\d+)/, `${label}: page server`, 10_000);

    mkdirSync(nonceDir, { recursive: true });
    writeFileSync(join(nonceDir, nonce), nonce);
    const back = await fetch(`http://127.0.0.1:${port}/.page-nonce/${nonce}`).then(r => (r.ok ? r.text() : `HTTP ${r.status}`), e => `unreachable: ${e.message}`);
    if (back !== nonce) throw new Error(`the server on ${port} is not serving THIS tree (${ROOT}): the nonce came back as ${JSON.stringify(back)}`);

    const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--window-size=${windowSize}`, "--remote-debugging-port=0",
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "cw-page-"))}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
    kids.push(chrome);
    const debug = await announced(chrome, [chrome.stdout, chrome.stderr], /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//, `${label}: chrome`, 30_000);

    const pageProof = `return await (await fetch("/.page-nonce/${nonce}")).text();`;
    return { port, debug, nonce, pageProof, done };
  } catch (e) {
    console.error(`${label} FAILED: ${e.message}`);
    done(1);
  }
}
