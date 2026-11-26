import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { LogDoc, type JournalEntry } from '../core/LogDoc'
import { hostCommand } from './host'
import type { BootInfo, JournalQuery, Level } from '@shared/types'

const OUTPUT_FIELDS = [
  'MESSAGE',
  'PRIORITY',
  '_SYSTEMD_UNIT',
  '_SYSTEMD_USER_UNIT',
  'SYSLOG_IDENTIFIER',
  '_COMM',
  '_PID',
  'SYSLOG_PID',
  '_HOSTNAME',
  '__REALTIME_TIMESTAMP'
].join(',')

/** Quote an argument for a POSIX shell (used for remote execution). */
export function shq(s: string): string {
  if (/^[A-Za-z0-9_\-+=.,:/@%]+$/.test(s)) return s
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

export function journalArgs(q: JournalQuery, follow: boolean): string[] {
  const a = ['--no-pager', '-o', 'json', '--output-fields=' + OUTPUT_FIELDS]
  if (q.scope === 'user') a.push('--user')
  else if (q.scope === 'system') a.push('--system')
  if (q.limit > 0) a.push('-n', String(q.limit))
  else if (follow) a.push('-n', 'all')
  if (q.since) a.push('--since', q.since)
  if (q.until && !follow) a.push('--until', q.until)
  if (q.boot !== undefined && q.boot !== '') a.push('-b', q.boot)
  if (q.kernel) a.push('-k')
  if (q.priority !== undefined && q.priority >= 0 && q.priority < 7) a.push('-p', '0..' + q.priority)
  for (const u of q.units ?? []) if (u) a.push('-u', u)
  for (const t of q.identifiers ?? []) if (t) a.push('-t', t)
  if (q.grep) a.push('-g', q.grep)
  if (follow) a.push('-f')
  return a
}

function fieldStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    // binary data (array of byte values) or a field that occurs multiple times
    if (v.length > 0 && typeof v[0] === 'number') return Buffer.from(v as number[]).toString('utf8')
    return v.map((x) => fieldStr(x) ?? '').join(' ')
  }
  return String(v)
}

export function parseJournalLine(line: string): JournalEntry | null {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  const us = Number(o.__REALTIME_TIMESTAMP)
  const prio = o.PRIORITY !== undefined ? Number(fieldStr(o.PRIORITY)) : 6
  return {
    ts: us / 1000,
    prio: (prio >= 0 && prio <= 7 ? prio : 6) as Level,
    msg: (fieldStr(o.MESSAGE) ?? '').replace(/\n+$/, ''),
    ident: fieldStr(o.SYSLOG_IDENTIFIER) ?? fieldStr(o._COMM),
    unit: fieldStr(o._SYSTEMD_UNIT) ?? fieldStr(o._SYSTEMD_USER_UNIT),
    host: fieldStr(o._HOSTNAME),
    pid: fieldStr(o._PID) ?? fieldStr(o.SYSLOG_PID)
  }
}

/**
 * Pump journalctl JSON output from a stream into a document. Entries are
 * flushed in batches; `onBatch` is called after each flush.
 */
export function pumpJournal(doc: LogDoc, stream: Readable, onBatch: (appended: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let carry = ''
    let pending: JournalEntry[] = []
    let timer: NodeJS.Timeout | null = null
    const flush = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pending.length === 0) return
      const n = doc.appendJournal(pending)
      pending = []
      onBatch(n)
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const text = carry + chunk
      let start = 0
      for (;;) {
        const nl = text.indexOf('\n', start)
        if (nl < 0) break
        const e = parseJournalLine(text.slice(start, nl))
        if (e) pending.push(e)
        start = nl + 1
      }
      carry = text.slice(start)
      if (pending.length >= 20000) flush()
      else if (!timer) timer = setTimeout(flush, 150)
    })
    stream.on('end', () => {
      const e = parseJournalLine(carry)
      if (e) pending.push(e)
      flush()
      resolve()
    })
    stream.on('error', (err) => {
      flush()
      reject(err)
    })
  })
}

export function describeQuery(q: JournalQuery): string {
  const parts: string[] = []
  if (q.boot !== undefined && q.boot !== '') parts.push(q.boot === '0' ? 'current boot' : 'boot ' + q.boot)
  if (q.units?.length) parts.push(q.units.join(', '))
  if (q.identifiers?.length) parts.push(q.identifiers.join(', '))
  if (q.kernel) parts.push('kernel')
  if (q.priority !== undefined && q.priority < 7) parts.push('prio ≤ ' + q.priority)
  if (q.since) parts.push('since ' + q.since)
  if (q.until) parts.push('until ' + q.until)
  if (q.scope === 'user') parts.push('user')
  if (q.limit > 0) parts.push('last ' + q.limit)
  return parts.join(' · ') || 'all entries'
}

