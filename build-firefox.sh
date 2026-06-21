#!/usr/bin/env bash
#
# build-firefox.sh — produce a Firefox-compatible build of the extension from
# the same source as the Chrome build.
#
# It generates a Firefox manifest (event-page background + gecko add-on id)
# from the Chrome manifest.json, stages the runtime files with it, and zips
# the result as leads-harvest-firefox-vX.Y.Z.zip.
#
# That zip is what you upload to addons.mozilla.org (AMO) to get a signed,
# one-click-installable, auto-updating .xpi. (Unsigned zips can't be installed
# in release Firefox; for local testing use about:debugging > Load Temporary
# Add-on and pick the manifest.json inside dist/firefox/.)
#
# Usage:  ./build-firefox.sh
# Needs:  python3, zip

set -euo pipefail
cd "$(dirname "$0")"

# Firefox add-on id (used for signing + updates). Keep this stable across releases.
GECKO_ID="leads-harvest@digitaiz.com"
GECKO_MIN_VERSION="115.0"

# Runtime files that ship in the extension (same set as the Chrome build).
FILES=(
  background.js
  content.js
  popup.html
  popup.js
  social_classifier.js
  styles.css
  leads-harvest-16.png
  leads-harvest-48.png
  leads-harvest-128.png
)

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
ZIP="leads-harvest-firefox-v${VERSION}.zip"
STAGE="dist/firefox"

echo "Building Firefox v${VERSION}"

# --- Stage files ------------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "${FILES[@]}" "$STAGE/"

# --- Generate the Firefox manifest from the Chrome manifest -----------------
GECKO_ID="$GECKO_ID" GECKO_MIN_VERSION="$GECKO_MIN_VERSION" python3 - "$STAGE/manifest.json" <<'PY'
import json, os, sys

m = json.load(open("manifest.json"))

# Firefox MV3 uses an event-page background (scripts), not a service worker.
# social_classifier.js must be listed first so its globals exist before
# background.js runs (Chrome handles this via importScripts at runtime).
m["background"] = {"scripts": ["social_classifier.js", "background.js"]}

# Firefox requires an explicit add-on id for signing and updates.
m["browser_specific_settings"] = {
    "gecko": {
        "id": os.environ["GECKO_ID"],
        "strict_min_version": os.environ["GECKO_MIN_VERSION"],
    }
}

with open(sys.argv[1], "w") as f:
    json.dump(m, f, indent=2)
print("  manifest: event-page background + gecko id", os.environ["GECKO_ID"])
PY

# --- Zip --------------------------------------------------------------------
rm -f "$ZIP"
( cd "$STAGE" && zip -q -r "../../$ZIP" . )
echo "  wrote $ZIP ($(du -h "$ZIP" | cut -f1))"
echo
echo "Next steps:"
echo "  • Test locally: Firefox > about:debugging > This Firefox > Load Temporary Add-on > pick $STAGE/manifest.json"
echo "  • Publish: upload $ZIP at https://addons.mozilla.org/developers/ to get a signed .xpi"
