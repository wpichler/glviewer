// Syslog receiver: UDP and TCP listeners, RFC 5424 / RFC 3164 parsing.

import dgram from 'node:dgram'
import net from 'node:net'
import { FACILITY_NAMES, type Level, type SyslogConfig } from '@shared/types'
import type { JournalEntry } from '../core/LogDoc'
import { NaiveConverter, resolveTz } from '../core/timezone'
import { detectLevel } from '../core/levels'
import { PARSERS, NO_OFFSET, type ParseOut } from '../core/timestamps'

export interface ParsedSyslog {
  facility: number | null
  severity: Level
  /** Epoch ms from the message, or null if absent / unparsable. */
  ts: number | null
  host?: string
  app?: string
  pid?: string
  msgid?: string
  msg: string
}

const RE_5424 = /^(\S+) (\S+) (\S+) (\S+) (\S+) ?(.*)$/s
const RE_3164_TS = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?: (\d{4}))?:? /
const RE_ISO_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?) /
const RE_TAG = /^([^\s:[\]]{1,64})(?:\[([^\]\s]{1,32})\])?:(?: |$)/

const nil = (s: string | undefined): string | undefined => (s === undefined || s === '-' ? undefined : s)

function parseIsoTs(s: string, conv: NaiveConverter): number | null {
  const out: ParseOut = { naive: NaN, offset: NO_OFFSET }
  if (!PARSERS.iso(s, { refMs: Date.now() }, out)) return null
  return out.offset === NO_OFFSET ? conv.toUtc(out.naive) : out.naive - out.offset * 60_000
}

/** Split the structured data part of an RFC 5424 message from its MSG part. */
function splitSd(rest: string): { sd: string; msg: string } {
  if (rest.startsWith('-')) return { sd: '', msg: rest.slice(rest.startsWith('- ') ? 2 : 1) }
  if (!rest.startsWith('[')) return { sd: '', msg: rest }
  let i = 0
  while (i < rest.length && rest[i] === '[') {
    i++
    while (i < rest.length && rest[i] !== ']') {
      if (rest[i] === '\\') i++
      else if (rest[i] === '"') {
        i++
        while (i < rest.length && rest[i] !== '"') {
          if (rest[i] === '\\') i++
          i++
        }
      }
      i++
    }
    i++ // skip ]
  }
  const sd = rest.slice(0, i)
  return { sd, msg: rest.slice(i).replace(/^ /, '') }
}

/**
 * Parse a single syslog message. `tz` is used for timestamps without UTC
 * offset (classic BSD syslog). `now` is used to infer the missing year.
 */
