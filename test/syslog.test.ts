import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import dgram from 'node:dgram'
import net from 'node:net'
import { parseSyslog, TcpFramer, startSyslog } from '../src/main/sources/syslog'
import type { JournalEntry } from '../src/main/core/LogDoc'
import { DEFAULT_SYSLOG } from '../src/shared/types'

const NOW = Date.UTC(2026, 10, 26, 12)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('RFC 5424 with structured data', () => {
  const p = parseSyslog('<165>1 2026-11-26T10:11:12.003Z web-01 nginx 4242 ID47 [exampleSDID@32473 iut="3" eventSource="App\\"x\\]"] ﻿upstream timed out', 'UTC', NOW)
  assert.equal(p.facility, 20) // local4
  assert.equal(p.severity, 5)
  assert.equal(p.ts, Date.UTC(2026, 10, 26, 10, 11, 12, 3))
  assert.equal(p.host, 'web-01')
  assert.equal(p.app, 'nginx')
  assert.equal(p.pid, '4242')
  assert.equal(p.msgid, 'ID47')
  assert.match(p.msg, /^upstream timed out \[exampleSDID@32473/)
})

test('RFC 5424 with nil values', () => {
  const p = parseSyslog('<14>1 - - - - - -', 'UTC', NOW)
  assert.equal(p.ts, null)
  assert.equal(p.host, undefined)
  assert.equal(p.msg, '')
})

test('RFC 3164 classic and variants', () => {
  let p = parseSyslog('<34>Nov 26 10:00:01 router1 sshd[123]: Failed password for root', 'Europe/Vienna', NOW)
  assert.equal(p.facility, 4)
  assert.equal(p.severity, 2)
  assert.equal(p.ts, Date.UTC(2026, 10, 26, 9, 0, 1))
  assert.equal(p.host, 'router1')
  assert.equal(p.app, 'sshd')
  assert.equal(p.pid, '123')
  assert.equal(p.msg, 'Failed password for root')
  // without hostname
  p = parseSyslog('<13>Nov  6 10:00:01 myapp: hello world', 'UTC', NOW)
  assert.equal(p.host, undefined)
  assert.equal(p.app, 'myapp')
  assert.equal(p.msg, 'hello world')
  // RFC 3339 timestamp (rsyslog high precision template)
  p = parseSyslog('<30>2026-11-26T10:00:01.5+01:00 nas kernel: disk ok', 'UTC', NOW)
  assert.equal(p.ts, Date.UTC(2026, 10, 26, 9, 0, 1, 500))
  assert.equal(p.host, 'nas')
  assert.equal(p.app, 'kernel')
  // no PRI, no header at all
  p = parseSyslog('just some ERROR text', 'UTC', NOW)
  assert.equal(p.facility, null)
  assert.equal(p.severity, 3)
  assert.equal(p.msg, 'just some ERROR text')
})

test('TCP framing: octet counting, newline, mixed and split chunks', () => {
  const f = new TcpFramer()
  const a = '<13>1 - h a - - - one'
  const b = '<13>Nov 26 10:00:00 h a: two'
  const stream = Buffer.from(`${Buffer.byteLength(a)} ${a}${b}\n<13>three\n`)
  const out: string[] = []
  for (let i = 0; i < stream.length; i += 7) out.push(...f.push(stream.subarray(i, i + 7)))
  assert.deepEqual(out, [a, b, '<13>three'])
})

test('listener receives UDP and TCP (node clients and logger)', async () => {
  const got: JournalEntry[] = []
  const port = 20000 + Math.floor(Math.random() * 20000)
  const l = await startSyslog({ ...DEFAULT_SYSLOG, address: '127.0.0.1', port }, (e) => got.push(...e))
  try {
    const u = dgram.createSocket('udp4')
    await new Promise<void>((r) => u.send('<11>Nov 26 10:00:00 dev1 app[7]: udp message', port, '127.0.0.1', () => r()))
    u.close()
    await new Promise<void>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.end('<12>1 2026-11-26T10:00:00Z dev2 svc - - - tcp message\n')
      })
      c.on('close', () => resolve())
    })
    if (existsSync('/usr/bin/logger')) {
      execFileSync('logger', ['--server', '127.0.0.1', '--port', String(port), '--udp', '--rfc3164', '-t', 'lgudp', 'from logger udp'])
      execFileSync('logger', ['--server', '127.0.0.1', '--port', String(port), '--tcp', '--octet-count', '--rfc5424', '-t', 'lgtcp', '-p', 'local3.warning', 'from logger tcp'])
    }
    await sleep(400)
  } finally {
    l.close()
  }
  const byMsg = Object.fromEntries(got.map((e) => [e.msg.replace(/ \[.*$/, ''), e]))
  assert.equal(byMsg['udp message'].host, 'dev1')
  assert.equal(byMsg['udp message'].prio, 3)
  assert.equal(byMsg['udp message'].unit, 'user')
  assert.equal(byMsg['tcp message'].ident, 'svc')
  if (existsSync('/usr/bin/logger')) {
    assert.equal(byMsg['from logger udp'].ident, 'lgudp')
    assert.equal(byMsg['from logger tcp'].ident, 'lgtcp')
    assert.equal(byMsg['from logger tcp'].prio, 4)
    assert.equal(byMsg['from logger tcp'].unit, 'local3')
  }
})

test('port in use gives a clear error', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const a = await startSyslog({ ...DEFAULT_SYSLOG, address: '127.0.0.1', port, udp: false }, () => {})
  try {
    await assert.rejects(startSyslog({ ...DEFAULT_SYSLOG, address: '127.0.0.1', port, udp: false }, () => {}), /already in use/)
  } finally {
    a.close()
  }
})
