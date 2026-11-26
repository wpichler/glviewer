// Minimal OpenSSH client config and known_hosts support.

import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import type { HostProfile } from '@shared/types'

export const sshDir = (): string => join(homedir(), '.ssh')

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function globFiles(pattern: string): string[] {
  const p = resolve(sshDir(), expandHome(pattern))
  if (!p.includes('*')) return existsSync(p) ? [p] : []
  const dir = dirname(p)
  const re = new RegExp('^' + basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

interface RawHost {
  patterns: string[]
  opts: Record<string, string>
}

function parseConfigFile(file: string, out: RawHost[], depth = 0): void {
  if (depth > 5) return
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  let cur: RawHost | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].replace(/^"(.*)"$/, '$1')
    if (key === 'include') {
      for (const pat of val.split(/\s+/)) for (const f of globFiles(pat)) parseConfigFile(f, out, depth + 1)
      continue
    }
    if (key === 'host') {
      cur = { patterns: val.split(/\s+/), opts: {} }
      out.push(cur)
      continue
    }
    if (key === 'match') {
      cur = null // not supported
      continue
    }
    if (cur && !(key in cur.opts)) cur.opts[key] = val
  }
}

/** Hosts defined in ~/.ssh/config (wildcard-only entries are skipped). */
export function readSshConfigHosts(): HostProfile[] {
  const file = join(sshDir(), 'config')
  if (!existsSync(file)) return []
  const raws: RawHost[] = []
  parseConfigFile(file, raws)
  // global defaults from "Host *"
  const wild = raws.filter((r) => r.patterns.includes('*'))
  const res: HostProfile[] = []
  const seen = new Set<string>()
  for (const r of raws) {
    for (const pat of r.patterns) {
      if (/[*?!]/.test(pat) || seen.has(pat)) continue
      seen.add(pat)
      const get = (k: string): string | undefined => r.opts[k] ?? wild.find((w) => w.opts[k])?.opts[k]
      res.push({
        id: 'cfg:' + pat,
        name: pat,
        host: get('hostname') ?? pat,
        port: Number(get('port') ?? 22),
        username: get('user') ?? process.env.USER ?? process.env.USERNAME ?? 'root',
        identityFile: get('identityfile') ? expandHome(get('identityfile')!) : undefined,
        origin: 'ssh-config'
      })
    }
  }
  return res
}

// ---- known_hosts ----------------------------------------------------------

export function keyTypeOf(blob: Buffer): string {
  try {
    const len = blob.readUInt32BE(0)
    return blob.subarray(4, 4 + len).toString('ascii')
  } catch {
    return 'unknown'
  }
}

export function fingerprint(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

function hostEntry(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function matchPattern(pattern: string, name: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|')
    if (!salt || !hash) return false
    const h = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64')
    return h === hash
  }
  if (pattern.includes('*') || pattern.includes('?')) {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    return re.test(name)
  }
  return pattern.toLowerCase() === name.toLowerCase()
}

export type HostKeyStatus = 'match' | 'mismatch' | 'unknown'

export function checkKnownHosts(files: string[], host: string, port: number, blob: Buffer): HostKeyStatus {
  const name = hostEntry(host, port)
  const b64 = blob.toString('base64')
  const type = keyTypeOf(blob)
  let sawOtherKeySameType = false
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const parts = line.split(/\s+/)
      let marker: string | null = null
      if (parts[0].startsWith('@')) marker = parts.shift()!
      if (parts.length < 3) continue
      const [hosts, ktype, key] = parts
      const pats = hosts.split(',')
      let hit = false
      let negated = false
      for (const p of pats) {
        if (p.startsWith('!')) {
          if (matchPattern(p.slice(1), name)) negated = true
        } else if (matchPattern(p, name)) hit = true
      }
      if (!hit || negated) continue
      if (marker === '@revoked' && key === b64) return 'mismatch'
      if (marker) continue
      if (key === b64) return 'match'
      if (ktype === type) sawOtherKeySameType = true
    }
  }
  return sawOtherKeySameType ? 'mismatch' : 'unknown'
}

export function appendKnownHost(file: string, host: string, port: number, blob: Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${hostEntry(host, port)} ${keyTypeOf(blob)} ${blob.toString('base64')}\n`, { mode: 0o600 })
}

export function defaultIdentityFiles(): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_ed25519_sk', 'id_ecdsa_sk'].map((f) => join(sshDir(), f)).filter((f) => existsSync(f))
}
