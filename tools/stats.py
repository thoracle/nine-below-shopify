"""=========================================================================
A/B statistics — the whole of the maths, isolated so it can be tested
against published values before it is trusted to call a winner.

This is the REFERENCE copy. The same functions are inlined in the results
view artifact, which has to be self-contained under a strict CSP. Keeping
this file in the repo is what makes them verifiable: tests/test_stats.py
checks it against Newcombe's published Wilson intervals, chi-square tables
and standard normal quantiles. If you change the artifact's maths, change
it here too and re-run — otherwise the tested copy and the shipped copy
drift, which has already happened once.

Ported from tools/stats.mjs on 5 Aug 2026. The artifact still carries the
JavaScript; this file and that copy must agree, and the tests are what
prove it.
========================================================================="""

import math

# ---- gamma, and the normal distribution derived from it -----------------

_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01]
_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00]


def norm_inv(p):
    """Acklam's inverse normal CDF, refined by one Halley step. ~1e-15."""
    if p <= 0:
        return -math.inf
    if p >= 1:
        return math.inf
    pl = 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        x = ((((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5])
             / ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1))
    elif p <= 1 - pl:
        q = p - 0.5
        r = q * q
        x = (((((( _A[0] * r + _A[1]) * r + _A[2]) * r + _A[3]) * r + _A[4]) * r + _A[5]) * q
             / (((((_B[0] * r + _B[1]) * r + _B[2]) * r + _B[3]) * r + _B[4]) * r + 1))
    else:
        q = math.sqrt(-2 * math.log(1 - p))
        x = (-((((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]))
             / ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1))
    e = norm_cdf(x) - p
    u = e * math.sqrt(2 * math.pi) * math.exp(x * x / 2)
    return x - u / (1 + x * u / 2)


# ---- chi-square survival, for the sample-ratio check --------------------

_G = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]


def _ln_gamma(x):
    xx = x
    y = x
    tmp = xx + 5.5
    tmp -= (xx + 0.5) * math.log(tmp)
    ser = 1.000000000190015
    for j in range(6):
        y += 1
        ser += _G[j] / y
    return -tmp + math.log(2.5066282746310005 * ser / xx)


def _gamma_q(a, x):
    """Regularised upper incomplete gamma Q(a,x): series below the crossover,
    continued fraction above, which is where each converges quickly."""
    if x < 0 or a <= 0:
        return math.nan
    if x == 0:
        return 1
    if x < a + 1:
        ap = a
        total = 1 / a
        del_ = total
        for _ in range(500):
            ap += 1
            del_ *= x / ap
            total += del_
            if abs(del_) < abs(total) * 1e-15:
                break
        return 1 - total * math.exp(-x + a * math.log(x) - _ln_gamma(a))
    tiny = 1e-300
    b = x + 1 - a
    c = 1 / tiny
    d = 1 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-15:
            break
    return math.exp(-x + a * math.log(x) - _ln_gamma(a)) * h


def chi2sf(x, df):
    return _gamma_q(df / 2, x / 2)


def erf(x):
    """The rational approximations usually pasted in for erf (Abramowitz &
    Stegun 7.1.26, Numerical Recipes' erfcc) are good to about 1e-7. That is
    invisible on a chart and not good enough for a p-value near the threshold,
    so erf is taken from the incomplete gamma above instead: erf(x) = P(½, x²)."""
    s = -1 if x < 0 else 1
    return s * (1 - _gamma_q(0.5, x * x))


def norm_cdf(z):
    return 0.5 * (1 + erf(z / math.sqrt(2)))


# ---- proportions --------------------------------------------------------

def wilson(successes, trials, alpha):
    """Wilson score interval. The textbook normal interval puts the bound below
    zero at the rates this funnel actually runs at, which reads as a bug."""
    if not trials:
        return {"lo": 0, "hi": 0, "p": 0}
    z = norm_inv(1 - alpha / 2)
    p = successes / trials
    d = 1 + z * z / trials
    centre = p + z * z / (2 * trials)
    half = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials))
    return {"p": p,
            "lo": max(0, (centre - half) / d),
            "hi": min(1, (centre + half) / d)}


def compare(ctrl, vari, alpha):
    """Two-proportion comparison of a variant against a control.
    Pooled variance for the test statistic (correct under H0), unpooled for the
    interval (correct under the estimate) — the standard, and deliberate."""
    n1, x1 = ctrl["exposures"], ctrl["conversions"]
    n2, x2 = vari["exposures"], vari["conversions"]
    if not n1 or not n2:
        return None
    p1 = x1 / n1
    p2 = x2 / n2
    p_pool = (x1 + x2) / (n1 + n2)
    se_pool = math.sqrt(p_pool * (1 - p_pool) * (1 / n1 + 1 / n2))
    z = (p2 - p1) / se_pool if se_pool > 0 else 0
    p_value = 2 * (1 - norm_cdf(abs(z)))

    se_un = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    zc = norm_inv(1 - alpha / 2)
    abs_lo = (p2 - p1) - zc * se_un
    abs_hi = (p2 - p1) + zc * se_un

    return {
        "p1": p1, "p2": p2, "z": z, "pValue": p_value,
        "absDiff": p2 - p1, "absLo": abs_lo, "absHi": abs_hi,
        "relDiff": (p2 - p1) / p1 if p1 > 0 else None,
        "relLo": abs_lo / p1 if p1 > 0 else None,
        "relHi": abs_hi / p1 if p1 > 0 else None,
    }


