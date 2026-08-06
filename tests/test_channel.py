"""Which platform sent the visitor, what they are shown, and what is stripped.

Channel matching is by TOKEN, not substring. Substring made `meta` match
metaverse, metabase, metal and metaphor, and `insta` match instant — a
campaign called metal_bottle_promo would have been served the ad landing and
filed under Facebook. The false-positive cases below are permanent guards."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (PASS, done, eq, mount, ok, read_preview,  # noqa: E402
                     section, suite)

UA = {
    "ig": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 302.0.0.23.113",
    "fb": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/443.0]",
    "tt": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 BytedanceWebview/d8a21c6 musical_ly_31.5.3",
    "plain": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
}

SECTIONS = ["hero", "product_story", "tasting_notes", "craft_process",
            "serve", "social_proof", "faq", "email_capture"]


def flow(**o):
    with mount(**o) as m:
        return m.eval("window.NINEBELOW_FLOW")


def shown_sections(**o):
    o.setdefault("age_pass", PASS)
    with mount(**o) as m:
        return [n for n in SECTIONS if m.visible(f'[data-section-name="{n}"]')]


suite("channel")

section("resolution, in priority order")
for label, opts, want in [
    ("?ch=tt", {"search": "?ch=tt"}, "tt"),
    ("?flow=ig", {"search": "?flow=ig"}, "ig"),
    ("utm_source=tiktok", {"search": "?utm_source=tiktok"}, "tt"),
    ("utm_source=tiktok_ads_manager", {"search": "?utm_source=tiktok_ads_manager"}, "tt"),
    ("utm_source=facebook", {"search": "?utm_source=facebook"}, "fb"),
    ("utm_campaign=ig_reel_07", {"search": "?utm_campaign=ig_reel_07"}, "ig"),
    ("utm_source=fb-feed", {"search": "?utm_source=fb-feed"}, "fb"),
    ("Instagram in-app browser", {"ua": UA["ig"]}, "ig"),
    ("Facebook in-app browser", {"ua": UA["fb"]}, "fb"),
    ("TikTok in-app browser", {"ua": UA["tt"]}, "tt"),
    ("referrer l.instagram.com", {"referrer": "https://l.instagram.com/"}, "ig"),
    ("referrer m.facebook.com", {"referrer": "https://m.facebook.com/"}, "fb"),
    ("plain browser, no signals", {"ua": UA["plain"]}, None),
    ("unrelated referrer", {"referrer": "https://news.ycombinator.com/"}, None),
    ("?flow=full beats a webview", {"search": "?flow=full", "ua": UA["ig"]}, None),
]:
    eq(label, flow(**opts).get("channel"), want)

section("token matching - these must NOT resolve to a channel")
for label, q in [
    ("metaverse_launch", "?utm_campaign=metaverse_launch"),
    ("metabase", "?utm_source=metabase"),
    ("metal_bottle_promo", "?utm_campaign=metal_bottle_promo"),
    ("winter_metaphor", "?utm_campaign=winter_metaphor"),
    ("instant_delivery", "?utm_campaign=instant_delivery"),
]:
    eq(label, flow(search=q).get("channel"), None)

section("in-app browsers are detected independently of channel")
for label, ua, want in [("Instagram", UA["ig"], "ig"), ("Facebook", UA["fb"], "fb"),
                        ("TikTok", UA["tt"], "tt"), ("desktop Chrome", UA["plain"], None)]:
    f = flow(ua=ua)
    eq(label, f.get("webview"), want)
    eq(f"{label} - inApp flag", bool(f.get("inApp")), want is not None)

section("message match - exactly one headline, and the right one")
for label, opts, want in [
    ("Instagram", {"search": "?ch=ig", "age_pass": PASS},
     "Clear enough to see the cold in it."),
    ("TikTok", {"search": "?ch=tt", "age_pass": PASS},
     "Why it's called Nine Below."),
    ("Facebook", {"search": "?ch=fb", "age_pass": PASS},
     "No sugar. No glycerol. Nothing to hide behind."),
    ("no channel, arm A",
     {"search": "?ab=reset,hero_headline:a", "age_pass": PASS, "ua": UA["plain"]},
     "Nine distillations. One clean finish."),
    ("no channel, arm B",
     {"search": "?ab=reset,hero_headline:b", "age_pass": PASS, "ua": UA["plain"]},
     "Distilled nine times. Filtered at nine below."),
]:
    with mount(**opts) as m:
        # __nbVisible walks the ancestor chain against real computed styles.
        # Chromium resolving the cascade correctly is what makes that answer
        # trustworthy now; under jsdom it was last-wins and ignored !important.
        vis = m.eval(
            "[...document.querySelectorAll('.hero__title')]"
            ".filter(__nbVisible).map(e => e.textContent.trim())")
        ok(label, len(vis) == 1 and vis[0] == want,
           f'"{vis[0]}"' if len(vis) == 1 else f"{len(vis)} visible")

section("a channel-scoped experiment buckets only its own channel")
# ig_strip ships parked, so nobody is enrolled and the scoping rule would never
# be exercised. Enable it for this check only — the point is the channel gate,
# not the on/off switch, and conflating the two would let a broken scope pass
# unnoticed the day someone launches the test.
LIVE = read_preview().replace('"ig_strip":{"enabled":false', '"ig_strip":{"enabled":true')
ok("registry patched for this check", '"ig_strip":{"enabled":true' in LIVE)

for label, q, should in [
    ("Instagram", "?ch=ig&ab=reset", True),
    ("TikTok", "?ch=tt&ab=reset", False),
    ("Facebook", "?ch=fb&ab=reset", False),
    ("no channel", "?ab=reset", False),
]:
    with mount(search=q, age_pass=PASS, html=LIVE) as m:
        active = m.eval("Object.keys(NINEBELOW_AB.active)"
                        ".filter(k => NINEBELOW_AB.active[k])")
        eq(f"{label} enrolled in ig_strip", "ig_strip" in active, should)

with mount(search="?ch=tt&ab=reset", age_pass=PASS, html=LIVE) as m:
    ok("and reports no impression for an out-of-scope channel",
       "ig_strip" not in m.impressions())

section("forcing an arm works even while the experiment is parked")
with mount(search="?ch=ig&ab=ig_strip:b", age_pass=PASS) as m:
    eq("forced arm wins over the off switch", m.root_attr("data-ab-ig_strip"), "b")

section("ad landings are stripped to the purchase path")
eq("full site", shown_sections(search="?flow=full"), SECTIONS)
eq("focus, no channel", shown_sections(search="?flow=focus"),
   ["hero", "product_story", "social_proof"])
eq("Instagram arm A", shown_sections(search="?ch=ig&ab=ig_strip:a"),
   ["hero", "product_story", "social_proof"])
eq("Instagram arm B", shown_sections(search="?ch=ig&ab=ig_strip:b"),
   ["hero", "social_proof"])
eq("TikTok", shown_sections(search="?ch=tt"),
   ["hero", "product_story", "social_proof"])
eq("Facebook", shown_sections(search="?ch=fb"),
   ["hero", "product_story", "social_proof"])

section("the strip survives every way the experiment can be absent")
SRC = read_preview()
for label, html in [
    ("experiment not registered",
     re.sub(r',\s*\n?\s*"ig_strip":\{[^}]*\}\}', "", SRC)),
    ("experiment parked",
     SRC.replace('"ig_strip":{"enabled":true', '"ig_strip":{"enabled":false')),
    ("visitor held out",
     SRC.replace('"ig_strip":{"enabled":true,"traffic":100',
                 '"ig_strip":{"enabled":true,"traffic":0')),
    ("A/B framework absent",
     re.sub(r'<script id="ab-registry"[\s\S]*?</script>', "", SRC)),
]:
    with mount(search="?ch=ig", age_pass=PASS, html=html) as m:
        n = len([s for s in SECTIONS if m.visible(f'[data-section-name="{s}"]')])
        ok(label, n <= 3, f"{n}/8 visible - the full site must never leak to paid traffic")

section("compliance is never stripped")
with mount(search="?ch=ig", age_pass=PASS) as m:
    legal = m.eval("[...document.querySelectorAll('.buybtn__legal')]"
                   ".filter(__nbVisible).map(e => e.textContent)")
    ok("21+ purchase notice", any("21" in t for t in legal))
    ok("responsibility statement",
       bool(re.search("DRINK RESPONSIBLY", m.eval("document.body.textContent"), re.I)))
    ok("a reachable buy button",
       m.eval("[...document.querySelectorAll('.buybtn__btn')].some(__nbVisible)"))

done()
