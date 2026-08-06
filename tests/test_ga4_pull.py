"""The GA4 tally, against synthetic rows.

The network half of ga4_pull has never run against the live property. The
arithmetic that turns GA4 rows into arms has, and it is the half that can be
wrong quietly: a conversion attributed to the wrong arm, or counted twice,
produces a clean-looking verdict from broken inputs."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ga4_pull import (assemble, parse_weights, tally_conversions,  # noqa: E402
                      tally_exposures, tally_revenue)
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

section("one conversion row feeds every experiment the visitor was in")
conv = {}
tally_conversions([row(["age_gate:b|hero_image:a"], ["30"])], conv)
eq("age_gate b", conv["age_gate"]["b"]["conversions"], 30)
eq("hero_image a", conv["hero_image"]["a"]["conversions"], 30)
ok("and nothing else was invented", set(conv) == {"age_gate", "hero_image"})

section("revenue is summed over the same rows, not re-counted")
conv2 = {}
rows = [row(["hero_image:a"], ["10", "699.90"]),
        row(["hero_image:b"], ["4", "799.96"])]
tally_conversions(rows, conv2)
tally_revenue(rows, conv2)
eq("arm a conversions", conv2["hero_image"]["a"]["conversions"], 10)
eq("arm a revenue", conv2["hero_image"]["a"]["revenue"], 699.90)
eq("arm b conversions", conv2["hero_image"]["b"]["conversions"], 4)
eq("arm b revenue", conv2["hero_image"]["b"]["revenue"], 799.96)

section("a missing revenue metric reads as zero, not as a guess")
conv3 = {}
tally_conversions([row(["hero_image:a"], ["10"])], conv3)
tally_revenue([row(["hero_image:a"], ["10"])], conv3)
eq("revenue stays zero", conv3["hero_image"]["a"]["revenue"], 0)

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
