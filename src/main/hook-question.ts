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
 *
 * On macOS, Remove's Return does nothing at all rather than choosing Cancel,
 * and no button is drawn as the default. Electron's message box gives the
 * `defaultId` button Return and then the `cancelId` button Esc, so when they are
 * the same button the Esc binding replaces the Return one. Esc and a click on
 * Cancel still cancel. `cancelId: -1` would make Return choose a blue Cancel but
 * leave Esc doing nothing, and leaving `cancelId` out infers 1 from the "Cancel"
 * label, so no setting gives all three (checked on Electron 45.3.4, Mac QA
 * 2026-11-19). Return removing nothing is what the owner asked for, so it stays.
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