def sample_size(p, mde, alpha, power):
    """Sample size per arm for a relative lift `mde` on baseline `p`.
    The runbook's 16·p(1−p)/δ² is this formula with α=.05, power=.80 rounded;
    this is the unrounded version so the two never disagree by much."""
    p2 = p * (1 + mde)
    if p <= 0 or p2 >= 1:
        return math.inf
    za = norm_inv(1 - alpha / 2)
    zb = norm_inv(power)
    delta = p2 - p
    return math.ceil((za + zb) ** 2 * (p * (1 - p) + p2 * (1 - p2)) / (delta * delta))


def obf_boundary(information_fraction, alpha):
    """O'Brien–Fleming boundary (the classic z_{α/2}/√t approximation to the
    Lan–DeMets spending function). This is what makes looking early safe: the
    bar starts far out of reach and falls to the fixed-horizon threshold only
    once the planned sample has actually arrived."""
    t = min(1, max(1e-6, information_fraction))
    return norm_inv(1 - alpha / 2) / math.sqrt(t)


def srm(arms):
    """Sample-ratio mismatch. If the split does not match what was configured,
    the bucketing or the tracking is broken and every other number on the page
    is meaningless — so this is checked before anything else is reported."""
    total_n = sum(a["exposures"] for a in arms)
    total_w = sum(a.get("weight") or 0 for a in arms)
    # No declared weights means there is nothing to check the split against.
    # Say so, rather than returning None for the caller to trip over.
    if not total_n or not total_w:
        return {"chi": 0, "df": 0, "p": 1, "checkable": False}
    chi = 0
    for a in arms:
        expected = total_n * (a["weight"] / total_w)
        if expected > 0:
            chi += (a["exposures"] - expected) ** 2 / expected
    return {"chi": chi, "df": len(arms) - 1,
            "p": chi2sf(chi, len(arms) - 1), "checkable": True}


# ---- the verdict --------------------------------------------------------

def analyse(exp, opts=None):
    opts = opts or {}
    alpha = (opts["alpha"] if opts.get("alpha") is not None else 5) / 100
    power = (opts["power"] if opts.get("power") is not None else 80) / 100
    mde = (opts["mde"] if opts.get("mde") is not None else 10) / 100

    arms = [a for a in exp["arms"] if a["exposures"] > 0]
    if len(arms) < 2:
        return {"state": "nodata", "reason": "Fewer than two arms have data."}

    # Conversions above exposures is always a data error — usually two columns
    # swapped. Clamped so the maths stays defined, and reported rather than
    # silently absorbed.
    impossible = [a["name"] for a in arms if a["conversions"] > a["exposures"]]
    arms = [{**a, "conversions": a["exposures"]} if a["conversions"] > a["exposures"] else a
            for a in arms]

    ctrl = arms[0]
    ratios = [{**a, "rate": wilson(a["conversions"], a["exposures"], alpha)} for a in arms]

    ratio = srm(arms)
    srm_broken = ratio["checkable"] and ratio["p"] < 0.001

    # Every extra arm is another chance to be fooled. Three arms means two
    # comparisons against the control, and at α each that is a ~10% chance of a
    # false winner rather than 5%. Bonferroni is the conservative choice and the
    # easy one to explain, which matters more here than squeezing out the last
    # of the power a Dunnett correction would recover.
    comparisons = len(arms) - 1
    alpha_adj = alpha / comparisons

    required = sample_size(ctrl["conversions"] / ctrl["exposures"], mde, alpha_adj, power)
    smallest = min(a["exposures"] for a in arms)
    t = 0 if required == math.inf else min(1, smallest / required)
    bound = obf_boundary(t, alpha_adj)

    tests = []
    for a in arms[1:]:
        c = compare(ctrl, a, alpha_adj)
        c["arm"] = a["name"]
        c["crossed"] = abs(c["z"]) >= bound
        tests.append(c)

    # Rank by effect size among those that cleared the boundary.
    winners = sorted([c for c in tests if c["crossed"] and c["absDiff"] > 0],
                     key=lambda c: -c["absDiff"])
    losers = [c for c in tests if c["crossed"] and c["absDiff"] < 0]

    no_baseline = not math.isfinite(required)

    if impossible:
        state = "broken"
        headline = ("Arm " + ", ".join(impossible).upper() +
                    " reports more conversions than exposures — the pull is wrong.")
    elif no_baseline:
        state = "running"
        headline = "No conversions yet, so there is no baseline to size against."
    elif srm_broken:
        state = "broken"
        headline = ("Traffic split does not match the configuration — "
                    "fix before reading anything else.")
    elif winners:
        state = "win"
        headline = "Arm " + winners[0]["arm"].upper() + " beats the control."
    elif t >= 1 and len(losers) == len(tests):
        state = "lose"
        headline = "Every variant is worse than the control. Keep the control."
    elif t >= 1:
        state = "flat"
        headline = ("No difference big enough to matter. "
                    "Keep the control and test something bolder.")
    else:
        state = "running"
        headline = "Not enough data yet."

    return {
        "state": state, "headline": headline,
        "alpha": alpha, "mde": mde, "power": power,
        "arms": ratios, "control": ctrl["name"], "tests": tests,
        "comparisons": comparisons, "alphaAdj": alpha_adj,
        "impossible": impossible, "noBaseline": no_baseline,
        "srm": ratio, "srmBroken": srm_broken,
        "required": required, "smallest": smallest,
        "fraction": t, "boundary": bound,
        "remaining": max(0, required - smallest),
    }
