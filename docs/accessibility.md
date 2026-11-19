<p align="center">
  <img src="../assets/shared/logo.png" width="96" alt="The Walder app icon: the head and chest of a golden long-haired dachshund in pixel art, on a rounded cream tile with a thin tan rim.">
</p>

<h1 align="center">Accessibility and language</h1>

<p align="center">
  What Walder does for still screens, screen readers and the keyboard, and what nobody has checked yet.
</p>

## Still mode

**Still mode** (Appearance ▸ Still mode) stops every animation: no breathing, no tail, no stretch.
He holds a resting frame and stays there. His face still changes with the number, because a
different picture is not motion. When your system's Reduce Motion setting is on, Walder holds still
as if Still mode were on; the switch itself does not change. The Walder window also turns off its
switch animations then.

## Screen readers

The dog carries a spoken label, rebuilt whenever anything changes, such as *"Walder, worried.
Claude 5-hour 87% used."* It adds how he is lying and anything he is saying, and leaves out the
number when there is none. The label says "Walder" with Yuna the cat too. A bark is announced when
it appears.

Each row of the hover card reads as one sentence, for example the window, how much is used and when
it resets, rather than a scatter of cells. The card's bars are hidden from screen readers.

## The Walder window

- **Pages:** the rail on the left is a list of tabs, and the arrow keys move between pages.
- **Companion:** the model and coat pickers are radio groups you can move through with the arrow
  keys.
- **Switches:** each switch is named after its setting, and the line under it is read as its
  description.
- **Card lines:** on Visibility ▸ Hover card, Alt+Up and Alt+Down move a line, and each move is
  read out with its new position.
- **Messages:** Apply and refresh results are announced. An error on a single setting is announced
  at once.
- **The card:** Overview shows the same card as the hover card, with the same row labels, so you
  can read your usage there without hovering over the dog.

## What has been checked

Checked on 2026-09-19, on one Mac, before 0.3.0:
- Still mode, then a menu item, worked.
- The Reduce Motion link worked.
- VoiceOver reached the dog's window and the card's window and announced them as web content.
  Whether it then read the labels inside was not tried.

The hover card is on screen only while the pointer is on the dog, so a screen reader that follows
the pointer can't land on its rows. The Walder window, new in 0.3.0, has not been tried with a
screen reader at all. If you use one, please
[report what you hear](https://github.com/ViuMP/Walder/issues/new), including nothing.

## Language

Walder speaks seven languages: English, Danish (Dansk), Simplified Chinese (简体中文), Hindi
(हिन्दी), Spanish (Español), French (Français) and German (Deutsch). Choose one in the Walder window under
**App ▸ Language**. Each language is listed under its own name, so you can find yours from any of
them.

**The six translations were written by a machine and have not been read by a native speaker.**
Corrections are welcome as [issues](https://github.com/ViuMP/Walder/issues/new). The tables are in
[`src/core/i18n/`](../src/core/i18n/), one file per language.

- **System** (the default) takes the first language in your computer's list of preferred languages
  that Walder has, and English if there is none. Traditional Chinese is skipped rather than shown in
  Simplified characters, and Norwegian and Swedish are not taken as Danish.
- A change applies after a restart (bone menu ▸ **Restart**). Until then every window keeps the
  language Walder started in.
- Dates, times and money follow the chosen language, with Western digits everywhere, so a
  percentage and a reset time read the same way in every language.
- A percentage is spaced the way the Unicode CLDR data writes it for that language: `87%` in
  English, Hindi and Chinese, `87 %` with a no-break space in Danish, German, Spanish and French.
  French also gets a no-break space before `:` and a narrow one before `;`, `?` and `!`. This is
  done in one place for every string ([`src/core/i18n/index.ts`](../src/core/i18n/index.ts)),
  not typed by hand.
- No font is bundled. Chinese and Hindi are drawn with the fallback fonts your system
  substitutes into the monospace text, so those lines are proportional where Latin text is
  monospace. Small text in those two languages is drawn at 11 px instead of 9 or 10.
- A speech bubble wraps only at ordinary spaces, so a no-break space keeps `87 %` and `5 h :`
  together and a sign never starts a line on its own.

**What stays English:** the log file and the **Report a bug** diagnostics; the settings file's keys
and values; product names (Walder, Claude, ChatGPT, Codex, Cursor, Copilot, Gemini, Antigravity);
commands inside sentences (`gh auth login`, `codex login`, `/hooks`); key names (Cmd, Ctrl, Alt,
Shift); hook event names; coat names; a hook installer's refusal reason and any provider message
Walder does not know (for example `HTTP 503`); the animation gallery; the command-line scripts
(`npm run install-hooks`, `npm run probe`); and the `12:03` times in the bone menu's login lines.
The Developer menu exists only in development builds and is translated, though nobody needs it to be.
