/**
 * The confirmation box for installing or removing the Claude Code and Codex
 * hooks, built here rather than inline in `index.ts` so it can be tested
 * without Electron.
 *
 * Button 0 is always the action and button 1 Cancel: the callers read
 * `response === 0` as "do it". Only the default differs. Remove defaults to
 * Cancel, so an accidental Return does not take the hooks out; Install keeps
 * the action as the default (2026-11-18, owner's decision on the 0.2.8 QA
 * findings).
 */
export interface HookQuestion {
  readonly type: 'question';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: true;
}

export function hookQuestion(opts: {
  readonly remove: boolean;
  readonly verb: string;
  readonly cancel: string;
  readonly message: string;
  readonly detail: string;
}): HookQuestion {
  return {
    type: 'question',
    title: 'Walder',
    message: opts.message,
    detail: opts.detail,
    buttons: [opts.verb, opts.cancel],
    defaultId: opts.remove ? 1 : 0,
    cancelId: 1,
    noLink: true
  };
}
