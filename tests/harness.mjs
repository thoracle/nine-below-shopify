/* =========================================================================
   Shared test harness.

   Every suite renders the real preview/index.html — the generated one — in
   jsdom, against the real assets/ and snippets on disk. That is deliberate:
   these tests exist to catch the theme diverging from what it claims to do,
   so they must read the same files a browser would.

   jsdom lies in three ways this harness papers over:

     · localStorage throws at an opaque origin, so a real `url` is always set
     · there is no matchMedia, and theme.js reads it at the top of its IIFE —
       without a polyfill the whole file throws and nothing under test runs
     · getComputedStyle does not inherit invisibility, so an element inside a
       display:none parent still reports its own display. Shopify wraps every
       section in <div class="shopify-section">, so visibility MUST be judged
       up the ancestor chain. Getting this wrong once made a working age gate
       look like it was failing all twelve of its blocking tests.
   ========================================================================= */

import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.THEME
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LOG  = process.env.LOG  || 'NINEBELOW_EVENT_LOG';
export const GKEY = process.env.GKEY || 'nb_age_ok';

/* Serve the theme off disk. Images are skipped — they are large, none of the
   assertions depend on them, and loading them makes every suite slow. */
class ThemeLoader extends ResourceLoader {
  constructor(mutate) { super(); this.mutate = mutate; }
  fetch(url) {
    const m = url.match(/^https?:\/\/[^/]+\/(.*)$/);
    if (!m) return null;
    const rel = decodeURIComponent(m[1]).replace(/^preview\/\.\.\//, '').split('?')[0];
    if (/\.(webp|png|jpe?g|svg|gif|ico)$/i.test(rel)) return null;
    let body;
    try { body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
    if (this.mutate) {
      const out = this.mutate(rel, body);
      if (out === null) return null;            // simulate a 404
      if (out !== undefined) body = out;        // simulate a modified asset
    }
    return Promise.resolve(Buffer.from(body));
  }
}

/**
 * Render the preview.
 * @param {object} o
 * @param {string} o.search   query string, e.g. '?ch=ig'
 * @param {string} o.ua       user agent to report
 * @param {string} o.referrer document.referrer
 * @param {string} o.html     override the page source (for damage simulation)
 * @param {Function} o.mutate (path, body) => body | null | undefined
 * @param {boolean} o.js      false to render with scripting disabled
 * @param {string|false} o.agePass  stored age pass; false for a fresh visitor
 */
export async function mount(o = {}) {
  const logs = [];
  const vc = new VirtualConsole()
    .on('jsdomError', e => logs.push('throw: ' + e.message))
    .on('error', (...a) => logs.push('error: ' + a.join(' ')))
    .on('warn', (...a) => logs.push('warn: ' + a.join(' ')));

  const src = o.html ?? fs.readFileSync(path.join(ROOT, 'preview/index.html'), 'utf8');
  const opts = {
    url: 'https://theme.test/preview/' + (o.search || ''),
    runScripts: o.js === false ? 'outside-only' : 'dangerously',
    pretendToBeVisual: true,
    resources: new ThemeLoader(o.mutate),
    virtualConsole: vc,
    /* The age pass and the UA must exist BEFORE parsing: the head snippet reads
       storage during parse, so seeding afterwards is already too late. */
    beforeParse(w) {
      if (o.agePass) {
        try { w.localStorage.setItem(GKEY, o.agePass); } catch {}
      }
      if (o.js !== false) {
        w.matchMedia = q => ({
          matches: false, media: q,
          addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {}
        });
        if (o.ua) Object.defineProperty(w.navigator, 'userAgent', { value: o.ua, configurable: true });
      }
    }
  };
  if (o.referrer) opts.referrer = o.referrer;

  const dom = new JSDOM(src, opts);
  await new Promise(r => dom.window.addEventListener('load', r));
  await new Promise(r => setTimeout(r, o.settle ?? 70));
  return { w: dom.window, d: dom.window.document, logs, dom };
}

export const PASS = JSON.stringify({ v: true, exp: Date.now() + 9e8 });

/** Visibility, judged up the ancestor chain. See the note at the top. */
export function visible(w, el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const s = w.getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (n.hasAttribute && n.hasAttribute('hidden')) return false;
  }
  return true;
}

export const events = w => (w[LOG] || []).map(e => e.event);
export const impressions = w =>
  (w[LOG] || []).filter(e => e.event === 'experiment_impression').map(e => e.params.experiment_id);
export const paramsOf = (w, name) => ((w[LOG] || []).find(e => e.event === name) || {}).params || {};

export const click = (w, el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
export const passGate = (w, d) => click(w, d.querySelector('[data-gate-arm="a"] [data-gate-confirm]'));

/* ---- assertions -------------------------------------------------------- */

const state = { pass: 0, fail: 0, name: '' };

export function suite(name) {
  state.name = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

export function section(text) { console.log(`\n  ${text}`); }

export function ok(label, condition, detail = '') {
  if (condition) { state.pass++; console.log(`    \x1b[32mok\x1b[0m   ${label}${detail ? '  ' + detail : ''}`); }
  else { state.fail++; console.log(`    \x1b[31mFAIL\x1b[0m ${label}${detail ? '  ' + detail : ''}`); }
  return !!condition;
}

export function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(label, a === e, a === e ? '' : `got ${a} want ${e}`);
}

export function done() {
  const { pass, fail } = state;
  console.log(fail
    ? `\n  \x1b[31m${fail} failed\x1b[0m, ${pass} passed\n`
    : `\n  \x1b[32mall ${pass} passed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}
