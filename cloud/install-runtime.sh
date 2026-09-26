#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
version=22.22.3
case "$(uname -m)" in
  x86_64) architecture=x64 ;;
  aarch64) architecture=arm64 ;;
  *) echo 'Unsupported Render architecture' >&2; exit 1 ;;
esac
archive="node-v${version}-linux-${architecture}.tar.xz"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
curl --fail --silent --show-error --retry 3 "https://nodejs.org/dist/v${version}/${archive}" -o "$staging/$archive"
curl --fail --silent --show-error --retry 3 "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "$staging/SHASUMS256.txt"
(cd "$staging"; awk -v name="$archive" '$2 == name' SHASUMS256.txt > expected.sha256; test -s expected.sha256; sha256sum --check expected.sha256)
mkdir -p .runtime
tar -xJf "$staging/$archive" --strip-components=1 -C .runtime
PATH="$PWD/.runtime/bin:$PATH" npm ci --no-audit --no-fund
PATH="$PWD/.runtime/bin:$PATH" npm test
