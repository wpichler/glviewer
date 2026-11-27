# AUR package: glviewer-bin

`glviewer-bin/` installs the prebuilt release (`GLViewer-X.Y.Z-linux-{x64,arm64}.tar.gz`)
to `/opt/glviewer` with a `/usr/bin/glviewer` link, desktop file, icon and licenses.
The CI workflow `.github/workflows/aur.yml` builds it with `makepkg` in an Arch Linux
container, runs `namcap` and checks that `.SRCINFO` is up to date.

## After a release

```sh
scripts/update-aur.sh 0.1.3     # version, checksums and .SRCINFO
```

## Publishing (done by the maintainer)

Before the first upload, read the current
[AUR submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines)
and check that the name `glviewer-bin` is still free. The package files were
written with the help of an AI agent; check whether the guidelines say anything
about that.

```sh
# once: AUR account with your SSH public key (https://aur.archlinux.org/account)
git clone ssh://aur@aur.archlinux.org/glviewer-bin.git aur-glviewer-bin
cp packaging/aur/glviewer-bin/{PKGBUILD,.SRCINFO} aur-glviewer-bin/
cd aur-glviewer-bin
git add PKGBUILD .SRCINFO
git commit -m "Update to 0.1.3"
git push
```
