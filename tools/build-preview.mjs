#!/usr/bin/env node
/* =========================================================================
   build-preview — render the Liquid theme into preview/index.html

   The preview used to be maintained by hand, and it drifted every single time
   the theme changed. Three defects in one afternoon came from that alone: the
   analytics mirror kept a stale placeholder branch and never loaded gtag.js;
   the A/B framework copy had no channel scoping and bucketed every visitor;
   and the script order was the reverse of the layout, so a channel-scoped
   experiment excluded everybody. Each looked fine and failed silently.

   Generating removes the class of bug rather than the instances. The preview is
   now a build artifact: change the Liquid, re-run this, commit both.

     npm install && npm run build:preview

   This implements the subset of Shopify Liquid this theme actually uses — the
   tags and filters are enumerated below. It is not a general Shopify renderer
   and does not try to be; anything unsupported throws loudly rather than
   emitting something subtly wrong.
   ========================================================================= */

import { Liquid, Value, Tokenizer, evalToken } from 'liquidjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJSON = p => JSON.parse(read(p));

/* ---- theme data -------------------------------------------------------- */

/* Settings resolve the way Shopify resolves them: schema defaults first, then
   whatever settings_data.json has stored on top. A setting that exists in the
   schema but not in the data must still render its default, or the preview
   diverges from a fresh install. */
function loadSettings() {
  const out = {};
  for (const group of readJSON('config/settings_schema.json')) {
    for (const s of group.settings || []) {
      if (s.id && 'default' in s) out[s.id] = s.default;
    }
  }
  Object.assign(out, readJSON('config/settings_data.json').current);
  return out;
}

/* Section schema defaults, same idea one level down. */
function sectionSchema(type) {
  const src = read(`sections/${type}.liquid`);
  const m = src.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  return m ? JSON.parse(m[1]) : {};
}

function sectionDefaults(schema) {
  const out = {};
  for (const s of schema.settings || []) if (s.id && 'default' in s) out[s.id] = s.default;
  return out;
}

function blockDefaults(schema, type) {
  const def = (schema.blocks || []).find(b => b.type === type);
  const out = {};
  for (const s of (def && def.settings) || []) if (s.id && 'default' in s) out[s.id] = s.default;
  return out;
}

/* ---- engine ------------------------------------------------------------ */

const engine = new Liquid({
  root: [path.join(ROOT, 'snippets'), path.join(ROOT, 'sections')],
  extname: '.liquid',
  jsTruthy: true,          // Shopify treats empty string as falsy in `if`
  strictFilters: true,     // an unimplemented filter must fail loudly
  strictVariables: false   // undefined objects render blank, as Shopify does
});

/* ---- Shopify filters --------------------------------------------------- */

const F = engine.filters;

/* Bundled theme assets. Under Pages the preview sits one level below the theme
   root, so `../assets/x` resolves to the same file Shopify would serve. */
engine.registerFilter('asset_url', v => `../assets/${v}`);

/* image_url only ever receives an uploaded image here, and none are set in
   this build — every image_picker is blank and the theme falls through to its
   bundled asset. Returning the raw value keeps that path honest; if an image
   were ever uploaded, the preview would show a broken src rather than silently
   inventing a CDN URL that does not exist. */
engine.registerFilter('image_url', v => (v == null || v === '' ? '' : String(v)));

