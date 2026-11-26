import { existsSync, readFileSync } from 'node:fs'

/** True when running inside a Flatpak sandbox. */
export const inFlatpak = process.platform === 'linux' && existsSync('/.flatpak-info')

/**
 * Whether the sandbox may run commands on the host via flatpak-spawn. The
 * Flatpak does not request this; a user can grant it (e.g. with Flatseal) by
 * allowing talk access to org.freedesktop.Flatpak.
 */
export const canSpawnOnHost: boolean = (() => {
  if (!inFlatpak) return true
  try {
    return /^org\.freedesktop\.Flatpak=talk/m.test(readFileSync('/.flatpak-info', 'utf8'))
  } catch {
    return false
  }
})()

/** journalctl bundled with the Flatpak (reads /var/log/journal inside the sandbox). */
const bundledJournalctl = inFlatpak && existsSync('/app/bin/journalctl')

/** Whether "as administrator" (pkexec) can be offered for local files and the journal. */
export const canElevate = process.platform === 'linux' && canSpawnOnHost

/**
 * Map a local command to how it has to be started.
 * - Outside Flatpak: unchanged.
 * - journalctl in Flatpak: the bundled one, inside the sandbox.
 * - pkexec in Flatpak: on the host, only if the user granted host access.
 */
export function hostCommand(argv: string[]): string[] {
  if (!inFlatpak) return argv
  if (argv[0] === 'pkexec') {
    if (!canSpawnOnHost) {
      throw Object.assign(
        new Error(
          'Administrator access is not available in the Flatpak version. ' +
            'Allow GLViewer to talk to org.freedesktop.Flatpak (e.g. with Flatseal), or use the AppImage / distribution package.'
        ),
        { code: 'EUNSUPPORTED' }
      )
    }
    return ['flatpak-spawn', '--host', ...argv]
  }
  if (argv[0] === 'journalctl' && !bundledJournalctl && canSpawnOnHost) return ['flatpak-spawn', '--host', ...argv]
  return argv
}
