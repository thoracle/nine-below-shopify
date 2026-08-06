"""What gets counted, and when.

`experiment_impression` is the denominator of every conversion rate, so the
moment it fires decides whether the numbers mean anything. Fire it behind the
gate and you count people who never saw the variant."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (PASS, done, eq, mount, ok, read_preview,  # noqa: E402
                     section, suite)

suite("measurement")

section("nothing is reported for a page the visitor cannot see")
with mount(search="?ab=reset,age_gate:a") as m:
    eq("only the gate is counted while the gate is up", m.impressions(), ["age_gate"])
    ok("view_item held back", "view_item" not in m.events())
    ok("section views held back", "section_view" not in m.events())

section("and everything is released when the gate lifts")
with mount(search="?ab=reset,age_gate:a") as m:
    m.pass_gate()
    m.wait(250)
    imps = m.impressions()
    ok("every live experiment counted",
       "age_gate" in imps and "hero_headline" in imps and "hero_image" in imps)
    eq("no duplicates", len(imps), len(set(imps)))
    ok("view_item fired", "view_item" in m.events())

section("a visitor who refuses is counted only for the gate")
with mount(search="?ab=reset,age_gate:a") as m:
    m.click('[data-gate-arm="a"] [data-gate-deny]')
    m.wait(200)
    eq("impressions", m.impressions(), ["age_gate"])
    ok("no view_item", "view_item" not in m.events())

section("the gate reports itself, so a remembered pass is never counted for it")
with mount(age_pass=PASS) as m:
    imps = m.impressions()
    ok("age_gate NOT counted - no gate was shown", "age_gate" not in imps)
    ok("hero experiments still counted", "hero_headline" in imps)
    ok("no gate events at all", "age_gate_view" not in m.events())

section("context rides on every event")
with mount(search="?ab=reset,age_gate:a&ch=tt") as m:
    m.pass_gate()
    m.wait(250)
    log = m.log()
    ok("at least six events fired", len(log) >= 6, f"got {len(log)}")
    ok("channel on every one", all(e["params"].get("channel") == "tt" for e in log))
    ok("ab_variants on every one",
       all(isinstance(e["params"].get("ab_variants"), str) for e in log))
    vi = m.params_of("view_item")
    eq("flow_mode", vi.get("flow_mode"), "focus")
    eq("in_app_browser", vi.get("in_app_browser"), False)

section("the buy path is instrumented")
with mount(age_pass=PASS) as m:
    found = m.eval("""() => {
        const b = [...document.querySelectorAll('.buybtn__btn')].find(__nbVisible);
        if (b) b.setAttribute('data-test-buy', '1');
        return !!b;
    }""")
    ok("a reachable buy button exists", found)
    m.click("[data-test-buy]")
    m.wait(600)
    ev = m.events()
    ok("buy_button_click", "buy_button_click" in ev)
    ok("add_to_cart", "add_to_cart" in ev)
    ok("add_to_cart carries the arm",
       isinstance(m.params_of("add_to_cart").get("ab_variants"), str))

section("the vendor script is not loaded before age is confirmed")
with mount(search="?ab=reset,age_gate:a") as m:
    ok("no buy_button_ready while gated", "buy_button_ready" not in m.events())
    ok("vendor slot empty",
       m.eval("!document.querySelector('[data-buy-vendor-slot]')?.children.length"))
    m.click('[data-gate-arm="a"] [data-gate-deny]')
    m.wait(400)
    ok("and never loads for a visitor who refuses",
       "buy_button_ready" not in m.events())

# ---------------------------------------------------------------------------
# Load order.
#
# ab.js reports the denominator of every experiment through window.NB, which
# analytics.js publishes on its LAST line. Any arrangement where ab.js runs
# first — a reordered layout, or analytics.js throwing before it finishes —
# used to leave ab.js holding a no-op it had cached at load, and it would then
# discard every impression for the rest of the page without a word. The page
# looks perfect, the funnel logs, and the exposure count is zero.
#
# These fail if the reference to window.NB is ever cached at load time again.
# ---------------------------------------------------------------------------

section("impressions survive ab.js loading before analytics.js")
# Deferred scripts execute in document order, so swapping the two tags is
# enough to run ab.js while window.NB does not yet exist.
_src = read_preview()
_swapped = re.sub(
    r'(<script src="[^"]*analytics\.js"[^>]*></script>)\s*'
    r'(<script src="[^"]*ab\.js"[^>]*></script>)',
    r"\2\1", _src)
ok("the swap actually applied", _swapped != _src)

with mount(search="?ab=reset,age_gate:a", html=_swapped) as m:
    m.pass_gate()
    m.wait(250)
    imps = m.impressions()
    ok("hero_headline still counted", "hero_headline" in imps)
    ok("hero_image still counted", "hero_image" in imps)
    ok("the self-reporting gate still counted", "age_gate" in imps)

section("and survive window.NB being published late")
# The real hazard is subtler than order: impressions are held until the gate
# lifts, so window.NB only has to exist by THEN, not at load. A cached
# reference cannot see it arrive; a use-time read can.
with mount(search="?ab=reset,age_gate:a",
           mutate=lambda r, b: (b.replace("window.NB = {", "window.__NB_LATE__ = {")
                                + "\n;setTimeout(function () "
                                  "{ window.NB = window.__NB_LATE__; }, 40);")
           if r.endswith("assets/analytics.js") else None) as m:
    ok("window.NB was genuinely absent at ab.js load",
       m.eval("!!window.__NB_LATE__"))
    m.pass_gate()
    m.wait(300)
    ok("impressions landed once window.NB appeared",
       "hero_headline" in m.impressions())

section("and ab.js stays silent, not broken, when window.NB never arrives")
with mount(search="?ab=reset,age_gate:a",
           mutate=lambda r, b: b.replace("window.NB = {", "window.__NB_NEVER__ = {")
           if r.endswith("assets/analytics.js") else None) as m:
    ok("nothing threw", not any(x.startswith("throw:") for x in m.logs),
       " | ".join(m.logs))
    ok("no impressions were invented", len(m.impressions()) == 0)
    # The gate must still block. An analytics failure may cost measurement; it
    # may never cost compliance.
    ok("the age gate still holds", m.root_attr("data-age") != "ok")
    m.pass_gate()
    m.wait(200)
    ok("and still opens on confirm", m.root_attr("data-age") == "ok")

done()
