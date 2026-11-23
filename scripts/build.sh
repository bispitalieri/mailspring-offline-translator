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
  --jsx=react

# 2. Verify lib/core/main.js compiled entry point
if [[ ! -f "lib/core/main.js" ]]; then
  echo "Error: lib/core/main.js not found after compilation!" >&2
  exit 1
fi
echo "✓ Verified lib/core/main.js entry point exists."

# 3. Build Apple Native Helper on macOS if swiftc is present
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[2/4] macOS detected: Compiling Apple Translation Helper..."
  if command -v swiftc >/dev/null 2>&1; then
    mkdir -p helpers/apple/bin
    swiftc -parse-as-library -O helpers/apple/TranslationHelper.swift -o helpers/apple/bin/apple-translator-darwin-universal && \
    echo "✓ Apple Translation Helper compiled successfully." || \
    echo "Warning: Failed to compile Apple Translation Helper. Using existing binary or stub."
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
node -e 'const pkg = require("./package.json"); if (pkg.main !== "lib/core/main.js") { console.error("package.json main must be lib/core/main.js"); process.exit(1); } console.log("✓ package.json main is verified:", pkg.main);'

echo "================================================================="
echo "✓ Build complete. The plugin is ready to install into ~/.mailspring/packages"
echo "================================================================="
