#!/usr/bin/env bash
# Sign Nexam.app, including the PyInstaller-frozen Python backend nested
# in Contents/Resources.
#
#   ./scripts/sign_macos_app.sh <identity> <path/to/Nexam.app>
#
# Pass "-" as the identity for an ad-hoc signature (local testing only --
# ad-hoc signatures cannot be notarized).
#
# Order matters: code signing seals the *contents* of a bundle, so nested
# code has to be signed before whatever encloses it. Signing the outer
# bundle first and the nested code afterwards silently invalidates the
# outer seal.

set -euo pipefail

IDENTITY="${1:?usage: sign_macos_app.sh <identity> <app-path>}"
APP="${2:?usage: sign_macos_app.sh <identity> <app-path>}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$REPO_ROOT/src-tauri/entitlements.plist"
RESOURCES="$APP/Contents/Resources"

# Fail with something readable rather than a bare `find: ... No such
# file or directory`. Quoting the path in the message makes stray
# leading/trailing whitespace visible, which is otherwise invisible in
# CI logs.
if [ ! -d "$APP" ]; then
  echo "error: app bundle not found at '$APP'" >&2
  exit 1
fi
if [ ! -d "$RESOURCES" ]; then
  echo "error: '$APP' has no Contents/Resources -- is it a real .app bundle?" >&2
  exit 1
fi
if [ ! -f "$ENTITLEMENTS" ]; then
  echo "error: entitlements not found at '$ENTITLEMENTS'" >&2
  exit 1
fi

sign() { codesign --force --timestamp --options runtime "$@"; }

# 1. Frameworks, signed as bundles.
#
# A framework keeps its seal in Versions/<v>/_CodeSignature/CodeResources.
# The Python framework PyInstaller bundles arrives already signed, so
# re-signing the inner Mach-O directly leaves that seal describing a
# binary that no longer matches. Local `codesign --verify` accepts the
# result, but notarization rejects it with "The signature of the binary
# is invalid". Sign the version directory so the seal is regenerated.
find "$RESOURCES" -type d -name '*.framework' -print0 |
  while IFS= read -r -d '' framework; do
    for version in "$framework"/Versions/*; do
      [ -d "$version" ] || continue
      [ "$(basename "$version")" = "Current" ] && continue
      echo "  framework: ${version#"$APP/"}"
      sign --sign "$IDENTITY" "$version"
    done
  done

# 2. Loose Mach-O files outside any framework (.so, .dylib, helper execs).
find "$RESOURCES" -type f -not -path '*.framework/*' -print0 |
  while IFS= read -r -d '' file_path; do
    if file -b "$file_path" | grep -q 'Mach-O'; then
      sign --sign "$IDENTITY" "$file_path"
    fi
  done

# 3. The backend entry point.
#
# Entitlements belong on the executable that loads the libraries, not on
# the libraries themselves -- disable-library-validation is what lets this
# process load the .so files signed above.
sign --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" \
  "$RESOURCES/nexam-backend/nexam-backend"

# 4. The app bundle itself, last, now that everything inside it is sealed.
sign --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"

echo "Verifying..."
codesign --verify --deep --strict --verbose=2 "$APP"
echo "Signed: $APP"
