/**
 * The message box that does not stop the main process (`main/dialog-host.ts`).
 *
 * What is pinned is the one decision the whole module exists for: on macOS the
 * dialog is **given a parent**, because Electron turns a parentless async
 * `showMessageBox` into `[NSAlert runModal]`, which starves every Node timer
 * until it is answered (0.2.8 QA 7a.3 / 7.12 / 7.13). Without a parent the
 * test below would pass `options` alone — exactly the call that blocked.
 *
 * Alongside it: the host is visible before the sheet is asked for (a sheet on
 * a hidden window cannot be dismissed), it is gone once the answer is in, even
 * when the dialog throws, and Windows — where a parentless box already runs on
 * its own thread — gets no window at all.
 *
 * `electron` is mocked: nothing here opens a real window or dialog.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const hosts: FakeWindow[] = [];

class FakeWindow {
  destroyed = false;
  constructor(readonly options: Record<string, unknown>) {
    hosts.push(this);
  }
  show(): void {
    calls.push('show');
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    calls.push('destroy');
    this.destroyed = true;
  }
}

const showMessageBox = vi.fn();

vi.mock('electron', () => ({ BrowserWindow: FakeWindow, dialog: { showMessageBox } }));

const { showMessageBoxWithoutBlocking } = await import('../src/main/dialog-host');

const options = { message: "Install Walder's Claude Code hooks?", buttons: ['Install', 'Cancel'] };

beforeEach(() => {
  calls.length = 0;
  hosts.length = 0;
  showMessageBox.mockReset();
});

describe('showMessageBoxWithoutBlocking', () => {
  it('on macOS asks as a sheet on a shown host, and destroys the host after the answer', async () => {
    showMessageBox.mockImplementation(async () => {
      calls.push('dialog');
      return { response: 1, checkboxChecked: false };
    });

    const answer = await showMessageBoxWithoutBlocking(options, 'darwin');

    expect(answer.response).toBe(1);
    expect(hosts).toHaveLength(1);
    // The parent is the whole fix: `(options)` alone is the runModal path.
    expect(showMessageBox).toHaveBeenCalledWith(hosts[0], options);
    expect(calls).toEqual(['show', 'dialog', 'destroy']);
    // Invisible: nothing of the host may be seen around the alert.
    expect(hosts[0]?.options).toMatchObject({ transparent: true, frame: false, show: false });
  });

  it('does not settle until the sheet is answered, so two offers never stack', async () => {
    let answer: (value: { response: number; checkboxChecked: boolean }) => void = () => undefined;
    showMessageBox.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );

    let settled = false;
    const pending = showMessageBoxWithoutBlocking(options, 'darwin').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(hosts[0]?.destroyed).toBe(false);

    answer({ response: 0, checkboxChecked: false });
    await pending;
    expect(settled).toBe(true);
    expect(hosts[0]?.destroyed).toBe(true);
  });

  it('destroys the host even when the dialog throws', async () => {
    showMessageBox.mockRejectedValue(new Error('no dialog'));
    await expect(showMessageBoxWithoutBlocking(options, 'darwin')).rejects.toThrow('no dialog');
    expect(hosts[0]?.destroyed).toBe(true);
  });

  it('on Windows passes the parentless call straight through', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    await showMessageBoxWithoutBlocking(options, 'win32');
    expect(hosts).toHaveLength(0);
    expect(showMessageBox).toHaveBeenCalledWith(options);
  });
});
