"""Walder-specific content components for the handbook generator.

Everything here produces raw HTML blocks the generator injects verbatim (it
passes through any string starting with '<'). The handbook's own chrome —
palette, rail, callouts, print rules — stays entirely in handbook.py; these are
content widgets: real sprite frames from art/out, animated at the tempos in
art/walder.json, so the reader sees what the app actually shows.
"""
import base64
import json
import os

ART = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "art")
OUT = os.path.join(ART, "out")
SHEET = json.load(open(os.path.join(ART, "walder.json")))

# 1.5 screen px per sprite px, sourced from the @3x PNGs so it stays crisp.
SCALE = 1.5


def _uri(path):
    with open(path, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


def frame_uris(palette="golden", zoom="3x"):
    """Every frame of one coat, as data URIs keyed by frame name."""
    out = {}
    for name in SHEET["frames"]:
        p = os.path.join(OUT, palette, f"{name}@{zoom}.png")
        out[name] = _uri(p)
    return out


def anim_meta():
    """The timing table, straight from the sheet the app validates and loads."""
    out = {}
    for name, a in SHEET["animations"].items():
        box = SHEET["boxes"]["stand"]
        first = a["frames"][0]
        # Frames carry their own box via the sheet's box table; the sleep and
        # decoration frames are the only non-stand ones.
        for bname, dims in SHEET["boxes"].items():
            if first.startswith(bname) or (bname == "sleep" and first.startswith("sleep")):
                box = dims
        out[name] = {
            "frames": a["frames"],
            "durations": a["durationsMs"],
            "loop": a["loop"],
            "hold": bool(a.get("hold")),
            "box": box,
        }
    return out


def boot():
    """Frame data, timing data, the player script and the widget CSS.

    Emitted once, invisibly, as the first block of the first step.
    """
    data = {"frames": frame_uris(), "anims": anim_meta(), "scale": SCALE}
    coats = {
        p: _uri(os.path.join(OUT, p, "idle_0@3x.png"))
        for p in ["golden", "red", "cream", "black-and-tan", "chocolate"]
    }
    data["coats"] = coats
    return (
        "<style>\n" + CSS + "\n</style>\n"
        "<script>window.__WALDER=" + json.dumps(data, separators=(",", ":")) + ";</script>\n"
        "<script>\n" + JS + "\n</script>"
    )


CSS = """
.wa-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:14px;margin:18px 0 6px}
.wa-card{background:#F6F8F4;border:1px solid var(--line);border-radius:12px;padding:12px 13px 14px;display:flex;flex-direction:column}
.wa-card.wa-quiet{background:#F0F1EE;border-style:dashed}
.wa-stage{height:124px;display:flex;align-items:flex-end;justify-content:center;
  background:#fff;border:1px solid var(--line);border-radius:9px;margin:0 0 11px;position:relative;overflow:hidden;cursor:pointer}
.wa-stage::after{content:"";position:absolute;left:10px;right:10px;bottom:11px;border-bottom:1px dashed #E2E7DE}
.wa-stage img{display:block;position:relative;image-rendering:pixelated;margin-bottom:8px}
.wa-stage .wa-replay{position:absolute;right:6px;bottom:6px;font-family:var(--mono);font-size:10px;
  letter-spacing:.06em;text-transform:uppercase;color:var(--accent);background:#fff;border:1px solid var(--line);
  border-radius:5px;padding:2px 6px;opacity:0;transition:opacity .15s}
.wa-stage:hover .wa-replay,.wa-stage:focus-visible .wa-replay{opacity:1}
.wa-name{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--chip-ink);margin:0 0 3px}
.wa-tech{font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin:0 0 8px;line-height:1.4}
.wa-why{font-size:13.5px;line-height:1.5;margin:0;color:#22322F}
.wa-why b{font-weight:600}
.wa-trigger{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--accent);margin:0 0 7px}
.wa-groupname{font-family:var(--display);font-weight:600;font-size:15px;margin:26px 0 0;
  padding-top:14px;border-top:1px solid var(--line)}
.wa-groupname:first-child{margin-top:6px;padding-top:0;border-top:0}
.wa-groupsub{font-size:13.5px;color:var(--ink-soft);margin:3px 0 0}

.wa-faces{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:16px 0 6px}
.wa-face{background:#fff;border:1px solid var(--line);border-radius:11px;padding:10px;text-align:center}
.wa-face.wa-same{background:#FBFAF4;border-color:#E4DFC9}
.wa-face .wa-stage{height:112px;border:0;background:transparent;margin-bottom:6px}
.wa-face .wa-band{font-family:var(--mono);font-size:11px;color:var(--accent);margin:0}
.wa-face .wa-lbl{font-family:var(--display);font-weight:600;font-size:15px;margin:2px 0 3px}
.wa-face .wa-note{font-size:12px;color:var(--ink-soft);margin:0;line-height:1.4}

.wa-scale{margin:18px 0 6px}
.wa-bar{display:flex;height:34px;border-radius:8px;overflow:hidden;border:1px solid var(--line)}
.wa-seg{display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:11.5px;color:#fff}
.wa-ticks{display:flex;font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin-top:6px}
.wa-ticks span{text-align:center}

.wa-tbl{width:100%;border-collapse:collapse;margin:16px 0 6px;font-size:14px}
.wa-tbl th{text-align:left;font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-soft);font-weight:500;padding:0 10px 8px 0;border-bottom:1px solid var(--ink)}
.wa-tbl td{padding:10px 10px 10px 0;border-bottom:1px solid var(--line);vertical-align:top;line-height:1.5}
.wa-tbl tr:last-child td{border-bottom:0}
.wa-tbl td:first-child{white-space:nowrap}

.wa-coats{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 6px}
.wa-coat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 8px 6px;text-align:center;width:112px}
.wa-coat img{display:block;width:88px;height:88px;image-rendering:pixelated;margin:0 auto}
.wa-coat span{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);display:block;margin-top:2px}

.wa-ladder{margin:16px 0 6px;counter-reset:wal}
.wa-rung{display:grid;grid-template-columns:26px 1fr;gap:12px;align-items:start;padding:10px 0;border-bottom:1px solid var(--line)}
.wa-rung:last-child{border-bottom:0}
.wa-rung i{font-family:var(--mono);font-style:normal;font-size:12px;color:#fff;background:var(--accent);
  width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-top:2px}
.wa-rung.wa-low i{background:#9AA9A4}
.wa-rung p{margin:0;font-size:14px;line-height:1.5}
.wa-rung p b{font-weight:600}

.wa-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0 6px}
.wa-bubble{background:#fff;border:1px solid var(--line);border-radius:11px;padding:12px 14px}
.wa-bubble .wa-says{font-family:var(--mono);font-size:15px;background:var(--chip-bg);border-radius:7px;
  padding:6px 9px;display:inline-block;margin:0 0 8px}
.wa-bubble p{margin:0;font-size:13.5px;line-height:1.5}
@media(max-width:560px){.wa-pair{grid-template-columns:1fr}}
@media print{.wa-stage{break-inside:avoid}.wa-card,.wa-face{break-inside:avoid}}
"""

JS = """
(function(){
  function boot(){
    var W = window.__WALDER; if(!W) return;
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var stages = [].slice.call(document.querySelectorAll('.wa-stage[data-anim]'));

    stages.forEach(function(stage){
      var a = W.anims[stage.dataset.anim]; if(!a) return;
      var img = stage.querySelector('img');
      var i = 0, timer = null, running = false;

      function paint(k){ img.src = W.frames[a.frames[k]]; }
      function stop(){ if(timer){ clearTimeout(timer); timer = null; } running = false; }
      function tick(){
        paint(i);
        timer = setTimeout(function(){
          if(i + 1 >= a.frames.length){
            // A one-shot parks on its last frame, which is what `hold: true`
            // means in the sheet and what the app really does.
            if(a.loop){ i = 0; tick(); } else { running = false; timer = null; }
          } else { i += 1; tick(); }
        }, a.durations[i] || 600);
      }
      function start(from){
        stop(); i = from || 0; running = true; tick();
      }

      paint(0);
      stage.__start = start; stage.__stop = stop;
      stage.__loops = a.loop;
      stage.addEventListener('click', function(){ start(0); });
      stage.addEventListener('keydown', function(e){
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); start(0); }
      });
      if(!still && a.loop) start(0);
      if(!still && !a.loop) stage.dataset.pending = '1';
    });

    // One-shots play once when they scroll into view, so the reader sees the
    // gesture without hunting for a button; loops pause off-screen.
    if(!still && 'IntersectionObserver' in window){
      var io = new IntersectionObserver(function(entries){
        entries.forEach(function(en){
          var s = en.target;
          if(en.isIntersecting){
            if(s.dataset.pending === '1'){ delete s.dataset.pending; s.__start(0); }
            else if(s.__loops) s.__start(0);
          } else if(s.__loops) s.__stop();
        });
      }, {threshold: 0.35});
      stages.forEach(function(s){ io.observe(s); });
    }

    [].slice.call(document.querySelectorAll('img[data-coat]')).forEach(function(img){
      img.src = W.coats[img.dataset.coat];
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})()
"""


def _stage(anim, height=124, extra="", mult=1.0):
    a = SHEET["animations"][anim]
    box = SHEET["boxes"]["stand"]
    first = a["frames"][0]
    for bname, dims in SHEET["boxes"].items():
        if first.startswith(bname):
            box = dims
    w = round(box[0] * SCALE * mult)
    h = round(box[1] * SCALE * mult)
    return (
        f'<div class="wa-stage" data-anim="{anim}" tabindex="0" role="button" '
        f'aria-label="Play the {anim} animation" style="height:{height}px{extra}">'
        f'<img width="{w}" height="{h}" alt="Walder, the {anim} animation" src="">'
        f'<span class="wa-replay">replay</span></div>'
    )


def tech_line(anim):
    a = SHEET["animations"][anim]
    n = len(a["frames"])
    durs = a["durationsMs"]
    uniq = sorted(set(durs))
    tempo = f"{uniq[0]} ms" if len(uniq) == 1 else "/".join(str(d) for d in durs) + " ms"
    total = sum(durs)
    kind = "loops" if a["loop"] else ("plays once, then holds" if a.get("hold") else "plays once")
    total_txt = f" · {total/1000:.2f} s a lap" if a["loop"] else f" · {total/1000:.2f} s"
    return f"{n} frame{'s' if n != 1 else ''} · {tempo} · {kind}{total_txt}"


def anim_card(anim, trigger, why, quiet=False, mult=1.0):
    cls = "wa-card wa-quiet" if quiet else "wa-card"
    return (
        f'<div class="{cls}">{_stage(anim, mult=mult)}'
        f'<p class="wa-trigger">{trigger}</p>'
        f'<p class="wa-name">{anim}</p>'
        f'<p class="wa-tech">{tech_line(anim)}</p>'
        f'<p class="wa-why">{why}</p></div>'
    )


def group(name, sub, cards):
    return (
        f'<p class="wa-groupname">{name}</p><p class="wa-groupsub">{sub}</p>'
        f'<div class="wa-grid">{"".join(cards)}</div>'
    )


def faces(rows):
    out = []
    for anim, band, label, note, same in rows:
        cls = "wa-face wa-same" if same else "wa-face"
        out.append(
            f'<div class="{cls}">{_stage(anim, height=112)}'
            f'<p class="wa-band">{band}</p>'
            f'<p class="wa-lbl">{label}</p>'
            f'<p class="wa-note">{note}</p></div>'
        )
    return f'<div class="wa-faces">{"".join(out)}</div>'


def scale_bar(segments, ticks):
    segs = "".join(
        f'<div class="wa-seg" style="flex:{w};background:{c}">{t}</div>' for w, c, t in segments
    )
    tk = "".join(f'<span style="flex:{w}">{t}</span>' for w, t in ticks)
    return f'<div class="wa-scale"><div class="wa-bar">{segs}</div><div class="wa-ticks">{tk}</div></div>'


def table(headers, rows):
    th = "".join(f"<th>{h}</th>" for h in headers)
    tr = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
    return f'<table class="wa-tbl"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'


def coats(names):
    cells = "".join(
        f'<div class="wa-coat"><img data-coat="{k}" src="" alt="Walder in the {n} coat"><span>{n}</span></div>'
        for k, n in names
    )
    return f'<div class="wa-coats">{cells}</div>'


def ladder(rungs):
    out = []
    for i, (text, low) in enumerate(rungs, start=1):
        cls = "wa-rung wa-low" if low else "wa-rung"
        out.append(f'<div class="{cls}"><i>{i}</i><p>{text}</p></div>')
    return f'<div class="wa-ladder">{"".join(out)}</div>'


def bubbles(items):
    out = []
    for says, body in items:
        out.append(f'<div class="wa-bubble"><span class="wa-says">{says}</span><p>{body}</p></div>')
    return f'<div class="wa-pair">{"".join(out)}</div>'
