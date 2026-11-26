#!/usr/bin/env bash
# Repack an electron-builder AppImage with
#   - the static type2 runtime (no libfuse2 needed on the host),
#   - AppStream metainfo (usr/share/metainfo),
#   - embedded update information + .zsync file (gh-releases-zsync).
#
# usage: scripts/repack-appimage.sh dist/GLViewer-X.Y.Z-linux-x86_64.AppImage x86_64|aarch64
# Needs: python3, curl, unsquashfs (squashfs-tools); zsyncmake (zsync) for the .zsync file.
# The tools are pinned and verified by SHA-256 before use.
set -euo pipefail

in=$(realpath "$1")
arch=$2
here=$(cd "$(dirname "$0")/.." && pwd)
tools=${TOOLS_DIR:-$here/.appimage-tools}

APPIMAGETOOL_URL=https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
APPIMAGETOOL_SHA=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
RUNTIME_BASE=https://github.com/AppImage/type2-runtime/releases/download/20251108
declare -A RUNTIME_SHA=(
  [x86_64]=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
  [aarch64]=00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444
)
[[ -n "${RUNTIME_SHA[$arch]:-}" ]] || { echo "unsupported arch: $arch" >&2; exit 1; }

fetch() { # url file sha256
  if [[ ! -f "$2" ]] || ! echo "$3  $2" | sha256sum -c --quiet - 2>/dev/null; then
    curl -sSfL -o "$2" "$1"
  fi
  echo "$3  $2" | sha256sum -c --quiet -
}
mkdir -p "$tools"
fetch "$APPIMAGETOOL_URL" "$tools/appimagetool" "$APPIMAGETOOL_SHA"
fetch "$RUNTIME_BASE/runtime-$arch" "$tools/runtime-$arch" "${RUNTIME_SHA[$arch]}"
chmod +x "$tools/appimagetool"

# The squashfs image starts right after the ELF runtime (end of the section header table).
offset=$(python3 - "$in" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb') as f:
    h = f.read(64)
assert h[:4] == b'\x7fELF' and h[4] == 2, 'not a 64-bit ELF'
shoff, = struct.unpack_from('<Q', h, 0x28)
shentsize, shnum = struct.unpack_from('<HH', h, 0x3A)
print(shoff + shentsize * shnum)
PY
)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
unsquashfs -q -no-progress -d "$work/AppDir" -o "$offset" "$in" >/dev/null
install -Dm644 "$here/flatpak/io.github.wpichler.GLViewer.metainfo.xml" \
  "$work/AppDir/usr/share/metainfo/io.github.wpichler.GLViewer.appdata.xml"

name=$(basename "$in")
# GLViewer-0.1.2-linux-x86_64.AppImage -> GLViewer-*-linux-x86_64.AppImage
pattern=$(sed -E 's/-[0-9]+\.[0-9]+\.[0-9]+([-.][^-]+)?-linux-/-*-linux-/' <<<"$name")
updinfo="gh-releases-zsync|wpichler|glviewer|latest|$pattern.zsync"

out="$work/out"
mkdir -p "$out"
(cd "$out" && ARCH=$arch APPIMAGE_EXTRACT_AND_RUN=1 "$tools/appimagetool" --no-appstream \
  --runtime-file "$tools/runtime-$arch" -u "$updinfo" "$work/AppDir" "$name" >/dev/null)
mv -f "$out/$name" "$in"
if [[ -f "$out/$name.zsync" ]]; then
  mv -f "$out/$name.zsync" "$in.zsync"
else
  echo "warning: no .zsync generated (install zsyncmake)" >&2
fi
echo "repacked $name (update info: $updinfo)"
