# Walder — agent entry point

Start with `docs/CODENOTCH_GAP_ANALYSIS.md` §4 (the live roadmap — what is done, what is left)
and `docs/DECISIONS.md` (where the reasoning for anything already built is written down), then
`docs/BUILD_LOG.md` (history) and `docs/PROMPTS_V4.md` (strip prompts). `CONTRIBUTING.md` is the
long form of everything below — setup, the `src/` map, the invariants and their tests, the binding
rules, and how to add a usage provider. `SECURITY.md` is where a vulnerability goes, not the
tracker. `docs/NEXT_STEPS.md` is retired: its two binding sections now live in `CONTRIBUTING.md`.

Hard rules: never redraw/trace/patch sprite pixels (whole generated strips only — Firefly, or GPT-image
by Codex for `lie` — sliced by `art/strips.py`, approved by Victor);
never release before all 20 strips are approved; handbook pass last; `src/core/` and `src/sprites/`
stay Electron-free; never refresh CLI tokens ourselves (renewal is delegated to the CLI, see
src/main/claude-renew.ts); never log usage payload values.

Open handoff for Codex: `docs/handoffs/CODEX_P2-3_P2-5.md` — the P2-3b addendum at the end (two held
lie postures, no loop); branch off `main`, PR into `main`.

Checks: `npm run typecheck && npm test && npm run build` · art: `python3 art/strips.py --report &&
node art/render.mjs && npm run sprites`.
