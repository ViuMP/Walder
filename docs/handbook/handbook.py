"""
handbook.py — fixed generator for step-by-step HTML handbooks.

The entire visual design (colours, fonts, spacing, callouts, step rail) lives in
this file and never changes. Future handbooks supply ONLY content + screenshots,
so every handbook comes out looking identical. Do not restyle in the caller;
if the design genuinely needs to change, change it here so all handbooks move
together.

Quick start
-----------
    from handbook import Handbook, figure, note, check

    hb = Handbook(
        title="Sorting the PnL by level",
        subtitle="How to give each account-group its own running order.",
        eyebrow="Power BI · Internal reference",
        thesis="A text category sorts alphabetically by default. Bring a numeric "
               "Order column out of Excel, merge it into dimCOA, then sort the "
               "category by that Order.",
        chain=["Excel order table", "load as query", "merge into dimCOA", "Sort by column"],
        meta=[("Works in", "the E-conomic import model"),
              ("Repeat per", "Local Level 2, Local Level 3, …")],
        footer="PnL level-sorting handbook · keep for reference",
    )

    hb.phase("In Power Query", "Build the Order column into dimCOA")  # optional
    hb.step("Open the Transform Data window", [
        "From the main window go to **Home → Transform data**.",
    ])
    hb.step("Duplicate a mapping query", [
        "Right-click `mergeLocalLevel2` and choose **Duplicate**.",
        figure("/path/to/photo1.png", "Photo 1 — the mergeTables group."),
        check("If the match count is 0, your keys don't line up."),
    ])
    hb.checklist(["Used Merge Queries, not 'as New'.", "One Order per category."])
    hb.build("/mnt/user-data/outputs/Handbook.html")

Authoring shorthand (works in step content, note(), check() text, captions):
    **bold**   _italic_   `code/UI term`   [label](url)
Pass a pre-built HTML string (starting with '<') to bypass formatting.

Steps are numbered automatically: flat (1, 2, 3) if you never call .phase(),
or per-phase (A1, A2 / B1, B2) once you do.
"""

import base64
import html as _html
import os
import re

# --------------------------------------------------------------------------
# LOCKED DESIGN SYSTEM — edit here to move every handbook at once
# --------------------------------------------------------------------------
TOKENS = {
    "bg": "#EBEEE8", "surface": "#FFFFFF", "ink": "#172321", "ink_soft": "#51605D",
    "line": "#DCE2DA", "accent": "#2C6E5B", "accent_soft": "#E2EDE7", "accent_deep": "#1E4F40",
    "flag": "#9C4A17", "flag_soft": "#F7ECE0", "flag_line": "#E6CDB4",
    "chip_bg": "#E7ECE4", "chip_ink": "#1B2A28",
    "display": '"Space Grotesk",system-ui,sans-serif',
    "body": '"Inter",system-ui,sans-serif',
    "mono": '"IBM Plex Mono",ui-monospace,monospace',
}
FONT_LINK = ('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700'
             '&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap')

_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}


# --------------------------------------------------------------------------
# Inline formatting + helpers
# --------------------------------------------------------------------------
def _inline(text):
    """Lightweight markdown for inline runs. Order matters: code first so its
    contents aren't re-processed."""
    out, codes = text, []

    def _stash(m):
        codes.append(m.group(1))
        return f"\x00{len(codes) - 1}\x00"

    out = re.sub(r"`([^`]+)`", _stash, out)
    out = _html.escape(out, quote=False)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"(?<!\w)_([^_]+)_(?!\w)", r"<i>\1</i>", out)
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', out)
    for i, c in enumerate(codes):
        out = out.replace(f"\x00{i}\x00", f'<span class="chip">{_html.escape(c, quote=False)}</span>')
    return out


def _embed(src):
    """Return a usable img src: pass through data:/http(s) URIs, base64-embed a
    local file so the handbook stays a single portable file."""
    if src.startswith(("data:", "http://", "https://")):
        return src
    ext = os.path.splitext(src)[1].lower()
    mime = _MIME.get(ext, "image/png")
    with open(src, "rb") as f:
        b = base64.b64encode(f.read()).decode()
    return f"data:{mime};base64,{b}"


def figure(src, caption, alt=None):
    """A framed screenshot with a caption. `src` may be a local file path
    (auto-embedded) or a data/http URI. `alt` is required for accessibility —
    falls back to the caption if omitted, but write a real one."""
    a = _html.escape(alt or re.sub(r"<[^>]+>", "", caption), quote=True)
    return (f'<figure class="shot"><img loading="lazy" src="{_embed(src)}" alt="{a}">'
            f'<figcaption>{_inline(caption)}</figcaption></figure>')


def note(text):
    """Green 'Note' callout — helpful context, prerequisites, a heads-up."""
    return (f'<div class="note"><span class="note-tag">Note</span>'
            f'<p>{_inline(text)}</p></div>')


def check(text):
    """Amber 'Double-check' callout — the critical gotcha that breaks things if
    missed. Use sparingly; over-flagging dilutes it."""
    return (f'<div class="flag"><span class="flag-tag">Double-check</span>'
            f'<p>{_inline(text)}</p></div>')


