#!/usr/bin/env bash
# Update packaging/aur/glviewer-bin (PKGBUILD + .SRCINFO) to a published release.
# usage: scripts/update-aur.sh 0.1.3
set -euo pipefail
ver=${1:?usage: $0 VERSION}
cd "$(dirname "$0")/../packaging/aur/glviewer-bin"
base=https://github.com/wpichler/glviewer
raw=https://raw.githubusercontent.com/wpichler/glviewer/v$ver
sum() { curl -sSfL "$1" | sha256sum | cut -d' ' -f1; }
desktop=$(sum "$raw/resources/glviewer.desktop")
icon=$(sum "$raw/resources/icon.png")
lic=$(sum "$raw/LICENSE")
x64=$(sum "$base/releases/download/v$ver/GLViewer-$ver-linux-x64.tar.gz")
arm=$(sum "$base/releases/download/v$ver/GLViewer-$ver-linux-arm64.tar.gz")
old=$(sed -n 's/^pkgver=//p' PKGBUILD)
python3 - "$old" "$ver" "$desktop" "$icon" "$lic" "$x64" "$arm" <<'PY'
import re, sys
old, ver, desktop, icon, lic, x64, arm = sys.argv[1:]
for f in ('PKGBUILD', '.SRCINFO'):
    s = open(f).read()
    s = s.replace(old, ver)
    s = re.sub(r'^pkgrel=\d+', 'pkgrel=1', s, flags=re.M)
    s = re.sub(r'(\tpkgrel = )\d+', r'\g<1>1', s)
    # checksums in source order: desktop, icon, license; then per architecture
    if f == 'PKGBUILD':
        s = re.sub(r"sha256sums=\('[0-9a-f]+'\n\s+'[0-9a-f]+'\n\s+'[0-9a-f]+'\)",
                   f"sha256sums=('{desktop}'\n            '{icon}'\n            '{lic}')", s)
        s = re.sub(r"sha256sums_x86_64=\('[0-9a-f]+'\)", f"sha256sums_x86_64=('{x64}')", s)
        s = re.sub(r"sha256sums_aarch64=\('[0-9a-f]+'\)", f"sha256sums_aarch64=('{arm}')", s)
    else:
        sums = iter([desktop, icon, lic])
        s = re.sub(r'(\tsha256sums = )[0-9a-f]+', lambda m: m.group(1) + next(sums), s)
        s = re.sub(r'(\tsha256sums_x86_64 = )[0-9a-f]+', r'\g<1>' + x64, s)
        s = re.sub(r'(\tsha256sums_aarch64 = )[0-9a-f]+', r'\g<1>' + arm, s)
    open(f, 'w').write(s)
PY
echo "glviewer-bin updated to $ver"
