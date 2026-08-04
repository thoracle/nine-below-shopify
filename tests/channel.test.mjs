/* Which platform sent the visitor, what they are shown, and what is stripped.

   Channel matching is by TOKEN, not substring. Substring made `meta` match
   metaverse, metabase, metal and metaphor, and `insta` match instant — a
   campaign called metal_bottle_promo would have been served the ad landing and
   filed under Facebook. The false-positive cases below are permanent guards. */

import { mount, visible, PASS, impressions, suite, section, ok, eq, done } from './harness.mjs';

const UA = {
  ig:    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 302.0.0.23.113',
  fb:    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/443.0]',
  tt:    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 BytedanceWebview/d8a21c6 musical_ly_31.5.3',
  plain: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
};

const chan = async o => (await mount(o)).w.NINEBELOW_FLOW;

suite('channel');

section('resolution, in priority order');
for (const [label, o, want] of [
  ['?ch=tt',                          { search: '?ch=tt' },                        'tt'],
  ['?flow=ig',                        { search: '?flow=ig' },                      'ig'],
  ['utm_source=tiktok',               { search: '?utm_source=tiktok' },            'tt'],
  ['utm_source=tiktok_ads_manager',   { search: '?utm_source=tiktok_ads_manager' },'tt'],
  ['utm_source=facebook',             { search: '?utm_source=facebook' },          'fb'],
  ['utm_campaign=ig_reel_07',         { search: '?utm_campaign=ig_reel_07' },      'ig'],
  ['utm_source=fb-feed',              { search: '?utm_source=fb-feed' },           'fb'],
  ['Instagram in-app browser',        { ua: UA.ig },                               'ig'],
  ['Facebook in-app browser',         { ua: UA.fb },                               'fb'],
  ['TikTok in-app browser',           { ua: UA.tt },                               'tt'],
  ['referrer l.instagram.com',        { referrer: 'https://l.instagram.com/' },    'ig'],
  ['referrer m.facebook.com',         { referrer: 'https://m.facebook.com/' },     'fb'],
  ['plain browser, no signals',       { ua: UA.plain },                            null],
  ['unrelated referrer',              { referrer: 'https://news.ycombinator.com/' },null],
  ['?flow=full beats a webview',      { search: '?flow=full', ua: UA.ig },         null],
]) eq(label, (await chan(o)).channel, want);

section('token matching — these must NOT resolve to a channel');
for (const [label, q] of [
  ['metaverse_launch',  '?utm_campaign=metaverse_launch'],
  ['metabase',          '?utm_source=metabase'],
  ['metal_bottle_promo','?utm_campaign=metal_bottle_promo'],
  ['winter_metaphor',   '?utm_campaign=winter_metaphor'],
  ['instant_delivery',  '?utm_campaign=instant_delivery'],
]) eq(label, (await chan({ search: q })).channel, null);

section('in-app browsers are detected independently of channel');
for (const [label, ua, want] of [['Instagram', UA.ig, 'ig'], ['Facebook', UA.fb, 'fb'],
                                 ['TikTok', UA.tt, 'tt'], ['desktop Chrome', UA.plain, null]]) {
  const f = await chan({ ua });
  eq(label, f.webview, want);
  eq(`${label} — inApp flag`, f.inApp, want !== null);
}

section('message match — exactly one headline, and the right one');
for (const [label, o, want] of [
  ['Instagram', { search: '?ch=ig', agePass: PASS }, 'Clear enough to see the cold in it.'],
  ['TikTok',    { search: '?ch=tt', agePass: PASS }, "Why it's called Nine Below."],
  ['Facebook',  { search: '?ch=fb', agePass: PASS }, 'No sugar. No glycerol. Nothing to hide behind.'],
  ['no channel, arm A', { search: '?ab=reset,hero_headline:a', agePass: PASS, ua: UA.plain }, 'Nine distillations. One clean finish.'],
  ['no channel, arm B', { search: '?ab=reset,hero_headline:b', agePass: PASS, ua: UA.plain }, 'Distilled nine times. Filtered at nine below.'],
]) {
  const { w, d } = await mount(o);
  const shown = [...d.querySelectorAll('.hero__title')].filter(e => visible(w, e));
  ok(label, shown.length === 1 && shown[0].textContent.trim() === want,
     shown.length === 1 ? `"${shown[0].textContent.trim()}"` : `${shown.length} visible`);
}