// ---- local execution ---------------------------------------------------

export interface Runner {
  /** Run a command, return a readable stdout and a completion promise. */
  run(argv: string[], opts?: { sudo?: boolean }): Promise<{ stdout: Readable; done: Promise<{ code: number; stderr: string }>; kill: () => void }>
}

export const localRunner: Runner = {
  async run(argv, opts) {
    const cmd = hostCommand(opts?.sudo ? ['pkexec', ...argv] : argv)
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 10000) stderr += c.toString()
    })
    const done = new Promise<{ code: number; stderr: string }>((resolve) => {
      p.on('error', (e) => resolve({ code: -1, stderr: String(e.message) }))
      p.on('close', (code) => resolve({ code: code ?? -1, stderr }))
    })
    return { stdout: p.stdout, done, kill: () => p.kill() }
  }
}

async function runCollect(runner: Runner, argv: string[], sudo?: boolean): Promise<string> {
  const r = await runner.run(argv, { sudo })
  const chunks: Buffer[] = []
  r.stdout.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  const res = await r.done
  const out = Buffer.concat(chunks).toString('utf8')
  if (res.code !== 0 && !out) throw new Error(res.stderr.trim() || 'command failed: ' + argv.join(' '))
  return out
}

export async function listBoots(runner: Runner, sudo?: boolean): Promise<BootInfo[]> {
  const out = await runCollect(runner, ['journalctl', '--no-pager', '--list-boots', '-o', 'json'], sudo)
  try {
    const arr = JSON.parse(out) as { index: number; boot_id: string; first_entry: number; last_entry: number }[]
    return arr
      .map((b) => ({ index: b.index, bootId: b.boot_id, first: b.first_entry / 1000, last: b.last_entry / 1000 }))
      .reverse()
  } catch {
    // older systemd: text output "  -1 <id> Thu 2026-... —Thu 2026-..."
    const res: BootInfo[] = []
    for (const line of out.split('\n')) {
      const m = /^\s*(-?\d+)\s+([0-9a-f]{32})\s+(.*)$/.exec(line)
      if (m) res.push({ index: Number(m[1]), bootId: m[2], first: NaN, last: NaN })
    }
    return res.reverse()
  }
}

export async function listFieldValues(runner: Runner, field: string, sudo?: boolean): Promise<string[]> {
  const out = await runCollect(runner, ['journalctl', '--no-pager', '-F', field], sudo)
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Load a journal into a new document. If `follow` is set, the process keeps
 * running and appends entries until the document is disposed.
 */
export async function openJournal(
  runner: Runner,
  q: JournalQuery,
  title: string,
  hostId: string | undefined,
  follow: boolean,
  onUpdate: (doc: LogDoc, appended: number) => void
): Promise<LogDoc> {
  const doc = new LogDoc({ kind: 'journal', hostId, journal: q, elevated: q.sudo }, title)
  doc.subtitle = describeQuery(q)
  doc.sourceTz = 'UTC'
  const r = await runner.run(['journalctl', ...journalArgs(q, follow)], { sudo: q.sudo })
  doc.following = follow
  doc.onDispose.push(() => r.kill())
  let first = true
  const pump = pumpJournal(doc, r.stdout, (n) => {
    if (first && follow) {
      // with -f journalctl never ends; first batch marks the initial load done
      first = false
      doc.loading = false
    }
    onUpdate(doc, n)
  })
  const finish = async (): Promise<void> => {
    try {
      await pump
    } catch (e) {
      doc.error = (e as Error).message
    }
    const res = await r.done
    doc.loading = false
    doc.following = false
    if (res.code !== 0 && res.code !== null && doc.lineCount === 0) {
      doc.error = res.stderr.trim() || 'journalctl exited with code ' + res.code
    } else if (res.stderr.trim() && doc.lineCount === 0) {
      doc.error = res.stderr.trim()
    }
    onUpdate(doc, 0)
  }
  void finish()
  if (follow) {
    // if there are no entries at all, mark loaded after a short time
    setTimeout(() => {
      if (doc.loading) {
        doc.loading = false
        onUpdate(doc, 0)
      }
    }, 1500)
  }
  return doc
}
