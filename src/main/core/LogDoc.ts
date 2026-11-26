// In-memory log document: lines plus columnar metadata (timestamps, levels,
// journal fields), a filtered view and search / time lookup helpers.

import { LEVEL_UNKNOWN, type DocInfo, type DocSource, type FilterSpec, type Level, type Row, type SearchSpec } from '@shared/types'
import { NaiveConverter, resolveTz } from './timezone'
import { NO_OFFSET, detectFormat, getParser, type ParseContext, type ParseOut } from './timestamps'
import { detectLevel, priFromSyslogPrefix } from './levels'

// ---- growable typed arrays -------------------------------------------------

type TA = Float64Array | Int16Array | Uint8Array | Uint32Array
type TACtor<T extends TA> = { new (n: number): T }

class Grow<T extends TA> {
  arr: T
  len = 0
  constructor(private ctor: TACtor<T>, cap = 1024) {
    this.arr = new ctor(cap)
  }
  ensure(n: number): void {
    if (n <= this.arr.length) return
    let cap = this.arr.length * 2
    while (cap < n) cap *= 2
    const a = new this.ctor(cap)
    a.set(this.arr.subarray(0, this.len) as never)
    this.arr = a
  }
  push(v: number): void {
    if (this.len === this.arr.length) this.ensure(this.len + 1)
    this.arr[this.len++] = v
  }
  reset(cap = 1024): void {
    this.arr = new this.ctor(cap)
    this.len = 0
  }
}

/** Interned string column (journal fields). */
class StrColumn {
  table: string[] = ['']
  map = new Map<string, number>([['', 0]])
  idx = new Grow(Uint32Array)
  push(s: string | undefined): void {
    const k = s ?? ''
    let id = this.map.get(k)
    if (id === undefined) {
      id = this.table.length
      this.table.push(k)
      this.map.set(k, id)
    }
    this.idx.push(id)
  }
  get(i: number): string {
    return this.table[this.idx.arr[i]]
  }
}

export interface JournalEntry {
  ts: number // epoch ms
  prio: Level
  msg: string
  ident?: string
  unit?: string
  host?: string
  pid?: string
}

const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r))
const CHUNK = 250_000

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildRegex(q: string, regex: boolean, caseSensitive: boolean): RegExp | null {
  if (!q) return null
  try {
    return new RegExp(regex ? q : escapeRe(q), caseSensitive ? '' : 'i')
  } catch {
    throw Object.assign(new Error('Invalid regular expression: ' + q), { code: 'EREGEX' })
  }
}

let nextId = 1

export class LogDoc {
  readonly id = 'doc' + nextId++
  title: string
  subtitle = ''
  source: DocSource
  version = 1
  loading = true
  following = false
  error?: string

  // file specific
  raw?: Buffer
  private rawParts: Buffer[] = []
  encoding?: string
  detectedEncoding?: string
  encodingConfidence?: number
  tsFormat = 'auto'
  detectedTsFormat?: string
  refMs = Date.now()

  sourceTz = 'local'

  lines: string[] = []
  private naive = new Grow(Float64Array)
  private offs = new Grow(Int16Array)
  private ts = new Grow(Float64Array)
  private inh = new Grow(Uint8Array)
  private level = new Grow(Uint8Array)
  private ident?: StrColumn
  private unit?: StrColumn
  private host?: StrColumn
  private pid?: StrColumn

  private view: Grow<Uint32Array> | null = null
  filter: FilterSpec | null = null
  private filterFn: ((i: number) => boolean) | null = null
  private filterGen = 0
  private naiveCount = 0
  /** Last timestamp seen while appending (for continuation lines). */
  private lastTs = NaN
  private lastLevel: Level = LEVEL_UNKNOWN

  /** Called when the document needs to dispose external resources (follow processes...). */
  onDispose: (() => void)[] = []

  constructor(source: DocSource, title: string) {
    this.source = source
    this.title = title
    if (source.kind !== 'file') {
      this.ident = new StrColumn()
      this.unit = new StrColumn()
      this.host = new StrColumn()
      this.pid = new StrColumn()
    }
  }

  /** Append bytes received while following (merged lazily). */
  appendRaw(b: Buffer): void {
    this.rawParts.push(b)
  }

  fullRaw(): Buffer {
    if (this.rawParts.length) {
      this.raw = Buffer.concat([this.raw ?? Buffer.alloc(0), ...this.rawParts])
      this.rawParts = []
    }
    return this.raw ?? Buffer.alloc(0)
  }

  get lineCount(): number {
    return this.lines.length
  }

