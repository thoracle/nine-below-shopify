"""=========================================================================
Shared test harness.

Every suite renders the real preview/index.html — the generated one — in a
real Chromium, against the real assets/ and snippets on disk. That is
deliberate: these tests exist to catch the theme diverging from what it
claims to do, so they must read the same files a browser would.

This replaced jsdom on 5 Aug 2026. jsdom lied in four ways that the old
harness had to paper over, and every one of them is simply gone here:

  · localStorage threw at an opaque origin, so the harness had to invent a
    URL. Pages are served from https://theme.test/ through a route handler,
    which is a real origin with real storage.
  · matchMedia did not exist, and theme.js reads it at the top of its IIFE —
    without a polyfill the whole file threw and nothing under test ran.
  · getComputedStyle did not inherit invisibility, so an element inside a
    display:none parent still reported its own display. Chromium answers the
    real question, so `visible()` is Playwright's own is_visible().
  · the cascade resolved last-wins and ignored !important, so a rule could
    pass the tests for the wrong reason. It is now the real cascade.

The routing layer keeps the two capabilities the jsdom loader had: `mutate`
to damage an asset (or 404 it), and `html` to damage the page itself.
========================================================================="""

import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote

from playwright.sync_api import sync_playwright

# Target and namespace come from the environment, so the suites are not tied to
# this theme. THEME points at any theme root containing preview/index.html.
ROOT = Path(os.environ.get("THEME")
            or Path(__file__).resolve().parent.parent).resolve()
LOG = os.environ.get("LOG", "NINEBELOW_EVENT_LOG")
GKEY = os.environ.get("GKEY", "nb_age_ok")

ORIGIN = "https://theme.test"


class _Drop:
    """Returned by a `mutate` callback to 404 an asset. A distinct sentinel
    because `None` already means "leave this file alone" — conflating the two
    made a dropped asset and an untouched one indistinguishable."""

    def __repr__(self):
        return "DROP"


DROP = _Drop()

# Hosts the suites must never reach.
#
# The theme carries a real measurement ID and defaults consent to granted, so
# every mount is a live GA4 hit unless something stops it. On 5 Aug a single
# afternoon of test runs put 25 users and 427 events into the production
# property — spoofed Instagram, Facebook and TikTok user agents included, since
# the channel suite sets those deliberately. It buried that morning's real
# device pass in synthetic traffic, and GA4 has no undo.
#
# The route handler only ever covered theme.test, so requests to Google went
# straight out. Blocking them here makes the suites hermetic, which they should
# have been from the start: a test that mutates production is not a test.
BLOCKED_HOSTS = (
    "**google-analytics.com/**",
    "**googletagmanager.com/**",
    "**analytics.google.com/**",
    "**google.com/ccm/**",
    "**doubleclick.net/**",
)

# Visibility, judged up the ancestor chain.
#
# Playwright's own is_visible() asks whether the element has a box, which is the
# wrong question for `display: contents` — a legitimate value that renders the
# children while generating no box of its own. The sticky bar's offer wrappers
# use it, so a box test reports both arms hidden and the arm-selection check
# silently passes for the wrong reason.
#
# The ancestor walk is the same shape the jsdom harness used. What has changed
# is that the computed styles behind it are now real: Chromium resolves the
# cascade and honours !important, where jsdom took last-wins and could pass a
# rule that a browser would never apply.
VIS_FN = """
window.__nbVisible = function (el) {
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
    var s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (n.hasAttribute('hidden')) return false;
  }
  return !!el;
};
"""

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}

_IMAGE = re.compile(r"\.(webp|png|jpe?g|gif|ico)$", re.I)

_pw = None
_browser = None


def _browser_once():
    """One browser for the whole run; a fresh context per mount. Contexts are
    cheap and isolate storage, which is what each test actually needs."""
    global _pw, _browser
    if _browser is None:
        _pw = sync_playwright().start()
        _browser = _pw.chromium.launch()
    return _browser


