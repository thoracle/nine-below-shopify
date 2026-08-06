#!/usr/bin/env python3
"""=========================================================================
build_preview — render the Liquid theme into preview/index.html

The preview used to be maintained by hand, and it drifted every single time
the theme changed. Five defects came from that alone, and every one of them
looked fine and failed silently. Generating removes the class of bug rather
than the instances: change the Liquid, re-run this, commit both.

    python3 tools/dev.py build

This implements the subset of Shopify Liquid this theme actually uses. It is
not a general Shopify renderer and does not try to be; anything unsupported
throws loudly rather than emitting something subtly wrong.

Ported from tools/build-preview.mjs (liquidjs) on 5 Aug 2026. The port is held
to a byte-identical output check — see tools/dev.py verify.
========================================================================="""

import json
import re
import sys
from pathlib import Path

from liquid import Environment
from liquid import FileSystemLoader

ROOT = Path(__file__).resolve().parent.parent


def read(p):
    return (ROOT / p).read_text(encoding="utf-8")


def read_json(p):
    return json.loads(read(p))


# ---- theme data ---------------------------------------------------------

class Settings(dict):
    """An unset setting is BLANK on Shopify, not missing.

    This matters more than it looks. The theme guards optional images with the
    standard `{% if settings.x != blank %}`. A missing key is not blank — it is
    undefined — and python-liquid correctly reports undefined != blank, so every
    one of those guards opened and the page filled with `src=""`: a favicon, an
    og:image, the age-gate logo, and both halves of the `hero_image` experiment,
    whose arm B is supposed to exist only once a background is uploaded.

    Shopify hands back an empty value for a setting nobody filled in, and
    `"" != blank` is correctly false. Modelling that here fixes the whole class
    at the source rather than patching truthiness engine-wide."""

    def __missing__(self, key):
        return ""


def load_settings():
    """Settings resolve the way Shopify resolves them: schema defaults first,
    then whatever settings_data.json has stored on top. A setting that exists
    in the schema but not in the data must still render its default, or the
    preview diverges from a fresh install."""
    out = Settings()
    for group in read_json("config/settings_schema.json"):
        for s in group.get("settings") or []:
            if s.get("id") and "default" in s:
                out[s["id"]] = s["default"]
    out.update(read_json("config/settings_data.json")["current"])
    return out


SENTINEL_WS = "\x01"

SCHEMA_RE = re.compile(r"\{%-?\s*schema\s*-?%\}(.*?)\{%-?\s*endschema\s*-?%\}", re.S)


def section_schema(type_):
    """Section schema defaults, same idea one level down."""
    m = SCHEMA_RE.search(read(f"sections/{type_}.liquid"))
    return json.loads(m.group(1)) if m else {}


def section_defaults(schema):
    return Settings({s["id"]: s["default"]
                     for s in schema.get("settings") or []
                     if s.get("id") and "default" in s})


def block_defaults(schema, type_):
    d = next((b for b in schema.get("blocks") or [] if b.get("type") == type_), None)
    return Settings({s["id"]: s["default"]
                     for s in ((d or {}).get("settings") or [])
                     if s.get("id") and "default" in s})


# ---- Shopify filters ----------------------------------------------------

def f_asset_url(v, *a, **k):
    """Bundled theme assets. Under Pages the preview sits one level below the
    theme root, so `../assets/x` resolves to the same file Shopify would."""
    return f"../assets/{v}"


def f_image_url(v, *a, **k):
    """image_url only ever receives an uploaded image here, and none are set in
    this build — every image_picker is blank and the theme falls through to its
    bundled asset. Returning the raw value keeps that path honest; if an image
    were ever uploaded the preview would show a broken src rather than silently
    inventing a CDN URL that does not exist."""
    return "" if v is None or v == "" else str(v)


def f_json(v, *a, **k):
    """Must match JSON.stringify: compact separators, and no \\u escaping of
    non-ASCII. Python's defaults differ on both counts and would change every
    embedded config blob in the page."""
    return json.dumps(_plain(v), separators=(",", ":"), ensure_ascii=False)


def _plain(v):
    """python-liquid hands back its own Undefined for missing keys; JSON.stringify
    of undefined was mapped to null by the original, so mirror that."""
    from liquid.undefined import Undefined
    if isinstance(v, Undefined):
        return None
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


