/**
 * `npm run sprites` — parked.
 *
 * In M2a this launched the dev app onto `src/renderer/sprites-dev.html`, a stub
 * gallery page, via `WALDER_PAGE`. M3 turned the main process into a
 * single-purpose overlay host (transparent, frameless, click-through, no dock
 * icon), so there is no longer a window a gallery could sensibly open in — and
 * the page itself still renders nothing.
 *
 * Rather than silently opening the mascot instead, this says so. A real gallery
 * needs its own ordinary window and the finished art; both belong to a later
 * stage. The drawn frames can be inspected today as PNGs under `art/out/`.
 */
console.error(
  [
    'npm run sprites is parked.',
    '',
    'The sprite gallery page is still a stub, and since M3 the app opens only the',
    'overlay window (transparent and click-through — not usable as a gallery).',
    '',
    '  To see the mascot:        npm run dev',
    '  To see the drawn frames:  open the PNGs under art/out/',
    ''
  ].join('\n')
);
process.exit(1);