  get viewCount(): number {
    return this.view ? this.view.len : this.lines.length
  }

  info(): DocInfo {
    const n = this.lines.length
    return {
      id: this.id,
      title: this.title,
      subtitle: this.subtitle,
      source: this.source,
      lineCount: n,
      viewCount: this.viewCount,
      version: this.version,
      loading: this.loading,
      following: this.following,
      error: this.error,
      encoding: this.encoding,
      detectedEncoding: this.detectedEncoding,
      encodingConfidence: this.encodingConfidence,
      sizeBytes: this.raw ? this.raw.length + this.rawParts.reduce((a, b) => a + b.length, 0) : undefined,
      timestampFormat: this.source.kind === 'file' ? this.tsFormat : undefined,
      detectedTimestampFormat: this.detectedTsFormat,
      sourceTz: this.sourceTz,
      hasNaiveTimestamps: this.naiveCount > 0,
      firstTs: this.firstTs(),
      lastTs: this.lastTsValue()
    }
  }

  private firstTs(): number | undefined {
    const n = this.ts.len
    for (let i = 0; i < Math.min(n, 1000); i++) if (!Number.isNaN(this.ts.arr[i])) return this.ts.arr[i]
    return undefined
  }

  private lastTsValue(): number | undefined {
    for (let i = this.ts.len - 1; i >= Math.max(0, this.ts.len - 1000); i--) if (!Number.isNaN(this.ts.arr[i])) return this.ts.arr[i]
    return undefined
  }

  dispose(): void {
    for (const f of this.onDispose) {
      try {
        f()
      } catch {
        /* ignore */
      }
    }
    this.onDispose = []
    this.lines = []
    this.raw = undefined
    this.view = null
  }

  // ---- plain text files -----------------------------------------------------

  /** Replace all lines (initial load or encoding change) and (re)compute metadata. */
  setTextLines(lines: string[]): void {
    this.lines = lines
    this.naive.reset(Math.max(1024, lines.length))
    this.offs.reset(Math.max(1024, lines.length))
    this.ts.reset(Math.max(1024, lines.length))
    this.inh.reset(Math.max(1024, lines.length))
    this.level.reset(Math.max(1024, lines.length))
    this.naiveCount = 0
    this.lastTs = NaN
    this.lastLevel = LEVEL_UNKNOWN
    const ctx: ParseContext = { refMs: this.refMs }
    this.detectedTsFormat = detectFormat(lines, ctx)
    this.computeTextMeta(0)
    this.version++
  }

  setTimestampFormat(fmt: string): void {
    this.tsFormat = fmt
    this.naive.len = this.offs.len = this.ts.len = this.inh.len = this.level.len = 0
    this.naiveCount = 0
    this.lastTs = NaN
    this.lastLevel = LEVEL_UNKNOWN
    this.computeTextMeta(0)
    this.version++
  }

  private activeFormat(): string {
    return this.tsFormat === 'auto' ? (this.detectedTsFormat ?? 'none') : this.tsFormat
  }

  /** Compute timestamps/levels for lines[from..]. */
  private computeTextMeta(from: number): void {
    const lines = this.lines
    const n = lines.length
    this.naive.ensure(n)
    this.offs.ensure(n)
    this.ts.ensure(n)
    this.inh.ensure(n)
    this.level.ensure(n)
    const parser = getParser(this.activeFormat())
    const ctx: ParseContext = { refMs: this.refMs }
    const out: ParseOut = { naive: NaN, offset: NO_OFFSET }
    const conv = new NaiveConverter(resolveTz(this.sourceTz))
    const naive = this.naive.arr, offs = this.offs.arr, ts = this.ts.arr, inh = this.inh.arr, level = this.level.arr
    let lastTs = this.lastTs
    let lastLevel = this.lastLevel
    for (let i = from; i < n; i++) {
      const line = lines[i]
      if (parser && line.length > 0 && parser(line, ctx, out)) {
        naive[i] = out.naive
        offs[i] = out.offset
        let t: number
        if (out.offset === NO_OFFSET) {
          t = conv.toUtc(out.naive)
          this.naiveCount++
        } else {
          t = out.naive - out.offset * 60_000
        }
        ts[i] = t
        inh[i] = 0
        lastTs = t
        const pri = priFromSyslogPrefix(line)
        lastLevel = pri ?? detectLevel(line)
        level[i] = lastLevel
      } else {
        naive[i] = NaN
        offs[i] = NO_OFFSET
        ts[i] = lastTs
        inh[i] = 1
        // continuation lines inherit the level unless they state their own
        const lv = detectLevel(line)
        level[i] = lv !== LEVEL_UNKNOWN || !parser ? lv : lastLevel
      }
    }
    this.lastTs = lastTs
    this.lastLevel = lastLevel
    this.naive.len = this.offs.len = this.ts.len = this.inh.len = this.level.len = n
  }