def read_preview():
    """The generated preview, as a browser would receive it. Exported so a suite
    can damage it deliberately — reordering scripts, dropping a tag — and mount
    the result through `mount(html=...)`."""
    return (ROOT / "preview/index.html").read_text(encoding="utf-8")


class Mounted:
    """A live page plus the console/error log for the load."""

    def __init__(self, page, context, logs):
        self.page = page
        self.context = context
        self.logs = logs

    # ---- reading the page ----------------------------------------------

    def eval(self, js):
        return self.page.evaluate(js)

    def events(self):
        return [e["event"] for e in self.page.evaluate(f"window.{LOG} || []")]

    def impressions(self):
        return [e["params"]["experiment_id"]
                for e in self.page.evaluate(f"window.{LOG} || []")
                if e["event"] == "experiment_impression"]

    def params_of(self, name):
        return self.page.evaluate(
            f"(window.{LOG} || []).find(e => e.event === {name!r})?.params || {{}}")

    def log(self):
        return self.page.evaluate(f"window.{LOG} || []")

    def attr(self, selector, name):
        return self.page.evaluate(
            f"document.querySelector({selector!r})?.getAttribute({name!r}) ?? null")

    def root_attr(self, name):
        return self.page.evaluate(
            f"document.documentElement.getAttribute({name!r})")

    def visible(self, selector):
        """Real visibility, ancestors included. Getting this wrong once made a
        perfectly working age gate look like it failed all twelve of its
        blocking tests."""
        return bool(self.page.evaluate(
            "sel => __nbVisible(document.querySelector(sel))", selector))

    def visible_all(self, selector):
        """Visibility for every match, in document order."""
        return self.page.evaluate(
            "sel => [...document.querySelectorAll(sel)].map(__nbVisible)", selector)

    def texts_visible(self, selector):
        """Text of each visible match — the shape most of these assertions want."""
        return self.page.evaluate(
            "sel => [...document.querySelectorAll(sel)]"
            ".filter(__nbVisible).map(e => e.textContent.trim())", selector)

    def exists(self, selector):
        return self.page.locator(selector).count() > 0

    def click(self, selector):
        self.page.locator(selector).first.dispatch_event("click")

    def pass_gate(self):
        self.click('[data-gate-arm="a"] [data-gate-confirm]')

    def wait(self, ms):
        self.page.wait_for_timeout(ms)

    def set_value(self, selector, value):
        """Type into a field the way a person does: set it, then fire `input`,
        which is what the gate listens for."""
        self.page.evaluate(
            """([sel, val]) => {
                 const el = document.querySelector(sel);
                 el.value = val;
                 el.dispatchEvent(new Event('input', { bubbles: true }));
               }""", [selector, value])

    def submit(self, selector):
        self.page.evaluate(
            """sel => document.querySelector(sel).dispatchEvent(
                 new Event('submit', { bubbles: true, cancelable: true }))""",
            selector)

    def prop(self, selector, path="value"):
        """Read a live DOM property (`hidden`, `value`, `style.opacity`) rather
        than an attribute — several of these are only ever set as properties."""
        return self.page.evaluate(
            f"sel => {{ const el = document.querySelector(sel);"
            f" return el ? el.{path} : null; }}", selector)

    def focused(self, selector):
        return self.page.evaluate(
            "sel => document.activeElement === document.querySelector(sel)", selector)

    def cookie(self):
        return self.page.evaluate("document.cookie")

    def storage(self, key):
        return self.page.evaluate(
            f"() => {{ try {{ return localStorage.getItem({key!r}); }}"
            f" catch (e) {{ return null; }} }}")

    def close(self):
        self.context.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def mount(search="", ua=None, referrer=None, html=None, mutate=None,
          js=True, age_pass=None, settle=250, viewport=None):
    """Render the preview.

    search    query string, e.g. '?ch=ig'
    ua        user agent to report
    referrer  document.referrer
    html      override the page source (for damage simulation)
    mutate    (path, body) -> body | None to 404 | unchanged if it returns None-ish
    js        False to render with scripting disabled
    age_pass  stored age pass; None for a fresh visitor
    viewport  {"width": w, "height": h}; the default is desktop. Anything that
              lives inside a media query has to be mounted at a width where it
              actually exists — the sticky buy bar is mobile-only.
    """
    browser = _browser_once()
    context = browser.new_context(
        user_agent=ua,
        java_script_enabled=js,
        viewport=viewport or {"width": 1280, "height": 900},
    )

    logs = []
    page = context.new_page()
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"throw: {e}"))

    def handler(route, request):
        rel = unquote(request.url.split("theme.test/", 1)[1].split("?")[0])
        rel = re.sub(r"^preview/\.\./", "", rel)

        if _IMAGE.search(rel):
            # Images are skipped — they are large, no assertion depends on
            # them, and loading them makes every suite slow.
            return route.abort()

        if rel == "preview/index.html" and html is not None:
            return route.fulfill(status=200, content_type=_MIME[".html"], body=html)

        p = ROOT / rel
        try:
            body = p.read_text(encoding="utf-8")
        except OSError:
            return route.abort()

        if mutate:
            out = mutate(rel, body)
            if out is DROP:
                return route.abort()
            if out is not None:
                body = out

        ext = p.suffix.lower()
        return route.fulfill(status=200,
                             content_type=_MIME.get(ext, "text/plain; charset=utf-8"),
                             body=body)

    context.route(f"{ORIGIN}/**", handler)
    for pattern in BLOCKED_HOSTS:
        context.route(pattern, lambda route, request: route.abort())

    context.add_init_script(VIS_FN)

    if age_pass:
        # The age pass must exist BEFORE parsing: the head snippet reads
        # storage during parse, so seeding afterwards is already too late.
        context.add_init_script(
            f"try {{ localStorage.setItem({GKEY!r}, {age_pass!r}); }} catch (e) {{}}")

    page.goto(f"{ORIGIN}/preview/index.html{search}", referer=referrer,
              wait_until="load")
    page.wait_for_timeout(settle)
    return Mounted(page, context, logs)


