# Sharing a Nexzam build with testers

This is an early beta build for feedback, not a finished release. It isn't
code-signed yet, so macOS will show a warning the first time it's opened.

## Building a copy to share

```bash
source .venv/bin/activate
./scripts/package_release.sh
```

This builds the backend binary, builds and bundles the Tauri app, re-signs it
(see "Why the re-sign step matters" below), and writes
`src-tauri/target/release/bundle/macos/Nexzam.zip`.

Send testers `Nexzam.zip`.

### Why the re-sign step matters

`tauri build` ad-hoc signs `Nexzam.app` itself, but that signature doesn't
reliably seal all of `Contents/Resources` once the frozen Python backend is
bundled in — `codesign --verify --deep --strict` fails with `code has no
resources but signature indicates they must be present`. A same-machine copy
still launches fine (macOS only runs the strict resource-seal check on files
carrying the `com.apple.quarantine` flag, i.e. ones that were actually
downloaded), which is why this doesn't show up until a tester downloads the
zip from GitHub — where it fails Gatekeeper's assessment and gets reported as
**"Nexzam is damaged and should be moved to the Trash"** instead of the
expected "unidentified developer" prompt. Right-click → Open does not bypass
that error, because it isn't a trust decision, it's a validation failure.

`scripts/package_release.sh` fixes this with a `codesign --force --deep
--sign -` pass after bundling, which regenerates a complete
`_CodeSignature/CodeResources` seal over every bundled file. If you ever build
manually instead of using the script, re-sign before zipping:

```bash
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/Nexzam.app
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/Nexzam.app
```

The second command should print `valid on disk` — if it doesn't, don't ship
that zip.

## Instructions for testers

1. Unzip `Nexzam.zip` and drag `Nexzam.app` to Applications (or run it from
   wherever you unzipped it).
2. On first launch, macOS will say it can't verify the developer. **Right-click**
   (or Control-click) `Nexzam.app` and choose **Open**, then click **Open**
   again in the dialog that appears. This is only needed once.
3. Click **Open Demo Bank** to try it with sample data, or **Open Bank** to
   open a `.bok` file.

This build has no auto-update mechanism yet — a new build has to be sent
manually for now.

## A note on gradebook (.nxgb) files

Grading (printing response sheets, scanning, scoring) uses a second file type, `.nxgb`, separate
from a `.bok` bank on purpose — it holds roster names and scores, which a `.bok` never does. Share
a `.bok` bank with other teachers as described above; **don't** share a `.nxgb` gradebook the same
way, since it contains student data. See `docs/grading.md`.
