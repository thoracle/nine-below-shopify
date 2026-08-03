/* =========================================================================
   Nine Below — age gate

   Deliberately its own file, loaded before theme.js. It used to live inside
   theme.js, which meant any unrelated throw in that file — a missing element,
   a browser without `matchMedia` — left the gate up with nothing wired to it.
   Nothing here depends on theme.js, and theme.js waits on this instead.

   The blocking half (hiding content, unlocking on a stored pass) is in
   snippets/age-gate-head.liquid and runs before first paint. This file only
   handles interaction, so if it fails the gate stays closed rather than open.
   ========================================================================= */

(function () {
  'use strict';

  /* Read at use time, never cached at load time. window.NB is published at the
     END of analytics.js, so a snapshot taken here would be empty if the load
     order ever changed — and an empty config previously read as "gate
     disabled", which is precisely how a gate opens itself. */
  function cfg() {
    return (window.NB && window.NB.config && window.NB.config.ageGate) || {};
  }

  var KEY = 'nb_age_ok';
  var COOKIE = 'nb_age_ok';

  /* The subscriber queue is published by age-gate-head.liquid, inline and above
     <body>, because analytics.js and ab.js both load before this file and both
     need to defer work until the visitor is actually through. This file only
     trips it. Re-creating the object here would drop everything they queued. */
  function resolve() {
    var api = window.NB_AGE_GATE;
    if (api && typeof api._resolve === 'function') api._resolve();
  }

  function track(name, params) {
    var t = window.NB && window.NB.track;
    if (typeof t === 'function') { try { t(name, params || {}); } catch (e) {} }
  }

  function remember(days) {
    var ms = days * 864e5;
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: true, exp: Date.now() + ms }));
    } catch (e) {}
    try {
      document.cookie = COOKIE + '=1;path=/;max-age=' + Math.round(ms / 1000) + ';SameSite=Lax';
    } catch (e) {}
  }

  /* ---- date handling ---------------------------------------------------- */

  /* Age in whole years. Comparing the month/day tuple rather than dividing
     elapsed milliseconds keeps leap years and DST out of it. */
  function ageOn(dob, now) {
    var years = now.getFullYear() - dob.getFullYear();
    var m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) years--;
    return years;
  }

  /* Strict parse. `new Date(y, m-1, d)` rolls 31 February forward to 3 March
     without complaint, so the parts are read back and compared. */
  function parseDob(mmRaw, ddRaw, yyyyRaw) {
    var mm = parseInt(mmRaw, 10), dd = parseInt(ddRaw, 10), yyyy = parseInt(yyyyRaw, 10);
    if (!mm || !dd || !yyyy) return null;
    if (String(yyyyRaw).length !== 4) return null;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

    var now = new Date();
    if (yyyy < 1900 || yyyy > now.getFullYear()) return null;

    var d = new Date(yyyy, mm - 1, dd);
    if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
    if (d > now) return null;
    return d;
  }

  /* ---- arms ------------------------------------------------------------- */

  function initTap(armEl, askStep, denyStep, pass, deny) {
    var yes = armEl.querySelector('[data-gate-confirm]');
    var no = armEl.querySelector('[data-gate-deny]');
    if (!yes) return false;

    yes.addEventListener('click', function () { pass({ gate_style: 'one_tap' }); });
    if (no) no.addEventListener('click', function () { deny({ gate_style: 'one_tap' }); });

    var back = armEl.querySelector('[data-gate-back]');
    if (back) back.addEventListener('click', function () {
      if (denyStep) denyStep.hidden = true;
      if (askStep) askStep.hidden = false;
      if (yes.focus) yes.focus();
    });

    // Focus the affirmative action so keyboard and screen-reader users land on it.
    try { yes.focus(); } catch (e) {}
    return true;
  }

  function initDob(armEl, pass, deny) {
    var form = armEl.querySelector('[data-gate-form]');
    var mm = armEl.querySelector('[data-gate-mm]');
    var dd = armEl.querySelector('[data-gate-dd]');
    var yyyy = armEl.querySelector('[data-gate-yyyy]');
    var errorEl = armEl.querySelector('[data-gate-error]');
    if (!form || !mm || !dd || !yyyy) return false;

    var minAge = Number(cfg().minAge) || 21;
    var attempts = 0;

    function showError(msg, reason) {
      if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; }
      // The friction signal. Without it a visitor who could not get the form
      // right is indistinguishable from one who simply left.
      track('age_gate_error', { gate_style: 'birthdate', reason: reason, attempt: attempts });
    }
    function clearError() { if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; } }

    // Strip non-digits as they are typed, then hand off once a field fills —
    // the live site's behaviour, and the only thing that makes three separate
    // inputs bearable on a phone.
    function digitsOnly(el, len, next) {
      el.addEventListener('input', function () {
        var clean = el.value.replace(/\D/g, '').slice(0, len);
        if (clean !== el.value) el.value = clean;
        clearError();
        if (next && clean.length === len) next.focus();
      });
      // Backspacing out of an empty field steps back, so a typo two fields ago
      // does not need a deliberate tap to reach.
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Backspace' || el.value) return;
        var field = el.closest ? el.closest('.dob__field') : null;
        var prevField = field && field.previousElementSibling;
        var prev = prevField && prevField.querySelector('.dob__input');
        if (prev) { prev.focus(); e.preventDefault(); }
      });
    }

    digitsOnly(mm, 2, dd);
    digitsOnly(dd, 2, yyyy);
    digitsOnly(yyyy, 4, null);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      attempts++;
      clearError();

      var dob = parseDob(mm.value, dd.value, yyyy.value);
      if (!dob) {
        showError(cfg().invalidText || 'Please enter a valid birthdate.', 'invalid_date');
        (mm.value.length !== 2 ? mm : dd.value.length !== 2 ? dd : yyyy).focus();
        return;
      }

      if (ageOn(dob, new Date()) >= minAge) pass({ gate_style: 'birthdate', attempts: attempts });
      else deny({ gate_style: 'birthdate', attempts: attempts });
    });

    /* Deliberately no initial focus. The live gate only moves focus when a
       field fills up, and focusing an input on load raises the mobile keyboard
       over the panel — a difference arm A does not have, which would end up
       measured as part of the effect. */
    return true;
  }

  /* ---- boot ------------------------------------------------------------- */

  function boot() {
    var root = document.documentElement;
    var gate = document.getElementById('age-gate');

    /* The SERVER decides whether there is a gate: the element is rendered only
       when the setting is on. That is the source of truth here — not JS config,
       which may not have loaded, and not a flag that could read as undefined. */
    if (!gate) {
      root.setAttribute('data-age', 'ok');
      resolve();
      return;
    }

    // Already passed before first paint — the head script stamped it.
    if (root.getAttribute('data-age') === 'ok') {
      gate.remove();
      resolve();
      return;
    }

    /* Which arm is live is stamped on <html> by the A/B framework before first
       paint. Reading the same attribute the stylesheet reads is what keeps the
       wired-up arm and the visible one in step. */
    var arm = root.getAttribute('data-ab-age_gate') || 'a';
    var armEl = gate.querySelector('[data-gate-arm="' + arm + '"]');
    if (!armEl) { arm = 'a'; armEl = gate.querySelector('[data-gate-arm="a"]'); }
    if (!armEl) { armEl = gate; }

    var heading = armEl.querySelector('.age-gate__heading[id]');
    if (heading) {
      gate.removeAttribute('aria-label');
      gate.setAttribute('aria-labelledby', heading.id);
    }

    var askStep = armEl.querySelector('[data-gate-step="ask"]');
    var denyStep = armEl.querySelector('[data-gate-step="deny"]');

    var reduceMotion = false;
    try {
      reduceMotion = !!(window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {}

    function pass(meta) {
      var days = Number(cfg().rememberDays) || 30;
      remember(days);
      meta = meta || {};
      meta.remembered_days = days;
      track('age_gate_accept', meta);

      // Reveal the content first, then dissolve the panel over it. `is-leaving`
      // keeps the gate displayed across the fade despite data-age="ok".
      gate.classList.add('is-leaving');
      document.documentElement.setAttribute('data-age', 'ok');

      /* Resolve as soon as the content is revealed, NOT when the fade ends.
         Subscribers report what the visitor can now see, and a visitor who
         navigates away inside the animation would otherwise take every
         deferred impression with them. Removing the element can wait. */
      resolve();

      gate.style.transition = 'opacity 320ms ease';
      gate.style.opacity = '0';
      window.setTimeout(function () { gate.remove(); }, reduceMotion ? 0 : 320);
    }

    function deny(meta) {
      track('age_gate_deny', meta || {});
      if (askStep) askStep.hidden = true;
      if (denyStep) denyStep.hidden = false;
      /* Focus was sitting on a control inside the step just hidden, which drops
         it to <body> and leaves a screen reader with nothing announced. Arm B
         has no "go back" to land on, so the panel itself takes focus. */
      if (denyStep) {
        var back = denyStep.querySelector('[data-gate-back]');
        var target = back || denyStep;
        if (!back) denyStep.setAttribute('tabindex', '-1');
        try { target.focus(); } catch (e) {}
      }
    }

    var wired = arm === 'b' ? initDob(armEl, pass, deny) : false;
    if (!wired) {
      /* Either this is the one-tap arm, or arm B's form could not be wired. In
         the second case fall back rather than strand the visitor behind a
         locked gate with no working control — a wrong arm beats no exit. The
         attribute is corrected too, so the stylesheet reveals what is wired. */
      if (arm === 'b') {
        var fallback = gate.querySelector('[data-gate-arm="a"]');
        if (fallback) {
          if (window.console) console.warn('[age gate] variant b markup is incomplete; falling back to a.');
          root.setAttribute('data-ab-age_gate', 'a');
          arm = 'a';          // keep the reported arm honest
          armEl = fallback;
          askStep = armEl.querySelector('[data-gate-step="ask"]');
          denyStep = armEl.querySelector('[data-gate-step="deny"]');
        }
      }
      wired = initTap(armEl, askStep, denyStep, pass, deny);
    }

    /* Last resort. If neither arm could be wired the visitor is looking at a
       panel with no working control and no way past it. Rather than leave them
       there, delegate a click handler on the whole gate so any button in it
       lets them through, and say so loudly in the console. */
    /* Both reported only now: the arm named is the arm the visitor can actually
       see, and the exposure is recorded only because a gate was genuinely put in
       front of them. A visitor with a remembered pass returns above, before this
       line, and so is never counted — which is the point. */
    var ab = window.NBAB;
    if (ab && typeof ab.impression === 'function') ab.impression('age_gate');
    track('age_gate_view', { gate_style: arm === 'b' ? 'birthdate' : 'one_tap' });

    if (!wired) {
      if (window.console) console.error('[age gate] no arm could be wired; using the emergency handler.');
      gate.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('button, [role="button"]');
        if (!btn || btn.hasAttribute('data-gate-deny') || btn.hasAttribute('data-gate-back')) return;
        pass({ gate_style: 'fallback' });
      });
    }
  }

  /* The gate element lives near the top of <body>, but this file is deferred,
     so the DOM is already parsed by the time it runs. The readyState check is
     only insurance against the script being loaded some other way. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
