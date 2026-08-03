/* =========================================================================
   Nine Below — measurement layer
   -------------------------------------------------------------------------
   The live site fires exactly five custom events (age_gate_view,
   age_gate_accept, form_open, form_submit, form_step_submit) and no
   ecommerce events at all. Because BottleNexus owns the cart and checkout,
   that means today there is no way to answer:

     · how many people click the buy button
     · how many reach the cart
     · how many start checkout
     · which placement or traffic source produced any of it

   This module restores the full funnel using GA4's standard ecommerce
   schema, so the built-in funnel/attribution reports work without custom
   modelling.

   Exposes window.NB for the other theme scripts.
   ========================================================================= */

(function () {
  'use strict';

  var cfgEl = document.getElementById('theme-config');
  var CFG = {};
  try { CFG = JSON.parse(cfgEl ? cfgEl.textContent : '{}'); } catch (e) { CFG = {}; }

  var GA = CFG.ga4 || {};
  var PRODUCT = CFG.product || {};
  var ENABLED = GA.enabled !== false;

  /* ---------------------------------------------------------------------
     Core dispatch
     --------------------------------------------------------------------- */

  function gtag() {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(arguments);
  }

  var sent = Object.create(null);

  /* Every event carries the visitor's experiment arms and traffic flow. This is
     what makes the whole framework measurable: without it you would know how
     many people entered arm B, but not how many of them converted, and you'd be
     stuck joining exports by hand. Merged here rather than at each call site so
     no event can be added later that forgets it. */
  function context() {
    var ctx = {};

    var ab = window.NINEBELOW_AB;
    if (ab && typeof ab.params === 'function') {
      var p = ab.params();
      for (var k in p) { if (p.hasOwnProperty(k)) ctx[k] = p[k]; }
    }

    var flow = window.NINEBELOW_FLOW;
    if (flow && flow.mode) ctx.flow_mode = flow.mode;

    return ctx;
  }

  function track(name, params) {
    if (!ENABLED) return;
    var merged = context();
    if (params) {
      for (var k in params) { if (params.hasOwnProperty(k)) merged[k] = params[k]; }
    }
    gtag('event', name, merged);
  }

  /* Fire a given event only once per page view. */
  function trackOnce(key, name, params) {
    if (sent[key]) return;
    sent[key] = true;
    track(name, params);
  }

  /* ---------------------------------------------------------------------
     Item payload
     GA4 ecommerce events share one item shape. Building it in one place
     keeps item_id/item_name consistent, which is what makes the funnel
     reports join correctly.
     --------------------------------------------------------------------- */

  function price() {
    var p = parseFloat(PRODUCT.price);
    return isNaN(p) ? undefined : p;
  }

  function item(extra) {
    var it = {
      item_id: PRODUCT.sku || 'NB-WW-750',
      item_name: PRODUCT.name || 'Nine Below — Winter Wheat Vodka',
      item_brand: 'Nine Below',
      item_category: 'Vodka',
      item_variant: PRODUCT.size || '750ml',
      quantity: 1
    };
    var p = price();
    if (p !== undefined) it.price = p;
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
    return it;
  }

  function ecommerce(name, extra) {
    var payload = {
      currency: PRODUCT.currency || 'USD',
      items: [item(extra && extra.item)]
    };
    var p = price();
    if (p !== undefined) payload.value = p * ((extra && extra.quantity) || 1);
    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k) && k !== 'item') payload[k] = extra[k];
      }
    }
    track(name, payload);
  }

  /* ---------------------------------------------------------------------
     Consent Mode v2
     --------------------------------------------------------------------- */

  var CONSENT_KEY = 'nb_consent_v2';

  function readConsent() {
    try {
      var raw = localStorage.getItem(CONSENT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeConsent(state) {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function applyConsent(state) {
    if (!GA.consentMode) return;
    var granted = function (v) { return v ? 'granted' : 'denied'; };
    gtag('consent', 'update', {
      ad_storage: granted(state.marketing),
      ad_user_data: granted(state.marketing),
      ad_personalization: granted(state.marketing),
      analytics_storage: granted(state.analytics),
      personalization_storage: granted(state.personalization)
    });
    gtag('set', 'ads_data_redaction', !state.marketing);
    track('consent_update', {
      analytics: state.analytics,
      marketing: state.marketing,
      personalization: state.personalization
    });
  }

  /* ---------------------------------------------------------------------
     Scroll depth
     Thresholds are the GA4 enhanced-measurement set plus 25/50, which on a
     long single-page layout is where the real drop-off shows.
     --------------------------------------------------------------------- */

  function initScrollDepth() {
    if (!GA.trackScroll) return;
    var marks = [25, 50, 75, 90];
    var hit = {};
    var ticking = false;

    function check() {
      ticking = false;
      var doc = document.documentElement;
      var scrollable = doc.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      var pct = Math.round((window.scrollY / scrollable) * 100);
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i];
        if (pct >= m && !hit[m]) {
          hit[m] = true;
          track('scroll_depth', { percent_scrolled: m });
        }
      }
    }

    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(check); }
    }, { passive: true });
  }

  /* ---------------------------------------------------------------------
     Section visibility
     Tells you which parts of the new page people actually reach — the input
     you need to decide what to cut or promote.
     --------------------------------------------------------------------- */

  function initSectionViews() {
    if (!('IntersectionObserver' in window)) return;
    var sections = document.querySelectorAll('[data-section-name]');
    if (!sections.length) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var name = entry.target.getAttribute('data-section-name');
        trackOnce('section:' + name, 'section_view', { section_name: name });
        io.unobserve(entry.target);
      });
    }, { threshold: 0.35 });

    sections.forEach(function (s) { io.observe(s); });
  }

  /* ---------------------------------------------------------------------
     CTA + outbound clicks
     --------------------------------------------------------------------- */

  function initClickTracking() {
    document.addEventListener('click', function (e) {
      var cta = e.target.closest('[data-track-cta]');
      if (cta) {
        track('cta_click', {
          cta_id: cta.getAttribute('data-track-cta'),
          cta_text: (cta.textContent || '').trim().slice(0, 80),
          link_url: cta.getAttribute('href') || undefined
        });
      }

      if (GA.trackOutbound) {
        var link = e.target.closest('a[href]');
        if (link) {
          var href = link.getAttribute('href') || '';
          if (/^https?:\/\//i.test(href)) {
            var host;
            try { host = new URL(href).hostname; } catch (err) { host = ''; }
            if (host && host !== window.location.hostname) {
              track('click', {
                link_url: href,
                link_domain: host,
                link_text: (link.textContent || '').trim().slice(0, 80),
                outbound: true
              });
            }
          }
        }
      }
    }, true);
  }

  /* ---------------------------------------------------------------------
     FAQ engagement
     Which objection a buyer opens is a direct read on what is blocking the
     sale — and cheap to act on.
     --------------------------------------------------------------------- */

  function initFaqTracking() {
    document.querySelectorAll('[data-faq-item]').forEach(function (el) {
      el.addEventListener('toggle', function () {
        if (!el.open) return;
        track('faq_open', { question: el.getAttribute('data-question') || '' });
      });
    });
  }

  /* ---------------------------------------------------------------------
     Engaged time — distinguishes a real read from a bounce.
     --------------------------------------------------------------------- */

  function initEngagement() {
    var start = Date.now();
    var fired = {};
    [15, 30, 60, 120].forEach(function (s) {
      setTimeout(function () {
        if (document.visibilityState !== 'visible' || fired[s]) return;
        fired[s] = true;
        track('engaged_time', { seconds: s });
      }, s * 1000);
    });

    window.addEventListener('pagehide', function () {
      track('session_duration', {
        seconds: Math.round((Date.now() - start) / 1000)
      });
    });
  }

  /* ---------------------------------------------------------------------
     Public surface
     --------------------------------------------------------------------- */

  window.NB = {
    config: CFG,
    gtag: gtag,
    track: track,
    trackOnce: trackOnce,
    ecommerce: ecommerce,
    item: item,
    price: price,
    consent: {
      read: readConsent,
      write: writeConsent,
      apply: applyConsent
    }
  };

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */

  /* Run fn once the visitor is past the age gate — immediately if they already
     are, or if this page has no gate. The API is published by the blocking head
     snippet, so it exists no matter where this file sits in the load order. */
  function whenSeen(fn) {
    var gate = window.NB_AGE_GATE;
    if (gate && typeof gate.onPass === 'function') gate.onPass(fn);
    else fn();
  }

  function boot() {
    // Restore a prior consent decision before anything else measures.
    var saved = readConsent();
    if (saved) applyConsent(saved);

    /* Delegated listeners cost nothing to attach early and there is nothing
       clickable behind the gate anyway, so these are not deferred — attaching
       late risks missing the first click after the panel lifts. */
    initClickTracking();
    initFaqTracking();

    /* Everything below reports on content the visitor cannot see yet. Fired on
       load it would say a bounce read the page: `view_item` for someone who
       only ever saw the gate, section views for sections that were display:none,
       and an engagement clock counting the seconds spent deciding whether to
       confirm their age. All of it waits. */
    whenSeen(function () {
      // view_item: the page IS the product page — but only once it is visible.
      ecommerce('view_item', { item_list_name: 'Homepage' });

      initScrollDepth();
      initSectionViews();
      // Started here, so the clock measures time on the page, not time at the gate.
      initEngagement();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
