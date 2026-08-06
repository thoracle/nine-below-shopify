# Tests

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    .venv/bin/playwright install chromium

    .venv/bin/python tools/dev.py test     # run every suite
    .venv/bin/python tools/dev.py check    # rebuild the preview, then test

Each suite renders the **generated** `preview/index.html` in a real Chromium
against the real `assets/` and `snippets/` on disk. They exist to catch the
theme diverging from what it claims to do, so they read the same files a
browser would — and, since 5 August 2026, they run the theme's JavaScript in
an engine that behaves like the one visitors use.

| Suite | Asserts |
|---|---|
| `test_age_gate` | 12 ways the gate could fail open, both arms, birthdate validation, the fallback when arm B is broken, and `?agegate=reset` |
| `test_measurement` | what is counted and when — nothing reported behind the gate, the gate reporting itself, context on every event, the buy path, vendor deferral, and script load order |
| `test_channel` | channel resolution, token-matching false positives, in-app browser detection, message match, channel-scoped experiments, section stripping, and that compliance survives it |
| `test_bundle` | the $199.99 offer, every way it must not leak, that arm B *replaces* the bottle, and that the two offers report as different products |
| `test_stats` | the results-view maths against published values — Newcombe's Wilson intervals, chi-square tables, normal quantiles, and the O'Brien–Fleming boundary |
| `test_ga4_pull` | the GA4 tally against synthetic rows: attribution across experiments, revenue summed not re-counted, weights and control ordering |

## Four things to know before adding one

**Use `harness.py`.** It gives you `mount()`, which serves the theme from a real
origin through a Playwright route handler. Two capabilities are worth knowing:
`mutate(path, body)` rewrites an asset — return `DROP` to 404 it — and
`html=` replaces the page itself. Between them you can test failure modes that
never appear in a healthy build, which is where the silent ones live.

**Judge visibility with `visible()`, never a computed `display`.** It walks the
ancestor chain, because Shopify wraps every section in
`<div class="shopify-section">` and a hidden wrapper is the usual reason
something is off-screen. Getting this wrong once made a working age gate look
like it failed all twelve of its blocking tests. Note that it is *not* the same
as "has a box": `.stickybar__offer` uses `display: contents`, which renders its
children while generating no box of its own.

**Mount at a width where the thing exists.** The sticky buy bar is
`display: none` above 900px — it is a mobile-only control — so assertions about
it use `viewport=PHONE`. This is the failure jsdom hid: it did not apply the
media query, so those checks used to pass against a bar that a desktop browser
never draws.

**A suite must be able to fail.** End with `done()`, which exits non-zero if any
assertion did. Several of these began as reports that always exited 0 — a
regression would have printed a failure line and still passed.

## What changed when jsdom went

jsdom lied in four ways, and the old harness carried a workaround for each. All
four are gone, and two of them had been hiding real gaps:

| jsdom | Real Chromium |
|---|---|
| `localStorage` threw at an opaque origin | pages are served from `https://theme.test/`, a real origin |
| no `matchMedia`; `theme.js` threw on line 13 without a shim | it exists |
| `getComputedStyle` did not inherit invisibility | it does, and `@media` is applied — which is how the mobile-only sticky bar was found to be untested |
| the cascade resolved last-wins, ignoring `!important` | the real cascade, so a rule can no longer pass for the wrong reason |

## Running against another theme

The harness reads its target and its namespace from the environment, so the
suites are not tied to this theme:

    THEME=../other-theme LOG=OTHER_EVENT_LOG GKEY=other_age_ok \
      .venv/bin/python tests/test_age_gate.py

| Variable | What it points at | Default |
|---|---|---|
| `THEME` | theme root containing `preview/index.html` | this repo |
| `LOG` | the global the analytics layer appends events to | `NINEBELOW_EVENT_LOG` |
| `GKEY` | the localStorage key holding the age-gate pass | `nb_age_ok` |

Only the age-gate and stats suites port cleanly — the others assume the channel
layer, which is specific to this theme.
