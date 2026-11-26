// Types shared between the main process, preload and renderer.

/** Syslog-style severity. 0..7 as in syslog, 8 = unknown. */
export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export const LEVEL_UNKNOWN = 8
export const LEVEL_NAMES = ['emerg', 'alert', 'crit', 'error', 'warning', 'notice', 'info', 'debug', 'none'] as const

export type DocKind = 'file' | 'journal'

/** Where a document came from. hostId === undefined means "this machine". */
export interface DocSource {
  kind: DocKind
  hostId?: string
  path?: string // for files
  journal?: JournalQuery // for journals
  elevated?: boolean // opened via pkexec / sudo
}

export interface DocInfo {
  id: string
  title: string
  subtitle: string
  source: DocSource
  lineCount: number
  viewCount: number
  /** Bumped every time line content / view changes so the renderer can drop caches. */
  version: number
  loading: boolean
  following: boolean
  error?: string
  // file specific
  encoding?: string
  detectedEncoding?: string
  encodingConfidence?: number
  sizeBytes?: number
  timestampFormat?: string // id of the timestamp parser in use
  detectedTimestampFormat?: string
  /** Time zone used to interpret timestamps that carry no UTC offset. */
  sourceTz: string
  /** True if at least one line carries a timestamp without offset (so sourceTz matters). */
  hasNaiveTimestamps: boolean
  firstTs?: number
  lastTs?: number
}

export interface Row {
  /** Index in the view (filtered list). */
  v: number
  /** Index of the line in the document. */
  i: number
  /** Epoch ms UTC, or null when no timestamp could be determined. */
  ts: number | null
  /** True if the timestamp was inherited from a previous line (continuation line). */
  inh: boolean
  level: Level
  text: string
  /** Journal: syslog identifier (or command name). */
  ident?: string
  /** Journal: systemd unit. */
  unit?: string
  host?: string
  pid?: string
}

export interface FilterSpec {
  include: string
  exclude: string
  regex: boolean
  caseSensitive: boolean
  /** Allowed levels; empty / undefined = all. */
  levels?: Level[]
  from?: number | null
  to?: number | null
  /** Journal only: substring match on unit / syslog identifier. */
  unit?: string
  /** Journal only: substring match on hostname. */
  host?: string
}

export const EMPTY_FILTER: FilterSpec = { include: '', exclude: '', regex: false, caseSensitive: false }

export interface SearchSpec {
  query: string
  regex: boolean
  caseSensitive: boolean
}

export interface JournalQuery {
  /** Max number of entries (from the end), 0 = unlimited. */
  limit: number
  since?: string // journalctl --since syntax, e.g. "2026-11-26 10:00" or "-1h"
  until?: string
  units?: string[]
  identifiers?: string[]
  /** Highest priority to include (0..7) — journalctl -p 0..N */
  priority?: number
  /** Boot offset/id, e.g. "0", "-1" or a boot id. undefined = all boots. */
  boot?: string
  /** Kernel messages only (-k). */
  kernel?: boolean
  /** Journal scope. */
  scope?: 'system' | 'user' | 'all'
  grep?: string
  sudo?: boolean
}

export interface BootInfo {
  index: number
  bootId: string
  first: number
  last: number
}

export interface HostProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  /** Optional explicit private key path. */
  identityFile?: string
  /** Where the profile came from. */
  origin: 'saved' | 'ssh-config'
}

export type HostState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface HostStatus {
  id: string
  state: HostState
  error?: string
  remoteTz?: string
  remoteHostname?: string
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number
  /** Best guess whether the logged in user can read it without sudo. */
  readable: boolean
}

export type PromptKind = 'password' | 'passphrase' | 'hostkey' | 'keyboard' | 'sudo'

export interface PromptRequest {
  reqId: string
  kind: PromptKind
  title: string
  message: string
  /** For keyboard-interactive: list of prompts. */
  prompts?: { prompt: string; echo: boolean }[]
  /** For host keys. */
  fingerprint?: string
  keyType?: string
  danger?: boolean
}

export interface PromptReply {
  reqId: string
  ok: boolean
  values?: string[]
  remember?: boolean
}

export interface Settings {
  displayTz: string // 'local' or IANA name
  fontSize: number
  journalLimit: number
  recentFiles: string[]
  hosts: HostProfile[]
  wrapDetail: boolean
  showLineNumbers: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  displayTz: 'local',
  fontSize: 13,
  journalLimit: 20000,
  recentFiles: [],
  hosts: [],
  wrapDetail: true,
  showLineNumbers: true
}

export interface DocUpdateEvent {
  info: DocInfo
  /** Lines appended (follow mode). */
  appended?: number
}

export interface OpenFileOptions {
  encoding?: string
  elevated?: boolean
}

export interface ApiError {
  code: string
  message: string
}

/** Timestamp formats that can be forced by the user. */
export const TIMESTAMP_FORMATS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto detect' },
  { id: 'iso', label: 'ISO 8601 (2026-11-26T15:08:01.123+01:00)' },
  { id: 'syslog', label: 'Syslog (Nov 26 15:08:01)' },
  { id: 'clf', label: 'Apache/CLF ([26/Nov/2026:15:08:01 +0100])' },
  { id: 'slash', label: 'Slash date (2026/11/26 15:08:01)' },
  { id: 'ctime', label: 'ctime (Thu Nov 26 15:08:01 2026)' },
  { id: 'dmy', label: 'Day-Mon-Year (26-Nov-2026 15:08:01)' },
  { id: 'epoch', label: 'Unix epoch / audit (1795702418.123)' },
  { id: 'none', label: 'No timestamps' }
]

export const ENCODINGS: string[] = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'iso-8859-1',
  'iso-8859-2',
  'iso-8859-15',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'koi8-r',
  'cp437',
  'cp850',
  'shift_jis',
  'euc-jp',
  'gbk',
  'gb18030',
  'big5',
  'euc-kr'
]
