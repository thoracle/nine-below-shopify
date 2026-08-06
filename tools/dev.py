#!/usr/bin/env python3
"""=========================================================================
dev — the whole toolchain for this theme.

    python3 tools/dev.py build     regenerate preview/index.html
    python3 tools/dev.py test      run every suite
    python3 tools/dev.py check     build, then test  (use this one)
    python3 tools/dev.py verify    rebuild and prove the build is deterministic
    python3 tools/dev.py serve     http://localhost:8090/preview/

This replaced package.json on 5 Aug 2026. Shopify ignores tooling files
either way; the point is that the theme now needs Python and nothing else.

Setup, once:

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    .venv/bin/playwright install chromium

Then run everything through .venv/bin/python.
========================================================================="""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable

# Discovered, not listed. This was a hardcoded list until 6 Aug, and a new
# suite that nobody remembered to add to it would sit in the repo passing
# nothing — `check` would report every suite green while silently running one
# fewer than exists. Sorted so the run order is stable.
SUITES = sorted(p.stem for p in (ROOT / "tests").glob("test_*.py"))

GREEN, RED, BOLD, OFF = "\033[32m", "\033[31m", "\033[1m", "\033[0m"


def build():
    return subprocess.run([PY, str(ROOT / "tools/build_preview.py")], cwd=ROOT).returncode


def verify():
    """The build is deterministic: a re-run on unchanged input is byte-identical.
    That property is what makes a dirty preview/index.html in `git status` mean
    something — it says an upstream file changed and was not rebuilt. If this
    ever fails, the generator has acquired a dependency on the clock, the
    filesystem order or the environment, and the guarantee is gone."""
    target = ROOT / "preview/index.html"
    before = target.read_bytes()
    if build() != 0:
        return 1
    after = target.read_bytes()
    if before == after:
        print(f"  {GREEN}deterministic{OFF}  preview/index.html unchanged on rebuild")
        return 0
    print(f"  {RED}NOT deterministic{OFF}  the rebuild changed preview/index.html")
    print("  If you edited the theme this is expected — commit the new preview.")
    print("  If you did not, the generator has become environment-dependent.")
    return 1


def test():
    failed = []
    for name in SUITES:
        r = subprocess.run([PY, str(ROOT / "tests" / f"{name}.py")], cwd=ROOT)
        if r.returncode != 0:
            failed.append(name)

    print("\n" + "-" * 58)
    for name in SUITES:
        mark = f"{RED}FAIL{OFF}" if name in failed else f"{GREEN}PASS{OFF}"
        print(f"  {mark}  {name}")
    print("-" * 58)
    if failed:
        print(f"\n{RED}{len(failed)} suite(s) failed{OFF}\n")
        return 1
    print(f"\n{GREEN}all {len(SUITES)} suites passed{OFF}\n")
    return 0


def serve():
    print("http://localhost:8090/preview/")
    # Served from the theme ROOT, not preview/ — the page loads ../assets/*.
    return subprocess.run([PY, "-m", "http.server", "8090"], cwd=ROOT).returncode


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "build":
        return build()
    if cmd == "test":
        return test()
    if cmd == "verify":
        return verify()
    if cmd == "serve":
        return serve()
    if cmd == "check":
        return build() or test()
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
