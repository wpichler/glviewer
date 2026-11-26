// SSH connection management: authentication, host key verification, remote
// command execution (with optional sudo), SFTP directory listing.

import { Client, utils, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import type { HostProfile, HostStatus, PromptRequest, PromptReply, RemoteEntry } from '@shared/types'
import { appendKnownHost, checkKnownHosts, defaultIdentityFiles, fingerprint, keyTypeOf, sshDir } from './sshconfig'
import { shq, type Runner } from './journal'

export type Prompter = (req: Omit<PromptRequest, 'reqId'>) => Promise<PromptReply>

interface Conn {
  profile: HostProfile
  client: Client
  status: HostStatus
  sftp?: SFTPWrapper
  uid?: number
  gids?: number[]
  loginPassword?: string
  sudoPassword?: string
  sudoNoPassword?: boolean
}

export class SshManager {
  private conns = new Map<string, Conn>()

  constructor(
    private appKnownHosts: string,
    private prompt: Prompter,
    private onStatus: (s: HostStatus) => void
  ) {}

  status(id: string): HostStatus {
    return this.conns.get(id)?.status ?? { id, state: 'disconnected' }
  }

  allStatus(): HostStatus[] {
    return [...this.conns.values()].map((c) => c.status)
  }

  private setStatus(c: Conn, s: Partial<HostStatus>): void {
    c.status = { ...c.status, ...s }
    this.onStatus(c.status)
  }

  disconnect(id: string): void {
    const c = this.conns.get(id)
    if (!c) return
    c.client.end()
    this.conns.delete(id)
    this.onStatus({ id, state: 'disconnected' })
  }

  disconnectAll(): void {
    for (const id of [...this.conns.keys()]) this.disconnect(id)
  }

  private get(id: string): Conn {
    const c = this.conns.get(id)
    if (!c || c.status.state !== 'connected') throw Object.assign(new Error('Not connected'), { code: 'ENOTCONN' })
    return c
  }

  async connect(profile: HostProfile): Promise<HostStatus> {
    const existing = this.conns.get(profile.id)
    if (existing && existing.status.state === 'connected') return existing.status
    if (existing) existing.client.end()

    const client = new Client()
    const conn: Conn = { profile, client, status: { id: profile.id, state: 'connecting' } }
    this.conns.set(profile.id, conn)
    this.onStatus(conn.status)

    const knownFiles = [join(sshDir(), 'known_hosts'), join(sshDir(), 'known_hosts2'), this.appKnownHosts]

    const hostVerifier = (key: Buffer, verify: (ok: boolean) => void): void => {
      const st = checkKnownHosts(knownFiles, profile.host, profile.port, key)
      if (st === 'match') return verify(true)
      if (st === 'mismatch') {
        conn.status.error =
          `HOST KEY MISMATCH for ${profile.host}! The server presented ${keyTypeOf(key)} ${fingerprint(key)}, ` +
          'which differs from the key in your known_hosts. This could be a man-in-the-middle attack. ' +
          'If the host was legitimately reinstalled, remove the old key (ssh-keygen -R host) and try again.'
        return verify(false)
      }
      this.prompt({
        kind: 'hostkey',
        title: 'Unknown host key',
        message: `The authenticity of host "${profile.host}" (port ${profile.port}) can't be established. Verify the fingerprint with the server administrator before trusting it.`,
        fingerprint: fingerprint(key),
        keyType: keyTypeOf(key)
      }).then(
        (r) => {
          if (r.ok && r.remember) {
            try {
              appendKnownHost(this.appKnownHosts, profile.host, profile.port, key)
            } catch {
              /* ignore */
            }
          }
          if (!r.ok) conn.status.error = 'Host key rejected'
          verify(r.ok)
        },
        () => verify(false)
      )
    }

    // Build the list of authentication attempts lazily.
    const user = profile.username
    const keyFiles = [...(profile.identityFile ? [profile.identityFile] : []), ...defaultIdentityFiles()].filter(
      (f, i, a) => a.indexOf(f) === i && existsSync(f)
    )
    const agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK
    type Step = 'agent' | { key: string } | 'keyboard-interactive' | 'password'
    const steps: Step[] = []
    if (agent) steps.push('agent')
    for (const k of keyFiles) steps.push({ key: k })
    steps.push('keyboard-interactive', 'password')

    const authHandler = (methodsLeft: string[] | null, _partial: boolean | null, next: (m: unknown) => void): void => {
      const allowed = (m: string): boolean => !methodsLeft || methodsLeft.includes(m)
      const tryNext = (): void => {
        const s = steps.shift()
        if (!s) return next(false)
        if (s === 'agent') {
          if (!allowed('publickey')) return tryNext()
          return next({ type: 'agent', username: user, agent })
        }
        if (s === 'keyboard-interactive') {
          if (!allowed('keyboard-interactive')) return tryNext()
          return next({
            type: 'keyboard-interactive',
            username: user,
            prompt: (_name: string, instructions: string, _lang: string, prompts: { prompt: string; echo: boolean }[], finish: (r: string[]) => void) => {
              if (prompts.length === 0) return finish([])
              this.prompt({
                kind: 'keyboard',
                title: `Login to ${profile.name}`,
                message: instructions || `${user}@${profile.host}`,
                prompts
              }).then(
                (r) => {
                  const vals = r.ok ? (r.values ?? []) : prompts.map(() => '')
                  if (prompts.length === 1 && /password/i.test(prompts[0].prompt)) conn.loginPassword = vals[0]
                  finish(vals)
                },
                () => finish(prompts.map(() => ''))
              )
            }
          })
        }
        if (s === 'password') {
          if (!allowed('password')) return tryNext()
          this.prompt({ kind: 'password', title: `Password for ${user}@${profile.host}`, message: '' }).then((r) => {
            if (!r.ok) return next(false)
            conn.loginPassword = r.values?.[0] ?? ''
            next({ type: 'password', username: user, password: conn.loginPassword })
          }, () => next(false))
          return
        }
        // private key file
        if (!allowed('publickey')) return tryNext()
        let data: Buffer
        try {
          data = readFileSync(s.key)
        } catch {
          return tryNext()
        }
        const parsed = utils.parseKey(data)
        if (!(parsed instanceof Error)) return next({ type: 'publickey', username: user, key: data })
        if (!/passphrase|encrypted/i.test(parsed.message)) return tryNext()
        this.prompt({ kind: 'passphrase', title: 'Unlock private key', message: `Passphrase for ${s.key}` }).then((r) => {
          if (!r.ok) return tryNext()
          const pp = r.values?.[0] ?? ''
          const k = utils.parseKey(data, pp)
          if (k instanceof Error) return tryNext()
          next({ type: 'publickey', username: user, key: data, passphrase: pp })
        }, () => tryNext())
      }
      tryNext()
    }

    const cfg: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: user,
      readyTimeout: 30000,
      keepaliveInterval: 15000,
      hostVerifier: hostVerifier as unknown as ConnectConfig['hostVerifier'],
      authHandler: authHandler as unknown as ConnectConfig['authHandler'],
      tryKeyboard: true,
      algorithms: { compress: ['zlib@openssh.com', 'zlib', 'none'] } as ConnectConfig['algorithms']
    }

    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve())
      client.once('error', (e) => reject(e))
      client.connect(cfg)
    }).catch((e: Error) => {
      const msg = conn.status.error ?? (/All configured authentication methods failed/.test(e.message) ? 'Authentication failed' : e.message)
      this.setStatus(conn, { state: 'error', error: msg })
      this.conns.delete(profile.id)
      client.end()
      throw Object.assign(new Error(msg), { code: 'ESSH' })
    })

    client.on('close', () => {
      if (this.conns.get(profile.id) === conn) {
        this.conns.delete(profile.id)
        this.onStatus({ id: profile.id, state: 'disconnected' })
      }
    })
    client.on('error', () => {
      /* handled via close */
    })

    conn.status = { id: profile.id, state: 'connected' }
    // gather some facts about the remote system
    try {
      const facts = await this.execText(
        conn,
        'id -u; id -G; hostname; (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime) | head -n1'
      )
      const [uid, gids, hostname, tz] = facts.split('\n')
      conn.uid = Number(uid)
      conn.gids = (gids ?? '').split(/\s+/).filter(Boolean).map(Number)
      conn.status.remoteHostname = hostname?.trim()
      const zone = (tz ?? '').trim().replace(/^.*zoneinfo\//, '')
      if (zone) conn.status.remoteTz = zone
    } catch {
      /* not fatal */
    }
    this.onStatus(conn.status)
    return conn.status
  }

  // ---- command execution ---------------------------------------------------

  /**
   * Execute a POSIX shell command. The user's login shell may be anything
   * (fish, csh...), so the command is always run through `sh -c`; messages are
   * forced to English so errors can be recognised.
   */
  private exec(conn: Conn, command: string): Promise<ClientChannel> {
    const wrapped = 'sh -c ' + shq('LC_MESSAGES=C; export LC_MESSAGES; ' + command)
    return new Promise((resolve, reject) => {
      conn.client.exec(wrapped, (err, ch) => (err ? reject(err) : resolve(ch)))
    })
  }

  private async execText(conn: Conn, command: string): Promise<string> {
    const ch = await this.exec(conn, command)
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      ch.on('data', (c: Buffer) => chunks.push(c))
      ch.stderr.on('data', () => {})
      ch.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
      ch.on('error', reject)
    })
  }

  /** Make sure we know a sudo password (or that none is needed). */
  private async ensureSudo(conn: Conn): Promise<void> {
    if (conn.sudoNoPassword || conn.sudoPassword !== undefined) return
    const ch = await this.exec(conn, 'sudo -n true 2>/dev/null && echo OK')
    const out = await new Promise<string>((resolve) => {
      let s = ''
      ch.on('data', (c: Buffer) => (s += c.toString()))
      ch.stderr.on('data', () => {})
      ch.on('close', () => resolve(s))
    })
    if (out.includes('OK')) {
      conn.sudoNoPassword = true
      return
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let pw = attempt === 0 ? conn.loginPassword : undefined
      if (pw === undefined) {
        const r = await this.prompt({
          kind: 'sudo',
          title: `sudo on ${conn.profile.name}`,
          message: attempt === 0 ? `Password for sudo (${conn.profile.username})` : 'Wrong password, try again'
        })
        if (!r.ok) throw Object.assign(new Error('sudo cancelled'), { code: 'ECANCELED' })
        pw = r.values?.[0] ?? ''
      }
      const v = await this.exec(conn, "sudo -S -p '' -v")
      v.end(pw + '\n')
      const code = await new Promise<number>((resolve) => {
        v.on('data', () => {})
        v.stderr.on('data', () => {})
        v.on('exit', (c: number) => resolve(c))
        v.on('close', () => resolve(-1))
      })
      if (code === 0) {
        conn.sudoPassword = pw
        return
      }
    }
    throw Object.assign(new Error('sudo authentication failed'), { code: 'EACCES' })
  }

  /** Runner implementation for a host (used for journalctl, cat, tail...). */
  runner(id: string): Runner {
    return {
      run: async (argv, opts) => {
        const conn = this.get(id)
        let cmd = argv.map(shq).join(' ')
        if (opts?.sudo) {
          await this.ensureSudo(conn)
          cmd = "sudo -S -p '' -- " + cmd
        }
        const ch = await this.exec(conn, cmd)
        if (opts?.sudo) {
          if (conn.sudoNoPassword) ch.end()
          else ch.end((conn.sudoPassword ?? '') + '\n')
        } else ch.end()
        let stderr = ''
        ch.stderr.on('data', (c: Buffer) => {
          if (stderr.length < 10000) stderr += c.toString()
        })
        const out = new PassThrough()
        ch.pipe(out)
        const done = new Promise<{ code: number; stderr: string }>((resolve) => {
          let code = -1
          ch.on('exit', (c: number | null) => (code = c ?? -1))
          ch.on('close', () => resolve({ code, stderr }))
        })
        return {
          stdout: out as Readable,
          done,
          kill: () => {
            try {
              ch.signal('KILL')
            } catch {
              /* ignore */
            }
            ch.close()
          }
        }
      }
    }
  }

  async readFile(id: string, path: string, sudo: boolean, onProgress?: (bytes: number) => void): Promise<{ data: Buffer; mtime: number }> {
    const r = await this.runner(id).run(['cat', '--', path], { sudo })
    const chunks: Buffer[] = []
    let total = 0
    r.stdout.on('data', (c: Buffer) => {
      chunks.push(c)
      total += c.length
      onProgress?.(total)
    })
    const res = await r.done
    if (res.code !== 0) {
      const msg = res.stderr.trim() || 'cat failed with code ' + res.code
      throw Object.assign(new Error(msg), { code: /permission denied/i.test(msg) ? 'EACCES' : 'EREMOTE' })
    }
    let mtime = Date.now()
    try {
      const st = await this.stat(id, path)
      mtime = st.mtime
    } catch {
      /* ignore */
    }
    return { data: Buffer.concat(chunks), mtime }
  }

  private async sftpOf(conn: Conn): Promise<SFTPWrapper> {
    if (conn.sftp) return conn.sftp
    conn.sftp = await new Promise<SFTPWrapper>((resolve, reject) => conn.client.sftp((err, s) => (err ? reject(err) : resolve(s))))
    conn.sftp.on('close', () => (conn.sftp = undefined))
    return conn.sftp
  }

  async stat(id: string, path: string): Promise<{ mtime: number; size: number }> {
    const conn = this.get(id)
    const sftp = await this.sftpOf(conn)
    return new Promise((resolve, reject) =>
      sftp.stat(path, (err, st) => (err ? reject(err) : resolve({ mtime: st.mtime * 1000, size: st.size })))
    )
  }

  private canRead(conn: Conn, mode: number, uid: number, gid: number, isDir: boolean): boolean {
    if (conn.uid === 0) return true
    const r = isDir ? 0o5 : 0o4
    if (conn.uid === uid) return ((mode >> 6) & r) === r
    if (conn.gids?.includes(gid)) return ((mode >> 3) & r) === r
    return (mode & r) === r
  }

  async listDir(id: string, path: string, sudo: boolean): Promise<RemoteEntry[]> {
    const conn = this.get(id)
    if (sudo) return this.listDirSudo(id, path)
    const sftp = await this.sftpOf(conn)
    const list = await new Promise<{ filename: string; attrs: { mode: number; size: number; mtime: number; uid: number; gid: number } }[]>(
      (resolve, reject) =>
        sftp.readdir(path, (err, l) => {
          if (err) {
            const code = (err as { code?: number }).code === 3 ? 'EACCES' : 'EREMOTE'
            reject(Object.assign(new Error(err.message), { code }))
          } else resolve(l as never)
        })
    )
    const out: RemoteEntry[] = []
    for (const e of list) {
      const full = (path.endsWith('/') ? path : path + '/') + e.filename
      let a = e.attrs
      const isLink = (a.mode & 0o170000) === 0o120000
      if (isLink) {
        try {
          a = await new Promise((resolve, reject) => sftp.stat(full, (err, st) => (err ? reject(err) : resolve(st as never))))
        } catch {
          /* dangling link */
        }
      }
      const isDir = (a.mode & 0o170000) === 0o040000
      out.push({
        name: e.filename,
        path: full,
        isDir,
        isLink,
        size: a.size,
        mtime: a.mtime * 1000,
        readable: this.canRead(conn, a.mode & 0o777, a.uid, a.gid, isDir)
      })
    }
    return sortEntries(out)
  }

  private async listDirSudo(id: string, path: string): Promise<RemoteEntry[]> {
    const r = await this.runner(id).run(
      ['find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%s\\t%T@\\t%Y\\t%f\\n'],
      { sudo: true }
    )
    const chunks: Buffer[] = []
    r.stdout.on('data', (c: Buffer) => chunks.push(c))
    const res = await r.done
    if (res.code !== 0 && chunks.length === 0) throw new Error(res.stderr.trim() || 'listing failed')
    const base = path.endsWith('/') ? path : path + '/'
    const out: RemoteEntry[] = []
    for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
      const [type, size, mtime, target, ...name] = line.split('\t')
      if (!name.length) continue
      const fn = name.join('\t')
      const isDir = type === 'd' || (type === 'l' && target === 'd')
      out.push({ name: fn, path: base + fn, isDir, isLink: type === 'l', size: Number(size), mtime: Number(mtime) * 1000, readable: true })
    }
    return sortEntries(out)
  }

  /** Follow a remote file (tail -F) starting at byte offset `from`. */
  async tail(id: string, path: string, from: number, sudo: boolean, onData: (b: Buffer) => void): Promise<() => void> {
    const r = await this.runner(id).run(['tail', '-c', '+' + (from + 1), '-F', '--', path], { sudo })
    r.stdout.on('data', (c: Buffer) => onData(c))
    return r.kill
  }
}

function sortEntries(e: RemoteEntry[]): RemoteEntry[] {
  return e.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })))
}
