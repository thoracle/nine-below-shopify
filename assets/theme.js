/* =========================================================================
   Nine Below — theme behaviour
   Age gate, sticky CTA, header, nav, announcements, consent, signup, reveal.
   ========================================================================= */

(function () {
  'use strict';

  var CFG = (window.NB && window.NB.config) || {};
  var track = (window.NB && window.NB.track) || function () {};
  var GATE = CFG.ageGate || {};

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* =====================================================================
     Storage helpers — every write is guarded because Safari private mode
     throws on localStorage.setItem.
     ===================================================================== */

  function store(key, value, days) {
    try {
      localStorage.setItem(key, JSON.stringify({
        v: value,
        exp: days ? Date.now() + days * 864e5 : null
      }));
    } catch (e) {}
  }

  function recall(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed.exp && Date.now() > parsed.exp) {
        localStorage.removeItem(key);
        return null;
      }
      return parsed.v;
    } catch (e) { return null; }
  }

  /* =====================================================================
     Age gate — lives in age-gate.js, which loads first and does not depend on
     this file. Anything that measures visible UI subscribes here so it never
     reports an impression for a page still behind the panel. If that file is
     somehow absent, run immediately rather than silently never initialising.
     ===================================================================== */

  function onGatePassed(fn) {
    var gate = window.NB_AGE_GATE;
    if (gate && typeof gate.onPass === 'function') gate.onPass(fn);
    else fn();
  }

  /* =====================================================================
     Header
     ===================================================================== */

  function initHeader() {
    var header = document.querySelector('[data-header]');
    if (!header) return;

    var lastY = 0;
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      header.classList.toggle('is-scrolled', y > 24);
      lastY = y;
    }, { passive: true });

    var toggle = document.querySelector('[data-nav-toggle]');
    var nav = document.querySelector('[data-mobile-nav]');
    if (!toggle || !nav) return;

    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      toggle.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
      nav.hidden = open;
      document.body.classList.toggle('nav-open', !open);
      if (!open) track('nav_open', { device: 'mobile' });
    });

    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        toggle.setAttribute('aria-expanded', 'false');
        nav.hidden = true;
        document.body.classList.remove('nav-open');
      }
    });
  }

  /* =====================================================================
     Sticky CTAs
     Both the mobile bar and the header button reveal only once the hero CTA
     has left the viewport, so they never compete with the primary button.
     ===================================================================== */

  function initStickyCtas() {
    var heroCta = document.querySelector('.hero__cta [data-buy-root]');
    var bar = document.querySelector('[data-sticky-bar]');
    var headerCta = document.querySelector('[data-header-cta]');

    /* In the bundle arm the hero CTA is removed and the bundle's button is the
       primary one. Observing a display:none element would report it as
       permanently off-screen, pinning the sticky bar open from the very top of
       the page — competing with the offer instead of backing it up.
       offsetParent is null exactly when an ancestor is display:none. */
    var anchor = heroCta;
    if (!anchor || !anchor.offsetParent) {
      anchor = document.querySelector('[data-section-name="bundle"] [data-buy-root]')
               || anchor;
    }

    if (!anchor || (!bar && !headerCta)) return;
    if (!('IntersectionObserver' in window)) return;

    if (bar) { bar.hidden = false; document.body.classList.add('has-sticky-bar'); }
    if (headerCta) headerCta.hidden = false;

    var shown = false;

    var io = new IntersectionObserver(function (entries) {
      var visible = entries[0].isIntersecting;

      if (bar) bar.classList.toggle('is-visible', !visible);
      if (headerCta) headerCta.style.opacity = visible ? '0' : '1';
      if (headerCta) headerCta.style.pointerEvents = visible ? 'none' : 'auto';

      if (!visible && !shown) {
        shown = true;
        track('sticky_cta_shown', {});
      }
    }, { threshold: 0 });

    io.observe(anchor);
  }

  /* =====================================================================
     Announcement rotation
     ===================================================================== */

  function initAnnounce() {
    var bar = document.querySelector('[data-announce]');
    if (!bar) return;

    if (recall('nb_announce_dismissed')) { bar.remove(); return; }

    var close = bar.querySelector('[data-announce-close]');
    if (close) {
      close.addEventListener('click', function () {
        store('nb_announce_dismissed', true, 7);
        bar.remove();
        track('announcement_dismiss', {});
      });
    }

    var items = bar.querySelectorAll('[data-announce-item]');
    if (items.length < 2 || reduceMotion) return;

    var i = 0;
    setInterval(function () {
      items[i].hidden = true;
      i = (i + 1) % items.length;
      items[i].hidden = false;
    }, 6000);
  }

  /* =====================================================================
     Privacy choices link

     The theme renders no cookie banner of its own — Shopify's native one owns
     that (see snippets/consent-bridge.liquid). This only wires the footer
     "Your privacy choices" link to Shopify's preferences dialog, which is the
     opt-out mechanism US state privacy laws actually ask for.
     ===================================================================== */

  function initPrivacyLink() {
    var links = document.querySelectorAll('[data-privacy-choices]');
    if (!links.length) return;

    links.forEach(function (link) {
      link.addEventListener('click', function (e) {
        var opened = window.NBPrivacy && window.NBPrivacy.showPreferences();
        if (opened) {
          e.preventDefault();
          track('privacy_preferences_open', {});
        }
        // If Shopify's dialog isn't available, the link falls through to its
        // href (the privacy policy page) rather than dead-ending.
      });
    });
  }

  /* =====================================================================
     Signup form
     ===================================================================== */

  function initSignup() {
    var forms = document.querySelectorAll('[data-signup-form]');
    if (!forms.length) return;

    forms.forEach(function (form) {
      var email = form.querySelector('[data-signup-email]');
      var submit = form.querySelector('[data-signup-submit]');
      var ok = form.querySelector('[data-signup-success]');
      var err = form.querySelector('[data-signup-error]');
      var opened = false;

      if (email) {
        email.addEventListener('focus', function () {
          if (opened) return;
          opened = true;
          track('form_open', { form: 'Allocation Signup' });
        });
      }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (ok) ok.hidden = true;
        if (err) err.hidden = true;

        var value = (email && email.value || '').trim();
        if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
          if (err) { err.textContent = 'Please enter a valid email address.'; err.hidden = false; }
          track('form_error', { form: 'Allocation Signup', reason: 'invalid_email' });
          return;
        }

        if (submit) { submit.disabled = true; submit.textContent = 'Joining…'; }

        var klaviyoId = (CFG.klaviyo && CFG.klaviyo.companyId) || '';

        function success() {
          if (ok) ok.hidden = false;
          if (submit) { submit.disabled = false; submit.textContent = 'Joined'; }
          if (email) email.value = '';

          // generate_lead is a GA4 recommended event — mark it a key event
          // in the GA4 UI so it counts as a conversion pre-launch.
          track('generate_lead', {
            form: 'Allocation Signup',
            currency: (CFG.product && CFG.product.currency) || 'USD',
            value: 0
          });
          track('sign_up', { method: klaviyoId ? 'klaviyo' : 'demo' });
        }

        function failure(reason) {
          if (err) err.hidden = false;
          if (submit) { submit.disabled = false; submit.textContent = 'Join the list'; }
          track('form_error', { form: 'Allocation Signup', reason: reason });
        }

        if (klaviyoId && window.klaviyo) {
          try {
            window.klaviyo.push(['identify', { '$email': value }]);
            success();
          } catch (e2) { failure('klaviyo_threw'); }
        } else {
          // Demo handler: no network call, so the funnel is still testable.
          setTimeout(success, 500);
        }
      });
    });
  }

  /* =====================================================================
     Reveal on scroll
     ===================================================================== */

  function initReveal() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;

    var targets = document.querySelectorAll(
      '.section__head, .notes__card, .timeline__item, .serve, .quote, .rum__body, .rum__media, .signup'
    );
    if (!targets.length) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-revealed');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    targets.forEach(function (t, i) {
      t.setAttribute('data-reveal', '');
      t.style.transitionDelay = Math.min(i % 4, 3) * 70 + 'ms';
      io.observe(t);
    });
  }

  /* =====================================================================
     Boot
     ===================================================================== */

  function boot() {
    // The gate owns its own lifecycle in age-gate.js; this only subscribes.
    // onPass fires immediately for a returning visitor with a remembered pass.
    onGatePassed(initStickyCtas);

    initHeader();
    initAnnounce();
    initSignup();
    initPrivacyLink();
    initReveal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
