#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$PLUGIN_ROOT"

PACKAGE_NAME="mailspring-offline-translator"
VERSION="1.0.0"
DIST_DIR="dist-package"

echo "=========================================================="
echo "Creating release distribution for ${PACKAGE_NAME} v${VERSION}"
echo "=========================================================="

# 1. Run build script to ensure freshly compiled lib/
bash scripts/build.sh

# 2. Prepare staging directory
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/${PACKAGE_NAME}"

# 3. Copy plugin payload (package.json, lib/, src/, helpers/, scripts/, docs)
STAGED_PLUGIN="${DIST_DIR}/${PACKAGE_NAME}"
cp -r package.json tsconfig.json lib src helpers scripts styles README.md ARCHITECTURE.md FEASIBILITY.md "$STAGED_PLUGIN/"

# Mailspring does not install plugin npm dependencies when loading a release archive.
npm install --prefix "$STAGED_PLUGIN" --omit=dev --no-audit --no-fund

# 4. Verify compiled entry point in staging
if [[ ! -f "${DIST_DIR}/${PACKAGE_NAME}/lib/main.js" ]]; then
  echo "Error: lib/main.js is missing from staging package!" >&2
  exit 1
fi
if [[ ! -f "${DIST_DIR}/${PACKAGE_NAME}/node_modules/ctranslate2/index.js" ]]; then
  echo "Error: the native CTranslate2 runtime is missing from the staged plugin!" >&2
  exit 1
fi

# 5. Create release archives
cd "${DIST_DIR}"
tar -czf "${PACKAGE_NAME}-v${VERSION}.tar.gz" "${PACKAGE_NAME}"
if command -v zip >/dev/null 2>&1; then
  zip -rq "${PACKAGE_NAME}-v${VERSION}.zip" "${PACKAGE_NAME}"
  echo "✓ Release archives generated: .tar.gz and .zip"
else
  echo "✓ Release archive generated: .tar.gz (zip binary not installed on host)"
fi
cd ..

echo "✓ Packaging complete in ${DIST_DIR}/"