  /** Append lines (follow mode). Returns number of lines appended. */
  appendTextLines(newLines: string[]): number {
    if (newLines.length === 0) return 0
    const from = this.lines.length
    for (const l of newLines) this.lines.push(l)
    this.computeTextMeta(from)
    this.extendView(from)
    return newLines.length
  }

  /** Re-interpret naive timestamps in another zone. */
  setSourceTz(tz: string): void {
    this.sourceTz = tz
    if (this.source.kind !== 'file') return
    const conv = new NaiveConverter(resolveTz(tz))
    const n = this.lines.length
    const naive = this.naive.arr, offs = this.offs.arr, ts = this.ts.arr, inh = this.inh.arr
    let last = NaN
    for (let i = 0; i < n; i++) {
      if (!inh[i]) {
        last = offs[i] === NO_OFFSET ? conv.toUtc(naive[i]) : naive[i] - offs[i] * 60_000
      }
      ts[i] = last
    }
    this.lastTs = last
    this.version++
  }

  // ---- journal --------------------------------------------------------------

  appendJournal(entries: JournalEntry[]): number {
    if (entries.length === 0) return 0
    const from = this.lines.length
    for (const e of entries) {
      this.lines.push(e.msg)
      this.ts.push(e.ts)
      this.naive.push(e.ts)
      this.offs.push(0)
      this.inh.push(0)
      this.level.push(e.prio)
      this.ident!.push(e.ident)
      this.unit!.push(e.unit)
      this.host!.push(e.host)
      this.pid!.push(e.pid)
    }
    this.extendView(from)
    return entries.length
  }

  /** Distinct values of a journal column (for filter suggestions). */
  distinct(col: 'unit' | 'ident' | 'host'): string[] {
    const c = this[col]
    if (!c) return []
    return c.table.filter((s) => s).sort((a, b) => a.localeCompare(b))
  }

  // ---- rows -----------------------------------------------------------------

  lineIndex(v: number): number {
    return this.view ? this.view.arr[v] : v
  }

  row(v: number): Row {
    const i = this.lineIndex(v)
    const t = this.ts.arr[i]
    const r: Row = {
      v,
      i,
      ts: Number.isNaN(t) ? null : t,
      inh: this.inh.arr[i] === 1,
      level: this.level.arr[i] as Level,
      text: this.lines[i]
    }
    if (this.ident) {
      r.ident = this.ident.get(i) || undefined
      r.unit = this.unit!.get(i) || undefined
      r.host = this.host!.get(i) || undefined
      r.pid = this.pid!.get(i) || undefined
    }
    return r
  }

  rows(start: number, count: number): Row[] {
    const n = this.viewCount
    const out: Row[] = []
    const end = Math.min(n, start + count)
    for (let v = Math.max(0, start); v < end; v++) out.push(this.row(v))
    return out
  }

  /** Text used for matching (message, plus identifier for journals). */
  private matchText(i: number): string {
    if (this.ident) {
      const id = this.ident.get(i)
      return id ? id + ': ' + this.lines[i] : this.lines[i]
    }
    return this.lines[i]
  }

  // ---- filtering ------------------------------------------------------------

  private buildFilterFn(f: FilterSpec): ((i: number) => boolean) | null {
    const inc = buildRegex(f.include, f.regex, f.caseSensitive)
    const exc = buildRegex(f.exclude, f.regex, f.caseSensitive)
    const levels = f.levels && f.levels.length > 0 && f.levels.length < 9 ? new Set<number>(f.levels) : null
    const from = f.from ?? null
    const to = f.to ?? null
    const unitQ = this.ident && f.unit ? f.unit.toLowerCase() : null
    const hostQ = this.host && f.host ? f.host.toLowerCase() : null
    if (!inc && !exc && !levels && from === null && to === null && !unitQ && !hostQ) return null
    const lvArr = this.level.arr
    const tsArr = this.ts.arr
    return (i: number) => {
      if (levels && !levels.has(lvArr[i])) return false
      if (from !== null || to !== null) {
        const t = tsArr[i]
        if (Number.isNaN(t)) return false
        if (from !== null && t < from) return false
        if (to !== null && t > to) return false
      }
      if (unitQ) {
        const a = this.ident!.get(i).toLowerCase()
        const b = this.unit!.get(i).toLowerCase()
        if (!a.includes(unitQ) && !b.includes(unitQ)) return false
      }
      if (hostQ && !this.host!.get(i).toLowerCase().includes(hostQ)) return false
      if (inc || exc) {
        const s = this.matchText(i)
        if (inc && !inc.test(s)) return false
        if (exc && exc.test(s)) return false
      }
      return true
    }
  }