def f_handleize(v, *a, **k):
    s = "" if v is None else str(v)
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))


def f_strip_newlines(v, *a, **k):
    return re.sub(r"[\r\n]+", "", "" if v is None else str(v))


def f_t(v, *a, **k):
    return "" if v is None else str(v)          # no locale lookup in the preview


def f_money(v, *a, **k):
    try:
        n = float(v or 0)
    except (TypeError, ValueError):
        n = 0.0
    return f"${n:.2f}"


def f_font_face(v, *a, **k):
    return ""                                    # system fonts in the preview


def f_font_modify(v, *a, **k):
    return v


def f_color_modify(color, prop=None, value=None, *a, **k):
    """Only `alpha` is used by this theme. Hex in, rgba out."""
    if prop != "alpha":
        return color
    h = str(color or "").replace("#", "")
    if len(h) != 6:
        return color
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return f"rgba({r}, {g}, {b}, {value})"


class JSNumber(float):
    """JavaScript prints an integral double as `1`; Python prints `1.0`.

    `divided_by: 100.0` feeds a CSS custom property, so the difference is real
    output, not cosmetics. Subclassing float keeps it a number for any further
    arithmetic and only changes how it renders."""

    def __str__(self):
        return str(int(self)) if self.is_integer() else repr(float(self))


def _js_number(x):
    return JSNumber(x) if isinstance(x, float) and not isinstance(x, JSNumber) else x


# ---- engine -------------------------------------------------------------

class SnippetLoader(FileSystemLoader):
    """Snippets reached through {% render %} are loaded by the engine, not by
    us, so the Shopify-tag rewrite has to happen here too. Without this, a
    {% style %} inside a snippet reaches the parser untouched and the build
    dies — which is the correct failure, but only if it never happens."""

    def get_source(self, env, template_name, **kwargs):
        src = super().get_source(env, template_name, **kwargs)
        return src._replace(text=preprocess(src.text))


def make_env(globals_):
    env = Environment(
        loader=SnippetLoader(str(ROOT / "snippets"), ext=".liquid"),
        strict_filters=True,      # an unimplemented filter must fail loudly
        globals=globals_,
    )
    env.filters.update({
        "asset_url": f_asset_url,
        "image_url": f_image_url,
        "json": f_json,
        "handleize": f_handleize,
        "handle": f_handleize,
        "strip_newlines": f_strip_newlines,
        "t": f_t,
        "money": f_money,
        "font_face": f_font_face,
        "font_modify": f_font_modify,
        "color_modify": f_color_modify,
    })

    # Wrap, rather than reimplement, so the arithmetic stays the engine's.
    _divided_by = env.filters["divided_by"]
    env.filters["divided_by"] = lambda v, *a, **k: _js_number(_divided_by(v, *a, **k))
    return env


STYLE_OPEN = re.compile(r"\{%-?\s*style\s*-?%\}")
STYLE_CLOSE = re.compile(r"\{%-?\s*endstyle\s*-?%\}")


def preprocess(src):
    """Two Shopify tags this theme uses have no python-liquid equivalent, and
    both are pure rewrites rather than behaviour:

      {% schema %}…{% endschema %}  is read by the build and never rendered
      {% style %}…{% endstyle %}    is exactly a <style> wrapper on Shopify

    Doing them here rather than as custom tags keeps the engine stock. The
    bodies still pass through Liquid, which is what Shopify does too."""
    # The schema block is replaced by the sentinel, not deleted. A tag stood
    # here, and a tag interrupts whitespace control: delete it and the text
    # either side merges into one node, so a preceding `{%- … -%}` trims across
    # the gap and swallows the newline that used to survive it. Sections end
    # `{%- endif -%}` + blank lines + schema, which is exactly that case.
    src = SCHEMA_RE.sub(SENTINEL_WS, src)
    src = STYLE_OPEN.sub("<style>", src)
    src = STYLE_CLOSE.sub("</style>", src)

    # Whitespace control differs between engines at end-of-template: a `-%}`
    # makes python-liquid strip the trailing whitespace of the text that
    # follows it, where liquidjs strips only the leading side. Several snippets
    # end `...{%- endif -%}` + markup + newline, so their final newline
    # vanished and tags that should sit on separate lines ran together.
    # A non-whitespace sentinel at the end stops the strip; it is removed from
    # the finished document.
    if src[-1:].isspace():
        src += SENTINEL_WS
    return src


