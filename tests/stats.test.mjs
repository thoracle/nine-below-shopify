/* The statistics that decide whether a test is finished.
   Checked against published values, not against itself. */

import { normCdf, normInv, chi2sf, wilson, compare, sampleSize, obfBoundary, srm, analyse }
  from '../tools/stats.mjs';
import { suite, section, ok, eq, done } from './harness.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const A = (arms, o = {}) => analyse({ arms }, { alpha: 5, power: 80, mde: 10, ...o });

suite('statistics');

section('normal distribution, against published values');
ok('Phi(0) = 0.5',            near(normCdf(0), 0.5, 1e-14));
ok('Phi(1.96) = 0.9750021',   near(normCdf(1.96), 0.9750021049, 1e-10));
ok('Phi(-2.5) = 0.0062097',   near(normCdf(-2.5), 0.0062096653, 1e-10));
ok('Phi(-6) = 9.8659e-10',    near(normCdf(-6), 9.865876e-10, 1e-15));
ok('normInv(.975) = 1.959964',near(normInv(0.975), 1.9599639845, 1e-10));
ok('normInv(.995) = 2.575829',near(normInv(0.995), 2.5758293035, 1e-10));
ok('round trip at 1e-6',      near(normCdf(normInv(1e-6)), 1e-6, 1e-16));

section('chi-square, against tables');
ok('chi2sf(3.841459, 1) = .05', near(chi2sf(3.841459, 1), 0.05, 1e-7));
ok('chi2sf(6.634897, 1) = .01', near(chi2sf(6.634897, 1), 0.01, 1e-7));
ok('chi2sf(5.991465, 2) = .05', near(chi2sf(5.991465, 2), 0.05, 1e-7));

section('Wilson intervals, against Newcombe 1998');
ok('15/148 -> .0624 .. .1605', near(wilson(15,148,.05).lo, 0.0624, 5e-5) && near(wilson(15,148,.05).hi, 0.1605, 5e-5));
ok('0/20 -> 0 .. .1611',       near(wilson(0,20,.05).lo, 0, 1e-12) && near(wilson(0,20,.05).hi, 0.1611, 5e-5));
ok('81/263 -> .2553 .. .3662', near(wilson(81,263,.05).lo, 0.2553, 5e-5) && near(wilson(81,263,.05).hi, 0.3662, 5e-5));

section('two-proportion comparison');
{
  const c = compare({ exposures: 100, conversions: 36 }, { exposures: 100, conversions: 50 }, 0.05);
  ok('z uses pooled variance', near(c.z, 0.14 / Math.sqrt(0.43 * 0.57 * 0.02), 1e-12));
  ok('p is two-sided',         near(c.pValue, 2 * (1 - normCdf(c.z)), 1e-15));
  const back = compare({ exposures: 100, conversions: 50 }, { exposures: 100, conversions: 36 }, 0.05);
  ok('swapping arms flips the sign, same p', near(back.z, -c.z, 1e-12) && near(back.pValue, c.pValue, 1e-15));
}

section('sample size');
ok('agrees with the runbook rule of thumb within 10%',
   Math.abs(sampleSize(0.03,0.10,0.05,0.80) - Math.ceil(16*0.03*0.97/9e-6)) / (16*0.03*0.97/9e-6) < 0.10);
ok('a bigger effect needs fewer people', sampleSize(0.03,0.20,0.05,0.80) < sampleSize(0.03,0.10,0.05,0.80));

section("O'Brien–Fleming boundary — why peeking is safe");
ok('t=1.00 -> 1.96',  near(obfBoundary(1.00, 0.05), 1.959964, 1e-6));
ok('t=0.50 -> 2.77',  near(obfBoundary(0.50, 0.05), 2.771808, 1e-6));
ok('t=0.25 -> 3.92',  near(obfBoundary(0.25, 0.05), 3.919928, 1e-6));
ok('falls monotonically', [0.1,0.25,0.5,0.75,1].map(t => obfBoundary(t,0.05)).every((v,i,a) => i===0 || v < a[i-1]));

section('sample-ratio mismatch');
ok('an even split is unremarkable', near(srm([{exposures:5000,weight:50},{exposures:5000,weight:50}]).p, 1, 1e-12));
ok('4800/5200 is flagged', srm([{exposures:5200,weight:50},{exposures:4800,weight:50}]).p < 0.001);
ok('a deliberate 90/10 ramp is not', near(srm([{exposures:9000,weight:90},{exposures:1000,weight:10}]).p, 1, 1e-12));

section('verdicts');
eq('a real winner',   A([{name:'a',weight:50,exposures:54000,conversions:1620},{name:'b',weight:50,exposures:54000,conversions:1890}]).state, 'win');
eq('a real loser',    A([{name:'a',weight:50,exposures:54000,conversions:1620},{name:'b',weight:50,exposures:54000,conversions:1350}]).state, 'lose');
eq('nothing there',   A([{name:'a',weight:50,exposures:54000,conversions:1620},{name:'b',weight:50,exposures:54000,conversions:1634}]).state, 'flat');
eq('broken split',    A([{name:'a',weight:50,exposures:12000,conversions:360},{name:'b',weight:50,exposures:9000,conversions:400}]).state, 'broken');
eq('impossible counts',A([{name:'a',weight:50,exposures:100,conversions:5000},{name:'b',weight:50,exposures:100,conversions:10}]).state, 'broken');
ok('no baseline yet', A([{name:'a',weight:50,exposures:500,conversions:0},{name:'b',weight:50,exposures:500,conversions:0}]).noBaseline);
ok('no weights declared is not a false alarm',
   A([{name:'a',weight:0,exposures:5000,conversions:150},{name:'b',weight:0,exposures:5000,conversions:180}]).srm.checkable === false);

section('the peeking guard');
{
  const r = A([{name:'a',weight:50,exposures:2000,conversions:52},{name:'b',weight:50,exposures:2000,conversions:82}]);
  ok('a naive p-value would call this significant', r.tests[0].pValue < 0.01);
  ok('the sequential boundary correctly holds', !r.tests[0].crossed && r.state === 'running');
}

done();