  /**
   * Apply a filter. Runs chunked so the main process stays responsive; a newer
   * call cancels an older one (returns false when cancelled).
   */
  async setFilter(f: FilterSpec | null, onProgress?: (done: number, total: number) => void): Promise<boolean> {
    const gen = ++this.filterGen
    const fn = f ? this.buildFilterFn(f) : null
    if (!fn) {
      this.filter = f
      this.filterFn = null
      this.view = null
      this.version++
      return true
    }
    const view = new Grow(Uint32Array, 4096)
    const n = this.lines.length
    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(n, start + CHUNK)
      // the level/ts arrays may have been reallocated while we yielded
      const chunkFn = this.buildFilterFn(f!)!
      for (let i = start; i < end; i++) if (chunkFn(i)) view.push(i)
      if (end < n) {
        onProgress?.(end, n)
        await yieldTick()
        if (gen !== this.filterGen) return false
      }
    }
    // lines appended while filtering
    const fnFinal = this.buildFilterFn(f!)!
    for (let i = n; i < this.lines.length; i++) if (fnFinal(i)) view.push(i)
    this.filter = f
    this.filterFn = fnFinal
    this.view = view
    this.version++
    return true
  }

  /** Re-run the current filter (e.g. after time zone change affects time ranges). */
  async refilter(): Promise<void> {
    await this.setFilter(this.filter)
  }

  private extendView(from: number): void {
    if (!this.view) return
    const fn = this.filter ? this.buildFilterFn(this.filter) : null
    this.filterFn = fn
    if (!fn) return
    for (let i = from; i < this.lines.length; i++) if (fn(i)) this.view.push(i)
  }

  // ---- search ---------------------------------------------------------------

  /**
   * Find the next view index (starting at `from`, inclusive) whose text matches.
   * direction: 1 forward, -1 backward. Wraps around once. Returns -1 if none.
   */
  async search(spec: SearchSpec, from: number, direction: 1 | -1): Promise<number> {
    const re = buildRegex(spec.query, spec.regex, spec.caseSensitive)
    if (!re) return -1
    const n = this.viewCount
    if (n === 0) return -1
    let v = Math.min(Math.max(from, 0), n - 1)
    for (let k = 0; k < n; k++) {
      if (re.test(this.matchText(this.lineIndex(v)))) return v
      v += direction
      if (v >= n) v = 0
      else if (v < 0) v = n - 1
      if ((k + 1) % CHUNK === 0) await yieldTick()
    }
    return -1
  }

  async countMatches(spec: SearchSpec): Promise<number> {
    const re = buildRegex(spec.query, spec.regex, spec.caseSensitive)
    if (!re) return 0
    const n = this.viewCount
    let c = 0
    for (let v = 0; v < n; v++) {
      if (re.test(this.matchText(this.lineIndex(v)))) c++
      if ((v + 1) % CHUNK === 0) await yieldTick()
    }
    return c
  }

  // ---- time lookup ----------------------------------------------------------

  /** First view index whose timestamp is >= t (binary search, assumes mostly sorted). */
  findTime(t: number): number {
    const n = this.viewCount
    let lo = 0, hi = n
    const ts = this.ts.arr
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const x = ts[this.lineIndex(mid)]
      if (Number.isNaN(x) || x < t) lo = mid + 1
      else hi = mid
    }
    return Math.min(lo, Math.max(0, n - 1))
  }

  /** Text of the view range (for copy / export). */
  textRange(start: number, end: number): string[] {
    const out: string[] = []
    for (let v = start; v < Math.min(end, this.viewCount); v++) out.push(this.lines[this.lineIndex(v)])
    return out
  }

  formatJournalLine(v: number, fmt: (ts: number) => string): string {
    const i = this.lineIndex(v)
    const t = this.ts.arr[i]
    if (!this.ident) return this.lines[i]
    const pid = this.pid!.get(i)
    return `${Number.isNaN(t) ? '' : fmt(t)} ${this.host!.get(i)} ${this.ident.get(i) || this.unit!.get(i)}${pid ? '[' + pid + ']' : ''}: ${this.lines[i]}`
  }
}
