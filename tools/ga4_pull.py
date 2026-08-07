#!/usr/bin/env python3
"""=========================================================================
ga4_pull — turn GA4 into the JSON the results view eats.

The results page cannot call GA4 itself: it is a static page under a strict
CSP, and a service-account key has no business in a browser anyway. So the
split is deliberate — this script runs where the credentials live, and its
output is pasted into the page.

  python3 tools/ga4_pull.py --property 123456789 --days 14
  python3 tools/ga4_pull.py --property 123456789 --since 2026-07-01 --until 2026-07-31
  python3 tools/ga4_pull.py --property 123456789 --metric add_to_cart --out th.json

Auth: a service account with Viewer on the GA4 property.
  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
The account's email must be added under Admin -> Property Access Management.

Requires: pip install google-auth requests

Ported from tools/ga4-pull.mjs on 5 Aug 2026 (that file is gone; this project
is Python only). First run against the live property on 6 Aug 2026 — which
immediately returned a 150% conversion rate. See the tallying section for what
that was and why the offline tests had not caught it.
========================================================================="""

import argparse
import datetime as _dt
import json
import os
import re
import sys

ENDPOINT = "https://analyticsdata.googleapis.com/v1beta/properties/{}:runReport"
SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"]


# ---- arguments ----------------------------------------------------------

def parse_weights(spec):
    """--weights age_gate=50/50,hero_image=90/10"""
    out = {}
    for pair in (spec or "").split(","):
        if not pair:
            continue
        id_, _, arms = pair.partition("=")
        if id_ and arms:
            out[id_] = [float(x) for x in arms.split("/")]
    return out


def build_parser():
    p = argparse.ArgumentParser(
        prog="ga4_pull",
        description="pull A/B exposures and conversions out of GA4")
    p.add_argument("--property", required=True, help="GA4 property id, digits only")
    p.add_argument("--days", type=int, default=14, help="trailing window, default 14")
    p.add_argument("--since", help="explicit start YYYY-MM-DD (overrides --days)")
    p.add_argument("--until", help="explicit end YYYY-MM-DD, default today")
    p.add_argument("--metric", default="begin_checkout",
                   help="conversion event, default begin_checkout")
    p.add_argument("--weights", default="",
                   help="configured split for the sample-ratio check, "
                        "e.g. age_gate=50/50,hero_image=90/10")
    p.add_argument("--control",
                   help="which arm is the control, default the alphabetically first")
    p.add_argument("--out", help="write JSON here instead of stdout")
    return p


# ---- tallying -----------------------------------------------------------
#
# Two different shapes, because the two events carry the arm differently.
#
# `experiment_impression` is emitted once per active experiment and names it
# outright (experiment_id / variant_id), so the denominator is read straight
# off those two dimensions — no string parsing, no ambiguity.
#
# The conversion event carries no experiment_id; it only inherits the merged
# `ab_variants` context ("age_gate:b|hero_image:a"). So the numerator has to be
# recovered from that list — and HOW is the whole problem.
#
# `totalUsers` throughout, never eventCount: a visitor who reloads five times is
# one exposure, not five.
#
# But `totalUsers` is NOT ADDITIVE ACROSS ROWS, and that is what broke the first
# live pull on 6 Aug 2026. The numerator used to be built by fetching every
# distinct `ab_variants` string and summing the users of each row that mentioned
# an arm. One person whose string changes between events — a channel resolving,
# a new experiment enrolling them, an arm being forced — appears in two rows and
# is counted twice:
#
#     totalUsers=2  age_gate:a|hero_headline:b|hero_image:b
#     totalUsers=1  age_gate:a|bundle_offer:a|hero_headline:b|hero_image:b
#     -> hero_headline:b credited with 3 conversions against 2 exposures
#
# The denominator cannot split that way — it is one row per experiment_id x
# variant_id — so the numerator inflates relative to it and rates run past 100%.
# A conversion rate over 1 is not merely wrong, it is undefined input to a Wilson
# interval and a two-proportion z-test.
#
# So GA4 is asked to do the unique-user arithmetic itself: one filtered request
# per (experiment, arm), each returning a single already-deduplicated number.
# That is one request per arm rather than one in total, which is the price of an
# answer that is correct.


