/* The age gate must never fail open.
   Twelve ways for it to break, plus the paths where it must actually open. */

import { mount, visible, PASS, GKEY, click, suite, section, ok, eq, done } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const SRC = fs.readFileSync(path.join(ROOT, 'preview/index.html'), 'utf8');
const bust = (rel, name) => rel.endsWith(name);

async function blocked(label, opts) {
  const { w, d } = await mount(opts);
  const gate = d.getElementById('age-gate');
  const main = d.querySelector('main');
  const header = d.querySelector('[data-header]');
  const gateUp = !!gate && visible(w, gate);
  const hidden = !visible(w, main) && !(header && visible(w, header));
  ok(label, gateUp && hidden, gateUp && hidden ? '' : `gate=${gateUp} contentHidden=${hidden}`);
}

suite('age gate');

section('it must stay closed in every failure mode');
await blocked('normal load, first visit',        {});
await blocked('JavaScript disabled entirely',    { js: false });
await blocked('theme.js fails to load',          { mutate: r => bust(r, 'assets/theme.js') ? null : undefined });
await blocked('theme.js throws on first line',   { mutate: (r, b) => bust(r, 'assets/theme.js') ? 'throw new Error("boom");' + b : b });
await blocked('analytics.js throws',             { mutate: (r, b) => bust(r, 'analytics.js') ? 'throw new Error("boom");' + b : b });
await blocked('ab.js throws',                    { mutate: (r, b) => bust(r, 'ab.js') ? 'throw new Error("boom");' + b : b });
await blocked('age-gate.js fails to load',       { mutate: r => bust(r, 'age-gate.js') ? null : undefined });
await blocked('age-gate.js throws immediately',  { mutate: (r, b) => bust(r, 'age-gate.js') ? 'throw new Error("boom");' + b : b });
await blocked('theme.css fails to load',         { mutate: r => bust(r, 'theme.css') ? null : undefined });
await blocked('expired stored pass',             { agePass: JSON.stringify({ v: true, exp: Date.now() - 1 }) });
await blocked('corrupt stored pass',             { agePass: '{{{not json' });
await blocked('forged falsy pass',               { agePass: JSON.stringify({ v: false, exp: Date.now() + 9e9 }) });

section('and it must open when it should');
{
  const { w, d } = await mount({ agePass: PASS });
  ok('returning visitor sees the page', visible(w, d.querySelector('main')));
  ok('gate removed, no flash', !d.getElementById('age-gate') && d.documentElement.getAttribute('data-age') === 'ok');
}
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:a' });
  click(w, d.querySelector('[data-gate-arm="a"] [data-gate-confirm]'));
  await new Promise(r => setTimeout(r, 40));
  ok('content revealed before the fade ends', d.documentElement.getAttribute('data-age') === 'ok' && visible(w, d.querySelector('main')));
  /* Assert the exact key, not an alternation. Accepting a second theme's
     cookie name meant this passed even if the wrong cookie were written, which
     is the only failure worth catching here. */
  ok('pass mirrored to a cookie', new RegExp(GKEY + '=1').test(d.cookie), d.cookie);
  await new Promise(r => setTimeout(r, 400));
  ok('gate element removed after the fade', !d.getElementById('age-gate'));
}

section('arm A — one tap');
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:a' });
  eq('arm attribute', d.documentElement.getAttribute('data-ab-age_gate'), 'a');
  ok('arm A shown, B hidden',
    visible(w, d.querySelector('[data-gate-arm="a"]')) && !visible(w, d.querySelector('[data-gate-arm="b"]')));
  eq('labelled for screen readers', d.getElementById('age-gate').getAttribute('aria-labelledby'), 'age-gate-heading-a');
}

section('arm B — birthdate');
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:b' });
  const arm = d.querySelector('[data-gate-arm="b"]');
  ok('arm B shown', visible(w, arm));
  const f = k => arm.querySelector(`[data-gate-${k}]`);
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const submit = () => arm.querySelector('[data-gate-form]').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const err = f('error');

  type(f('mm'), 'ab12');
  eq('non-digits stripped', f('mm').value, '12');
  ok('auto-advances when a field fills', d.activeElement === f('dd'));

  type(f('dd'), '99'); type(f('yyyy'), '2000'); submit();
  ok('day 99 rejected', !err.hidden);

  type(f('mm'), '02'); type(f('dd'), '31'); type(f('yyyy'), '2000'); submit();
  ok('31 February rejected, not rolled to 3 March', !err.hidden);

  type(f('mm'), '02'); type(f('dd'), '29'); type(f('yyyy'), '2004'); submit();
  ok('leap day accepted, of age', d.getElementById('age-gate').style.opacity === '0');
}
{
  const { w, d } = await mount({ search: '?ab=reset,age_gate:b' });
  const arm = d.querySelector('[data-gate-arm="b"]');
  const type = (k, v) => { const e = arm.querySelector(`[data-gate-${k}]`); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };
  type('mm', '06'); type('dd', '15'); type('yyyy', '2015');
  arm.querySelector('[data-gate-form]').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  ok('under age is refused', arm.querySelector('[data-gate-step="ask"]').hidden
    && !arm.querySelector('[data-gate-step="deny"]').hidden);
  ok('and stays refused — content still hidden', !visible(w, d.querySelector('main')));
}

section('a broken arm B falls back rather than trapping the visitor');
{
  const html = SRC.replace(/<form class="dob"[\s\S]*?<\/form>/, '<!-- removed -->');
  const { w, d } = await mount({ search: '?ab=reset,age_gate:b', html });
  eq('attribute corrected to the wired arm', d.documentElement.getAttribute('data-ab-age_gate'), 'a');
  const yes = d.querySelector('[data-gate-arm="a"] [data-gate-confirm]');
  ok('a working control is offered', !!yes && visible(w, yes));
  click(w, yes);
  ok('and the visitor gets through', d.documentElement.getAttribute('data-age') === 'ok');
}

section('QA');
{
  const { w, d } = await mount({ search: '?agegate=reset', agePass: PASS });
  ok('?agegate=reset re-opens the gate for a passed visitor', visible(w, d.getElementById('age-gate')));
  ok('and clears the stored pass', w.localStorage.getItem(GKEY) === null);
}

done();
