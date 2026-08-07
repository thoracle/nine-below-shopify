"""Which traffic is ours, and which is a visitor's.

GA4's internal-traffic filter excludes every event whose `traffic_type`
matches a configured value. Until 6 Aug the theme sent that value as a
build-wide constant, so it labelled *everybody* — which is why the filter
could never be activated: an Exclude on it would have dropped 100% of the
property, and excluded data is not recoverable.

The resolution now happens at runtime. These tests exist mostly to pin down
the direction the marking is allowed to be wrong in. Under-marking is a
nuisance: our own walkthroughs land in the reports and we know when we ran
them. Over-marking is silent and permanent: a live ad link that resolves to
`internal` disappears from reporting while the charts still fill in from
everyone else. So the guardrail section below — the params that legitimately
appear in the wild and must never mark — is the part worth keeping."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (done, eq, mount, ok, read_preview,  # noqa: E402
                     section, suite)

suite("traffic type")

# The label the theme sends for internal traffic. It has to match the value on
# the GA4 data filter character for character; a mismatch excludes nothing and
# reports no error, which is how the filter sat dead from creation until 4 Aug.
LABEL = "demo"

# Reading the config call rather than the events: `traffic_type` is set on
# gtag('config'), so it becomes a default parameter for every event on the
# measurement ID. Asserting it on one event would pass even if it were attached
# to that event alone.
CONFIG = """() => {
  const entry = [...(window.dataLayer || [])]
    .map(a => Array.from(a))
    .find(a => a[0] === 'config');
  return entry ? entry[2] : null;
}"""


def config(m):
    return m.eval(CONFIG)


section("a visitor arriving normally is not marked")
with mount() as m:
    eq("type", m.eval("NINEBELOW_TRAFFIC.type"), "external")
    cfg = config(m)
    ok("a config call was made", cfg is not None)
    ok("no traffic_type on it", "traffic_type" not in (cfg or {}), repr(cfg))
    eq("nothing persisted", m.storage("nb_qa"), None)

section("?qa=1 marks the visit, and it sticks")
with mount(search="?qa=1") as m:
    eq("type", m.eval("NINEBELOW_TRAFFIC.type"), "internal")
    eq("label sent", (config(m) or {}).get("traffic_type"), LABEL)
    ok("persisted", m.storage("nb_qa") is not None)
    # Same context, second navigation, no parameter: the marker has to survive
    # or a QA pass is only marked on the page it started on.
    m.page.goto("https://theme.test/preview/index.html", wait_until="load")
    m.wait(150)
    eq("still internal without the param", m.eval("NINEBELOW_TRAFFIC.type"), "internal")
    eq("reason", m.eval("NINEBELOW_TRAFFIC.reason"), "stored")

section("?qa=0 opts back out and clears the marker")
with mount(search="?qa=1") as m:
    m.page.goto("https://theme.test/preview/index.html?qa=0", wait_until="load")
    m.wait(150)
    eq("type", m.eval("NINEBELOW_TRAFFIC.type"), "external")
    eq("marker gone", m.storage("nb_qa"), None)
    ok("no traffic_type", "traffic_type" not in (config(m) or {}))
    m.page.goto("https://theme.test/preview/index.html", wait_until="load")
    m.wait(150)
    eq("and it stays out", m.eval("NINEBELOW_TRAFFIC.type"), "external")

section("the QA instruments mark on their own")
for search, label in (("?debug=1", "the event inspector"),
                      ("?ab=reset", "an assignment reset"),
                      ("?ab=reset,age_gate:a", "a reset with an arm pinned"),
                      ("?agegate=reset", "a gate reset")):
    with mount(search=search) as m:
        eq(f"{label} ({search})", m.eval("NINEBELOW_TRAFFIC.type"), "internal")

section("but nothing that can appear in a real ad link ever marks")
# This is the section that matters. Each of these is a parameter the campaign
# kit can put in front of paid traffic; marking any of them internal would
# delete that campaign from the reports without a symptom.
for search, label in (("?ch=ig", "a channel landing"),
                      ("?ch=tt&utm_source=tiktok&utm_content=reel_07", "a full ad link"),
                      ("?flow=focus", "a forced flow"),
                      ("?ab=hero_image:b", "a pinned arm"),
                      ("?ch=ig&ab=bundle_offer:b", "the bundle QA link"),
                      ("?debug=0", "debug explicitly off"),
                      ("?qa=yes", "an unrecognised qa value"),
                      # The escape hatch. ?debug=1 marks internal, which would
                      # otherwise make the panel's own traffic row unable to
                      # ever show the public path.
                      ("?debug=1&qa=0", "the inspector held open on public traffic")):
    with mount(search=search) as m:
        eq(f"{label} ({search})", m.eval("NINEBELOW_TRAFFIC.type"), "external")
        ok("  and no label was sent", "traffic_type" not in (config(m) or {}))

section("developer hosts are internal without being asked")
# The suites are served from a fixed origin and can never reach this branch by
# navigating, so the predicate is exposed and tested directly. `dev.py serve`
# runs on localhost against a live measurement ID — the same hole the test
# harness had before 5 Aug, and the same fix.
with mount() as m:
    for host in ("localhost", "127.0.0.1", "[::1]", "retro.local"):
        ok(f"{host} is internal",
           m.eval(f"NINEBELOW_TRAFFIC.devHost({host!r}, 'https:')"))
    for host in ("thoracle.github.io", "ninebelow.com", "notlocalhost.com",
                 "localhost.evil.com", "mylocal.com"):
        ok(f"{host} is not",
           not m.eval(f"NINEBELOW_TRAFFIC.devHost({host!r}, 'https:')"))
    ok("a file:// page is internal",
       m.eval("NINEBELOW_TRAFFIC.devHost('', 'file:')"))

section("a resolver that throws costs the label and nothing else")
# The resolver decides a REPORTING LABEL — the least important thing in the
# analytics head. It used to sit inside the bootstrap block, where a throw took
# the Consent Mode defaults, `gtag('js')` and the whole config call with it: a
# labelling failure would have cost every visitor's analytics, silently. It has
# its own block now, and the config call reads it defensively.
BREAK = "window.NINEBELOW_TRAFFIC = (function () {\n    throw new Error('boom');"
with mount(search="?qa=1",
           html=read_preview().replace(
               "window.NINEBELOW_TRAFFIC = (function () {", BREAK, 1)) as m:
    ok("the resolver did throw, so this is testing what it claims",
       any("boom" in x for x in m.logs), " | ".join(m.logs[:3]))
    ok("the global is genuinely absent",
       m.eval("typeof window.NINEBELOW_TRAFFIC") == "undefined")
    cfg = config(m)
    ok("gtag('config') still ran", cfg is not None)
    ok("unlabelled rather than mislabelled", "traffic_type" not in (cfg or {}))
    ok("consent defaults still went out",
       any(a[0] == "consent" for a in m.eval(
           "() => [...(window.dataLayer || [])].map(a => Array.from(a))")))
    ok("and the funnel still reports", len(m.events()) > 0)
    ok("the age gate still holds", m.root_attr("data-age") != "ok")

section("the resolver cannot break the page")
with mount(search="?qa=1") as m:
    ok("nothing threw", not any(x.startswith("throw:") for x in m.logs),
       " | ".join(m.logs))
    # Marking traffic is a reporting concern. It may never cost compliance.
    ok("the age gate still holds", m.root_attr("data-age") != "ok")
    ok("the funnel still runs", len(m.events()) > 0)

done()
