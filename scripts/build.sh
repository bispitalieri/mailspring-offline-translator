#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==============================================="
echo "Building Mailspring Offline Translator Plugin"
echo "==============================================="

cd "$PLUGIN_ROOT"

# 1. Compile TypeScript source to lib/
echo "[1/4] Compiling TypeScript source from src/ to lib/..."
npx tsc --project tsconfig.json

# 2. Verify lib/main.js compiled entry point
if [[ ! -f "lib/main.js" ]]; then
  echo "Error: lib/main.js not found after compilation!" >&2
  exit 1
fi
echo "✓ Verified lib/main.js entry point exists."

# 3. Build Apple Native Helper on macOS if swiftc is present
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[2/4] macOS detected: Compiling Apple Translation Helper..."
  if command -v swiftc >/dev/null 2>&1; then
    mkdir -p helpers/apple/bin
    swiftc -O -target arm64-apple-macos15.0 helpers/apple/TranslationHelper.swift -o helpers/apple/bin/apple-translator-darwin-arm64 || \
    swiftc -O helpers/apple/TranslationHelper.swift -o helpers/apple/bin/apple-translator-darwin-universal || \
    echo "Notice: Swift compiler on this machine does not target macOS 15+ SDK. Using universal stub."
  else
    echo "Notice: swiftc not found. Using precompiled Apple helper stub."
  fi
else
  echo "[2/4] Non-macOS platform: Preserving Apple Swift stubs."
fi

# 4. Ensure the Apple helper has executable permissions
echo "[3/4] Ensuring executable permissions on native helpers..."
chmod +x helpers/apple/bin/* 2>/dev/null || true

echo "[4/4] Verifying package integrity..."
node -e 'const pkg = require("./package.json"); if (pkg.main !== "lib/main.js") { console.error("package.json main must be lib/main.js"); process.exit(1); } console.log("✓ package.json main is verified:", pkg.main);'

echo "================================================================="
echo "✓ Build complete. The plugin is ready to install into ~/.mailspring/packages"
echo "================================================================="
