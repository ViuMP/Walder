# Walder — the 0.2 handoff note (historical)

**This note is history.** It was written on 2026-09-10 for the run-up to 0.2.0, and its state,
its strip list and its release checklist all predate 0.2.2. Do not plan from it.

**The live roadmap is `docs/CODENOTCH_GAP_ANALYSIS.md` §4.** What was built between then and now
is in `docs/BUILD_LOG.md`, and why each thing was built that way is indexed in
`docs/DECISIONS.md`. The rest of this note — the 0.2.2 state, the 20 strips, the release order —
is in git history if you want it.

Two sections below are not history. They are still binding, and they stay here until
`CONTRIBUTING.md` exists to hold them (P1-11).

## Binding rules (Victor's decisions — do not re-litigate)

1. **No release before all 20 planned visual slots are owner-approved** in `npm run sprites`. Victor
   approved the four current fallback slots on 2026-09-11; their absent v4 source PNGs are intentional.
2. **The handbook content pass comes LAST**, right before `npm run release` — never earlier (it would
   be redone once the art changes).
3. **Never redraw Walder by hand or trace him.** Every hand-drawn/traced sprite was rejected. The only
   accepted method is Victor's own Firefly strips sliced 1:1 by `art/strips.py`.
4. Never refresh the Claude Code / Codex CLI tokens from Walder ourselves; Claude Code renewal is
   delegated to the CLI (src/main/claude-renew.ts spawns `claude -p` and never touches the token).
   Never log payload values, only key names.
5. `src/core/` and `src/sprites/` stay Electron-free; long WHY comments; no magic numbers.


## Process that has worked for this repo

Builder in a git worktree (`git worktree add ../Walder-<stage> -b <branch>`, symlink `node_modules`)
→ fresh reviewer → owner-side audit of the critical files → fix round → `git merge --no-ff` →
typecheck/vitest/build → push → remove worktree. Small verified steps; explain decisions to Victor in
plain language; ask before anything that changes the architecture.
