import { test } from 'node:test'
import assert from 'node:assert/strict'
import iconv from 'iconv-lite'
import { LogDoc } from '../src/main/core/LogDoc'
import { detectEncoding, decodeLines } from '../src/main/core/encoding'
import { detectFormat, PARSERS, NO_OFFSET } from '../src/main/core/timestamps'
import { NaiveConverter, tzOffsetAt } from '../src/main/core/timezone'
import { detectLevel } from '../src/main/core/levels'
import { parseJournalLine, journalArgs, shq } from '../src/main/sources/journal'
import { checkKnownHosts } from '../src/main/sources/sshconfig'
import { createHmac, randomBytes } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ctx = { refMs: Date.UTC(2026, 10, 26, 12) }
const out = { naive: 0, offset: NO_OFFSET }

test('iso timestamps with offset', () => {
  assert.ok(PARSERS.iso('2026-11-26T15:08:01.123+01:00 host foo', ctx, out))
  assert.equal(out.naive - out.offset * 60000, Date.UTC(2026, 10, 26, 14, 8, 1, 123))
  assert.ok(PARSERS.iso('[2026-11-26 15:08:01,5] INFO x', ctx, out))
  assert.equal(out.offset, NO_OFFSET)
  assert.equal(out.naive, Date.UTC(2026, 10, 26, 15, 8, 1, 500))
  assert.ok(PARSERS.iso('2026-11-26T15:08:01+0100 dnf', ctx, out))
  assert.equal(out.offset, 60)
})

test('syslog year inference', () => {
  assert.ok(PARSERS.syslog('Nov 26 11:00:00 host sshd[1]: hi', ctx, out))
  assert.equal(out.naive, Date.UTC(2026, 10, 26, 11))
  // December entries in a file modified in November belong to the previous year
  assert.ok(PARSERS.syslog('Dec  3 11:00:00 host x', ctx, out))
  assert.equal(new Date(out.naive).getUTCFullYear(), 2025)
})

test('clf, epoch and audit', () => {
  assert.ok(PARSERS.clf('1.2.3.4 - - [26/Nov/2026:15:08:01 +0100] "GET /"', ctx, out))
  assert.equal(out.naive - out.offset * 60000, Date.UTC(2026, 10, 26, 14, 8, 1))
  assert.ok(PARSERS.epoch('type=SYSCALL msg=audit(1795702418.890:123): arch=c000003e', ctx, out))
  assert.equal(out.naive, 1795702418890)
})

test('format detection', () => {
  const lines = ['Nov 26 10:00:00 a b: c', 'Nov 26 10:00:01 a b: d', '   continuation', 'Nov 26 10:00:02 a b: e']
  assert.equal(detectFormat(lines, ctx), 'syslog')
  assert.equal(detectFormat(['hello', 'world'], ctx), 'none')
})

test('time zone conversion incl. DST', () => {
  assert.equal(tzOffsetAt('Europe/Vienna', Date.UTC(2026, 6, 1)), 2 * 3600000)
  assert.equal(tzOffsetAt('Europe/Vienna', Date.UTC(2026, 0, 1)), 3600000)
  const c = new NaiveConverter('America/New_York')
  assert.equal(c.toUtc(Date.UTC(2026, 10, 26, 10)), Date.UTC(2026, 10, 26, 15))
  assert.equal(c.toUtc(Date.UTC(2026, 6, 1, 10)), Date.UTC(2026, 6, 1, 14))
})

test('encoding detection', () => {
  assert.equal(detectEncoding(Buffer.from('plain ascii\n')).encoding, 'utf-8')
  assert.equal(detectEncoding(Buffer.from('Grüße aus Österreich\n')).encoding, 'utf-8')
  const latin = iconv.encode('Grüße aus Österreich, schöne Größe, Äpfel und Übermut. '.repeat(20), 'latin1')
  const det = detectEncoding(latin)
  assert.ok(['iso-8859-1', 'windows-1252', 'iso-8859-15'].includes(det.encoding), det.encoding)
  const u16 = iconv.encode('﻿hello\r\nworld\r\n', 'utf-16le')
  assert.equal(detectEncoding(u16).encoding, 'utf-16le')
  const { lines, partial } = decodeLines(u16, 'utf-16le')
  assert.deepEqual(lines, ['hello', 'world'])
  assert.equal(partial, '')
})

test('levels', () => {
  assert.equal(detectLevel('2026-11-26 10:00:00 ERROR something'), 3)
  assert.equal(detectLevel('[warn] disk'), 4)
  assert.equal(detectLevel('level=debug msg=x'), 7)
  assert.equal(detectLevel('nothing here'), 8)
})

