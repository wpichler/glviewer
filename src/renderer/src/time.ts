// Time formatting in a selectable display time zone.

export function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function resolveTz(tz: string): string {
  return !tz || tz === 'local' ? systemTz() : tz
}

let tzList: string[] | null = null
export function allTimeZones(): string[] {
  if (!tzList) {
    let l: string[] = []
    try {
      l = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
    } catch {
      l = []
    }
    tzList = ['local', 'UTC', ...l.filter((z) => z !== 'UTC')]
  }
  return tzList
}

export function isValidTz(tz: string): boolean {
  if (tz === 'local') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const fmts = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    fmts.set(tz, f)
  }
  return f
}

/** Parts of a UTC instant in a zone. */
function parts(ms: number, tz: string): Record<string, string> {
  const o: Record<string, string> = {}
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value
  return o
}

const tsCache = new Map<string, Map<number, string>>()

/** "2026-11-26 15:08:01.123" in the given zone. Cached per second. */
export function formatTs(ms: number, tz: string): string {
  const z = resolveTz(tz)
  const sec = Math.floor(ms / 1000)
  let c = tsCache.get(z)
  if (!c) {
    c = new Map()
    tsCache.set(z, c)
  }
  let base = c.get(sec)
  if (base === undefined) {
    const p = parts(sec * 1000, z)
    base = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
    if (c.size > 20000) c.clear()
    c.set(sec, base)
  }
  const msPart = Math.floor(ms - sec * 1000)
  return base + '.' + String(msPart).padStart(3, '0')
}

/** Offset in minutes of tz at instant ms. */
export function offsetMinutes(ms: number, tz: string): number {
  const z = resolveTz(tz)
  const p = parts(ms, z)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000)
}

export function formatOffset(min: number): string {
  const s = min < 0 ? '-' : '+'
  const a = Math.abs(min)
  return `UTC${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

export function tzLabel(tz: string): string {
  const z = resolveTz(tz)
  const off = formatOffset(offsetMinutes(Date.now(), z))
  return tz === 'local' ? `Local (${z}, ${off})` : `${z} (${off})`
}

/** Value for <input type="datetime-local"> showing instant ms in tz. */
export function toLocalInput(ms: number | null | undefined, tz: string): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return ''
  return formatTs(ms, tz).slice(0, 19).replace(' ', 'T')
}

/** Parse an <input type="datetime-local"> value interpreted in tz into UTC ms. */
export function fromLocalInput(v: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v)
  if (!m) return null
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
  const z = resolveTz(tz)
  const guess = naive - offsetMinutes(naive, z) * 60000
  return naive - offsetMinutes(guess, z) * 60000
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MiB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GiB'
}

export function formatDuration(ms: number): string {
  const a = Math.abs(ms)
  if (a < 1000) return `${Math.round(ms)} ms`
  if (a < 60000) return `${(ms / 1000).toFixed(1)} s`
  if (a < 3600000) return `${(ms / 60000).toFixed(1)} min`
  if (a < 86400000) return `${(ms / 3600000).toFixed(1)} h`
  return `${(ms / 86400000).toFixed(1)} d`
}
