/* =========================================================================
   Nine Below — A/B reporting layer

   Assignment already happened inline in <head> (snippets/ab-framework.liquid),
   before paint. This file only reports it.

   Two things are sent to GA4:

     1. An `experiment_impression` event per active experiment, once per page.
        Gives you an exposure denominator — the count of people who actually
        entered an arm, which is what a conversion rate should divide by. Using
        sessions instead systematically understates both arms.

        WHEN it fires matters as much as that it fires. An impression sent while
        the age gate still covers the page counts a visitor who never saw the
        thing being tested, and many of them never will — they close the gate
        and leave. That inflates the denominator, deflates the measured rate,
        and makes the sample-size target too small, because a share of the
        people counted can never convert. So everything is held until the gate
        lifts, EXCEPT experiments that live on the gate itself.

     2. Variant params merged onto EVERY other event, by analytics.js. That is
        what lets `add_to_cart` and `begin_checkout` split by arm in a standard
        GA4 report with no custom modelling.

   Holdouts (visitors withheld by `traffic`) report nothing at all — they are not
   in the experiment and must not appear in either arm.
   ========================================================================= */

(function () {
  'use strict';

  var AB = window.NINEBELOW_AB;
  if (!AB) return; // framework disabled

  /* Read at use time, never cached at load time. window.NB is published at the
     END of analytics.js, so a snapshot taken here is empty if that file ever
     runs later than this one — or throws before its last line — and the cached
     no-op would then be permanent: every impression silently discarded for the
     rest of the page, with nothing in the console to say so. Impressions are the
     denominator of every experiment, so losing them does not break a rate, it
     invents one. Reading late also means the deferred impressions (held until
     the age gate lifts, often seconds later) still land if window.NB arrives in
     the meantime. Same rule, and same reason, as cfg() in age-gate.js. */
  function track(name, params) {
    var t = window.NB && window.NB.track;
    if (typeof t === 'function') { try { t(name, params || {}); } catch (e) {} }
  }

  /* Run fn once the visitor is past the age gate — immediately if they already
     are, or if this page has no gate. The API is published by the blocking head
     snippet, so it exists no matter where this file sits in the load order. */
  function whenSeen(fn) {
    var gate = window.NB_AGE_GATE;
    if (gate && typeof gate.onPass === 'function') gate.onPass(fn);
    else fn();
  }

  /* An experiment is self-reporting when only the surface it lives on can know
     whether it was actually shown. The age gate is the case in point: a visitor
     with a remembered pass never sees one, so firing from here would count them
     in the denominator of a gate they were never exposed to — and with a 30-day
     memory that is up to a month of returning traffic diluting the test. Those
     surfaces call `NBAB.impression(id)` at the moment they render instead. */
  function isSelfReported(id) {
    if (id === 'age_gate') return true;
    var exp = (AB.registry || {})[id];
    return !!(exp && exp.self_reported === true);
  }

  var sent = {};

  function sendImpression(id, variant) {
    if (sent[id]) return;   // once per page, however it was triggered
    sent[id] = true;
    track('experiment_impression', {
      experiment_id: id,
      variant_id: variant,
      // GA4's own naming, so this also populates the built-in
      // Reports → Engagement → Experiments surface where available.
      exp_variant_string: id + '-' + variant
    });
  }

  function report() {
    var active = AB.active || {};
    var ids = Object.keys(active).filter(function (id) { return active[id]; });
    if (!ids.length) return;

    /* User properties describe the visitor, not an exposure, and GA4 applies
       them to subsequent events — so they are set immediately and in full.
       Holding them back would leave the gate's own events unsegmented. */
    var props = {};
    ids.forEach(function (id) { props['ab_' + id] = active[id]; });
    if (typeof gtag === 'function') gtag('set', 'user_properties', props);

    // Self-reporting surfaces are left alone entirely — they fire their own.
    var deferred = ids.filter(function (id) { return !isSelfReported(id); });
    if (deferred.length) {
      whenSeen(function () {
        deferred.forEach(function (id) { sendImpression(id, active[id]); });
      });
    }

    if (window.console) {
      var gate = window.NB_AGE_GATE;
      console.info(
        '%c A/B %c ' + ids.map(function (i) {
          if (isSelfReported(i)) return i + '=' + active[i] + '\u00b7self';
          var held = gate && !gate.passed;
          return i + '=' + active[i] + (held ? '\u00b7deferred' : '');
        }).join('  '),
        'background:#1f8ab0;color:#e8eef2;padding:1px 5px;border-radius:2px',
        'color:#8098a6'
      );
    }
  }

  /* -----------------------------------------------------------------------
     Public API — for console QA and for any custom variant logic that can't
     be expressed with markup alone.
     --------------------------------------------------------------------- */
  window.NBAB = {
    /** Active variant for an experiment, or null if control/holdout/disabled. */
    get: function (id) { return AB.get(id); },

    /** All active assignments. */
    all: function () { return AB.active; },

    /** Force an arm and reload. Persists, so you can walk a whole funnel. */
    force: function (id, variant) {
      var u = new URL(location.href);
      u.searchParams.set('ab', id + ':' + variant);
      location.href = u.toString();
    },

    /** Clear assignments and re-bucket. */
    reset: function () {
      var u = new URL(location.href);
      u.searchParams.set('ab', 'reset');
      location.href = u.toString();
    },

    /** Params merged onto outbound events — useful for debugging. */
    params: function () { return AB.params(); },

    /** Report an exposure for a self-reporting surface, at the moment it is
        actually shown. Idempotent, and silent for holdouts and parked
        experiments, so a caller never has to check first. */
    impression: function (id) {
      var v = AB.active && AB.active[id];
      if (v) sendImpression(id, v);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report);
  } else {
    report();
  }
})();