engine.registerFilter('json', v => JSON.stringify(v === undefined ? null : v));
engine.registerFilter('handleize', v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
engine.registerFilter('handle', v => F.handleize(v));
engine.registerFilter('strip_newlines', v => String(v ?? '').replace(/[\r\n]+/g, ''));
engine.registerFilter('t', v => String(v ?? ''));            // no locale lookup in the preview
engine.registerFilter('money', v => `$${Number(v || 0).toFixed(2)}`);
engine.registerFilter('font_face', () => '');                 // system fonts in the preview
engine.registerFilter('font_modify', v => v);

/* color_modify: only `alpha` is used by this theme. Hex in, rgba out. */
engine.registerFilter('color_modify', (color, prop, value) => {
  if (prop !== 'alpha') return color;
  const h = String(color || '').replace('#', '');
  if (h.length !== 6) return color;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${value})`;
});

/* ---- Shopify tags ------------------------------------------------------ */

/* {% schema %} … {% endschema %} — parsed by the build, never rendered. */
engine.registerTag('schema', {
  parse(token, remain) {
    this.tokens = [];
    while (remain.length) {
      const t = remain.shift();
      if (t.name === 'endschema') return;
      this.tokens.push(t);
    }
  },
  render() { return ''; }
});

/* {% style %} … {% endstyle %} — Shopify wraps the body in a <style> element. */
engine.registerTag('style', {
  parse(token, remain) {
    this.tpls = [];
    const stream = this.liquid.parser.parseStream(remain)
      .on('template', tpl => this.tpls.push(tpl))
      .on('tag:endstyle', function () { this.stop(); })
      .on('end', () => { throw new Error('{% style %} is missing {% endstyle %}'); });
    stream.start();
  },
  *render(ctx, emitter) {
    emitter.write('<style>');
    yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
    emitter.write('</style>');
  }
});

/* {% render 'name' %} and {% render 'name', k: v %}

   liquidjs's own render tag isolates scope and does NOT carry the globals, so
   every `{% if settings.x %}` inside a snippet was silently false — the A/B
   framework, the flow styles and the analytics head all rendered as empty
   strings and the page merely looked a bit short. Shopify isolates too, but
   keeps the global objects available, which is what this restores.

   Isolation is otherwise preserved: a snippet gets `settings` and whatever it
   was passed, never the caller's `section` or `block`. No snippet in this theme
   references those, which is why Shopify's own rule works here unchanged. */
engine.registerTag('render', {
  parse(token) {
    const tok = new Tokenizer(token.args);
    this.file = tok.readValue();
    this.args = {};
    tok.skipBlank();
    if (tok.peek() === ',') tok.advance();
    while (!tok.end()) {
      tok.skipBlank();
      const name = tok.readIdentifier();
      if (!name || !name.content) break;
      tok.skipBlank();
      if (tok.peek() !== ':') break;
      tok.advance();
      this.args[name.content] = tok.readValue();
      tok.skipBlank();
      if (tok.peek() === ',') tok.advance();
    }
  },
  *render(ctx, emitter) {
    const name = yield evalToken(this.file, ctx);
    const scope = { ...globals };
    for (const k of Object.keys(this.args)) scope[k] = yield evalToken(this.args[k], ctx);
    emitter.write(yield this.liquid.parseAndRender(read(`snippets/${name}.liquid`), scope));
  }
});

/* {% section 'name' %} — renders sections/<name>.liquid with the settings and
   blocks the template assigns it, over the section schema's own defaults. */
engine.registerTag('section', {
  parse(token) { this.value = new Value(token.args, this.liquid); },
  *render(ctx, emitter) {
    const name = yield this.value.value(ctx);
    // `template` and `globals` are module-scope constants. They are declared
    // below this registration, but render only ever runs during
    // parseAndRender, by which point both are initialised.
    const key = Object.keys(template.sections).find(k => template.sections[k].type === name);
    const conf = key ? template.sections[key] : { type: name, settings: {}, blocks: {} };
    const schema = sectionSchema(name);

    const settings = { ...sectionDefaults(schema), ...(conf.settings || {}) };
    const order = conf.block_order || Object.keys(conf.blocks || {});
    const blocks = order.map((bid, i) => {
      const b = conf.blocks[bid];
      return {
        id: bid,
        type: b.type,
        settings: { ...blockDefaults(schema, b.type), ...(b.settings || {}) },
        shopify_attributes: `data-block-id="${bid}"`,
        index: i
      };
    });

    const src = read(`sections/${name}.liquid`);
    const html = yield this.liquid.parseAndRender(src, {
      ...globals,
      section: { id: key || name, settings, blocks }
    });
    // Shopify wraps sections in an id'd div; the theme's own markup already
    // carries the classes, so this only mirrors the wrapper.
    emitter.write(`<div id="shopify-section-${key || name}" class="shopify-section">${html}</div>`);
  }
});

/* ---- render the layout ------------------------------------------------- */

const settings = loadSettings();
const template = readJSON('templates/index.json');

const globals = {
  settings,
  shop: { name: settings.product_name?.split('—')[0].trim() || 'Shop', url: 'https://example.com' },
  request: { locale: { iso_code: 'en' }, path: '/' },
  template: { name: 'index' },
  page_title: settings.meta_title || 'Preview',
  page_description: settings.meta_description || '',
  canonical_url: '',
  content_for_header: '',
  content_for_layout: ''
};

/* content_for_layout is the template's sections, in order. */
let body = '';
for (const key of template.order) {
  const conf = template.sections[key];
  const schema = sectionSchema(conf.type);
  const s = { ...sectionDefaults(schema), ...(conf.settings || {}) };
  const order = conf.block_order || Object.keys(conf.blocks || {});
  const blocks = order.map((bid, i) => {
    const b = conf.blocks[bid];
    return {
      id: bid, type: b.type,
      settings: { ...blockDefaults(schema, b.type), ...(b.settings || {}) },
      shopify_attributes: `data-block-id="${bid}"`, index: i
    };
  });
  const html = await engine.parseAndRender(read(`sections/${conf.type}.liquid`), {
    ...globals, section: { id: key, settings: s, blocks }
  });
  body += `<div id="shopify-section-${key}" class="shopify-section">${html}</div>\n`;
}
globals.content_for_layout = body;

let out = await engine.parseAndRender(read('layout/theme.liquid'), globals);

/* ---- preview-only scaffolding -----------------------------------------
   Everything above is the theme exactly as Shopify would render it. What
   follows exists only in the preview: an in-page event log so the funnel can
   be inspected without opening GA4, and the ?debug=1 panel that displays it.
   Kept here rather than in the theme so it can never ship to a real store. */

const extras = read('tools/preview-extras.html');
out = out.replace('</head>', extras.split('<!--BODY-->')[0] + '\n</head>');
out = out.replace('</body>', extras.split('<!--BODY-->')[1] + '\n</body>');

/* The preview is served from preview/, one level below the theme root. */
out = out.replace(/(["'(])\.\.\/assets\//g, '$1../assets/');

fs.writeFileSync(path.join(ROOT, 'preview/index.html'), out);

const size = (out.length / 1024).toFixed(0);
console.log(`preview/index.html  ${size} KB  ${template.order.length} sections`);
