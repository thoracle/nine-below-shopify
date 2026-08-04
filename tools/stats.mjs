/* =========================================================================
   A/B statistics — the whole of the maths, isolated so it can be tested
   against published values before it is trusted to call a winner.

   This is the REFERENCE copy. The same functions are inlined in the results
   view artifact, which has to be self-contained under a strict CSP. Keeping
   this file in the repo is what makes them verifiable: tests/stats.test.mjs
   checks it against Newcombe's published Wilson intervals, chi-square tables
   and standard normal quantiles. If you change the artifact's maths, change
   it here too and re-run — otherwise the tested copy and the shipped copy
   drift, which has already happened once.
   ========================================================================= */

/* ---- gamma, and the normal distribution derived from it ---------------- */

/* Acklam's inverse normal CDF, refined by one Halley step. ~1e-15. */
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
            1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
            6.680131188771972e+01, -1.328068155288572e+01];
  var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
           -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
           3.754408661907416e+00];
  var pl = 0.02425, q, r, x;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
        ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
        (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
         ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  var e = normCdf(x) - p;
  var u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

/* ---- chi-square survival, for the sample-ratio check ------------------- */

function lnGamma(x) {
  var g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
           -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  var xx = x, y = x, tmp = xx + 5.5;
  tmp -= (xx + 0.5) * Math.log(tmp);
  var ser = 1.000000000190015;
  for (var j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / xx);
}

/* Regularised upper incomplete gamma Q(a,x): series below the crossover,
   continued fraction above, which is where each converges quickly. */
function gammaQ(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) {
    var ap = a, sum = 1 / a, del = sum;
    for (var n = 0; n < 500; n++) {
      ap++; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  var TINY = 1e-300;
  var b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
  for (var i = 1; i < 500; i++) {
    var an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;        if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    var delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

export function chi2sf(x, df) { return gammaQ(df / 2, x / 2); }

/* The rational approximations usually pasted in for erf (Abramowitz & Stegun
   7.1.26, Numerical Recipes' erfcc) are good to about 1e-7. That is invisible
   on a chart and not good enough for a p-value near the threshold, so erf is
   taken from the incomplete gamma above instead: erf(x) = P(1/2, x²). */
export function erf(x) {
  var s = x < 0 ? -1 : 1;
  return s * (1 - gammaQ(0.5, x * x));
}

export function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

/* ---- proportions ------------------------------------------------------- */

/* Wilson score interval. The textbook normal interval puts the bound below
   zero at the rates this funnel actually runs at, which reads as a bug. */
export function wilson(successes, trials, alpha) {
  if (!trials) return { lo: 0, hi: 0, p: 0 };
  var z = normInv(1 - alpha / 2);
  var p = successes / trials;
  var d = 1 + z * z / trials;
  var centre = p + z * z / (2 * trials);
  var half = z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials));
  return { p: p, lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}

/* Two-proportion comparison of a variant against a control.
   Pooled variance for the test statistic (correct under H0), unpooled for the
   interval (correct under the estimate) — the standard, and deliberate. */
export function compare(ctrl, vari, alpha) {
  var n1 = ctrl.exposures, x1 = ctrl.conversions;
  var n2 = vari.exposures, x2 = vari.conversions;
  if (!n1 || !n2) return null;
  var p1 = x1 / n1, p2 = x2 / n2;
  var pPool = (x1 + x2) / (n1 + n2);
  var sePool = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  var z = sePool > 0 ? (p2 - p1) / sePool : 0;
  var pValue = 2 * (1 - normCdf(Math.abs(z)));

  var seUn = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2);
  var zc = normInv(1 - alpha / 2);
  var absLo = (p2 - p1) - zc * seUn, absHi = (p2 - p1) + zc * seUn;

  return {
    p1: p1, p2: p2, z: z, pValue: pValue,
    absDiff: p2 - p1, absLo: absLo, absHi: absHi,
    relDiff: p1 > 0 ? (p2 - p1) / p1 : null,
    relLo:   p1 > 0 ? absLo / p1 : null,
    relHi:   p1 > 0 ? absHi / p1 : null
  };
}

/* Sample size per arm for a relative lift `mde` on baseline `p`.
   The runbook's 16·p(1−p)/δ² is this formula with α=.05, power=.80 rounded;
   this is the unrounded version so the two never disagree by much. */
export function sampleSize(p, mde, alpha, power) {
  var p2 = p * (1 + mde);
  if (p <= 0 || p2 >= 1) return Infinity;
  var za = normInv(1 - alpha / 2), zb = normInv(power);
  var delta = p2 - p;
  return Math.ceil(Math.pow(za + zb, 2) * (p * (1 - p) + p2 * (1 - p2)) / (delta * delta));
}

/* O'Brien–Fleming boundary (the classic z_{α/2}/√t approximation to the
   Lan–DeMets spending function). This is what makes looking early safe: the
   bar starts far out of reach and falls to the fixed-horizon threshold only
   once the planned sample has actually arrived. */
export function obfBoundary(informationFraction, alpha) {
  var t = Math.min(1, Math.max(1e-6, informationFraction));
  return normInv(1 - alpha / 2) / Math.sqrt(t);
}

/* Sample-ratio mismatch. If the split does not match what was configured, the
   bucketing or the tracking is broken and every other number on the page is
   meaningless — so this is checked before anything else is reported. */
export function srm(arms) {
  var totalN = arms.reduce(function (s, a) { return s + a.exposures; }, 0);
  var totalW = arms.reduce(function (s, a) { return s + (a.weight || 0); }, 0);
  /* No declared weights means there is nothing to check the split against.
     Say so, rather than returning null for the caller to trip over. */
  if (!totalN || !totalW) return { chi: 0, df: 0, p: 1, checkable: false };
  var chi = 0;
  arms.forEach(function (a) {
    var expected = totalN * (a.weight / totalW);
    if (expected > 0) chi += Math.pow(a.exposures - expected, 2) / expected;
  });
  return { chi: chi, df: arms.length - 1, p: chi2sf(chi, arms.length - 1), checkable: true };
}

/* ---- the verdict ------------------------------------------------------- */

export function analyse(exp, opts) {
  var alpha = (opts.alpha != null ? opts.alpha : 5) / 100;
  var power = (opts.power != null ? opts.power : 80) / 100;
  var mde   = (opts.mde   != null ? opts.mde   : 10) / 100;

  var arms = exp.arms.filter(function (a) { return a.exposures > 0; });
  if (arms.length < 2) return { state: 'nodata', reason: 'Fewer than two arms have data.' };

  /* Conversions above exposures is always a data error — usually two columns
     swapped. Clamped so the maths stays defined, and reported rather than
     silently absorbed. */
  var impossible = arms.filter(function (a) { return a.conversions > a.exposures; })
                       .map(function (a) { return a.name; });
  arms = arms.map(function (a) {
    return a.conversions > a.exposures
      ? { name: a.name, weight: a.weight, exposures: a.exposures, conversions: a.exposures }
      : a;
  });

  var ctrl = arms[0];
  var ratios = arms.map(function (a) {
    return Object.assign({}, a, { rate: wilson(a.conversions, a.exposures, alpha) });
  });

  var ratio = srm(arms);
  var srmBroken = ratio.checkable && ratio.p < 0.001;

  /* Every extra arm is another chance to be fooled. Three arms means two
     comparisons against the control, and at α each that is a ~10% chance of a
     false winner rather than 5%. Bonferroni is the conservative choice and the
     easy one to explain, which matters more here than squeezing out the last
     of the power a Dunnett correction would recover. */
  var comparisons = arms.length - 1;
  var alphaAdj = alpha / comparisons;

  var required = sampleSize(ctrl.conversions / ctrl.exposures, mde, alphaAdj, power);
  var smallest = Math.min.apply(null, arms.map(function (a) { return a.exposures; }));
  var t = required === Infinity ? 0 : Math.min(1, smallest / required);
  var bound = obfBoundary(t, alphaAdj);

  var tests = arms.slice(1).map(function (a) {
    var c = compare(ctrl, a, alphaAdj);
    c.arm = a.name;
    c.crossed = Math.abs(c.z) >= bound;
    return c;
  });

  // Rank by effect size among those that cleared the boundary.
  var winners = tests.filter(function (c) { return c.crossed && c.absDiff > 0; })
                     .sort(function (x, y) { return y.absDiff - x.absDiff; });
  var losers  = tests.filter(function (c) { return c.crossed && c.absDiff < 0; });

  var noBaseline = !isFinite(required);

  var state, headline;
  if (impossible.length) {
    state = 'broken';
    headline = 'Arm ' + impossible.join(', ').toUpperCase() +
               ' reports more conversions than exposures — the pull is wrong.';
  } else if (noBaseline) {
    state = 'running';
    headline = 'No conversions yet, so there is no baseline to size against.';
  } else if (srmBroken) {
    state = 'broken';
    headline = 'Traffic split does not match the configuration — fix before reading anything else.';
  } else if (winners.length) {
    state = 'win';
    headline = 'Arm ' + winners[0].arm.toUpperCase() + ' beats the control.';
  } else if (t >= 1 && losers.length === tests.length) {
    state = 'lose';
    headline = 'Every variant is worse than the control. Keep the control.';
  } else if (t >= 1) {
    state = 'flat';
    headline = 'No difference big enough to matter. Keep the control and test something bolder.';
  } else {
    state = 'running';
    headline = 'Not enough data yet.';
  }

  return {
    state: state, headline: headline, alpha: alpha, mde: mde, power: power,
    arms: ratios, control: ctrl.name, tests: tests,
    comparisons: comparisons, alphaAdj: alphaAdj,
    impossible: impossible, noBaseline: noBaseline,
    srm: ratio, srmBroken: srmBroken,
    required: required, smallest: smallest, fraction: t, boundary: bound,
    remaining: Math.max(0, required - smallest)
  };
}
