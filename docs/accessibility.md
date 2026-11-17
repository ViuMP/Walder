# Accessibility and language

## Accessibility

**Still mode**, in the menu, stops every animation: no breathing, no tail, no
stretch. He holds a resting frame and stays there. His *face* still changes with
the number, because a different picture is not motion — a worried dog is still
worth seeing. If your system's Reduce Motion setting is on, Still mode switches
itself on with it.

For screen readers he carries a spoken label, rebuilt whenever anything changes:
*"Walder, worried. Claude 5-hour 87% used."* A bark is announced when it
appears, and each row of the hover card reads as one sentence rather than a
scatter of cells.

**What has and has not been checked** (2026-09-19, one Mac): Still mode and the
Reduce Motion link both work. VoiceOver does reach Walder's windows and
announces them as web content, but whether it then reads the labels inside has
not been tried, and the card is only on screen while the pointer is on the dog,
so a screen reader that follows the pointer can never land on its rows. If you
use one, please report what you hear — including nothing.

## Language

English only for now; every owner-facing string sits in
[`src/core/strings.ts`](../src/core/strings.ts), so a second language is a second
table, not a hunt through the code.