def variants_regex(id_, arm):
    """Match `id:arm` as a TOKEN of the pipe-joined ab_variants list.

    Never a substring test. `ig_strip:a` is a substring of `big_strip:a`, and
    `hero:b` of `hero:bb` — the same trap the channel resolver documents at
    length in snippets/landing-flow.liquid, where substring matching filed
    `metal_bottle_promo` under Facebook because `meta` appeared in it.
    """
    return r"(^|\|)" + re.escape(f"{id_}:{arm}") + r"(\||$)"

def _bump(into, id_, arm, field, n):
    if not id_ or not arm or arm == "(not set)":
        return
    into.setdefault(id_, {}).setdefault(
        arm, {"exposures": 0, "conversions": 0, "revenue": 0})
    into[id_][arm][field] += n


def _cell(row, key, i):
    try:
        return row[key][i].get("value")
    except (KeyError, IndexError, TypeError):
        return None


def tally_exposures(rows, into):
    """Denominator: experiment_id x variant_id, taken at face value."""
    for row in rows:
        _bump(into,
              _cell(row, "dimensionValues", 0),
              _cell(row, "dimensionValues", 1),
              "exposures",
              float(_cell(row, "metricValues", 0) or 0))


def arm_totals(rows):
    """Read (users, revenue) off a metrics-only report — one row, no dimensions,
    so GA4 has already deduplicated the users across whatever combinations of
    `ab_variants` the filter matched. Zero rows means nobody converted, which is
    a real answer and not a failure."""
    if not rows:
        return 0.0, 0.0
    return (float(_cell(rows[0], "metricValues", 0) or 0),
            float(_cell(rows[0], "metricValues", 1) or 0))


def collect_conversions(exposures, fetch):
    """Numerator, one arm at a time.

    `fetch(id_, arm)` returns that arm's report rows. Only arms that actually
    have exposures are asked about — an arm nobody was enrolled in has no
    denominator, so its conversions would have nothing to divide into.

    A visitor still converts for every test they are enrolled in at once: they
    match the filter for each of those arms independently, which is the same
    behaviour the old split had and the reason it was right about that much.
    """
    conversions = {}
    for id_ in sorted(exposures):
        for arm in sorted(exposures[id_]):
            users, value = arm_totals(fetch(id_, arm))
            _bump(conversions, id_, arm, "conversions", users)
            _bump(conversions, id_, arm, "revenue", value)
    return conversions


def _count(n):
    """A user count as a whole number where it is one, untouched otherwise —
    a fractional count means something upstream is wrong and hiding it would be
    the wrong kind of tidy."""
    return int(n) if float(n).is_integer() else n


def assemble(exposures, conversions, metric, weights, control=None):
    """The results view treats the FIRST arm as the control, and the theme's
    control is the first key in the registry JSON — not necessarily the
    alphabetically first. They coincide for a/b/c naming, which is what the
    themes use, so the default sort is right; --control exists for anything
    named otherwise."""
    experiments = []
    for id_ in sorted(exposures):
        arms = sorted(exposures[id_])
        if control and control in arms:
            arms.remove(control)
            arms.insert(0, control)
        declared = weights.get(id_)

        experiments.append({
            "id": id_,
            "metric": metric,
            "arms": [{
                "name": name,
                # Without --weights there is nothing to check the split against,
                # so the configured share is assumed even. Pass the real weights
                # for any test that is not a straight split, or the guardrail
                # will cry wolf.
                "weight": (declared[i] if declared and i < len(declared) else 0)
                          if declared else round(100 / len(arms)),
                # People, so a whole number. GA4 hands back "10" as a string and
                # it is read as a float for the revenue path's sake; emitting
                # `10.0` into the results view makes a count look like a
                # measurement, and puts a stray `.0` in every pasted payload.
                "exposures": _count(exposures[id_][name]["exposures"]),
                "conversions": _count(
                    conversions.get(id_, {}).get(name, {}).get("conversions", 0)),
                "revenue": round(
                    conversions.get(id_, {}).get(name, {}).get("revenue", 0) * 100) / 100,
            } for i, name in enumerate(arms)],
        })
    return experiments


# ---- the network half ---------------------------------------------------

