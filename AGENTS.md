# Walder — agent entry point

Start with `docs/OPEN_ITEMS.md` (the one current list of open work — what is left, what waits on
Victor) and `docs/DECISIONS.md` (where the reasoning for anything already built is written down), then
`docs/BUILD_LOG.md` (history) and `docs/PROMPTS_V4.md` (strip prompts). `docs/CODENOTCH_GAP_ANALYSIS.md`
is history: the finished 0.2.6 roadmap, kept for its reasoning. `docs/scheduled-agents.md`
says what the scheduled cloud agents may do. `CONTRIBUTING.md` is the
long form of everything below — setup, the `src/` map, the invariants and their tests, the binding
rules, and how to add a usage provider. `SECURITY.md` is where a vulnerability goes, not the
tracker.

Hard rules: never redraw/trace/patch sprite pixels (whole generated strips only — Firefly, or GPT-image
by Codex for `lie` — sliced by `art/strips.py`, approved by Victor). The one exception, added
2026-09-22: an **owner-requested, single-strip correction** to a strip that has already been
generated whole and passed the normal pipeline, staying inside the existing 72 × 72 output frames —
no redraw, trace, rescale or pose change; sources and edited output kept as versioned review assets;
frames, purpose and Victor's approval written into the Yuna review notes; the art checks re-run and
nothing active replaced until he approves. The full conditions are in `CONTRIBUTING.md` (binding
rule 3) — read them before touching a pixel;
the 20-strip release gate is satisfied (2026-11-18, Victor); he may reopen any strip for minor fixes
at any time, and a reopened strip is approved again before it ships; handbook pass last;
`src/core/` and `src/sprites/` stay Electron-free; never refresh CLI tokens ourselves (renewal is
delegated to the CLI, see src/main/claude-renew.ts); never log usage payload values.

Checks: `npm run typecheck && npm test && npm run build` · art: `python3 art/strips.py --report &&
node art/render.mjs && npm run sprites`.

## Before you finish

Every session, before its last message:

- **`docs/OPEN_ITEMS.md`:** remove what you finished, add what you found and did not fix.
- **Docs:** update the docs your change touches (README, SETTINGS, QA-CHECKLIST, privacy, …).
- **No stray files:** scratch goes to the session scratchpad, QA evidence to `~/Walder-qa/<run>`;
  nothing new is left untracked in the checkout unless Victor asked for it.
- **No leftovers:** remove your worktrees and merged local branches; ask Victor before deleting a
  merged remote branch.
- **The gate, by exit code:** the checks above, never piped through `grep` or `tail`.
