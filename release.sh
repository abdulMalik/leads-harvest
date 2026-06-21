#!/usr/bin/env bash
#
# release.sh — build the extension zip, tag the commit, and publish a
# GitHub release with the zip attached.
#
# Usage:
#   ./release.sh            # version is read from manifest.json
#   ./release.sh "notes..." # optional release-notes text (overrides default)
#
# Prerequisites:
#   - Commit your changes first (bump "version" in manifest.json, then commit).
#   - A GitHub token cached in ~/.git-credentials (created on your first push).
#   - python3, curl, zip on PATH.

set -euo pipefail
cd "$(dirname "$0")"

# Files that ship in the extension. Add new runtime files here.
FILES=(
  manifest.json
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

# --- Derive version, repo, tag, zip name -----------------------------------
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
TAG="v${VERSION}"
ZIP="leads-harvest-${TAG}.zip"

REMOTE_URL=$(git remote get-url origin)
# Accept https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
REPO=$(python3 -c "import re,sys;u='$REMOTE_URL';m=re.search(r'github\.com[/:]([^/]+/[^/]+?)(?:\.git)?$',u);print(m.group(1))")

echo "Releasing $REPO @ $TAG"

# --- Sanity checks ----------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARNING: you have uncommitted changes — they won't be in this release."
  read -r -p "Continue anyway? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted."; exit 1; }
fi

TOKEN=$(python3 -c "import re,os;d=open(os.path.expanduser('~/.git-credentials')).read();m=re.search(r'https://[^:]+:([^@]+)@github.com',d);print(m.group(1))")
[[ -n "$TOKEN" ]] || { echo "ERROR: no GitHub token in ~/.git-credentials. Push once to cache it."; exit 1; }

# --- Build the zip ----------------------------------------------------------
echo "Building $ZIP ..."
rm -f "$ZIP"
zip -q "$ZIP" "${FILES[@]}"
echo "  $(unzip -l "$ZIP" | tail -1 | awk '{print $2}') files, $(du -h "$ZIP" | cut -f1)"

# --- Tag and push -----------------------------------------------------------
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally — reusing it."
else
  git tag -a "$TAG" -m "Leads Harvest $TAG"
fi
git push origin "$TAG"

# --- Release notes ----------------------------------------------------------
NOTES="${1:-}"
if [[ -z "$NOTES" ]]; then
  NOTES=$(cat <<EOF
## Leads Harvest $TAG

### Install (Chrome / Edge / Brave)
1. Download **\`$ZIP\`** below.
2. Unzip it to a folder you'll keep.
3. Open \`chrome://extensions\`, turn on **Developer mode**, click **Load unpacked**, and select the folder.

Full instructions: see the [README](https://github.com/$REPO#install-chrome--edge--brave).
EOF
)
fi

# --- Create the release -----------------------------------------------------
echo "Creating GitHub release ..."
PAYLOAD=$(NOTES="$NOTES" TAG="$TAG" python3 -c "import json,os;print(json.dumps({'tag_name':os.environ['TAG'],'name':'Leads Harvest '+os.environ['TAG'],'body':os.environ['NOTES'],'draft':False,'prerelease':False}))")

RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "$PAYLOAD")

RELEASE_ID=$(echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or '')")
if [[ -z "$RELEASE_ID" ]]; then
  echo "ERROR creating release:"
  echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(' ',d.get('message'));print(' ',d.get('errors'))"
  echo "(If a release for $TAG already exists, delete it on GitHub or bump the version.)"
  exit 1
fi

# --- Upload the zip asset ---------------------------------------------------
echo "Uploading $ZIP ..."
ASSET=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/zip" \
  --data-binary @"$ZIP" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$ZIP")

echo "$ASSET" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  state:',d.get('state'));print('  download:',d.get('browser_download_url') or d.get('message'))"

echo "Done: https://github.com/$REPO/releases/tag/$TAG"