def report_body(since, until, event_name, dimensions,
                metrics=("totalUsers",), arm=None):
    """The request. Split out from the POST so the filter can be asserted on
    without a network round trip — the arm filter is the part that is easy to
    get subtly wrong and impossible to notice afterwards."""
    event = {"filter": {"fieldName": "eventName",
                        "stringFilter": {"matchType": "EXACT", "value": event_name}}}
    if arm is None:
        dimension_filter = event
    else:
        id_, name = arm
        dimension_filter = {"andGroup": {"expressions": [
            event,
            {"filter": {
                "fieldName": "customEvent:ab_variants",
                # PARTIAL_REGEXP, not CONTAINS. See variants_regex.
                "stringFilter": {"matchType": "PARTIAL_REGEXP",
                                 "value": variants_regex(id_, name)},
            }},
        ]}}
    return {
        "dateRanges": [{"startDate": since, "endDate": until}],
        "dimensions": [{"name": n} for n in dimensions],
        "metrics": [{"name": n} for n in metrics],
        "dimensionFilter": dimension_filter,
        "limit": 5000,
    }


def run_report(session, property_id, since, until, event_name, dimensions,
               metrics=("totalUsers",), arm=None):
    body = report_body(since, until, event_name, dimensions, metrics, arm)
    res = session.post(ENDPOINT.format(property_id), json=body, timeout=60)
    if res.status_code != 200:
        raise RuntimeError(_error_message(res))
    return res.json().get("rows", [])


def _error_message(res):
    try:
        return res.json()["error"]["message"]
    except Exception:
        return f"HTTP {res.status_code}: {res.text[:400]}"


def authed_session():
    try:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install google-auth requests")

    key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not key:
        sys.exit("Set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON key.")
    if not os.path.exists(key):
        sys.exit(f"Cannot read credentials at {key}")

    creds, _ = google.auth.default(scopes=SCOPES)
    return AuthorizedSession(creds)


def main(argv=None):
    args = build_parser().parse_args(argv)

    until = args.until or "today"
    since = args.since or f"{args.days}daysAgo"
    weights = parse_weights(args.weights)

    session = authed_session()
    exposures, conversions = {}, {}

    try:
        tally_exposures(
            run_report(session, args.property, since, until, "experiment_impression",
                       ["customEvent:experiment_id", "customEvent:variant_id"]),
            exposures)

        # One request per arm, each filtered to that arm and asking for no
        # dimensions at all, so GA4 returns a single already-deduplicated
        # figure. Both metrics come from the same request: asking twice would be
        # two chances for the matched sets to differ — a conversion counted
        # against revenue that is not there, or the reverse.
        def fetch(id_, name):
            return run_report(session, args.property, since, until, args.metric,
                              [], ["totalUsers", "eventValue"], arm=(id_, name))

        conversions = collect_conversions(exposures, fetch)
    except RuntimeError as e:
        msg = str(e)
        print(f"GA4 request failed: {msg}", file=sys.stderr)
        if "customEvent" in msg or "custom" in msg.lower() and "dimension" in msg.lower():
            print("""
The custom dimension is probably not registered. In GA4:
  Admin -> Custom definitions -> Create custom dimension
Three event-scoped custom dimensions are needed, one per parameter:
    experiment_id, variant_id, ab_variants
They only collect from the moment they are created — GA4 does not backfill.""",
                  file=sys.stderr)
        return 1

    experiments = assemble(exposures, conversions, args.metric, weights, args.control)

    if not experiments:
        print(f"""No experiment_impression rows in {since}..{until}. Check that:
  - the ab_variants custom dimension exists and has had time to collect
  - at least one experiment is enabled in the theme
  - the property id is right""", file=sys.stderr)
        return 1

    payload = {
        "pulledAt": _dt.datetime.now(_dt.timezone.utc)
                       .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "property": str(args.property),
        "window": {"since": since, "until": until},
        "experiments": experiments,
    }
    text = json.dumps(payload, indent=2)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"Wrote {args.out}", file=sys.stderr)
    else:
        print(text)

    # A short human summary on stderr, so `> file.json` stays clean.
    print(f"\n{since} .. {until}   metric: {args.metric}", file=sys.stderr)
    for e in experiments:
        print(f"  {e['id']}", file=sys.stderr)
        for a in e["arms"]:
            rate = (f"{a['conversions'] / a['exposures'] * 100:.2f}%"
                    if a["exposures"] else "-")
            print(f"    {a['name']}  {str(a['exposures']):>9} exposed  "
                  f"{str(a['conversions']):>7} converted  {rate:>7}", file=sys.stderr)
    print("\nPaste the JSON into the results view -> Data & settings -> "
          "Paste a GA4 pull.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