test('LogDoc filter, search, findTime, tz', async () => {
  const d = new LogDoc({ kind: 'file', path: '/x' }, 'x')
  d.refMs = ctx.refMs
  d.sourceTz = 'UTC'
  d.setTextLines([
    '2026-11-26 10:00:00 INFO start',
    '2026-11-26 10:00:05 ERROR boom',
    '  at stack line',
    '2026-11-26 10:00:10 WARN careful',
    '2026-11-26 10:00:20 INFO end'
  ])
  assert.equal(d.info().hasNaiveTimestamps, true)
  assert.equal(d.row(2).inh, true)
  assert.equal(d.row(2).level, 3) // continuation inherits level
  await d.setFilter({ include: '', exclude: '', regex: false, caseSensitive: false, levels: [3] })
  assert.equal(d.viewCount, 2)
  await d.setFilter({ include: 'b(oo|ar)m', exclude: '', regex: true, caseSensitive: false })
  assert.equal(d.viewCount, 1)
  await d.setFilter(null)
  assert.equal(await d.search({ query: 'info', regex: false, caseSensitive: false }, 1, 1), 4)
  assert.equal(await d.search({ query: 'info', regex: false, caseSensitive: false }, 1, -1), 0)
  assert.equal(await d.countMatches({ query: 'INFO', regex: false, caseSensitive: true }), 2)
  assert.equal(d.findTime(Date.UTC(2026, 10, 26, 10, 0, 7)), 3)
  d.setSourceTz('Europe/Vienna')
  assert.equal(d.row(0).ts, Date.UTC(2026, 10, 26, 9))
  // follow append with an active filter
  await d.setFilter({ include: 'new', exclude: '', regex: false, caseSensitive: false })
  d.appendTextLines(['2026-11-26 10:00:30 INFO new line'])
  assert.equal(d.viewCount, 1)
  assert.equal(d.row(0).text, '2026-11-26 10:00:30 INFO new line')
})

test('journal json parsing', () => {
  const e = parseJournalLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1795702418890110', PRIORITY: '3', MESSAGE: [104, 105], SYSLOG_IDENTIFIER: 'sshd', _PID: '42', _HOSTNAME: 'h', _SYSTEMD_UNIT: 'sshd.service' }))!
  assert.equal(e.ts, 1795702418890.11)
  assert.equal(e.prio, 3)
  assert.equal(e.msg, 'hi')
  assert.equal(e.unit, 'sshd.service')
  const a = journalArgs({ limit: 100, boot: '0', units: ['sshd.service'], priority: 4 }, false)
  assert.ok(a.includes('-u') && a.includes('-p') && a.includes('0..4'))
  assert.equal(shq("it's"), `'it'\\''s'`)
})

test('known_hosts hashed + plain matching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'glv-'))
  const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), randomBytes(36)])
  const other = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), randomBytes(36)])
  const salt = randomBytes(20)
  const hash = createHmac('sha1', salt).update('[srv.example]:2222').digest('base64')
  const f = join(dir, 'known_hosts')
  writeFileSync(f, `plain.example ssh-ed25519 ${key.toString('base64')}\n|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${key.toString('base64')}\n`)
  assert.equal(checkKnownHosts([f], 'plain.example', 22, key), 'match')
  assert.equal(checkKnownHosts([f], 'srv.example', 2222, key), 'match')
  assert.equal(checkKnownHosts([f], 'plain.example', 22, other), 'mismatch')
  assert.equal(checkKnownHosts([f], 'new.example', 22, key), 'unknown')
})

test('sort by timestamp keeps continuation lines with their entry', async () => {
  const d = new LogDoc({ kind: 'file', path: '/x' }, 'x')
  d.refMs = ctx.refMs
  d.sourceTz = 'UTC'
  d.setTextLines([
    '2026-11-26 10:00:20 INFO c',
    '2026-11-26 10:00:00 INFO a',
    '2026-11-26 10:00:10 ERROR b',
    '  at stack 1',
    '  at stack 2',
    '2026-11-26 10:00:10 INFO b2'
  ])
  const texts = () => d.rows(0, d.viewCount).map((r) => r.text.replace(/^2026-11-26 10:00:\d\d /, ''))
  await d.setFilter({ include: '', exclude: '', regex: false, caseSensitive: false, order: 'asc' })
  assert.deepEqual(texts(), ['INFO a', 'ERROR b', '  at stack 1', '  at stack 2', 'INFO b2', 'INFO c'])
  await d.setFilter({ include: '', exclude: '', regex: false, caseSensitive: false, order: 'desc' })
  assert.deepEqual(texts(), ['INFO c', 'INFO b2', 'ERROR b', '  at stack 1', '  at stack 2', 'INFO a'])
  // newest first: first entry at or before the given time
  assert.equal(d.findTime(Date.UTC(2026, 10, 26, 10, 0, 15)), 1)
  // with a filter: errors only (continuation lines inherit the level)
  await d.setFilter({ include: '', exclude: '', regex: false, caseSensitive: false, levels: [3], order: 'desc' })
  assert.deepEqual(texts(), ['ERROR b', '  at stack 1', '  at stack 2'])
  // following: new lines go to the top when sorted newest first
  await d.setFilter({ include: '', exclude: '', regex: false, caseSensitive: false, order: 'desc' })
  const v = d.info().version
  d.appendTextLines(['2026-11-26 10:00:30 WARN d', '  detail'])
  assert.deepEqual(texts().slice(0, 3), ['WARN d', '  detail', 'INFO c'])
  assert.ok(d.info().version > v)
  // back to file order
  await d.setFilter({ include: '', exclude: '', regex: false, caseSensitive: false, order: 'file' })
  assert.equal(d.row(0).text, '2026-11-26 10:00:20 INFO c')
})
