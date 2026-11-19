"""What the print skill's pages share: an A4 page's style, its frame, its text made safe and the business's brand."""
import html
import json
from datetime import datetime, timezone

STYLE = """
@page { size: A4; margin: 16mm 15mm 18mm; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink, #111); background: #fff; font: 10.5pt/1.45 var(--body-font, "Helvetica Neue", Arial, sans-serif); }
h1, h2, h3 { font-family: var(--heading-font, inherit); }
h1 { font-size: 20pt; margin: 0 0 2mm; }
h2 { font-size: 13.5pt; margin: 7mm 0 2mm; border-bottom: 0.4mm solid var(--accent, #333); padding-bottom: 1mm; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 5mm 0 1.5mm; break-after: avoid; }
p { margin: 0 0 2mm; }
p.meta { color: var(--muted, #444); font-size: 9.5pt; }
table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; font-size: 9.5pt; }
th, td { text-align: left; vertical-align: top; border-bottom: 0.2mm solid var(--rule, #bbb); padding: 1.2mm 1.5mm; }
th { background: #eee; }
tr { break-inside: avoid; }
ul { margin: 0 0 2mm; padding-left: 5mm; }
.state { break-inside: avoid; border: 0.3mm solid var(--rule, #999); border-radius: 1.5mm; padding: 2mm 3mm; margin: 0 0 3mm; }
.state dl { display: grid; grid-template-columns: 22mm 1fr; gap: 0.6mm 3mm; margin: 1mm 0 0; }
.state dt { font-weight: 600; } .state dd { margin: 0; }
figure { margin: 2mm 0 4mm; } figure img { width: 100%; border: 0.2mm solid var(--rule, #bbb); }
figcaption { font-size: 9pt; color: var(--muted, #444); }
.none { color: #555; font-style: italic; }
.brand-logo { display: block; height: 12mm; width: auto; max-width: 60mm; object-fit: contain; margin: 0 0 4mm; }
"""


def esc(value):
    return html.escape(str(value if value is not None else ""), quote=True)


def script_json(value):
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def printed_on(now=None):
    """Today's date as a person reads it, such as 15 October 2026."""
    d = now or datetime.now(timezone.utc)
    return f"{d.day} {d:%B %Y}"


def read_brand(path):
    """The business's brand, as the fabrik command writes it for a page: its style and its logo, or None with no path."""
    if not path:
        return None
    value = read(path)
    if not isinstance(value, dict) or not isinstance(value.get("style"), str) or not isinstance(value.get("logo"), str):
        raise SystemExit("the brand file holds no style and logo; no page was written")
    return value


def brand_style(brand):
    """The brand's style, after the page's own, so its tokens win, or nothing."""
    return f"<style>\n{brand['style']}</style>" if brand else ""


def page(title, body, data_id, data, brand=None):
    """A whole A4 page, with its data kept in a JSON block for its checks, in the business's brand where one is given."""
    return "\n".join(["<!doctype html>", '<html lang="en-GB"><head><meta charset="utf-8">', f"<title>{esc(title)}</title>",
                      f"<style>{STYLE}</style>{brand_style(brand)}</head><body>", (brand["logo"] if brand and brand["logo"] else ""), body,
                      f'<script type="application/json" id="{data_id}">{script_json(data)}</script>', "</body></html>"]) + "\n"


def read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)
