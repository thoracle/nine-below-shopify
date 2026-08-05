/* What gets counted, and when.

   `experiment_impression` is the denominator of every conversion rate, so the
   moment it fires decides whether the numbers mean anything. Fire it behind the
   gate and you count people who never saw the variant. */

import { mount, visible, PASS, events, impressions, paramsOf, passGate,
         readPreview, suite, section, ok, eq, done } from './harness.mjs';

suite('measurement');

section('nothing is reported for a page the visitor cannot see');
{
  const { w } = await mount({ search: '?ab=reset,age_gate:a' });
  eq('only the gate is counted while the gate is up', impressions(w), ['age_gate']);
  ok('view_item held back', !events(w).includes('view_item'));
  ok('section views held back', !events(w).includes('section_view'));
}

section('and everything is released when the gate lifts');
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:a' });
  passGate(w, d);
  await new Promise(r => setTimeout(r, 150));
  const imps = impressions(w);
  ok('every live experiment counted', imps.includes('age_gate') && imps.includes('hero_headline') && imps.includes('hero_image'));
  eq('no duplicates', imps.length, new Set(imps).size);
  ok('view_item fired', events(w).includes('view_item'));
}

section('a visitor who refuses is counted only for the gate');
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:a' });
  d.querySelector('[data-gate-arm="a"] [data-gate-deny]')
   .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  eq('impressions', impressions(w), ['age_gate']);
  ok('no view_item', !events(w).includes('view_item'));
}

section('the gate reports itself, so a remembered pass is never counted for it');
{
  const { w } = await mount({ agePass: PASS });
  const imps = impressions(w);
  ok('age_gate NOT counted — no gate was shown', !imps.includes('age_gate'));
  ok('hero experiments still counted', imps.includes('hero_headline'));
  ok('no gate events at all', !events(w).includes('age_gate_view'));
}

section('context rides on every event');
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:a&ch=tt' });
  passGate(w, d);
  await new Promise(r => setTimeout(r, 150));
  const log = w[(process.env.LOG || 'NINEBELOW_EVENT_LOG')] || [];
  ok('at least six events fired', log.length >= 6, `got ${log.length}`);
  ok('channel on every one', log.every(e => e.params.channel === 'tt'));
  ok('ab_variants on every one', log.every(e => typeof e.params.ab_variants === 'string'));
  const vi = paramsOf(w, 'view_item');
  eq('flow_mode', vi.flow_mode, 'focus');
  eq('in_app_browser', vi.in_app_browser, false);
}

section('the buy path is instrumented');
{
  const { w, d } = await mount({ agePass: PASS });
  const btn = [...d.querySelectorAll('.buybtn__btn')].find(b => visible(w, b));
  ok('a reachable buy button exists', !!btn);
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const ev = events(w);
  ok('buy_button_click', ev.includes('buy_button_click'));
  ok('add_to_cart', ev.includes('add_to_cart'));
  ok('add_to_cart carries the arm', typeof paramsOf(w, 'add_to_cart').ab_variants === 'string');
}

section('the vendor script is not loaded before age is confirmed');
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:a' });
  ok('no buy_button_ready while gated', !events(w).includes('buy_button_ready'));
  const slot = d.querySelector('[data-buy-vendor-slot]');
  ok('vendor slot empty', !slot || !slot.children.length);
  d.querySelector('[data-gate-arm="a"] [data-gate-deny]')
   .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  ok('and never loads for a visitor who refuses', !events(w).includes('buy_button_ready'));
}

/* ---------------------------------------------------------------------------
   Load order.

   ab.js reports the denominator of every experiment through window.NB, which
   analytics.js publishes on its LAST line. Any arrangement where ab.js runs
   first — a reordered layout, or analytics.js throwing before it finishes —
   used to leave ab.js holding a no-op it had cached at load, and it would then
   discard every impression for the rest of the page without a word. The page
   looks perfect, the funnel logs, and the exposure count is zero.

   These fail if the reference to window.NB is ever cached at load time again.
   --------------------------------------------------------------------------- */

section('impressions survive ab.js loading before analytics.js');
{
  /* Deferred scripts execute in document order, so swapping the two tags is
     enough to run ab.js while window.NB does not yet exist. */
  const html = readPreview().replace(
    /(<script src="[^"]*analytics\.js"[^>]*><\/script>)\s*(<script src="[^"]*ab\.js"[^>]*><\/script>)/,
    '$2$1'
  );
  ok('the swap actually applied', html !== readPreview());

  const { w, d } = await mount({ html, search: '?ab=reset,age_gate:a' });
  passGate(w, d);
  await new Promise(r => setTimeout(r, 150));
  const imps = impressions(w);
  ok('hero_headline still counted', imps.includes('hero_headline'));
  ok('hero_image still counted', imps.includes('hero_image'));
  ok('the self-reporting gate still counted', imps.includes('age_gate'));
}

section('and survive window.NB being published late');
{
  /* The real hazard is subtler than order: impressions are held until the gate
     lifts, so window.NB only has to exist by THEN, not at load. A cached
     reference cannot see it arrive; a use-time read can. */
  const { w, d } = await mount({
    search: '?ab=reset,age_gate:a',
    mutate: (p, b) => p.endsWith('assets/analytics.js')
      ? b.replace('window.NB = {', 'window.__NB_LATE__ = {')
        + '\n;setTimeout(function () { window.NB = window.__NB_LATE__; }, 40);'
      : undefined
  });
  ok('window.NB was genuinely absent at ab.js load', !!w.__NB_LATE__);
  passGate(w, d);
  await new Promise(r => setTimeout(r, 200));
  ok('impressions landed once window.NB appeared', impressions(w).includes('hero_headline'));
}

section('and ab.js stays silent, not broken, when window.NB never arrives');
{
  const { w, d, logs } = await mount({
    search: '?ab=reset,age_gate:a',
    mutate: (p, b) => p.endsWith('assets/analytics.js')
      ? b.replace('window.NB = {', 'window.__NB_NEVER__ = {')
      : undefined
  });
  ok('nothing threw', !logs.some(l => l.startsWith('throw:')), logs.join(' | '));
  ok('no impressions were invented', impressions(w).length === 0);
  /* The gate must still block. An analytics failure may cost measurement; it
     may never cost compliance. */
  ok('the age gate still holds', d.documentElement.getAttribute('data-age') !== 'ok');
  passGate(w, d);
  await new Promise(r => setTimeout(r, 120));
  ok('and still opens on confirm', d.documentElement.getAttribute('data-age') === 'ok');
}

done();
