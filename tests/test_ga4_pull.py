"""The GA4 tally, against synthetic rows.

The network half of ga4_pull has never run against the live property. The
arithmetic that turns GA4 rows into arms has, and it is the half that can be
wrong quietly: a conversion attributed to the wrong arm, or counted twice,
produces a clean-looking verdict from broken inputs."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ga4_pull import (_count, arm_totals, assemble,  # noqa: E402
                      collect_conversions, parse_weights, report_body,
                      tally_exposures, variants_regex)
from harness import done, eq, ok, section, suite  # noqa: E402


def row(dims, mets):
    return {"dimensionValues": [{"value": d} for d in dims],
            "metricValues": [{"value": m} for m in mets]}


suite("ga4 pull")

section("exposures come straight off the two dimensions")
exp = {}
tally_exposures([
    row(["hero_image", "a"], ["1200"]),
    row(["hero_image", "b"], ["1190"]),
    row(["age_gate", "a"], ["2400"]),
], exp)
eq("hero_image a", exp["hero_image"]["a"]["exposures"], 1200)
eq("hero_image b", exp["hero_image"]["b"]["exposures"], 1190)
eq("age_gate a", exp["age_gate"]["a"]["exposures"], 2400)

section("(not set) is dropped rather than becoming an arm")
exp2 = {}
tally_exposures([row(["hero_image", "(not set)"], ["999"]),
                 row(["", "a"], ["999"])], exp2)
ok("no phantom arm", exp2 == {}, repr(exp2))

# --------------------------------------------------------------------------
# The numerator.
#
# Until 6 Aug 2026 this was built by pulling every distinct `ab_variants`
# string and summing the users of each row that mentioned an arm. The first
# live pull returned a 150% conversion rate, because `totalUsers` is not
# additive across rows. The fixture below is that failure, reduced.
# --------------------------------------------------------------------------

# Two people. p2 converts twice, and their `ab_variants` string differs between
# the two events because bundle_offer enrolled them on the second visit — which
# is ordinary behaviour, not corruption: bundle_offer is scoped to Instagram, so
# it appears the moment a channel resolves.
PEOPLE = {
    "p1": ["age_gate:a|hero_headline:b|hero_image:b"],
    "p2": ["age_gate:a|hero_headline:b|hero_image:b",
           "age_gate:a|bundle_offer:a|hero_headline:b|hero_image:b"],
}


def ga4_rows_by_variant_string():
    """What the OLD pull asked for: one row per distinct ab_variants string,
    with that row's own unique-user count."""
    counts = {}
    for person, labels in PEOPLE.items():
        for label in set(labels):
            counts.setdefault(label, set()).add(person)
    return [(label, len(who)) for label, who in sorted(counts.items())]


def ga4_filtered(id_, arm):
    """What the NEW pull asks for: GA4 counts unique users matching the arm
    token, across every combination it appears in. One row, no dimensions."""
    pattern = re.compile(variants_regex(id_, arm))
    who = {p for p, labels in PEOPLE.items()
           if any(pattern.search(lb) for lb in labels)}
    return [row([], [str(len(who)), "0"])] if who else []


section("the fixture reproduces the bug: summing rows double-counts a person")
rows_old = ga4_rows_by_variant_string()
eq("GA4 splits the same arm across two rows",
   [r for r in rows_old if "hero_headline:b" in r[0]],
   [("age_gate:a|bundle_offer:a|hero_headline:b|hero_image:b", 1),
    ("age_gate:a|hero_headline:b|hero_image:b", 2)])
eq("and the old sum-the-rows numerator gives 3",
   sum(n for label, n in rows_old if "hero_headline:b" in label), 3)
ok("which exceeds the 2 people who exist", len(PEOPLE) == 2)

section("asking GA4 per arm returns the deduplicated count instead")
exp_fix = {}
tally_exposures([row(["hero_headline", "b"], ["2"]),
                 row(["bundle_offer", "a"], ["1"])], exp_fix)
conv_fix = collect_conversions(exp_fix, ga4_filtered)
eq("hero_headline b", conv_fix["hero_headline"]["b"]["conversions"], 2)
ok("never more conversions than exposures",
   conv_fix["hero_headline"]["b"]["conversions"]
   <= exp_fix["hero_headline"]["b"]["exposures"])
eq("and the arm only one person was in stays at one",
   conv_fix["bundle_offer"]["a"]["conversions"], 1)

