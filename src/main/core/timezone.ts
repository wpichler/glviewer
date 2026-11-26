// Time zone helpers based on Intl — no tz database needs to be shipped.

const fmtCache = new Map<string, Intl.DateTimeFormat>()

export function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function resolveTz(tz: string | undefined): string {
  if (!tz || tz === 'local') return systemTz()
  return tz
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    fmtCache.set(tz, f)
  }
  return f
}

/** Offset (ms) of `tz` relative to UTC at the given UTC instant: local = utc + offset. */
export function tzOffsetAt(tz: string, utcMs: number): number {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 0
  const parts = formatter(tz).formatToParts(new Date(utcMs))
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0
  for (const p of parts) {
    switch (p.type) {
      case 'year': y = +p.value; break
      case 'month': mo = +p.value; break
      case 'day': d = +p.value; break
      case 'hour': h = +p.value; break
      case 'minute': mi = +p.value; break
      case 'second': s = +p.value; break
    }
  }
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  const secMs = utcMs - Math.floor(utcMs / 1000) * 1000
  return asUtc - (utcMs - secMs)
}

/**
 * Converts "naive" wall clock times (encoded as if they were UTC) to real UTC
 * instants for a given zone. Results are cached per hour bucket which makes
 * converting millions of lines cheap.
 */
export class NaiveConverter {
  private cache = new Map<number, number>()
  constructor(private tz: string) {}

  toUtc(naiveMs: number): number {
    if (this.tz === 'UTC' || this.tz === 'Etc/UTC') return naiveMs
    const bucket = Math.floor(naiveMs / 3_600_000)
    let off = this.cache.get(bucket)
    if (off === undefined) {
      // two-pass guess handles DST transitions reasonably
      const guess = naiveMs - tzOffsetAt(this.tz, naiveMs)
      off = tzOffsetAt(this.tz, guess)
      this.cache.set(bucket, off)
    }
    return naiveMs - off
  }
}