def shutdown():
    global _pw, _browser
    if _browser:
        _browser.close()
        _browser = None
    if _pw:
        _pw.stop()
        _pw = None


# A stored pass far enough in the future to still be valid.
def make_pass(ms_ahead=900_000_000):
    import json
    import time
    return json.dumps({"v": True, "exp": int(time.time() * 1000) + ms_ahead})


PASS = make_pass()

# The sticky buy bar is `display: none` above 900px by design, so every
# assertion about it has to be made at a width where it exists. Paid social
# traffic is overwhelmingly mobile, which is the point of the bar.
PHONE = {"width": 390, "height": 844}


# ---- assertions ---------------------------------------------------------

_state = {"pass": 0, "fail": 0, "name": ""}

_GREEN = "\033[32m"
_RED = "\033[31m"
_BOLD = "\033[1m"
_OFF = "\033[0m"


def suite(name):
    _state["name"] = name
    print(f"\n{_BOLD}{name}{_OFF}")


def section(text):
    print(f"\n  {text}")


def ok(label, condition, detail=""):
    if condition:
        _state["pass"] += 1
        print(f"    {_GREEN}ok{_OFF}   {label}" + (f"  {detail}" if detail else ""))
    else:
        _state["fail"] += 1
        print(f"    {_RED}FAIL{_OFF} {label}" + (f"  {detail}" if detail else ""))
    return bool(condition)


def eq(label, actual, expected):
    same = actual == expected
    return ok(label, same, "" if same else f"got {actual!r} want {expected!r}")


def done():
    shutdown()
    p, f = _state["pass"], _state["fail"]
    if f:
        print(f"\n  {_RED}{f} failed{_OFF}, {p} passed\n")
    else:
        print(f"\n  {_GREEN}all {p} passed{_OFF}\n")
    sys.exit(1 if f else 0)