section("an arm is matched as a token, never as a substring")
ok("ig_strip:a does not match big_strip:a",
   not re.search(variants_regex("ig_strip", "a"), "big_strip:a"))
ok("hero:b does not match hero:bb",
   not re.search(variants_regex("hero", "b"), "age_gate:a|hero:bb"))
ok("but it does match at the start", re.search(variants_regex("hero", "b"), "hero:b|x:a"))
ok("in the middle", re.search(variants_regex("hero", "b"), "x:a|hero:b|y:c"))
ok("and at the end", re.search(variants_regex("hero", "b"), "x:a|hero:b"))

section("the request carries the arm filter, and asks for no dimensions")
body = report_body("14daysAgo", "today", "begin_checkout", [],
                   ["totalUsers", "eventValue"], arm=("hero_headline", "b"))
eq("no dimensions, so GA4 returns one deduplicated row", body["dimensions"], [])
grp = body["dimensionFilter"]["andGroup"]["expressions"]
eq("filtered on the event", grp[0]["filter"]["stringFilter"]["value"], "begin_checkout")
eq("and on the arm", grp[1]["filter"]["fieldName"], "customEvent:ab_variants")
eq("by regex, not CONTAINS",
   grp[1]["filter"]["stringFilter"]["matchType"], "PARTIAL_REGEXP")
ok("an unfiltered report is left alone",
   "andGroup" not in report_body("14daysAgo", "today", "experiment_impression",
                                 ["customEvent:experiment_id"])["dimensionFilter"])

section("revenue rides on the same request as the conversions")
conv2 = collect_conversions(
    {"hero_image": {"a": {}, "b": {}}},
    lambda i, a: [row([], ["10", "699.90"])] if a == "a" else [row([], ["4", "799.96"])])
eq("arm a conversions", conv2["hero_image"]["a"]["conversions"], 10)
eq("arm a revenue", conv2["hero_image"]["a"]["revenue"], 699.90)
eq("arm b conversions", conv2["hero_image"]["b"]["conversions"], 4)
eq("arm b revenue", conv2["hero_image"]["b"]["revenue"], 799.96)

section("a missing revenue metric reads as zero, not as a guess")
eq("no second metric", arm_totals([row([], ["10"])]), (10.0, 0.0))

section("an arm nobody converted in is zero, not an error")
eq("empty report", arm_totals([]), (0.0, 0.0))
conv_none = collect_conversions({"x": {"a": {}}}, lambda i, a: [])
eq("recorded as zero", conv_none["x"]["a"]["conversions"], 0)

section("counts are emitted as whole numbers")
eq("a whole float becomes an int", _count(10.0), 10)
ok("and stays an int", isinstance(_count(10.0), int))
eq("zero too", _count(0), 0)
eq("a fractional count is left visible rather than tidied away", _count(2.5), 2.5)
built_int = assemble({"x": {"a": {"exposures": 7.0}}},
                     {"x": {"a": {"conversions": 3.0, "revenue": 10.0}}},
                     "begin_checkout", {}, None)
eq("exposures in the payload", built_int[0]["arms"][0]["exposures"], 7)
eq("conversions in the payload", built_int[0]["arms"][0]["conversions"], 3)

section("assembling arms")
built = assemble(exp, conv2, "begin_checkout", {}, None)
ids = [e["id"] for e in built]
eq("experiments sorted", ids, ["age_gate", "hero_image"])
hero = next(e for e in built if e["id"] == "hero_image")
eq("even split assumed with no --weights", [a["weight"] for a in hero["arms"]], [50, 50])
eq("control is the first arm", hero["arms"][0]["name"], "a")

section("declared weights are carried through for the split check")
built_w = assemble(exp, conv2, "begin_checkout",
                   parse_weights("hero_image=90/10"), None)
hero_w = next(e for e in built_w if e["id"] == "hero_image")
eq("90/10 preserved", [a["weight"] for a in hero_w["arms"]], [90, 10])
eq("weights parsed for one experiment only",
   sorted(parse_weights("age_gate=50/50,hero_image=90/10")),
   ["age_gate", "hero_image"])

section("--control overrides alphabetical order")
built_c = assemble(exp, conv2, "begin_checkout", {}, "b")
hero_c = next(e for e in built_c if e["id"] == "hero_image")
eq("named control leads", [a["name"] for a in hero_c["arms"]], ["b", "a"])

section("an arm with exposures but no conversions is still reported")
eq("age_gate a converted 0",
   next(e for e in built if e["id"] == "age_gate")["arms"][0]["conversions"], 0)

done()
