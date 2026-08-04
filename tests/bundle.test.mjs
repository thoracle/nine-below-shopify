/* The $199.99 bundle offer, and every way it must NOT appear.

   This section is the B arm of `bundle_offer`. It is gated by a positive match
   on the assigned arm — `:root:not([data-ab-bundle_offer="b"])` — so anything
   that stops the experiment running leaves the attribute absent and the offer
   hidden. The failure this guards against is not cosmetic: leaking a bundle
   price to traffic that was never enrolled would put an offer the campaign did
   not budget for in front of everyone, and would make the arm unreadable. */

import fs from 'node:fs';
import path from 'node:path';
import { mount, visible, PASS, events, impressions, paramsOf,
         click, ROOT, suite, section, ok, eq, done } from './harness.mjs';

const SRC = fs.readFileSync(path.join(ROOT, 'preview/index.html'), 'utf8');

const shown = async o => {
  const { w, d } = await mount({ agePass: PASS, ...o });
  const el = d.querySelector('[data-section-name="bundle"]');
  return { on: !!el && visible(w, el), w, d, el };
};

suite('bundle offer');

section('it appears only for an enrolled Instagram visitor in arm B');
eq('Instagram, arm B',        (await shown({ search: '?ch=ig&ab=bundle_offer:b' })).on, true);
eq('Instagram, arm A',        (await shown({ search: '?ch=ig&ab=bundle_offer:a' })).on, false);
eq('TikTok, arm B forced',    (await shown({ search: '?ch=tt&ab=bundle_offer:b' })).on, false);
eq('Facebook, arm B forced',  (await shown({ search: '?ch=fb&ab=bundle_offer:b' })).on, false);
eq('no channel, arm B forced',(await shown({ search: '?ab=bundle_offer:b' })).on, false);
eq('no channel, unforced',    (await shown({ search: '?ab=reset' })).on, false);

section('and stays hidden through every way the experiment can be absent');
for (const [label, html] of [
  ['experiment not registered', SRC.replace(/,"bundle_offer":\{[^}]*\}\}/, '}')],
  ['experiment parked',         SRC.replace('"bundle_offer":{"enabled":true', '"bundle_offer":{"enabled":false')],
  ['visitor held out',          SRC.replace('"bundle_offer":{"enabled":true,"traffic":100', '"bundle_offer":{"enabled":true,"traffic":0')],
  ['A/B framework absent',      SRC.replace(/<script id="ab-registry"[\s\S]*?<\/script>/, '')],
  ['registry is malformed',     SRC.replace(/(<script id="ab-registry"[^>]*>)/, '$1{{{ not json ')],
]) {
  const { w, d } = await mount({ search: '?ch=ig', agePass: PASS, html });
  const el = d.querySelector('[data-section-name="bundle"]');
  ok(label, !(el && visible(w, el)), 'a $199.99 offer must never leak to unenrolled traffic');
}

section('the offer is not counted for people who were never eligible');
{
  const { w } = await mount({ search: '?ch=tt&ab=reset', agePass: PASS });
  ok('no impression off-channel', !impressions(w).includes('bundle_offer'));
}
{
  const { w } = await mount({ search: '?ch=ig&ab=reset', agePass: PASS });
  ok('impression on Instagram', impressions(w).includes('bundle_offer'));
}

section('what the section actually says');
{
  const { d, el } = await shown({ search: '?ch=ig&ab=bundle_offer:b' });
  const txt = el.textContent.replace(/\s+/g, ' ');
  ok('bundle price shown', txt.includes('$199.99'));
  ok('retail shown as struck through', !!el.querySelector('s') && txt.includes('$262.95'));

  /* The saving is rendered from the two prices rather than typed, so the page
     cannot claim a discount its own numbers do not support. */
  ok('saving is the difference, to the cent', /Save \$62\.96/.test(txt), txt.slice(0, 160));

  const btn = el.querySelector('[data-buy-trigger]');
  ok('has its own buy button', !!btn);
  eq('tagged as the bundle offer', btn.getAttribute('data-offer'), 'bundle');
  ok('button carries the bundle price, not the bottle price',
     btn.textContent.includes('199.99') && !btn.textContent.includes('69.99'));
  ok('21+ notice is not stripped from the offer',
     /21/.test(el.textContent));
}

section('the two offers report as different products');
{
  const { w, el } = await shown({ search: '?ch=ig&ab=bundle_offer:b' });
  click(w, el.querySelector('[data-buy-trigger]'));
  await new Promise(r => setTimeout(r, 400));
  const atc = paramsOf(w, 'add_to_cart');
  eq('offer_type', atc.offer_type, 'bundle');
  eq('value', atc.value, 199.99);
  eq('item_id', atc.items[0].item_id, 'NB-BUNDLE-LE');
  eq('click reported as bundle', paramsOf(w, 'buy_button_click').offer_type, 'bundle');
}
{
  const { w, d } = await mount({ search: '?ch=ig&ab=bundle_offer:b', agePass: PASS });
  /* Enrolled in arm B, but buys a single bottle from the hero. Reporting that
     as a bundle sale would inflate the arm it is supposed to measure. */
  const hero = [...d.querySelectorAll('[data-buy-trigger]')]
    .find(b => b.getAttribute('data-offer') !== 'bundle' && visible(w, b));
  ok('the single-bottle button is still reachable in arm B', !!hero);
  click(w, hero);
  await new Promise(r => setTimeout(r, 400));
  const atc = paramsOf(w, 'add_to_cart');
  eq('offer_type', atc.offer_type, 'single');
  eq('value', atc.value, 69.99);
}

section('the handoff tag tells BottleNexus which offer was bought');
{
  const { w, d, el } = await shown({ search: '?ch=ig&ab=bundle_offer:b&utm_content=reel_07' });
  click(w, el.querySelector('[data-buy-trigger]'));
  await new Promise(r => setTimeout(r, 400));
  /* begin_checkout is raised by the cart's own checkout button, not by adding
     to the cart — the handoff tag is only meaningful at the point of leaving. */
  click(w, d.querySelector('[data-cart-checkout]'));
  await new Promise(r => setTimeout(r, 200));
  const co = [...(w[process.env.LOG || 'NINEBELOW_EVENT_LOG'] || [])]
    .find(e => e.event === 'begin_checkout');
  ok('begin_checkout fired', !!co);
  const tag = co && co.params.handoff_tag;
  ok('carries the arm and the offer', /offer-bundle/.test(tag) && /bundle_offer-b/.test(tag), tag);
  ok('preserves the ad creative id', /reel_07/.test(tag), tag);
}

done();