section('a channel-scoped experiment buckets only its own channel');
{
  /* ig_strip ships parked, so nobody is enrolled and the scoping rule would
     never be exercised. Enable it for this check only — the point is the
     channel gate, not the on/off switch, and conflating the two would let a
     broken scope pass unnoticed the day someone launches the test. */
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const { ROOT: R } = await import('./harness.mjs');
  const live = fsx.readFileSync(pathx.join(R, 'preview/index.html'), 'utf8')
    .replace('"ig_strip":{"enabled":false', '"ig_strip":{"enabled":true');
  ok('registry patched for this check', live.includes('"ig_strip":{"enabled":true'));

  for (const [label, q, should] of [
    ['Instagram',  '?ch=ig&ab=reset', true],
    ['TikTok',     '?ch=tt&ab=reset', false],
    ['Facebook',   '?ch=fb&ab=reset', false],
    ['no channel', '?ab=reset',       false],
  ]) {
    const { w } = await mount({ search: q, agePass: PASS, html: live });
    const active = Object.keys(w.NINEBELOW_AB.active).filter(k => w.NINEBELOW_AB.active[k]);
    eq(`${label} enrolled in ig_strip`, active.includes('ig_strip'), should);
  }
  const { w } = await mount({ search: '?ch=tt&ab=reset', agePass: PASS, html: live });
  ok('and reports no impression for an out-of-scope channel', !impressions(w).includes('ig_strip'));
}

section('forcing an arm works even while the experiment is parked');
{
  const { d } = await mount({ search: '?ch=ig&ab=ig_strip:b', agePass: PASS });
  eq('forced arm wins over the off switch', d.documentElement.getAttribute('data-ab-ig_strip'), 'b');
}

section('ad landings are stripped to the purchase path');
const SECTIONS = ['hero','product_story','tasting_notes','craft_process','serve','social_proof','faq','email_capture'];
const shownSections = async o => {
  const { w, d } = await mount({ agePass: PASS, ...o });
  return SECTIONS.filter(n => {
    const el = d.querySelector(`[data-section-name="${n}"]`);
    return el && visible(w, el);
  });
};
eq('full site',        await shownSections({ search: '?flow=full' }), SECTIONS);
eq('focus, no channel',await shownSections({ search: '?flow=focus' }), ['hero','product_story','social_proof']);
eq('Instagram arm A',  await shownSections({ search: '?ch=ig&ab=ig_strip:a' }), ['hero','product_story','social_proof']);
eq('Instagram arm B',  await shownSections({ search: '?ch=ig&ab=ig_strip:b' }), ['hero','social_proof']);
eq('TikTok',           await shownSections({ search: '?ch=tt' }), ['hero','product_story','social_proof']);
eq('Facebook',         await shownSections({ search: '?ch=fb' }), ['hero','product_story','social_proof']);

section('the strip survives every way the experiment can be absent');
{
  const fs2 = await import('node:fs');
  const path = await import('node:path');
  const { ROOT } = await import('./harness.mjs');
  const SRC = fs2.readFileSync(path.join(ROOT, 'preview/index.html'), 'utf8');
  for (const [label, html] of [
    ['experiment not registered', SRC.replace(/,\s*\n?\s*"ig_strip":\{[^}]*\}\}/, '')],
    ['experiment parked',         SRC.replace('"ig_strip":{"enabled":true', '"ig_strip":{"enabled":false')],
    ['visitor held out',          SRC.replace('"ig_strip":{"enabled":true,"traffic":100', '"ig_strip":{"enabled":true,"traffic":0')],
    ['A/B framework absent',      SRC.replace(/<script id="ab-registry"[\s\S]*?<\/script>/, '')],
  ]) {
    const { w, d } = await mount({ search: '?ch=ig', agePass: PASS, html });
    const n = SECTIONS.filter(s => { const el = d.querySelector(`[data-section-name="${s}"]`); return el && visible(w, el); }).length;
    ok(label, n <= 3, `${n}/8 visible — the full site must never leak to paid traffic`);
  }
}

section('compliance is never stripped');
{
  const { w, d } = await mount({ search: '?ch=ig', agePass: PASS });
  ok('21+ purchase notice', [...d.querySelectorAll('.buybtn__legal')].some(e => /21/.test(e.textContent) && visible(w, e)));
  ok('responsibility statement', /DRINK RESPONSIBLY/i.test(d.body.textContent));
  ok('a reachable buy button', [...d.querySelectorAll('.buybtn__btn')].some(b => visible(w, b)));
}

done();