export function parseSyslog(raw: string, tz = 'local', now = Date.now()): ParsedSyslog {
  let s = raw.replace(/[\r\n\0]+$/, '')
  let facility: number | null = null
  let severity: Level | null = null
  const m = /^<(\d{1,3})>/.exec(s)
  if (m) {
    const pri = Number(m[1])
    facility = pri >> 3
    severity = (pri & 7) as Level
    s = s.slice(m[0].length)
  }
  const conv = new NaiveConverter(resolveTz(tz))

  // RFC 5424: VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [SP MSG]
  if (/^[1-9]\d? /.test(s)) {
    const body = s.slice(s.indexOf(' ') + 1)
    const p = RE_5424.exec(body)
    if (p) {
      const { sd, msg } = splitSd(p[6] ?? '')
      const text = msg.replace(/^﻿/, '')
      return {
        facility,
        severity: severity ?? detectLevel(text),
        ts: p[1] === '-' ? null : parseIsoTs(p[1], conv),
        host: nil(p[2]),
        app: nil(p[3]),
        pid: nil(p[4]),
        msgid: nil(p[5]),
        msg: sd ? (text ? text + ' ' + sd : sd) : text
      }
    }
  }

  // RFC 3164 (and common variants): TIMESTAMP HOSTNAME TAG[PID]: MSG
  let ts: number | null = null
  const t = RE_3164_TS.exec(s)
  if (t) {
    const out: ParseOut = { naive: NaN, offset: NO_OFFSET }
    if (PARSERS.syslog(t[0], { refMs: now }, out)) {
      let naive = out.naive
      if (t[6]) {
        const d = new Date(naive)
        naive = Date.UTC(Number(t[6]), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
      }
      ts = conv.toUtc(naive)
    }
    s = s.slice(t[0].length)
  } else {
    const iso = RE_ISO_TS.exec(s)
    if (iso) {
      ts = parseIsoTs(iso[1], conv)
      s = s.slice(iso[0].length)
    }
  }
  let host: string | undefined
  let app: string | undefined
  let pid: string | undefined
  let tag = RE_TAG.exec(s)
  if (!tag && t !== null) {
    // first token is the hostname unless it already looks like a tag
    const sp = s.indexOf(' ')
    if (sp > 0) {
      host = s.slice(0, sp)
      s = s.slice(sp + 1)
      tag = RE_TAG.exec(s)
    }
  } else if (!tag && /^\S+ \S/.test(s) && ts !== null) {
    const sp = s.indexOf(' ')
    host = s.slice(0, sp)
    s = s.slice(sp + 1)
    tag = RE_TAG.exec(s)
  }
  if (tag) {
    app = tag[1]
    pid = tag[2]
    s = s.slice(tag[0].length)
  }
  return { facility, severity: severity ?? detectLevel(s), ts, host, app, pid, msg: s }
}

export function facilityName(f: number | null): string | undefined {
  if (f === null) return undefined
  return FACILITY_NAMES[f] ?? 'facility' + f
}

/** Split a TCP stream into messages: RFC 6587 octet counting or newline framing. */
export class TcpFramer {
  private buf: Buffer = Buffer.alloc(0)
  push(chunk: Buffer): string[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: string[] = []
    for (;;) {
      if (this.buf.length === 0) break
      const c = this.buf[0]
      if (c >= 0x31 && c <= 0x39) {
        // octet counting: "LEN SP MSG"
        const sp = this.buf.indexOf(0x20)
        if (sp < 0 || sp > 10) {
          if (sp < 0 && this.buf.length < 11) break
          if (!this.newline(out)) break
          continue
        }
        const lenStr = this.buf.subarray(0, sp).toString('ascii')
        if (!/^\d+$/.test(lenStr)) {
          if (!this.newline(out)) break
          continue
        }
        const len = Number(lenStr)
        if (this.buf.length < sp + 1 + len) break
        out.push(this.buf.subarray(sp + 1, sp + 1 + len).toString('utf8'))
        this.buf = this.buf.subarray(sp + 1 + len)
      } else if (c === 0x0a || c === 0x0d || c === 0x00) {
        this.buf = this.buf.subarray(1)
      } else if (!this.newline(out)) break
    }
    // protect against unbounded growth from a peer that never sends a delimiter
    if (this.buf.length > 1024 * 1024) {
      out.push(this.buf.toString('utf8'))
      this.buf = Buffer.alloc(0)
    }
    return out
  }
  private newline(out: string[]): boolean {
    let nl = this.buf.indexOf(0x0a)
    const nul = this.buf.indexOf(0x00)
    if (nul >= 0 && (nl < 0 || nul < nl)) nl = nul
    if (nl < 0) return false
    out.push(this.buf.subarray(0, nl).toString('utf8'))
    this.buf = this.buf.subarray(nl + 1)
    return true
  }
  flush(): string | null {
    if (!this.buf.length) return null
    const s = this.buf.toString('utf8')
    this.buf = Buffer.alloc(0)
    return s
  }
}

export interface SyslogListener {
  /** Human readable list of bound endpoints. */
  endpoints: string[]
  close(): void
}

function toEntry(raw: string, remote: string, cfg: SyslogConfig): JournalEntry {
  const now = Date.now()
  const p = parseSyslog(raw, cfg.messageTz, now)
  const ts = cfg.timeSource === 'message' && p.ts !== null ? p.ts : now
  return {
    ts,
    prio: p.severity,
    msg: p.msg,
    ident: p.app,
    unit: facilityName(p.facility),
    host: p.host ?? remote,
    pid: p.pid
  }
}

/**
 * Start UDP and/or TCP listeners. Entries are delivered in batches through
 * `onEntries`. Rejects if a socket cannot be bound (port in use, privileges).
 */
export async function startSyslog(cfg: SyslogConfig, onEntries: (e: JournalEntry[]) => void): Promise<SyslogListener> {
  let pending: JournalEntry[] = []
  let timer: NodeJS.Timeout | null = null
  const push = (e: JournalEntry): void => {
    pending.push(e)
    if (pending.length >= 5000) flush()
    else if (!timer) timer = setTimeout(flush, 100)
  }
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending.length) return
    const batch = pending
    pending = []
    onEntries(batch)
  }
  const clean = (addr: string): string => addr.replace(/^::ffff:/, '')

  const closers: (() => void)[] = []
  const endpoints: string[] = []
  const v6 = cfg.address.includes(':')
  try {
    if (cfg.udp) {
      const sock = dgram.createSocket({ type: v6 ? 'udp6' : 'udp4', reuseAddr: true })
      await new Promise<void>((resolve, reject) => {
        sock.once('error', reject)
        sock.bind(cfg.port, cfg.address, () => {
          sock.off('error', reject)
          resolve()
        })
      })
      sock.on('message', (msg, rinfo) => push(toEntry(msg.toString('utf8'), clean(rinfo.address), cfg)))
      sock.on('error', () => {})
      closers.push(() => sock.close())
      endpoints.push(`udp ${cfg.address}:${cfg.port}`)
    }
    if (cfg.tcp) {
      const sockets = new Set<net.Socket>()
      const server = net.createServer((conn) => {
        sockets.add(conn)
        const framer = new TcpFramer()
        const remote = clean(conn.remoteAddress ?? '?')
        conn.on('data', (c: Buffer) => {
          for (const m of framer.push(c)) if (m.trim()) push(toEntry(m, remote, cfg))
        })
        conn.on('end', () => {
          const rest = framer.flush()
          if (rest && rest.trim()) push(toEntry(rest, remote, cfg))
        })
        conn.on('close', () => sockets.delete(conn))
        conn.on('error', () => {})
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, cfg.address, () => {
          server.off('error', reject)
          resolve()
        })
      })
      closers.push(() => {
        server.close()
        for (const s of sockets) s.destroy()
      })
      endpoints.push(`tcp ${cfg.address}:${cfg.port}`)
    }
  } catch (e) {
    for (const c of closers) c()
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EADDRINUSE') throw Object.assign(new Error(`Port ${cfg.port} is already in use`), { code: err.code })
    if (err.code === 'EACCES')
      throw Object.assign(new Error(`No permission to listen on port ${cfg.port}. Ports below 1024 need root on Linux; use e.g. 1514.`), { code: err.code })
    throw err
  }
  return {
    endpoints,
    close() {
      flush()
      for (const c of closers) {
        try {
          c()
        } catch {
          /* ignore */
        }
      }
    }
  }
}