def _block(item):
    """Render one content block: raw HTML if it starts with '<', else a
    paragraph with inline formatting."""
    s = item if isinstance(item, str) else str(item)
    return s if s.lstrip().startswith("<") else f"<p>{_inline(s)}</p>"


# --------------------------------------------------------------------------
# Handbook
# --------------------------------------------------------------------------
class Handbook:
    def __init__(self, title, subtitle="", eyebrow="Reference", thesis="",
                 chain=None, meta=None, footer="Handbook · keep for reference"):
        self.title = title
        self.subtitle = subtitle
        self.eyebrow = eyebrow
        self.thesis = thesis
        self.chain = chain or []
        self.meta = meta or []
        self.footer = footer
        self._phases = []        # [(tag, heading, [steps])]
        self._flat = []          # steps when no phase declared
        self._checklist = []
        self._phase_letters = "ABCDEFGH"

    def phase(self, tag, heading):
        """Start a new phase. Steps after this get a per-phase letter (A/B/…)."""
        self._phases.append((tag, heading, []))

    def step(self, title, content):
        """Add a step. `content` is a list of strings/figure()/note()/check()."""
        target = self._phases[-1][2] if self._phases else self._flat
        target.append((title, content))

    def checklist(self, items):
        """Optional recap checklist at the foot of the handbook."""
        self._checklist = list(items)

    # ---- rendering ----
    def _render_step(self, label, title, content):
        body = "\n        ".join(_block(c) for c in content)
        return (f'<article class="step">\n'
                f'      <div class="rail"><span class="node">{label}</span></div>\n'
                f'      <div class="card">\n        <h3>{_inline(title)}</h3>\n'
                f'        {body}\n      </div>\n    </article>')

    def _render_steps(self):
        out = []
        if self._phases:
            for i, (tag, heading, steps) in enumerate(self._phases):
                letter = self._phase_letters[i]
                out.append(f'<section class="phase"><p class="tag">'
                           f'Phase {letter} · {_inline(tag)}</p>'
                           f'<h2>{_inline(heading)}</h2></section>')
                for j, (title, content) in enumerate(steps, 1):
                    out.append(self._render_step(f"{letter}{j}", title, content))
        else:
            for j, (title, content) in enumerate(self._flat, 1):
                out.append(self._render_step(str(j), title, content))
        return "\n  ".join(out)

    def _render_masthead(self):
        sub = f'<span class="sub">{_inline(self.subtitle)}</span>' if self.subtitle else ""
        thesis = ""
        if self.thesis:
            chain = ""
            if self.chain:
                links = '<span>→</span>'.join(f"<b>{_inline(c)}</b>" for c in self.chain)
                chain = f'<div class="chain">{links}</div>'
            thesis = (f'<div class="thesis"><p class="lbl">The idea in one line</p>'
                      f'<p>{_inline(self.thesis)}</p>{chain}</div>')
        meta = ""
        if self.meta:
            cells = "".join(f"<span><b>{_inline(k)}:</b> {_inline(v)}</span>" for k, v in self.meta)
            meta = f'<div class="meta">{cells}</div>'
        return (f'<header class="top"><p class="eyebrow">{_inline(self.eyebrow)}</p>'
                f'<h1>{_inline(self.title)}\n      {sub}</h1>{thesis}{meta}</header>')

    def _render_checklist(self):
        if not self._checklist:
            return ""
        lis = "\n      ".join(f"<li>{_inline(i)}</li>" for i in self._checklist)
        return (f'<section class="recap"><h2>Quick sanity checklist</h2>'
                f'<ul>\n      {lis}\n    </ul></section>')

    def html(self):
        t = TOKENS
        css_vars = ";".join(f"--{k.replace('_', '-')}:{v}" for k, v in t.items())
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_html.escape(self.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="{FONT_LINK}" rel="stylesheet">
<style>
  :root{{{css_vars}}}
  *{{box-sizing:border-box}} html{{scroll-behavior:smooth}}
  body{{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);
    line-height:1.62;font-size:16px;-webkit-font-smoothing:antialiased}}
  .wrap{{max-width:880px;margin:0 auto;padding:0 22px}}
  header.top{{padding:64px 0 30px}}
  .eyebrow{{font-family:var(--mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase;
    color:var(--accent);font-weight:500;margin:0 0 18px}}
  h1{{font-family:var(--display);font-weight:700;font-size:clamp(34px,6vw,52px);
    line-height:1.04;letter-spacing:-.02em;margin:0 0 16px}}
  h1 .sub{{display:block;color:var(--ink-soft);font-weight:500;font-size:clamp(17px,2.4vw,21px);
    letter-spacing:0;margin-top:12px;font-family:var(--body)}}
  .thesis{{background:var(--accent-deep);color:#EAF2EE;border-radius:14px;padding:24px 26px;margin:26px 0 8px}}
  .thesis .lbl{{font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#9FC9BB;margin:0 0 10px}}
  .thesis p{{margin:0;font-size:17px;line-height:1.55}}
  .thesis .chain{{margin:16px 0 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-family:var(--mono);font-size:13px}}
  .thesis .chain b{{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);padding:5px 10px;border-radius:7px;font-weight:500;color:#fff}}
  .thesis .chain span{{color:#7FB3A3}}
  .meta{{font-family:var(--mono);font-size:12.5px;color:var(--ink-soft);margin:18px 0 0;display:flex;gap:18px;flex-wrap:wrap}}
  .meta span b{{color:var(--ink);font-weight:500}}
  .phase{{margin:54px 0 6px;padding-top:26px;border-top:2px solid var(--ink)}}
  .phase .tag{{font-family:var(--mono);font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);font-weight:500}}
  .phase h2{{font-family:var(--display);font-weight:600;font-size:26px;letter-spacing:-.01em;margin:6px 0 0}}
  .step{{display:grid;grid-template-columns:64px 1fr;gap:18px;position:relative}}
  .rail{{display:flex;flex-direction:column;align-items:center;position:relative}}
  .rail::before{{content:"";position:absolute;top:0;bottom:-2px;width:2px;background:var(--line)}}
  .step:last-child .rail::before{{bottom:auto;height:30px}}
  .node{{position:relative;z-index:1;margin-top:22px;width:54px;height:54px;border-radius:50%;
    background:var(--surface);border:2px solid var(--accent);color:var(--accent-deep);
    font-family:var(--display);font-weight:700;font-size:17px;display:flex;align-items:center;justify-content:center;letter-spacing:-.01em}}
  .card{{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:14px 0;box-shadow:0 1px 0 rgba(23,35,33,.03)}}
  .card h3{{font-family:var(--display);font-weight:600;font-size:20px;letter-spacing:-.01em;margin:0 0 12px;line-height:1.2}}
  .card p{{margin:0 0 12px}} .card p:last-child{{margin-bottom:0}}
  .card b{{font-weight:600}} .card u{{text-decoration-color:var(--accent);text-underline-offset:2px}}
  .chip{{font-family:var(--mono);font-size:13px;background:var(--chip-bg);color:var(--chip-ink);padding:2px 7px;border-radius:6px;white-space:nowrap}}
  .shot{{margin:16px 0 6px}}
  .shot img{{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:10px;background:#fafbf9}}
  .shot figcaption{{font-family:var(--mono);font-size:12px;color:var(--ink-soft);margin-top:9px;line-height:1.45}}
  .flag,.note{{border-radius:10px;padding:13px 15px;margin:16px 0 6px;font-size:14.5px;line-height:1.55}}
  .flag{{background:var(--flag-soft);border:1px solid var(--flag-line)}}
  .flag p{{margin:6px 0 0;color:#3a2a1c}}
  .flag-tag{{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--flag);font-weight:500}}
  .flag .chip{{background:#efe0d0}}
  .note{{background:var(--accent-soft);border:1px solid #CADED4}}
  .note p{{margin:6px 0 0;color:#1f3a32}}
  .note-tag{{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:500}}
  .recap{{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:24px 26px;margin:30px 0 0}}
  .recap h2{{font-family:var(--display);font-weight:600;font-size:22px;margin:0 0 14px;letter-spacing:-.01em}}
  .recap ul{{list-style:none;margin:0;padding:0}}
  .recap li{{padding:11px 0 11px 30px;border-top:1px solid var(--line);position:relative;font-size:15px}}
  .recap li:first-child{{border-top:0}}
  .recap li::before{{content:"";position:absolute;left:2px;top:16px;width:11px;height:11px;border:2px solid var(--accent);border-radius:3px}}
  footer{{margin:46px 0 70px;padding-top:22px;border-top:1px solid var(--line);font-family:var(--mono);font-size:12px;color:var(--ink-soft)}}
  a{{color:var(--accent-deep)}} a:focus-visible,article:focus-visible{{outline:2px solid var(--accent);outline-offset:3px}}
  @media(max-width:560px){{.step{{grid-template-columns:44px 1fr;gap:10px}}
    .node{{width:40px;height:40px;font-size:13px;margin-top:20px}} .card{{padding:18px 16px}} header.top{{padding:42px 0 22px}}}}
  @media(prefers-reduced-motion:no-preference){{.card{{animation:rise .5s ease both}}
    @keyframes rise{{from{{opacity:0;transform:translateY(8px)}}to{{opacity:1;transform:none}}}}}}
  @media print{{body{{background:#fff}} .card,.recap,.thesis{{box-shadow:none}}
    .card{{break-inside:avoid;animation:none}} .shot{{break-inside:avoid}}}}
</style>
</head>
<body>
<div class="wrap">
  {self._render_masthead()}
  {self._render_steps()}
  {self._render_checklist()}
  <footer>{_inline(self.footer)}</footer>
</div>
</body>
</html>"""

    def build(self, out_path):
        """Write the handbook and return the path."""
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w") as f:
            f.write(self.html())
        return out_path
