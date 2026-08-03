#!/usr/bin/env node
/* =========================================================================
   ga4-pull — turn GA4 into the JSON the results view eats.

   The results page cannot call GA4 itself: it is a static page under a strict
   CSP, and a service-account key has no business in a browser anyway. So the
   split is deliberate — this script runs where the credentials live, and its
   output is pasted into the page.

     node tools/ga4-pull.mjs --property 123456789 --days 14
     node tools/ga4-pull.mjs --property 123456789 --since 2026-07-01 --until 2026-07-31
     node tools/ga4-pull.mjs --property 123456789 --metric add_to_cart --out th.json

   Auth: a service account with Viewer on the GA4 property.
     export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
   The account's email must be added under Admin -> Property Access Management.

   Requires: npm i google-auth-library
   ========================================================================= */

import { readFileSync, writeFileSync } from 'node:fs';

/* ---- arguments --------------------------------------------------------- */

function parseArgs(argv) {
  const out = { days: 14, metric: 'begin_checkout', weights: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    if (key === 'weights') {
      // --weights age_gate=50/50,hero_image=90/10
      val.split(',').forEach(pair => {
        const [id, spec] = pair.split('=');
        if (id && spec) out.weights[id] = spec.split('/').map(Number);
      });
    } else out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.property || args.help === 'true') {
  console.error(`
ga4-pull — pull A/B exposures and conversions out of GA4

  --property  <id>          GA4 property id, digits only            (required)
  --days      <n>           trailing window, default 14
  --since     <YYYY-MM-DD>  explicit start (overrides --days)
  --until     <YYYY-MM-DD>  explicit end, default today
  --metric    <event>       conversion event, default begin_checkout
  --weights   <spec>        configured split so the results view can run its
                            sample-ratio check, e.g. age_gate=50/50,hero_image=90/10
                            (order follows the arm order below)
  --control   <arm>         which arm is the control, default the alphabetically
                            first. Only needed if your arms are not named a/b/c.
  --out       <file>        write JSON here instead of stdout

Auth: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
`);
  process.exit(args.property ? 0 : 1);
}

/* ---- auth -------------------------------------------------------------- */

let GoogleAuth;
try {
  ({ GoogleAuth } = await import('google-auth-library'));
} catch {
  console.error('Missing dependency. Run:  npm i google-auth-library');
  process.exit(1);
}

const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFile) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON key.');
  process.exit(1);
}
try { readFileSync(keyFile); }
catch { console.error(`Cannot read credentials at ${keyFile}`); process.exit(1); }

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
const client = await auth.getClient();

/* ---- date window ------------------------------------------------------- */

const until = args.until || 'today';
const since = args.since || `${Number(args.days)}daysAgo`;

/* ---- the queries -------------------------------------------------------
   Two different shapes, because the two events carry the arm differently.

   `experiment_impression` is emitted once per active experiment and names it
   outright (experiment_id / variant_id), so the denominator is read straight
   off those two dimensions — no string parsing, no ambiguity.

   The conversion event carries no experiment_id; it only inherits the merged
   `ab_variants` context ("age_gate:b|hero_image:a"). So the numerator has to
   be recovered by splitting that list.

   `totalUsers` throughout, never eventCount: a visitor who reloads five times
   is one exposure, not five, and counting events would inflate the
   denominator faster than the numerator and quietly depress every rate.
   ------------------------------------------------------------------------ */

const ENDPOINT = `https://analyticsdata.googleapis.com/v1beta/properties/${args.property}:runReport`;

