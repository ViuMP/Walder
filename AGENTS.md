# Walder — agent entry point

Start with `docs/NEXT_STEPS.md` (what is left before 0.2.0, the 20 missing strips, release order),
then `docs/PROMPTS_V4.md` (strip prompts) and `docs/BUILD_LOG.md` (history).

Hard rules: never redraw/trace/patch sprite pixels (Firefly strips only, sliced by `art/strips.py`);
never release before all 20 strips are approved; handbook pass last; `src/core/` and `src/sprites/`
stay Electron-free; never refresh CLI tokens ourselves (renewal is delegated to the CLI, see
src/main/claude-renew.ts); never log usage payload values.

Checks: `npm run typecheck && npm test && npm run build` · art: `python3 art/strips.py --report &&
node art/render.mjs && npm run sprites`.
