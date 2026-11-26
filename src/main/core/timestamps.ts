// Timestamp detection and parsing for plain text log files.
//
// Parsers produce a "naive" time (wall clock encoded as if it were UTC) and,
// if the timestamp carries one, a UTC offset in minutes. Naive times without
// offset are later converted using the user-selected source time zone.

export const NO_OFFSET = 32767

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
}

export interface ParseContext {
  /** Reference time (epoch ms) used for formats without a year, typically the file mtime. */
  refMs: number
}

export interface ParseOut {
  naive: number
  offset: number // minutes, or NO_OFFSET
}

type Parser = (line: string, ctx: ParseContext, out: ParseOut) => boolean

function fracMs(frac: string | undefined): number {
  if (!frac) return 0
  // "1" -> 100ms, "123456" -> 123.456ms
  return Number((frac + '000').slice(0, 3)) + (frac.length > 3 ? Number('0.' + frac.slice(3)) : 0)
}

function parseOffset(s: string | undefined): number {
  if (!s) return NO_OFFSET
  if (s === 'Z' || s === 'UTC' || s === 'GMT' || s === 'z') return 0
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(s)
  if (!m) return NO_OFFSET
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0)
  return m[1] === '-' ? -v : v
}

function inferYear(month: number, day: number, h: number, mi: number, s: number, ctx: ParseContext): number {
  const ref = new Date(ctx.refMs)
  let y = ref.getUTCFullYear()
  const t = Date.UTC(y, month, day, h, mi, s)
  // A log line cannot be (much) newer than the file itself -> previous year.
  if (t > ctx.refMs + 2 * 86_400_000) y -= 1
  return y
}

// ---- individual parsers --------------------------------------------------

const RE_ISO =
  /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s?(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?/
const parseIso: Parser = (line, _ctx, out) => {
  const m = RE_ISO.exec(line.length > 200 ? line.slice(0, 200) : line)
  if (!m || m.index > 80) return false
  const mo = +m[2], d = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  out.naive = Date.UTC(+m[1], mo - 1, d, +m[4], +m[5], +m[6]) + fracMs(m[7])
  out.offset = parseOffset(m[8])
  return true
}

const RE_SYSLOG = /^(?:<\d{1,3}>)?(?:\d+ )?([A-Z][a-z]{2})\s{1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?/
const parseSyslog: Parser = (line, ctx, out) => {
  const m = RE_SYSLOG.exec(line)
  if (!m) return false
  const mo = MONTHS[m[1].toLowerCase()]
  if (mo === undefined) return false
  const d = +m[2], h = +m[3], mi = +m[4], s = +m[5]
  const y = inferYear(mo, d, h, mi, s, ctx)
  out.naive = Date.UTC(y, mo, d, h, mi, s) + fracMs(m[6])
  out.offset = NO_OFFSET
  return true
}

const RE_CLF = /\[(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?: ([+-]\d{4}))?\]/
const parseClf: Parser = (line, _ctx, out) => {
  const m = RE_CLF.exec(line.length > 300 ? line.slice(0, 300) : line)
  if (!m) return false
  const mo = MONTHS[m[2].toLowerCase()]
  if (mo === undefined) return false
  out.naive = Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +m[6]) + fracMs(m[7])
  out.offset = parseOffset(m[8])
  return true
}

const RE_SLASH = /(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s?(Z|[+-]\d{2}:?\d{2})?/
const parseSlash: Parser = (line, _ctx, out) => {
  const m = RE_SLASH.exec(line.length > 200 ? line.slice(0, 200) : line)
  if (!m || m.index > 80) return false
  out.naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + fracMs(m[7])
  out.offset = parseOffset(m[8])
  return true
}

const RE_CTIME =
  /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2})\s{1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? (?:([A-Z]{3,4}|[+-]\d{4}) )?(\d{4})/
const parseCtime: Parser = (line, _ctx, out) => {
  const m = RE_CTIME.exec(line.length > 200 ? line.slice(0, 200) : line)
  if (!m || m.index > 80) return false
  const mo = MONTHS[m[1].toLowerCase()]
  if (mo === undefined) return false
  out.naive = Date.UTC(+m[8], mo, +m[2], +m[3], +m[4], +m[5]) + fracMs(m[6])
  out.offset = m[7] && /^[+-]/.test(m[7]) ? parseOffset(m[7]) : m[7] === 'UTC' || m[7] === 'GMT' ? 0 : NO_OFFSET
  return true
}

const RE_DMY = /(\d{1,2})[-/ ]([A-Z][a-z]{2})[-/ ](\d{4})[ :](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/
const parseDmy: Parser = (line, _ctx, out) => {
  const m = RE_DMY.exec(line.length > 200 ? line.slice(0, 200) : line)
  if (!m || m.index > 80) return false
  const mo = MONTHS[m[2].toLowerCase()]
  if (mo === undefined) return false
  out.naive = Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +m[6]) + fracMs(m[7])
  out.offset = NO_OFFSET
  return true
}

const RE_EPOCH = /(?:^\[?|audit\(|^\S+=)(1\d{9})(?:\.(\d{1,9}))?/
const parseEpoch: Parser = (line, _ctx, out) => {
  const m = RE_EPOCH.exec(line.length > 200 ? line.slice(0, 200) : line)
  if (!m) return false
  out.naive = Number(m[1]) * 1000 + fracMs(m[2])
  out.offset = 0
  return true
}

export const PARSERS: Record<string, Parser> = {
  iso: parseIso,
  syslog: parseSyslog,
  clf: parseClf,
  slash: parseSlash,
  ctime: parseCtime,
  dmy: parseDmy,
  epoch: parseEpoch
}

// Order matters when scores tie: more specific formats first.
const DETECT_ORDER = ['iso', 'syslog', 'clf', 'slash', 'ctime', 'dmy', 'epoch']

/** Pick the parser that matches most of the sample lines. Returns 'none' if nothing fits. */
export function detectFormat(lines: string[], ctx: ParseContext, sampleSize = 2000): string {
  const sample: string[] = []
  // sample from start and middle to be robust against headers
  const step = Math.max(1, Math.floor(lines.length / sampleSize))
  for (let i = 0; i < lines.length && sample.length < sampleSize; i += step) {
    if (lines[i].length > 0) sample.push(lines[i])
  }
  if (sample.length === 0) return 'none'
  const out: ParseOut = { naive: 0, offset: NO_OFFSET }
  let best = 'none'
  let bestScore = 0
  for (const id of DETECT_ORDER) {
    const p = PARSERS[id]
    let score = 0
    for (const l of sample) if (p(l, ctx, out)) score++
    if (score > bestScore) {
      best = id
      bestScore = score
    }
  }
  // require at least 10% of lines to carry the timestamp
  return bestScore >= Math.max(1, sample.length * 0.1) ? best : 'none'
}

export function getParser(id: string): Parser | null {
  return PARSERS[id] ?? null
}