async function runReport(eventName, dimensions) {
  const body = {
    dateRanges: [{ startDate: since, endDate: until }],
    dimensions: dimensions.map(name => ({ name })),
    metrics: [{ name: 'totalUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: eventName } }
    },
    limit: 5000
  };
  const res = await client.request({ url: ENDPOINT, method: 'POST', data: body });
  return res.data.rows || [];
}

const exposures = {};
const conversions = {};

function bump(into, id, arm, field, n) {
  if (!id || !arm || arm === '(not set)') return;
  into[id] ??= {};
  into[id][arm] ??= { exposures: 0, conversions: 0 };
  into[id][arm][field] += n;
}

/* Denominator: experiment_id x variant_id, taken at face value. */
function tallyExposures(rows) {
  for (const row of rows) {
    const id  = row.dimensionValues?.[0]?.value;
    const arm = row.dimensionValues?.[1]?.value;
    bump(exposures, id, arm, 'exposures', Number(row.metricValues?.[0]?.value || 0));
  }
}

/* Numerator: split the pipe-joined list. One GA4 row feeds several
   experiments, which is right — a visitor converts for every test they are
   enrolled in at once. */
function tallyConversions(rows) {
  for (const row of rows) {
    const label = row.dimensionValues?.[0]?.value || '';
    const users = Number(row.metricValues?.[0]?.value || 0);
    if (!label || label === '(not set)' || !users) continue;
    for (const part of label.split('|')) {
      const [id, arm] = part.split(':');
      bump(conversions, id, arm, 'conversions', users);
    }
  }
}

try {
  tallyExposures(await runReport('experiment_impression',
    ['customEvent:experiment_id', 'customEvent:variant_id']));
  tallyConversions(await runReport(args.metric, ['customEvent:ab_variants']));
} catch (e) {
  const msg = e?.response?.data?.error?.message || e.message;
  console.error(`GA4 request failed: ${msg}`);
  if (/custom.*dimension|customEvent/i.test(msg || '')) {
    console.error(`
The custom dimension is probably not registered. In GA4:
  Admin -> Custom definitions -> Create custom dimension
Three event-scoped custom dimensions are needed, one per parameter:
    experiment_id, variant_id, ab_variants
They only collect from the moment they are created — GA4 does not backfill.`);
  }
  process.exit(1);
}

/* ---- assemble ---------------------------------------------------------- */

/* The results view treats the FIRST arm as the control, and the theme's control
   is the first key in the registry JSON — not necessarily the alphabetically
   first. They coincide for a/b/c naming, which is what the themes use, so the
   default sort is right; --control exists for anything named otherwise. */
const experiments = Object.keys(exposures).sort().map(id => {
  const arms = Object.keys(exposures[id]).sort();
  if (args.control && arms.includes(args.control)) {
    arms.splice(arms.indexOf(args.control), 1);
    arms.unshift(args.control);
  }
  const declared = args.weights[id];

  return {
    id,
    metric: args.metric,
    arms: arms.map((name, i) => ({
      name,
      // Without --weights there is nothing to check the split against, so the
      // configured share is assumed even. Pass the real weights for any test
      // that is not a straight split, or the guardrail will cry wolf.
      weight: declared ? (declared[i] ?? 0) : Math.round(100 / arms.length),
      exposures: exposures[id][name].exposures,
      conversions: conversions[id]?.[name]?.conversions || 0
    }))
  };
});

if (!experiments.length) {
  console.error(`No experiment_impression rows in ${since}..${until}. Check that:
  - the ab_variants custom dimension exists and has had time to collect
  - at least one experiment is enabled in the theme
  - the property id is right`);
  process.exit(1);
}

const payload = {
  pulledAt: new Date().toISOString(),
  property: String(args.property),
  window: { since, until },
  experiments
};

const json = JSON.stringify(payload, null, 2);

if (args.out && args.out !== 'true') {
  writeFileSync(args.out, json + '\n');
  console.error(`Wrote ${args.out}`);
} else {
  console.log(json);
}

/* A short human summary on stderr, so `> file.json` stays clean. */
console.error(`\n${since} .. ${until}   metric: ${args.metric}`);
for (const e of experiments) {
  console.error(`  ${e.id}`);
  for (const a of e.arms) {
    const rate = a.exposures ? (a.conversions / a.exposures * 100).toFixed(2) + '%' : '—';
    console.error(`    ${a.name}  ${String(a.exposures).padStart(9)} exposed  ` +
                  `${String(a.conversions).padStart(7)} converted  ${rate.padStart(7)}`);
  }
}
console.error('\nPaste the JSON into the results view -> Data & settings -> Paste a GA4 pull.');
