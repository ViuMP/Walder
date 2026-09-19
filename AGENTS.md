# Walder — agent entry point

Start with `docs/CODENOTCH_GAP_ANALYSIS.md` §4 (the live roadmap — what is done, what is left)
and `docs/DECISIONS.md` (where the reasoning for anything already built is written down), then
`docs/BUILD_LOG.md` (history) and `docs/PROMPTS_V4.md` (strip prompts). `CONTRIBUTING.md` is the
long form of everything below — setup, the `src/` map, the invariants and their tests, the binding
rules, and how to add a usage provider. `SECURITY.md` is where a vulnerability goes, not the
tracker. `docs/NEXT_STEPS.md` is retired: its two binding sections now live in `CONTRIBUTING.md`.

Hard rules: never redraw/trace/patch sprite pixels (Firefly strips only, sliced by `art/strips.py`);
never release before all 20 strips are approved; handbook pass last; `src/core/` and `src/sprites/`
stay Electron-free; never refresh CLI tokens ourselves (renewal is delegated to the CLI, see
src/main/claude-renew.ts); never log usage payload values.

Checks: `npm run typecheck && npm test && npm run build` · art: `python3 art/strips.py --report &&
node art/render.mjs && npm run sprites`.
