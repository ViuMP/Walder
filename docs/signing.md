# Signing and notarising the macOS build

The build Walder ships today is ad-hoc signed: coherent, but trusted by nobody,
so the first launch goes through System Settings ▸ Privacy & Security ▸ Open
Anyway. The signed path exists and has never run, because it needs an Apple
Developer account ($99 a year) and there is no certificate on the owner's Mac.
This is what turns it on. Nothing here changes `npm run dist:mac`.

## Once

1. Enrol at developer.apple.com and, in Certificates, create a **Developer ID
   Application** certificate. Download it and double-click it into the login
   keychain. `security find-identity -v -p codesigning` must then list one line
   containing `Developer ID Application: <name> (<TEAMID>)`.
2. In App Store Connect ▸ Users and Access ▸ Integrations ▸ App Store Connect
   API, create a key with the Developer role. Keep the `.p8` file somewhere
   outside this tree and note the Key ID and Issuer ID. This is the form
   electron-builder recommends over an Apple ID password.

## Every release

```bash
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
npm run dist:mac:signed
```

`dist:mac:signed` builds with `electron-builder.signed.yml`, which extends the
default config and changes only the signing half: the Developer ID identity,
the hardened runtime, the two JIT entitlements in `build/entitlements.mac.plist`,
and notarisation with stapling. It packages into `/tmp/walder-dist-signed` for
the same iCloud reason `dist:mac` uses `$TMPDIR`, then copies into `release/`.
`postdist:mac:signed` runs the asar check and then `npm run check:signed`:

```bash
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Walder.app
spctl --assess --type execute --verbose=2 release/mac-arm64/Walder.app
xcrun stapler validate release/mac-arm64/Walder.app
```

All three must pass before the `.dmg` is uploaded. `spctl` saying `accepted`
with `source=Notarized Developer ID` is the line that means the Open Anyway
dance is over for everyone who downloads it.

## Afterwards, and only afterwards

Auto-update. `electron-updater` needs a signed app to install into, and
`scripts/publish-release.ts` currently withholds `latest-mac.yml` from the
upload because nothing reads it. Once one signed release has been verified in
the wild, add `electron-updater` against the release repo and stop excluding
that feed. Until then the update check stays a notice with a link.

## Why the default is still ad-hoc

`identity: null` shipped 0.2.0–0.2.2 as "Walder is damaged" (no Open Anyway
button at all); `"-"` is what fixed it. Both halves of that are pinned in
`test/electron-builder-config.test.ts`, as is the overlay above, so neither can
drift without the suite saying so. The long history is in `electron-builder.yml`.
