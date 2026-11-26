import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { followLocalFile, openLocalFile } from '../src/main/sources/files'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('follow appends lines, handles partial lines and truncation', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'glv-')), 'f.log')
  writeFileSync(f, '2026-11-26 10:00:00 INFO a\n')
  const doc = await openLocalFile(f, {})
  let appended = 0
  let resets = 0
  const stop = followLocalFile(doc, (n) => (appended += n), () => resets++)
  appendFileSync(f, '2026-11-26 10:00:01 INFO b\n2026-11-26 10:00:02 ERR')
  await sleep(1300)
  appendFileSync(f, 'OR c\n')
  await sleep(1300)
  assert.equal(doc.lineCount, 3)
  assert.equal(doc.row(2).text, '2026-11-26 10:00:02 ERROR c')
  assert.equal(doc.row(2).level, 3)
  writeFileSync(f, 'x\n') // truncate (rotation)
  await sleep(1300)
  stop()
  assert.equal(resets, 1)
  assert.equal(doc.lineCount, 1)
  assert.equal(doc.row(0).text, 'x')
  assert.ok(appended >= 2)
})

test('after rotation the timestamp format is detected again and the size is correct', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'glv-')), 'r.log')
  writeFileSync(f, '2026-11-26 10:00:00 INFO a\n2026-11-26 10:00:01 INFO b\n')
  const doc = await openLocalFile(f, {})
  const stop = followLocalFile(doc, () => {}, () => {})
  writeFileSync(f, 'Nov 26 11:00:00 host app: rotated\n')
  await sleep(1300)
  stop()
  assert.equal(doc.lineCount, 1)
  assert.equal(doc.info().detectedTimestampFormat, 'syslog')
  assert.notEqual(doc.row(0).ts, null)
  assert.equal(doc.info().sizeBytes, Buffer.byteLength('Nov 26 11:00:00 host app: rotated\n'))
})
