# QA-M3 — overlay shell, manual checklist

Eleven checks that need a human at the keyboard. Everything else in M3 is covered
by `npm test` (272 tests) and `npm run typecheck`.

**Start the app:**

```
npm run dev
```

To see what the app is doing while you test, start it with logging on instead:

```
WALDER_LOG=1 npm run dev
```

Add `WALDER_DEBUG=1` as well to draw a magenta one-pixel box around the clickable
area — useful for check 2 if click-through misbehaves.

Quit between checks with **Quit** in the menu-bar menu, not by closing anything:
Walder deliberately never quits on its own.

The dog appears in the **bottom-right corner** of the main display on first run,
and wherever you last left it after that. It is a crude golden blob at this
stage — the real drawing lands separately; a long body, a head with a floppy ear
on the left, four short legs and a tail on the right is correct.

---

### 1. It appears, and it stays on top

Expect: a small pixel dog in the bottom-right corner, sitting on nothing (no box,
no shadow, no grey rectangle around it — only the dog's own pixels are visible).

Open a normal window (Finder, a browser) and move it under the dog. The dog stays
in front. Click on that window's title bar. The dog is still in front.

### 2. Clicks pass through everywhere except the dog

Put a browser window behind the dog, with a link or button in the area the dog
covers but **not** under the dog's own pixels — the corners of its square are
transparent.

- Click a transparent corner → the browser gets the click (the link follows, the
  browser comes forward). The dog does nothing.
- Click the dog's body → the browser does **not** react.

If a click on transparent pixels is being swallowed, run with `WALDER_DEBUG=1` and
compare where you clicked against the magenta box.

### 3. Clicking the dog pets it

Click once on the dog's body. Expect a short wiggle: it dips one pixel and springs
back for about half a second. (A one-pixel dip is all there is at this stage —
the real pet animation arrives with the art.)

With `WALDER_LOG=1` running, the terminal prints `[walder] pet`.

### 4. Dragging moves it, and the position survives a restart

Drag the dog by its body to a different corner of the screen. It should follow the
cursor smoothly and **not** trigger a pet when you let go.

Try to drag it off the edge of the screen. It should refuse to disappear — part of
it always stays reachable.

Now **Quit** from the menu and run `npm run dev` again. The dog comes back where
you left it.

### 5. Right-clicking the dog opens the menu

Right-click (or two-finger click) on the dog's body. The menu-bar menu opens.

Right-click a transparent corner instead → nothing happens, and the app behind
gets its own context menu.

### 6. Size

In the menu: **Size → Small / Medium / Large**. Each one resizes the dog
immediately. The bottom-left corner of the dog stays put, so it grows upward and
to the right rather than jumping.

The dot in the menu marks the current size. Quit and relaunch — the size is
remembered.

### 7. Colour

In the menu: **Colour → Golden / Red / Cream / Black and tan / Chocolate**.

Only **Golden** has real colours at this stage. Picking any other one is expected
to leave the dog looking the same — the choice is stored and will start working
when the real art lands. Nothing should break or flicker.

Quit and relaunch — the choice is remembered (the radio dot is on the colour you
picked, even though the dog still looks golden).

### 8. Reset position (the other escape hatch)

Drag the dog somewhere awkward — a far corner, or half off an edge. Then choose
**Reset position** in the menu.

It jumps back to the bottom-right of your **main** display, 16 px from each edge:
the same spot a fresh install puts it. Quit and relaunch — it is still there, so
the reset was saved and not just applied.

This is the recovery path for a dog that cannot be reached with the mouse at all
(left on a monitor that has since been unplugged, say), so it deliberately
ignores whatever display the dog was on and always uses the main one.

### 9. Force interactive (the escape hatch)

In the menu, tick **Force interactive (debug)**.

Now the dog's whole square swallows clicks — clicking the transparent corners no
longer reaches the window behind. That is the point: it is the fallback if the
pixel hit test ever misbehaves.

Untick it **with the cursor sitting on the dog**. Click-through should come back
straight away for the transparent corners, without needing to move the mouse off
the dog and back on — **and the dog must still be clickable where the cursor
already is**. Click it without moving the mouse first: it should pet.

(This is the case that needed a resync message between the two halves of the app,
and untick is now handled entirely by that resync rather than by main guessing.
It is the one to watch.)

### 10. No dock icon, and it survives a full-screen video

There should be **no Walder icon in the Dock** (macOS) and none in the taskbar
(Windows) — the menu-bar/tray icon is the only one.

Play a YouTube video and put it full-screen. The dog should still be visible on
top of it. On macOS, switch to another Space and back — the dog is on every Space.

*(This is the check most likely to behave differently on your machine than on the
builder's; see the note at the bottom.)*

### 11. It does not burn CPU

Leave the dog alone for two minutes, then open Activity Monitor (macOS) or Task
Manager (Windows) and find the Electron/Walder processes.

Expect roughly **under 1 %** CPU total while idle. The dog only redraws when its
animation frame changes (twice a second), not continuously.

Also look at the **Launch at login** item. Under `npm run dev` it is greyed out
and reads **"Launch at login (packaged app only)"** — that is correct and
deliberate: an unsigned dev build cannot register a login item, and offering a
tick that silently fails was worse than saying so. From a packaged build the item
is live, and its tick mirrors what macOS System Settings actually reports.

---

## What the builder could not verify

- **Everything in checks 1–11 above** was implemented and reasoned about but not
  seen: this shell was verified by launching the app and reading the main-process
  log (window size, click-through default, store file, IPC round trip), not by
  looking at the screen. Screen capture is not permitted to the builder's shell.
- **Check 9 in particular.** `alwaysOnTop(true, 'screen-saver')`,
  `setVisibleOnAllWorkspaces(visibleOnFullScreen: true)` and macOS
  `type: 'panel'` are the right combination for floating over full-screen apps,
  but macOS honours them differently across versions and Space configurations.
- **Windows.** Nothing was run on Windows. `forward: true` on
  `setIgnoreMouseEvents` is supported on both macOS and Windows, so checks 2–5
  should hold, but the platform branch (`setSkipTaskbar`, no `panel` type) is
  untested. The Windows tray icon in particular: `build/tray-win.png` (a white
  bone with a dark outline, so it reads on a dark *or* light taskbar) is
  generated and the platform branch that selects it is unit-tested, but it has
  never been looked at in a real Windows tray.
- **Fractional display scaling.** The renderer rasterises the dog at a whole
  number of device pixels per sprite pixel, which is what stops the pixels
  wobbling at a 1.5x or 1.75x ratio. That maths is unit-tested; the result has
  not been seen on a 150 %-scaled monitor.
- **Multi-monitor.** The off-screen clamp is unit-tested against synthetic
  display layouts (`test/geometry.test.ts`), but dragging between two real
  monitors, and unplugging one while the dog sits on it, were not tried.

If check 2 or 3 fails, the escape hatches in checks 8 and 9 keep the app usable
while it is diagnosed.
