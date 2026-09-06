#!/usr/bin/env bash
# Build the full release bundle: backend binary, Tauri .app, an ad-hoc
# deep re-sign, and a distributable zip.
#
# Run from the repo root:
#   source .venv/bin/activate
#   ./scripts/package_release.sh
#
# Output: src-tauri/target/release/bundle/macos/Nexam.app and Nexam.zip

set -euo pipefail

cd "$(dirname "$0")/.."

./scripts/build_backend_binary.sh

(cd app/frontend && npm run tauri:build)

APP="src-tauri/target/release/bundle/macos/Nexam.app"

# Tauri's resource copier dereferences symlinks, which breaks the
# versioned Python framework PyInstaller ships inside the backend (see
# the same step in .github/workflows/release-macos.yml). ditto preserves
# them. Harmless locally since this path is ad-hoc signed rather than
# notarized, but it keeps local and CI builds structurally identical --
# and keeps the .app ~10MB smaller.
echo "Restoring backend framework symlinks..."
rm -rf "$APP/Contents/Resources/nexam-backend"
ditto dist/backend/nexam-backend "$APP/Contents/Resources/nexam-backend"

# `tauri build`'s own ad-hoc signing does not produce a valid
# resource-sealed signature once the frozen Python backend is bundled
# under Contents/Resources: `codesign --verify --deep --strict` fails
# with "code has no resources but signature indicates they must be
# present", and a downloaded copy is reported by Gatekeeper as
# "damaged" rather than merely from an unidentified developer. A local,
# un-quarantined copy launches fine regardless, because that stricter
# check only runs on quarantined files -- which is why it never
# reproduces with a same-machine copy.
#
# Sign with the same script CI uses, so this path exercises the real
# signing logic. "-" means ad-hoc: fine for local testing, but ad-hoc
# signatures cannot be notarized, so builds from this script still show
# the unidentified-developer prompt. Releases come from the workflow.
echo "Signing $APP (ad-hoc) ..."
./scripts/sign_macos_app.sh - "$APP"

ZIP_DIR="src-tauri/target/release/bundle/macos"
rm -f "$ZIP_DIR/Nexam.zip"
(cd "$ZIP_DIR" && ditto -c -k --sequesterRsrc --keepParent Nexam.app Nexam.zip)

echo "Wrote $ZIP_DIR/Nexam.zip"
