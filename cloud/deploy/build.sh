#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Nest stays in its own repository. Fetch a fixed revision only while building.
nest_revision=083453ea3359022ac9a528151296e699a5fcb5f2
if [ ! -d .nest/.git ]; then
  git init .nest
  git -C .nest remote add origin https://github.com/keithkml/nest-logger.git
fi
git -C .nest fetch --depth 1 origin "$nest_revision"
git -C .nest checkout --detach FETCH_HEAD
test "$(git -C .nest rev-parse HEAD)" = "$nest_revision"

# Keep Nest on the runtime it used before this migration.
version=14.17.0
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
mkdir -p .nest-runtime
tar -xJf "$staging/$archive" --strip-components=1 -C .nest-runtime
PATH="$PWD/.nest-runtime/bin:$PATH" npm --prefix .nest ci --no-audit --no-fund

bash install-runtime.sh
