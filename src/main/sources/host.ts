import { existsSync } from 'node:fs'

/** True when running inside a Flatpak sandbox. */
export const inFlatpak = process.platform === 'linux' && existsSync('/.flatpak-info')

/**
 * Commands like journalctl and pkexec live on the host system. Inside a
 * Flatpak sandbox they are run on the host via flatpak-spawn (requires
 * --talk-name=org.freedesktop.Flatpak).
 */
export function hostCommand(argv: string[]): string[] {
  return inFlatpak ? ['flatpak-spawn', '--host', ...argv] : argv
}
