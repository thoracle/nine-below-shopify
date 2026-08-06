"""The $199.99 bundle offer, and every way it must NOT appear.

This section is the B arm of `bundle_offer`. It is gated by a positive match
on the assigned arm — `:root:not([data-ab-bundle_offer="b"])` — so anything
that stops the experiment running leaves the attribute absent and the offer
hidden. The failure this guards against is not cosmetic: leaking a bundle
price to traffic that was never enrolled would put an offer the campaign did
not budget for in front of everyone, and would make the arm unreadable."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import (PASS, PHONE, done, eq, mount, ok,  # noqa: E402
                     read_preview, section, suite)

SRC = read_preview()
BUNDLE = '[data-section-name="bundle"]'


def live_bars(m):
    """Which sticky-bar offer the CSS selects.

    Two things have to be true before this means anything, and neither was
    true under jsdom. The bar is `display: none` above 900px — it is a
    mobile-only control — so it must be mounted at a phone width or every
    variant reads as hidden and the assertion passes vacuously. And it carries
    `hidden` until theme.js reveals it behind an IntersectionObserver, which
    only fires once the hero CTA scrolls away; it is un-hidden here so the arm
    SELECTION is what gets tested, deterministically, rather than the reveal."""
    return m.eval("""() => {
        const bar = document.querySelector('[data-sticky-bar]');
        if (bar) bar.hidden = false;
        return [...document.querySelectorAll('[data-offer-variant]')]
          .filter(b => __nbVisible(b))
          .map(b => b.getAttribute('data-offer-variant'));
    }""")


suite("bundle offer")

section("it appears only for an enrolled Instagram visitor in arm B")
for label, q, want in [
    ("Instagram, arm B", "?ch=ig&ab=bundle_offer:b", True),
    ("Instagram, arm A", "?ch=ig&ab=bundle_offer:a", False),
    ("TikTok, arm B forced", "?ch=tt&ab=bundle_offer:b", False),
    ("Facebook, arm B forced", "?ch=fb&ab=bundle_offer:b", False),
    ("no channel, arm B forced", "?ab=bundle_offer:b", False),
    ("no channel, unforced", "?ab=reset", False),
]:
    with mount(search=q, age_pass=PASS) as m:
        eq(label, m.visible(BUNDLE), want)

section("and stays hidden through every way the experiment can be absent")
for label, html in [
    ("experiment not registered", re.sub(r',"bundle_offer":\{[^}]*\}\}', "}", SRC)),
    ("experiment parked",
     SRC.replace('"bundle_offer":{"enabled":true', '"bundle_offer":{"enabled":false')),
    ("visitor held out",
     SRC.replace('"bundle_offer":{"enabled":true,"traffic":100',
                 '"bundle_offer":{"enabled":true,"traffic":0')),
    ("A/B framework absent",
     re.sub(r'<script id="ab-registry"[\s\S]*?</script>', "", SRC)),
    ("registry is malformed",
     re.sub(r'(<script id="ab-registry"[^>]*>)', r"\1{{{ not json ", SRC)),
]:
    with mount(search="?ch=ig", age_pass=PASS, html=html) as m:
        ok(label, not m.visible(BUNDLE),
           "a $199.99 offer must never leak to unenrolled traffic")

section("the offer is not counted for people who were never eligible")
with mount(search="?ch=tt&ab=reset", age_pass=PASS) as m:
    ok("no impression off-channel", "bundle_offer" not in m.impressions())
with mount(search="?ch=ig&ab=reset", age_pass=PASS) as m:
    ok("impression on Instagram", "bundle_offer" in m.impressions())

section("what the section actually says")
with mount(search="?ch=ig&ab=bundle_offer:b", age_pass=PASS) as m:
    txt = re.sub(r"\s+", " ", m.eval(f"document.querySelector({BUNDLE!r}).textContent"))
    ok("bundle price shown", "$199.99" in txt)
    ok("retail shown as struck through",
       m.exists(f"{BUNDLE} s") and "$262.95" in txt)
    # The saving is rendered from the two prices rather than typed, so the page
    # cannot claim a discount its own numbers do not support.
    ok("saving is the difference, to the cent",
       bool(re.search(r"Save \$62\.96", txt)), txt[:160])

    btn = f"{BUNDLE} [data-buy-trigger]"
    ok("has its own buy button", m.exists(btn))
    eq("tagged as the bundle offer", m.attr(btn, "data-offer"), "bundle")
    btn_txt = m.eval(f"document.querySelector({btn!r}).textContent")
    ok("button carries the bundle price, not the bottle price",
       "199.99" in btn_txt and "69.99" not in btn_txt)
    ok("21+ notice is not stripped from the offer", bool(re.search(r"21", txt)))

section("arm B replaces the offer - the bottle is not also for sale")
with mount(search="?ch=ig&ab=bundle_offer:b", age_pass=PASS, viewport=PHONE) as m:
    singles = m.eval("[...document.querySelectorAll('[data-buy-root][data-offer=\"single\"]')]"
                     ".map(b => __nbVisible(b))")
    ok("there are single-bottle buttons in the markup", len(singles) > 0)
    ok("but none of them are visible", not any(singles),
       "arm B must present one offer, not two")
    ok("the bundle button is the one on offer", m.visible(f"{BUNDLE} [data-buy-root]"))
    eq("exactly one sticky bar variant is live", live_bars(m), ["bundle"])

with mount(search="?ch=ig&ab=bundle_offer:a", age_pass=PASS, viewport=PHONE) as m:
    ok("arm A still sells the bottle", m.visible(".hero__cta [data-buy-root]"))
    eq("and shows the bottle bar", live_bars(m), ["single"])

# The swap is keyed on an explicit ="b". With the framework gone the attribute
# is absent, and the bottle must remain buyable — hiding it would leave a page
# with nothing on it to purchase at all.
with mount(search="?ch=ig", age_pass=PASS,
           html=re.sub(r'<script id="ab-registry"[\s\S]*?</script>', "", SRC)) as m:
    ok("no A/B framework - the bottle is still on sale",
       m.visible(".hero__cta [data-buy-root]"))

section("the two offers report as different products")
with mount(search="?ch=ig&ab=bundle_offer:b", age_pass=PASS) as m:
    m.click(f"{BUNDLE} [data-buy-trigger]")
    m.wait(500)
    atc = m.params_of("add_to_cart")
    eq("offer_type", atc.get("offer_type"), "bundle")
    eq("value", atc.get("value"), 199.99)
    eq("item_id", atc["items"][0]["item_id"], "NB-BUNDLE-LE")
    eq("click reported as bundle",
       m.params_of("buy_button_click").get("offer_type"), "bundle")

# Arm A is where the bottle is sold, and it must still report as the bottle —
# the offer is read from the clicked button, so a shared code path that quietly
# defaulted to the bundle would show up here.
with mount(search="?ch=ig&ab=bundle_offer:a", age_pass=PASS) as m:
    found = m.eval("""() => {
        const b = [...document.querySelectorAll('[data-buy-trigger]')]
          .find(x => x.getAttribute('data-offer') !== 'bundle'
                     && __nbVisible(x));
        if (b) b.setAttribute('data-test-hero', '1');
        return !!b;
    }""")
    ok("the bottle is buyable in arm A", found)
    m.click("[data-test-hero]")
    m.wait(500)
    atc = m.params_of("add_to_cart")
    eq("offer_type", atc.get("offer_type"), "single")
    eq("value", atc.get("value"), 69.99)

# And in arm B there is no way to buy a single bottle at all — that is the
# whole point of "replaces" rather than "adds".
with mount(search="?ch=ig&ab=bundle_offer:b", age_pass=PASS) as m:
    buyable = m.eval("[...document.querySelectorAll('[data-buy-trigger]')]"
                     ".filter(b => __nbVisible(b))"
                     ".map(b => b.getAttribute('data-offer'))")
    ok("every reachable buy button is the bundle",
       len(buyable) > 0 and all(o == "bundle" for o in buyable),
       ",".join(buyable) or "nothing buyable at all")

section("the handoff tag tells BottleNexus which offer was bought")
with mount(search="?ch=ig&ab=bundle_offer:b&utm_content=reel_07", age_pass=PASS) as m:
    m.click(f"{BUNDLE} [data-buy-trigger]")
    m.wait(500)
    # begin_checkout is raised by the cart's own checkout button, not by adding
    # to the cart — the handoff tag is only meaningful at the point of leaving.
    m.click("[data-cart-checkout]")
    m.wait(300)
    co = m.params_of("begin_checkout")
    ok("begin_checkout fired", "begin_checkout" in m.events())
    tag = co.get("handoff_tag") or ""
    ok("carries the arm and the offer",
       bool(re.search("offer-bundle", tag)) and bool(re.search("bundle_offer-b", tag)), tag)
    ok("preserves the ad creative id", bool(re.search("reel_07", tag)), tag)

done()
