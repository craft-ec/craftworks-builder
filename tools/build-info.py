#!/usr/bin/env python3
"""Write build-info.json: what this builder build IS, read from artefacts.

Nothing here invents a value. Every field is read from a file or from git, and
anything that cannot be read becomes an explicit absence with the reason,
because a version display that can be confidently wrong is worse than none.

The contract hashes are COPIED from freenet-contracts, never recomputed here.
The number that matters is the hash Freenet keys the contract by, and that is
produced by the one script that builds the wasm; a second hashing here would
match it only by luck of using the identical algorithm over identical bytes,
and any drift would put an authoritative-looking number on screen that matches
nothing.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
CONTRACTS = Path(os.environ.get("CRAFTWORKS_CONTRACTS", HERE.parent / "freenet-contracts"))


def git(*args, cwd=HERE):
    try:
        out = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def rev_of(repo):
    """`abc1234`, `abc1234-dirty`, or None. Dirty because a rev that names a
    commit whose code is not what was built is the confidently-wrong value."""
    head = git("rev-parse", "--short=7", "HEAD", cwd=repo)
    if not head:
        return None
    status = git("status", "--porcelain", cwd=repo)
    return f"{head}-dirty" if status else head


def parse_toml_tables(text):
    """A deliberately small reader for the two shapes this needs.

    Not a TOML library: these two files are generated and hand-kept to a fixed
    shape, and a dependency for them would be more surface than the feature.
    Anything it cannot read comes back missing, which the caller reports rather
    than papers over.
    """
    top, tables, arrays = {}, {}, {}
    cur, cur_name, cur_is_array = top, None, False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[["):
            cur_name = line[2:-2].strip()
            cur = {}
            arrays.setdefault(cur_name, []).append(cur)
            cur_is_array = True
            continue
        if line.startswith("["):
            cur_name = line[1:-1].strip()
            if cur_is_array and "." in cur_name and arrays:
                # `[epoch.code]` belongs to the last `[[epoch]]`.
                head, tail = cur_name.split(".", 1)
                if head in arrays and arrays[head]:
                    cur = arrays[head][-1].setdefault(tail, {})
                    continue
            cur = tables.setdefault(cur_name, {})
            cur_is_array = False
            continue
        m = re.match(r'^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*$', line)
        if m:
            cur[m.group(1)] = m.group(2)
            continue
        m = re.match(r"^([A-Za-z0-9_-]+)\s*=\s*([0-9]+)\s*$", line)
        if m:
            cur[m.group(1)] = int(m.group(2))
    return top, tables, arrays


def contracts_block():
    path = CONTRACTS / "build" / "hashes.toml"
    if not path.is_file():
        return {
            # Named relatively: the absolute path wrapped to four lines in the
            # panel and carried whoever built it home directory.
            "reason": "not available in this build — freenet-contracts/build/"
            "hashes.toml was not found (freenet-contracts#32 writes it; "
            "run that repo's ./build.sh)"
        }
    top, tables, _ = parse_toml_tables(path.read_text())
    code = tables.get("code", {})
    if not code:
        return {"reason": f"{path} has no [code] table"}
    return {
        "rev": top.get("rev"),
        "built": top.get("built"),
        "code": code,
        "source": str(path),
    }


def released_epochs():
    path = CONTRACTS / "released.toml"
    if not path.is_file():
        return []
    _, _, arrays = parse_toml_tables(path.read_text())
    return arrays.get("epoch", [])


def main():
    sdk_rev_file = HERE / "SDK_REV"
    info = {
        "builder": {
            "version": (HERE / "package.json").is_file()
            and json.loads((HERE / "package.json").read_text()).get("version", "0.0.0")
            or "0.0.0",
            "rev": rev_of(HERE) or "unknown",
            "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            # A dirty rev is neutral in a dev tree and an alarm in a release
            # build; the builder cannot tell the difference, so it is told.
            "profile": os.environ.get("BUILDER_PROFILE")
            or ("release" if os.environ.get("CI") else "dev"),
        },
        "sdkRev": sdk_rev_file.read_text().strip() if sdk_rev_file.is_file() else None,
        "contracts": contracts_block(),
        "released": released_epochs(),
    }
    sys.stdout.write(json.dumps(info, indent=2) + "\n")


if __name__ == "__main__":
    main()
