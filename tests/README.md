# Tests

    npm install
    npm test          # run every suite
    npm run check     # rebuild the preview, then test

Each suite renders the **generated** `preview/index.html` in jsdom against the
real `assets/` and `snippets/` on disk. They exist to catch the theme diverging
from what it claims to do, so they read the same files a browser would.

| Suite | Asserts |
|---|---|
| `age-gate` | 12 ways the gate could fail open, both arms, birthdate validation, the fallback when arm B is broken, and `?agegate=reset` |
| `measurement` | what is counted and when — nothing reported behind the gate, the gate reporting itself, context on every event, the buy path, vendor deferral |
| `channel` | channel resolution, token-matching false positives, in-app browser detection, message match, channel-scoped experiments, section stripping, and that compliance survives it |
| `stats` | the results-view maths against published values — Newcombe's Wilson intervals, chi-square tables, normal quantiles, and the O'Brien–Fleming boundary |

## Three things to know before adding one

**Use `harness.mjs`.** It papers over three ways jsdom lies, each of which has
already produced a convincing false result:

- `localStorage` throws at an opaque origin, so a real `url` is always set
- there is no `matchMedia`, and `theme.js` reads it at the top of its IIFE —
  without a polyfill the whole file throws and nothing under test runs
- **`getComputedStyle` does not inherit invisibility.** An element inside a
  `display:none` parent still reports its own display. Shopify wraps every
  section in `<div class="shopify-section">`, so visibility must be judged up
  the ancestor chain — use `visible(w, el)`, never `getComputedStyle` directly.
  Getting this wrong once made a working age gate look like it failed all
  twelve of its blocking tests.

**Pass the age gate first** if the suite assesses the landing, or it is
measuring the page behind it. Use `agePass: PASS`.

**A suite must be able to fail.** End with `done()`, which exits non-zero if any
assertion did. Several of these began as reports that always exited 0 — a
regression would have printed a failure line and still passed CI.

## Running against another theme

The harness reads its target and its namespace from the environment, so the
suites are not tied to this theme:

    THEME=../other-theme LOG=OTHER_EVENT_LOG GKEY=other_age_ok node tests/age-gate.test.mjs

| Variable | What it points at | Default |
|---|---|---|
| `THEME` | theme root containing `preview/index.html` | this repo |
| `LOG` | the global the analytics layer appends events to | `NINEBELOW_EVENT_LOG` |
| `GKEY` | the localStorage key holding the age-gate pass | `nb_age_ok` |

Only the age-gate and stats suites port cleanly — the others assume the channel
layer, which is specific to this theme.
