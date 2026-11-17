; Walder's additions to electron-builder's NSIS installer (`nsis.include` in
; electron-builder.yml).
;
; Launch at login (2026-11-13). `app.setLoginItemSettings` writes the HKCU Run
; value `electron.app.Walder` (QA row 8.5) and electron-builder's uninstaller
; never removes it, so uninstalling with the item ticked left a startup entry
; pointing at a deleted exe, and a later reinstall into the same folder started
; at login unasked. The ${isUpdated} guard is essential: installing a new
; version runs the old uninstaller with --updated, and deleting the value there
; would switch Launch at login off on every update. Not yet run on Windows.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Walder"
  ${endIf}
!macroend