# ---- rendering ----------------------------------------------------------

def build_section(env, template_json, name, key=None):
    """Render sections/<name>.liquid with the settings and blocks the template
    assigns it, over the section schema's own defaults."""
    if key is None:
        key = next((k for k, v in template_json["sections"].items()
                    if v.get("type") == name), None)
    conf = template_json["sections"].get(key) if key else None
    conf = conf or {"type": name, "settings": {}, "blocks": {}}
    schema = section_schema(name)

    settings = Settings({**section_defaults(schema), **(conf.get("settings") or {})})
    blocks_src = conf.get("blocks") or {}
    order = conf.get("block_order") or list(blocks_src.keys())
    blocks = []
    for i, bid in enumerate(order):
        b = blocks_src[bid]
        blocks.append({
            "id": bid,
            "type": b["type"],
            "settings": Settings({**block_defaults(schema, b["type"]), **(b.get("settings") or {})}),
            "shopify_attributes": f'data-block-id="{bid}"',
            "index": i,
        })

    html = env.from_string(preprocess(read(f"sections/{name}.liquid"))).render(
        section={"id": key or name, "settings": settings, "blocks": blocks}
    )
    # Shopify wraps sections in an id'd div; the theme's own markup already
    # carries the classes, so this only mirrors the wrapper.
    sid = key or name
    return f'<div id="shopify-section-{sid}" class="shopify-section">{html}</div>'


# {% section 'x' %} appears only in the layout, and always with a literal name.
# It is swapped for a sentinel before parsing and filled in after rendering, so
# that section markup — which contains inline JSON and script — is never fed
# back through the parser.
SECTION_RE = re.compile(r"\{%-?\s*section\s+['\"]([^'\"]+)['\"]\s*-?%\}")
SENTINEL = "\x00section:{}\x00"


def main():
    settings = load_settings()
    template_json = read_json("templates/index.json")

    product_name = settings.get("product_name") or ""
    globals_ = {
        "settings": settings,
        "shop": {"name": (product_name.split("—")[0].strip() or "Shop"),
                 "url": "https://example.com"},
        "request": {"locale": {"iso_code": "en"}, "path": "/"},
        "template": {"name": "index"},
        "page_title": settings.get("meta_title") or "Preview",
        "page_description": settings.get("meta_description") or "",
        "canonical_url": "",
        "content_for_header": "",
        "content_for_layout": "",
    }

    env = make_env(globals_)

    # content_for_layout is the template's sections, in order.
    body = ""
    for key in template_json["order"]:
        conf = template_json["sections"][key]
        body += build_section(env, template_json, conf["type"], key) + "\n"
    globals_["content_for_layout"] = body

    layout = preprocess(read("layout/theme.liquid"))
    names = SECTION_RE.findall(layout)
    layout = SECTION_RE.sub(lambda m: SENTINEL.format(m.group(1)), layout)

    out = env.from_string(layout).render()

    for name in names:
        out = out.replace(SENTINEL.format(name), build_section(env, template_json, name))

    # ---- preview-only scaffolding --------------------------------------
    # Everything above is the theme exactly as Shopify would render it. What
    # follows exists only in the preview: an in-page event log so the funnel
    # can be inspected without opening GA4, and the ?debug=1 panel that shows
    # it. Kept here rather than in the theme so it can never ship to a store.
    head_extra, body_extra = read("tools/preview-extras.html").split("<!--BODY-->")
    out = out.replace("</head>", head_extra + "\n</head>", 1)
    out = out.replace("</body>", body_extra + "\n</body>", 1)

    out = out.replace(SENTINEL_WS, "")

    (ROOT / "preview/index.html").write_text(out, encoding="utf-8")
    print(f"preview/index.html  {len(out) / 1024:.0f} KB  "
          f"{len(template_json['order'])} sections")


if __name__ == "__main__":
    sys.exit(main())
