"""The age gate must never fail open.
Twelve ways for it to break, plus the paths where it must actually open."""

import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (DROP, GKEY, PASS, done, eq, mount, ok,  # noqa: E402
                     read_preview, section, suite)

SRC = read_preview()


def bust(rel, name):
    return rel.endswith(name)


def blocked(label, **opts):
    """Gate up, and nothing behind it reachable. Both halves matter: a gate that
    is present but not covering the page is not a gate."""
    with mount(**opts) as m:
        gate_up = m.visible("#age-gate")
        hidden = not m.visible("main") and not m.visible("[data-header]")
        ok(label, gate_up and hidden,
           "" if gate_up and hidden else f"gate={gate_up} contentHidden={hidden}")


suite("age gate")

section("it must stay closed in every failure mode")
blocked("normal load, first visit")
blocked("JavaScript disabled entirely", js=False)
blocked("theme.js fails to load",
        mutate=lambda r, b: DROP if bust(r, "assets/theme.js") else None)
blocked("theme.js throws on first line",
        mutate=lambda r, b: 'throw new Error("boom");' + b if bust(r, "assets/theme.js") else None)
blocked("analytics.js throws",
        mutate=lambda r, b: 'throw new Error("boom");' + b if bust(r, "analytics.js") else None)
blocked("ab.js throws",
        mutate=lambda r, b: 'throw new Error("boom");' + b if bust(r, "ab.js") else None)
blocked("age-gate.js fails to load",
        mutate=lambda r, b: DROP if bust(r, "age-gate.js") else None)
blocked("age-gate.js throws immediately",
        mutate=lambda r, b: 'throw new Error("boom");' + b if bust(r, "age-gate.js") else None)
blocked("theme.css fails to load",
        mutate=lambda r, b: DROP if bust(r, "theme.css") else None)
blocked("expired stored pass",
        age_pass=json.dumps({"v": True, "exp": int(time.time() * 1000) - 1}))
blocked("corrupt stored pass", age_pass="{{{not json")
blocked("forged falsy pass",
        age_pass=json.dumps({"v": False, "exp": int(time.time() * 1000) + 9_000_000_000}))

section("and it must open when it should")
with mount(age_pass=PASS) as m:
    ok("returning visitor sees the page", m.visible("main"))
    ok("gate removed, no flash",
       not m.exists("#age-gate") and m.root_attr("data-age") == "ok")

with mount(search="?ab=reset,age_gate:a") as m:
    m.pass_gate()
    m.wait(60)
    ok("content revealed before the fade ends",
       m.root_attr("data-age") == "ok" and m.visible("main"))
    # Assert the exact key, not an alternation. Accepting a second theme's
    # cookie name meant this passed even if the wrong cookie were written,
    # which is the only failure worth catching here.
    cookie = m.cookie()
    ok("pass mirrored to a cookie", bool(re.search(GKEY + "=1", cookie)), cookie)
    m.wait(500)
    ok("gate element removed after the fade", not m.exists("#age-gate"))

section("arm A - one tap")
with mount(search="?ab=reset,age_gate:a") as m:
    eq("arm attribute", m.root_attr("data-ab-age_gate"), "a")
    ok("arm A shown, B hidden",
       m.visible('[data-gate-arm="a"]') and not m.visible('[data-gate-arm="b"]'))
    eq("labelled for screen readers",
       m.attr("#age-gate", "aria-labelledby"), "age-gate-heading-a")

section("arm B - birthdate")
with mount(search="?ab=reset,age_gate:b") as m:
    arm = '[data-gate-arm="b"]'
    ok("arm B shown", m.visible(arm))

    def f(k):
        return f"{arm} [data-gate-{k}]"

    m.set_value(f("mm"), "ab12")
    eq("non-digits stripped", m.prop(f("mm"), "value"), "12")
    ok("auto-advances when a field fills", m.focused(f("dd")))

    m.set_value(f("dd"), "99")
    m.set_value(f("yyyy"), "2000")
    m.submit(f("form"))
    ok("day 99 rejected", not m.prop(f("error"), "hidden"))

    m.set_value(f("mm"), "02")
    m.set_value(f("dd"), "31")
    m.set_value(f("yyyy"), "2000")
    m.submit(f("form"))
    ok("31 February rejected, not rolled to 3 March", not m.prop(f("error"), "hidden"))

    m.set_value(f("mm"), "02")
    m.set_value(f("dd"), "29")
    m.set_value(f("yyyy"), "2004")
    m.submit(f("form"))
    ok("leap day accepted, of age", m.prop("#age-gate", "style.opacity") == "0")

with mount(search="?ab=reset,age_gate:b") as m:
    arm = '[data-gate-arm="b"]'
    m.set_value(f"{arm} [data-gate-mm]", "06")
    m.set_value(f"{arm} [data-gate-dd]", "15")
    m.set_value(f"{arm} [data-gate-yyyy]", "2015")
    m.submit(f"{arm} [data-gate-form]")
    ok("under age is refused",
       m.prop(f'{arm} [data-gate-step="ask"]', "hidden")
       and not m.prop(f'{arm} [data-gate-step="deny"]', "hidden"))
    ok("and stays refused - content still hidden", not m.visible("main"))

section("a broken arm B falls back rather than trapping the visitor")
html = re.sub(r'<form class="dob"[\s\S]*?</form>', "<!-- removed -->", SRC)
with mount(search="?ab=reset,age_gate:b", html=html) as m:
    eq("attribute corrected to the wired arm", m.root_attr("data-ab-age_gate"), "a")
    yes = '[data-gate-arm="a"] [data-gate-confirm]'
    ok("a working control is offered", m.visible(yes))
    m.click(yes)
    ok("and the visitor gets through", m.root_attr("data-age") == "ok")

section("QA")
with mount(search="?agegate=reset", age_pass=PASS) as m:
    ok("?agegate=reset re-opens the gate for a passed visitor", m.visible("#age-gate"))
    ok("and clears the stored pass", m.storage(GKEY) is None)

done()
