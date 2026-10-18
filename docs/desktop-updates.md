# Desktop updates

OpenQuire Desktop checks for signed updates through a dedicated GitHub release. The updater feed is:

```text
https://github.com/akilfernando/openquire/releases/download/desktop-updates/latest.json
```

The `desktop-updates` release is a dedicated desktop feed pointer. After a desktop release has been tested, maintainers manually promote it by replacing the `latest.json` asset on that release with the manifest generated for the tested release. Do not point the desktop updater at GitHub's generic `latest` release: this repository also publishes npm packages, and its generic latest release may not be a tested desktop build.

Tagging a desktop version builds signed updater artifacts on Windows, macOS, and Linux and attaches them to a draft release. Release candidates whose tag contains `-rc.` are marked as prereleases. The build needs the repository Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and, for a password-protected key, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the private key must never be committed or copied into the release. Keep the generated release in draft until the installers and update path have been tested. Publishing a release does not automatically promote the desktop feed.

## Update choices

The default update preference is **Notify me**. OpenQuire checks for a signed update and offers the user the choice to install it. **Automatic** downloads an update in the background and installs it only when all PDFs are closed, no tasks or settings writes are active, and no dialog is open. OpenQuire then restarts. **Manual** disables background update checks; users can check for updates themselves from the app.

All update packages and their advertised versions are verified with the Tauri updater signature before installation. Updater signing is separate from Windows Authenticode or macOS notarization. A failed signature check prevents installation.

App version 0.2.0 is used by the initial test release. The next promoted release, including stable, must have a higher app version (for example 0.2.1). Older installations without this updater need a one-time manual installation.

## Release and promotion checklist

1. Create and push a version tag such as `desktop-v0.2.0` or `desktop-v0.2.0-rc.1`.
2. Wait for the Desktop workflow to attach signed bundles and updater metadata to the draft release. Confirm artifacts for each supported operating system are present.
3. Run candidate CI and independently verify the downloaded release using `node scripts/verify-updater-release.mjs <directory>`. It checks all platform signatures, version binding, and tamper rejection. Record installed-app acceptance separately; a clearly labelled test prerelease may be published for that human testing.
4. Publish the release after it passes testing. To promote an approved desktop release, manually replace `latest.json` on the `desktop-updates` release with the tested version's generated manifest. The initial feed may point to the explicitly published test release; subsequent candidates are not promoted automatically.

The workflow also attaches portable CLI archives to the versioned release. Those archives are not desktop updater packages.
