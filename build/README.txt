Build resources for electron-builder (`directories.buildResources: build` in
electron-builder.yml).

Application icons go in this folder. To be added in M6 (packaging):

  icon.icns          macOS app icon (1024x1024 source, .icns bundle)
  icon.ico           Windows app icon (256x256 and down, .ico bundle)
  trayTemplate.png   macOS tray icon, monochrome template image
                     (16x16 @1x plus trayTemplate@2x.png at 32x32)

Nothing here is required for `npm run dev` or `npm run build`; electron-builder
falls back to the stock Electron icon until these files exist.
