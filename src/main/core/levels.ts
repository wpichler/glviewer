import { LEVEL_UNKNOWN, type Level } from '@shared/types'

// Matches common severity tokens near the start of a line.
const RE_LEVEL =
  /(?:^|[\s[(<|:"=])(EMERG(?:ENCY)?|ALERT|CRIT(?:ICAL)?|FATAL|SEVERE|ERR(?:OR)?|WARN(?:ING)?|NOTICE|INFO|DEBUG|TRACE|VERBOSE)(?=$|[\s\]):>|,"])/i

const MAP: Record<string, Level> = {
  emerg: 0, emergency: 0,
  alert: 1,
  crit: 2, critical: 2, fatal: 2, severe: 2,
  err: 3, error: 3,
  warn: 4, warning: 4,
  notice: 5,
  info: 6,
  debug: 7, trace: 7, verbose: 7
}

/** Heuristic severity detection; only looks at the beginning of the line. */
export function detectLevel(line: string): Level {
  const head = line.length > 160 ? line.slice(0, 160) : line
  const m = RE_LEVEL.exec(head)
  if (!m) return LEVEL_UNKNOWN
  return MAP[m[1].toLowerCase()] ?? LEVEL_UNKNOWN
}

/** Convert syslog <PRI> prefix if present. */
export function priFromSyslogPrefix(line: string): Level | null {
  if (line.charCodeAt(0) !== 60 /* < */) return null
  const m = /^<(\d{1,3})>/.exec(line)
  if (!m) return null
  return (Number(m[1]) & 7) as Level
}
