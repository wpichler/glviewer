#!/usr/bin/env bash
# Regenerate flatpak/generated-sources.json from package-lock.json.
# Needs flatpak-node-generator (https://github.com/flatpak/flatpak-builder-tools/tree/master/node), e.g.:
#   pipx install "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"
set -euo pipefail
cd "$(dirname "$0")/.."
flatpak-node-generator npm package-lock.json -o flatpak/generated-sources.json
sha256sum package-lock.json | cut -d' ' -f1 > flatpak/generated-sources.lock-sha256
echo "updated flatpak/generated-sources.json"
