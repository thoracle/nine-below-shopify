# Nine Below — Conversion Theme (test site)

**Nine Below is a fictional brand.** It exists to exercise the Shopify theme,
A/B framework and paid-social flow against a second identity — so you can prove
the system is genuinely re-skinnable rather than hard-wired to one client.

Nothing here is a real product, company, or endorsement.

---

## Same skeleton, different skin

Layout, sections, and every framework file are shared with the sibling theme.
What differs is entirely identity:

| | Nine Below |
|---|---|
| Category | Nordic winter wheat vodka |
| Register | Cold, clinical, grotesque |
| Ground | Graphite `#0d1418` |
| Text | Ice `#e8eef2` |
| Accent | Glacial blue `#1f8ab0` |
| Display face | Work Sans 700 |
| Price | $34.99 |
| Proof points | 9× · −9°C · Nordic |

The palette and typography are **theme settings**, not code. Re-skinning again
means changing eight colour values and two font pickers.

## Isolated from the sibling site

Every storage key and console global is namespaced, so both previews can run in
one browser without colliding:

| Storage | Key |
|---|---|
| Assignments | `nb_ab_v1` |
| Age gate | `nb_age_ok` |
| Flow mode | `nb_flow` |
| Consent | `nb_consent_v2` |
| Console API | `NBAB` |
| Gate API | `NB_AGE_GATE` |
| Event log | `NINEBELOW_EVENT_LOG` |

## Preview

```bash
python3 -m http.server 8090      # run from THIS folder, not its parent —
                                 # the preview loads ../assets/* relative to it
# http://localhost:8090/preview/
```

| Parameter | Effect |
|---|---|
| `?debug=1` | shows the GA4 event inspector |
| `?ab=hero_headline:b` | forces an arm |
| `?ab=reset` | clears assignments and re-buckets |
| `?agegate=reset` | re-opens the age gate after you have confirmed |
| `?flow=focus` | shows the stripped paid-social view |
| `?ch=ig` / `?ch=tt` / `?ch=fb` | forces a channel landing |

## Imagery — all mock

Every image ships generated and **unbranded**: no label, no mark, no likeness.
They exist so each section can be A/B tested with something real in the slot.

| Slot | Asset | Notes |
|---|---|---|
| Hero, arm A | `hero-a` | Glacial ice — textural |
| Hero, arm B | `hero-b` | Bar counter — atmospheric. Brightened in post; ungraded it read as pure black |
| Product detail | `detail` | Bottle shoulder macro |
| Craft band | `craft` | Column stills |
| Serves ×3 | `serve-1/2/3` | Frozen pour, martini, soda and lime |

Every slot still has an **image picker** — uploading in the theme editor overrides
the bundled asset, and the experiment runs either way.

**Social proof is deliberately fictional and says so.** The publications are
invented and each quote is captioned as mock content. Real competitions and
publications stay out even on a fictional brand — borrowing their names is the
same misuse whether or not the product exists.

**Tasting notes** are plausible against the stated process, not a real panel.

## The age gate cannot fail open

The gate is closed by a blocking stylesheet in `snippets/age-gate-head.liquid`,
above `<body>`. JavaScript's only job is to *open* it. So JS disabled, a thrown
script, or a 404 on any asset all leave the gate up and the content hidden.

`assets/age-gate.js` is deliberately its own file, loaded before `theme.js`, so
an unrelated error elsewhere cannot strand a visitor behind a panel with nothing
wired to it.

## Channel landings

Instagram, TikTok and Facebook do not behave alike, so they do not get the same
page. The channel resolves before paint from `?ch=`, then `utm_source` /
`utm_medium` / `utm_campaign`, then the in-app browser's user agent, then the
referrer — and is remembered for the session.

| | Treatment |
|---|---|
| `ig` | Visual-led headline. Subheading dropped on mobile to tighten the fold. |
| `tt` | Hook headline that pays off the video. Tightest fold of the three. |
| `fb` | Reassurance-led headline. Header nav kept on desktop, where a one-column strip reads as broken rather than focused. |

Any element can be targeted without duplicating a section:

```html
<p data-ch="tt">TikTok only</p>
<p data-ch="ig fb">Instagram or Facebook</p>
<p data-ch-not="tt">Everyone except TikTok</p>
```

An experiment can be pinned to one platform with `"channel": "tt"` in the
experiment JSON. Traffic from anywhere else sees the control and is not
reported, so a TikTok-only headline test never pollutes Facebook's numbers.

**In-app browsers are detected separately from the channel.** All three
platforms open links inside their own webview, where storage is often
partitioned, `target="_blank"` opens a tab with no way back, and a third-party
checkout can be cramped or broken. None of that is fixable from the theme, but
`webview` and `in_app_browser` ride on every event, so a funnel dying in the
Instagram browser is distinguishable from bad creative.

## Measurement

`experiment_impression` is the denominator for every conversion rate, and it is
held until the visitor is actually through the gate — an impression sent while
the panel still covers the page counts someone who never saw the variant.

`age_gate` is the exception and reports itself, at the moment a gate is put in
front of someone. A visitor with a remembered pass never sees one and is never
counted. The two therefore sit at different denominators; do not compare their
rates directly.
