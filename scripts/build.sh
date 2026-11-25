#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==============================================="
echo "Building Mailspring Offline Translator Plugin"
echo "==============================================="

cd "$PLUGIN_ROOT"

# 1. Compile TypeScript source to lib/ using esbuild
echo "[1/4] Compiling TypeScript source from src/ to lib/..."
npx esbuild $(find src -name '*.ts' -o -name '*.tsx') \
  --outdir=lib \
  --platform=node \
  --target=node24 \
  --format=cjs \
  --jsx=transform

# 2. Verify lib/core/main.js compiled entry point
if [[ ! -f "lib/core/main.js" ]]; then
  echo "Error: lib/core/main.js not found after compilation!" >&2
  exit 1
fi
echo "✓ Verified lib/core/main.js entry point exists."

# 3. Build a universal Apple Translation helper on macOS
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[2/4] macOS detected: Compiling Apple Translation Helper..."
  if command -v swiftc >/dev/null 2>&1 && command -v lipo >/dev/null 2>&1; then
    HELPER_BIN_DIR="helpers/apple/bin"
    BUILD_DIR="$(mktemp -d "${HELPER_BIN_DIR}/.build.XXXXXX")"
    trap 'rm -rf "$BUILD_DIR"' EXIT
    swiftc -target arm64-apple-macosx26.0 -parse-as-library -O \
      helpers/apple/TranslationHelper.swift -o "${BUILD_DIR}/apple-translator-arm64"
    swiftc -target x86_64-apple-macosx26.0 -parse-as-library -O \
      helpers/apple/TranslationHelper.swift -o "${BUILD_DIR}/apple-translator-x86_64"
    lipo -create \
      "${BUILD_DIR}/apple-translator-arm64" \
      "${BUILD_DIR}/apple-translator-x86_64" \
      -output "${BUILD_DIR}/apple-translator-darwin-universal"
    mv "${BUILD_DIR}/apple-translator-darwin-universal" \
      "${HELPER_BIN_DIR}/apple-translator-darwin-universal"
    echo "✓ Universal Apple Translation Helper compiled for macOS 26+."
  else
    echo "Notice: Swift compiler or lipo not found. Using the bundled Apple helper."
  fi
else
  echo "[2/4] Non-macOS platform: Preserving Apple Swift stubs."
fi

# 4. Ensure the Apple helper has executable permissions
echo "[3/4] Ensuring executable permissions on native helpers..."
chmod +x helpers/apple/bin/* 2>/dev/null || true

echo "[4/4] Verifying package integrity..."
node -e 'const pkg = require("./package.json"); if (pkg.main !== "lib/core/main.js") { console.error("package.json main must be lib/core/main.js"); process.exit(1); } console.log("✓ package.json main is verified:", pkg.main);'

echo "================================================================="
echo "✓ Build complete. The plugin is ready to install into ~/.mailspring/packages"
echo "================================================================="
