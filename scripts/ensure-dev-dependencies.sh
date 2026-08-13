#!/usr/bin/env bash
set -Eeuo pipefail

if [ ! -f node_modules/@types/node/package.json ] || [ ! -f node_modules/vitest/package.json ]; then
  echo "Development dependencies are incomplete; restoring them from package-lock.json."
  npm ci --include=dev
else
  echo "Development dependencies are present."
fi

