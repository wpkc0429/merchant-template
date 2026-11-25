/* ============================================================
   commerce/content-allowlist.js — LOCKED COMMERCE LAYER (do not edit by hand).

   The platform's rich-text allowlist (ecommerce api/internal/cms/richtext/allowlist.json), embedded as a classical
   script because the storefront has no build step and must not fetch it at runtime. GENERATED from
   commerce/content-allowlist.json, which is a byte copy of the platform file:
     sha256 61b53075c279364f7d1382f877c6a8d0d3d23e50b837e5c3c80d337e1c528541
   Regenerate by serialising the JSON file into the object below. tests/content.test.mjs fails when this object, the JSON
   copy or the recorded hash drift, and when public/content.schema.json relies on something the allowlist lacks.
   ============================================================ */
(function (root) {
  'use strict';
  var C = root.ShopCommerce = root.ShopCommerce || {};
  C._internal = C._internal || {};
  C._internal.allowlist = {
    "$comment": "Single source of truth for rich text HTML sanitization (change cms-rich-text-sanitization, design D4/D5). Consumed by the API (go:embed, internal/cms/richtext); a merchant storefront that renders the markup should keep its own copy of this file for defense in depth. Edit here only. No h1 (the theme owns the page title); no style/class/id/on* anywhere.",
    "elements": {
      "p": [],
      "br": [],
      "strong": [],
      "b": [],
      "em": [],
      "i": [],
      "u": [],
      "s": [],
      "blockquote": [],
      "ul": [],
      "ol": [],
      "li": [],
      "h2": [],
      "h3": [],
      "h4": [],
      "hr": [],
      "a": [
        "href",
        "title",
        "target"
      ],
      "img": [
        "src",
        "alt",
        "width",
        "height"
      ],
      "table": [],
      "caption": [],
      "thead": [],
      "tbody": [],
      "tfoot": [],
      "tr": [],
      "th": [
        "colspan",
        "rowspan",
        "scope"
      ],
      "td": [
        "colspan",
        "rowspan"
      ]
    },
    "attribute_patterns": {
      "a.target": "^_blank$",
      "img.src": "^https://",
      "img.width": "^[0-9]{1,4}$",
      "img.height": "^[0-9]{1,4}$",
      "th.colspan": "^[0-9]{1,3}$",
      "th.rowspan": "^[0-9]{1,3}$",
      "th.scope": "^(row|col|rowgroup|colgroup)$",
      "td.colspan": "^[0-9]{1,3}$",
      "td.rowspan": "^[0-9]{1,3}$"
    },
    "url_schemes": [
      "http",
      "https",
      "mailto",
      "tel"
    ],
    "allow_relative_urls": true,
    "drop_with_content": [
      "script",
      "style",
      "iframe",
      "noscript",
      "object",
      "embed",
      "template",
      "svg",
      "math",
      "textarea",
      "select",
      "title"
    ]
  };
})(window);
