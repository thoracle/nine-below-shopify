/* =========================================================================
   Nine Below — BottleNexus bridge
   -------------------------------------------------------------------------
   BottleNexus owns the cart and the checkout handoff, and its widget emits
   nothing to GA4. That is the reason the current site can see traffic but
   not commerce.

   This module does two things:

   1. LIVE MODE (bn_demo_mode = false)
      Loads buybutton.min.js, mounts the vendor component, and instruments it
      from the outside — delegated clicks plus a MutationObserver on the cart
      node — so add_to_cart / view_cart / begin_checkout fire against the
      real widget without the vendor needing to support callbacks.

   2. DEMO MODE (bn_demo_mode = true, the default here)
      Renders a self-contained mock cart with the same interaction surface,
      so the full funnel and every GA4 event can be exercised end to end
      without live credentials. The handoff to checkout is stubbed at the
      point where BottleNexus would take over.

   Both modes emit an identical event stream, so nothing about measurement
   changes when you flip the switch.
   ========================================================================= */

(function () {
  'use strict';

  var CFG = (window.NB && window.NB.config) || {};
  var BN = CFG.bottleNexus || {};
  var PRODUCT = CFG.product || {};

  if (!BN.enabled) return;

  var track = (window.NB && window.NB.track) || function () {};
  var ecommerce = (window.NB && window.NB.ecommerce) || function () {};

  var state = {
    ready: false,
    quantity: 0,
    cartOpen: false,
    lastLocation: 'hero'
  };

  /* =====================================================================
     Campaign context — the bridge between GA4 and BottleNexus

     GA4 can see as far as `begin_checkout` and no further; the order itself is
     created on BottleNexus's domain. Neither system can join to the other on
     its own, so the experiment arm is written into the UTM payload handed to
     the buy button. The same string is attached to `begin_checkout`, which
     gives both sides a shared key: BottleNexus's order export and the GA4
     funnel can be reconciled on one value instead of on faith.

     Original campaign parameters are preserved, never overwritten — clobbering
     utm_source with a theme identifier would destroy the ad attribution this is
     meant to complement. The arm is appended to utm_content, which is the
     conventional home for creative variants.
     ===================================================================== */

  var UTM_KEY = 'nb_utm';
  var UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  /* Landing parameters survive internal navigation via sessionStorage; without
     this, a visitor who clicks through to another page loses their attribution
     before ever reaching the buy button. */
  function landingParams() {
    var stored = {};
    try { stored = JSON.parse(sessionStorage.getItem(UTM_KEY)) || {}; } catch (e) {}

    var qs = new URLSearchParams(location.search);
    var found = {}, any = false;
    UTM_FIELDS.forEach(function (f) {
      var v = qs.get(f);
      if (v) { found[f] = v; any = true; }
    });

    if (any) {
      try { sessionStorage.setItem(UTM_KEY, JSON.stringify(found)); } catch (e) {}
      return found;
    }
    return stored;
  }

  /* URL-safe, human-readable, and stable across both systems. */
  function armTag() {
    var ab = window.NINEBELOW_AB;
    if (!ab || typeof ab.active !== 'object') return '';
    var parts = Object.keys(ab.active)
      .filter(function (id) { return ab.active[id]; })
      .sort()
      .map(function (id) { return id + '-' + ab.active[id]; });
    return parts.length ? 'ab.' + parts.join('_') : '';
  }

  function flowTag() {
    var f = window.NINEBELOW_FLOW;
    return f && f.mode ? 'flow-' + f.mode : '';
  }

  function campaignContext() {
    var p = landingParams();
    var content = [p.utm_content, armTag(), flowTag()].filter(Boolean).join('__');

    var utm = {
      source: p.utm_source || 'ninebelow_site',
      medium: p.utm_medium || 'website'
    };
    if (p.utm_campaign) utm.campaign = p.utm_campaign;
    if (p.utm_term) utm.term = p.utm_term;
    if (content) utm.content = content;

    return { utm: utm, tag: content };
  }

  /* =====================================================================
     Shared funnel events
     ===================================================================== */

  function fireAddToCart(qty, location) {
    state.quantity += qty;
    ecommerce('add_to_cart', {
      quantity: qty,
      item: { quantity: qty },
      cta_location: location
    });
  }

  function fireViewCart() {
    if (state.cartOpen) return;
    state.cartOpen = true;
    ecommerce('view_cart', {
      quantity: state.quantity || 1,
      item: { quantity: state.quantity || 1 }
    });
  }

  function fireBeginCheckout() {
    var ctx = campaignContext();
    ecommerce('begin_checkout', {
      quantity: state.quantity || 1,
      item: { quantity: state.quantity || 1 },
      checkout_provider: 'bottlenexus',
      // Identical to the utm_content handed to BottleNexus — the join key
      // between this funnel and their order export.
      handoff_tag: ctx.tag || '(none)'
    });
  }

  /* =====================================================================
     Button wiring (shared by both modes)
     ===================================================================== */

  function setLoading(btn, on) {
    if (!btn) return;
    btn.classList.toggle('is-loading', !!on);
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function initTriggers(handler) {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-buy-trigger]');
      if (!btn) return;
      e.preventDefault();

      var location = btn.getAttribute('data-location') || 'unknown';
      state.lastLocation = location;

      track('buy_button_click', {
        cta_location: location,
        provider: 'bottlenexus',
        demo_mode: !!BN.demoMode
      });

      handler(btn, location);
    });
  }

  /* =====================================================================
     LIVE MODE
     ===================================================================== */

  function loadVendor(onReady) {
    if (window.BottleNexus) { onReady(); return; }
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://buybutton.bottlenexus.com/buybutton.min.js?v=' + Date.now();
    s.onload = onReady;
    s.onerror = function () {
      track('buy_button_error', { reason: 'vendor_script_failed' });
      console.error('[NineBelow] BottleNexus script failed to load.');
    };
    (document.head || document.body).appendChild(s);
  }

  function mountVendor() {
    var slots = document.querySelectorAll('[data-buy-vendor-slot]');
    if (!slots.length || !window.BottleNexus) return;

    // Mount a single hidden vendor instance; the theme's own buttons proxy to it.
    var slot = slots[0];
    slot.removeAttribute('hidden');

    try {
      window.BottleNexus.init().createComponent({
        currentScript: slot,
        token: BN.token,
        id: parseInt(BN.productId, 10),
        options: {
          iframe: false,
          layout: 'basic',
          behavior: BN.behavior || 'sidebar',
          buttonText: BN.buttonText || 'Order Now',
          initialQuantity: 1,
          showInput: false,
          utm: campaignContext().utm
        }
      });
      state.ready = true;
      track('buy_button_ready', { provider: 'bottlenexus' });
    } catch (err) {
      track('buy_button_error', { reason: 'init_threw' });
      console.error('[NineBelow] BottleNexus init failed:', err);
    }
  }

  /* Instrument the vendor widget from the outside. */
  function observeVendor() {
    // Delegated clicks on vendor-rendered controls.
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-component]');
      if (!el) return;
      var kind = el.getAttribute('data-component');

      if (kind === 'button' || kind === 'add-to-cart') {
        fireAddToCart(1, state.lastLocation);
      } else if (kind === 'toggle' || kind === 'cart-toggle') {
        fireViewCart();
      } else if (/checkout/i.test(kind)) {
        fireBeginCheckout();
      }
    }, true);

    // Cart open/close is a DOM mutation, not a click, when opened programmatically.
    if (!('MutationObserver' in window)) return;
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes && Array.prototype.forEach.call(m.addedNodes, function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches('[data-component="cart"]')) fireViewCart();
          else if (node.querySelector && node.querySelector('[data-component="cart"]')) fireViewCart();
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function initLive() {
    loadVendor(function () {
      mountVendor();
      observeVendor();
    });

    initTriggers(function (btn) {
      setLoading(btn, true);

      // Proxy to the vendor's own button so the real cart opens.
      var vendorBtn = document.querySelector('[data-buy-vendor-slot] [data-component="button"]');
      if (vendorBtn) {
        vendorBtn.click();
        fireAddToCart(1, state.lastLocation);
      } else {
        track('buy_button_error', { reason: 'vendor_button_missing' });
      }

      setTimeout(function () { setLoading(btn, false); }, 600);
    });
  }

  /* =====================================================================
     DEMO MODE — mock cart with the same event surface
     ===================================================================== */

  var cartEl = null;

  function money(n) {
    var cur = PRODUCT.currency || 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n);
    } catch (e) {
      return '$' + n.toFixed(2);
    }
  }

  function unitPrice() {
    var p = parseFloat(PRODUCT.price);
    return isNaN(p) ? 0 : p;
  }

  function buildCart() {
    if (cartEl) return cartEl;

    cartEl = document.createElement('div');
    cartEl.className = 'democart';
    cartEl.setAttribute('role', 'dialog');
    cartEl.setAttribute('aria-modal', 'true');
    cartEl.setAttribute('aria-label', 'Cart');
    cartEl.hidden = true;

    cartEl.innerHTML =
      '<div class="democart__backdrop" data-cart-close></div>' +
      '<aside class="democart__panel">' +
        '<header class="democart__head">' +
          '<h2>Cart</h2>' +
          '<button type="button" class="democart__x" data-cart-close aria-label="Close cart">&times;</button>' +
        '</header>' +
        '<div class="democart__body">' +
          '<div class="democart__line">' +
            '<div class="democart__info">' +
              '<p class="democart__name">' + (PRODUCT.name || 'Winter Wheat Vodka') + '</p>' +
              '<p class="democart__meta">' + (PRODUCT.size || '750ml') +
                (PRODUCT.abv ? ' · ' + PRODUCT.abv : '') + '</p>' +
            '</div>' +
            '<div class="democart__qty">' +
              '<button type="button" data-qty-dec aria-label="Decrease quantity">&minus;</button>' +
              '<span data-qty-value>1</span>' +
              '<button type="button" data-qty-inc aria-label="Increase quantity">+</button>' +
            '</div>' +
            '<p class="democart__price" data-line-total></p>' +
          '</div>' +
          '<p class="democart__note">Shipping and taxes are calculated by our licensed retail partner at checkout.</p>' +
        '</div>' +
        '<footer class="democart__foot">' +
          '<div class="democart__subtotal"><span>Subtotal</span><span data-cart-total></span></div>' +
          '<button type="button" class="btn btn--primary democart__checkout" data-cart-checkout>Checkout</button>' +
          '<p class="democart__legal">Demo mode — no real order is placed. Checkout hands off to BottleNexus in production.</p>' +
        '</footer>' +
      '</aside>';

    document.body.appendChild(cartEl);
    wireCart();
    return cartEl;
  }

  function renderCart() {
    if (!cartEl) return;
    var qty = Math.max(1, state.quantity);
    var total = unitPrice() * qty;
    cartEl.querySelector('[data-qty-value]').textContent = qty;
    cartEl.querySelector('[data-line-total]').textContent = money(total);
    cartEl.querySelector('[data-cart-total]').textContent = money(total);
  }

  function openCart() {
    buildCart();
    cartEl.hidden = false;
    requestAnimationFrame(function () { cartEl.classList.add('is-open'); });
    document.body.classList.add('cart-open');
    renderCart();
    fireViewCart();
    var closeBtn = cartEl.querySelector('.democart__x');
    if (closeBtn) closeBtn.focus();
  }

  function closeCart() {
    if (!cartEl) return;
    cartEl.classList.remove('is-open');
    document.body.classList.remove('cart-open');
    state.cartOpen = false;
    setTimeout(function () { if (cartEl) cartEl.hidden = true; }, 280);
  }

  function wireCart() {
    cartEl.addEventListener('click', function (e) {
      if (e.target.closest('[data-cart-close]')) { closeCart(); return; }

      if (e.target.closest('[data-qty-inc]')) {
        state.quantity += 1;
        renderCart();
        ecommerce('add_to_cart', {
          quantity: 1, item: { quantity: 1 }, cta_location: 'cart-stepper'
        });
        return;
      }

      if (e.target.closest('[data-qty-dec]')) {
        if (state.quantity <= 1) return;
        state.quantity -= 1;
        renderCart();
        ecommerce('remove_from_cart', {
          quantity: 1, item: { quantity: 1 }, cta_location: 'cart-stepper'
        });
        return;
      }

      if (e.target.closest('[data-cart-checkout]')) {
        fireBeginCheckout();
        var btn = e.target.closest('[data-cart-checkout]');
        btn.disabled = true;
        btn.textContent = 'Handing off to BottleNexus…';
        // In production this is where the vendor redirect happens. The demo
        // stops here on purpose so no real order can be created.
        var ctx = campaignContext();
        if (window.console) {
          console.info(
            '%c Nine Below %c handoff payload (demo — not sent)',
            'background:#0d1418;color:#e8eef2;padding:2px 6px;border-radius:2px',
            'color:#8098a6'
          );
          console.log(ctx.utm);
        }
        setTimeout(function () {
          btn.disabled = false;
          btn.textContent = 'Checkout';
          track('checkout_handoff_stub', {
            provider: 'bottlenexus',
            quantity: state.quantity || 1,
            handoff_tag: ctx.tag || '(none)'
          });
        }, 1400);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && cartEl && !cartEl.hidden) closeCart();
    });
  }

  function initDemo() {
    console.info(
      '%c Nine Below %c BottleNexus demo mode — mock cart, no real orders.',
      'background:#0d1418;color:#e8eef2;padding:2px 6px;border-radius:2px',
      'color:#8098a6'
    );

    initTriggers(function (btn, location) {
      setLoading(btn, true);
      setTimeout(function () {
        setLoading(btn, false);
        fireAddToCart(1, location);
        openCart();
      }, 260);
    });

    state.ready = true;
  }

  /* =====================================================================
     Boot
     ===================================================================== */

  /* Run fn once the visitor is past the age gate — immediately if they already
     are, or if this page has no gate. The API is published by the blocking head
     snippet, so it exists no matter where this file sits in the load order. */
  function whenSeen(fn) {
    var gate = window.NB_AGE_GATE;
    if (gate && typeof gate.onPass === 'function') gate.onPass(fn);
    else fn();
  }

  function boot() {
    /* Held until the gate lifts. This fetches and initialises the RETAILER's
       widget, and loading a third-party alcohol-sales script for someone who
       has not yet confirmed their age is the exact thing the gate exists to
       prevent. It also stopped `buy_button_ready` being reported for visitors
       who never saw a buy button.

       The latency cost is small: the connection to the vendor is already warm
       from the preconnect in <head>, so only the download and init are deferred,
       and the button has a loading state for that window. */
    whenSeen(function () {
      if (BN.demoMode) initDemo();
      else initLive();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
