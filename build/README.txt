Build resources for electron-builder (`directories.buildResources: build` in
electron-builder.yml).

Everything in this folder is GENERATED from the sprite art, and none of it is
committed. There is no hand-drawn binary here to keep in step with anything.

  icon.png           512x512 app icon (also what electron-builder uses on Linux)
  icon.icns          macOS app icon (16..1024 px members, assembled by iconutil)
  icon.ico           Windows app icon (16/32/48/64/128/256 px PNG members)
                     -- all three written by `npm run gen:icons`, which renders
                     the golden `idle_0` head crop straight out of the sheet
  trayTemplate.png   macOS tray icon, monochrome template image
                     (16x16 @1x plus trayTemplate@2x.png at 32x32)
  tray-win.png       Windows/Linux tray icon, white bone with a dark outline
                     (16x16 @1x plus tray-win@2x.png at 32x32); those platforms
                     do not tint template images, so the macOS file would be
                     invisible on a dark taskbar
                     -- both written by `npm run gen:tray`

Both generators run automatically: `gen:tray` before `dev` and `build`,
`gen:icons` before `dist:mac` / `dist:win` (after `sync:sheet`, so the icon is
rendered from the current artwork and not the previous one).

The tray PNGs are required at runtime -- `tray.ts` reads them through
`app.getAppPath()`. The app icons are only needed when packaging; without them
electron-builder falls back to the stock Electron icon.
