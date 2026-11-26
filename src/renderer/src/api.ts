import type {
  BootInfo, DocInfo, DocUpdateEvent, FilterSpec, HostProfile, HostStatus, JournalQuery, OpenFileOptions,
  PromptReply, PromptRequest, RemoteEntry, Row, SearchSpec, Settings, SyslogConfig
} from '@shared/types'

const c = window.glv.call

export const api = {
  settings: () => c<Settings>('settings:get'),
  saveSettings: (p: Partial<Settings>) => c<Settings>('settings:set', p),
  appInfo: () => c<{ platform: string; version: string; initialFiles: string[]; initialJournal: boolean; canElevate: boolean }>('app:info'),
  openFileDialog: () => c<string[]>('dialog:openFiles'),
  openFile: (path: string, opts?: OpenFileOptions) => c<DocInfo>('file:open', path, opts ?? {}),
  openRemoteFile: (hostId: string, path: string, opts?: OpenFileOptions) => c<DocInfo>('remote:openFile', hostId, path, opts ?? {}),
  listLocal: (path: string) => c<RemoteEntry[]>('local:list', path),
  listRemote: (hostId: string, path: string, sudo?: boolean) => c<RemoteEntry[]>('remote:list', hostId, path, sudo),
  openJournal: (q: JournalQuery, hostId: string | undefined, follow: boolean) => c<DocInfo>('journal:open', q, hostId, follow),
  startSyslog: (cfg: SyslogConfig) => c<DocInfo>('syslog:start', cfg),
  netAddresses: () => c<{ name: string; address: string; family: string }[]>('net:addresses'),
  boots: (hostId?: string, sudo?: boolean) => c<BootInfo[]>('journal:boots', hostId, sudo),
  journalFields: (hostId: string | undefined, field: string, sudo?: boolean) => c<string[]>('journal:fields', hostId, field, sudo),
  closeDoc: (id: string) => c<void>('doc:close', id),
  docInfo: (id: string) => c<DocInfo>('doc:info', id),
  rows: (id: string, start: number, count: number) => c<Row[]>('doc:rows', id, start, count),
  setFilter: (id: string, f: FilterSpec | null) => c<DocInfo>('doc:setFilter', id, f),
  search: (id: string, s: SearchSpec, from: number, dir: 1 | -1) => c<number>('doc:search', id, s, from, dir),
  count: (id: string, s: SearchSpec) => c<number>('doc:count', id, s),
  findTime: (id: string, t: number) => c<number>('doc:findTime', id, t),
  setEncoding: (id: string, enc: string) => c<DocInfo>('doc:setEncoding', id, enc),
  setSourceTz: (id: string, tz: string) => c<DocInfo>('doc:setSourceTz', id, tz),
  setTsFormat: (id: string, fmt: string) => c<DocInfo>('doc:setTsFormat', id, fmt),
  follow: (id: string, on: boolean) => c<DocInfo>('doc:follow', id, on),
  text: (id: string, views: number[]) => c<string[]>('doc:text', id, views),
  distinct: (id: string, col: 'unit' | 'ident' | 'host') => c<string[]>('doc:distinct', id, col),
  exportDoc: (id: string, lines: string[] | null) => c<boolean>('doc:export', id, lines),
  hosts: () => c<HostProfile[]>('ssh:hosts'),
  saveHost: (h: HostProfile) => c<HostProfile>('ssh:saveHost', h),
  deleteHost: (id: string) => c<void>('ssh:deleteHost', id),
  connect: (id: string) => c<HostStatus>('ssh:connect', id),
  disconnect: (id: string) => c<void>('ssh:disconnect', id),
  sshStatus: () => c<HostStatus[]>('ssh:status'),
  onDocUpdate: (cb: (e: DocUpdateEvent) => void) => window.glv.on('doc:update', cb as (p: unknown) => void),
  onSshStatus: (cb: (s: HostStatus) => void) => window.glv.on('ssh:status', cb as (p: unknown) => void),
  onPrompt: (cb: (p: PromptRequest) => void) => window.glv.on('prompt', cb as (p: unknown) => void),
  onOpenFiles: (cb: (files: string[]) => void) => window.glv.on('app:openFiles', cb as (p: unknown) => void),
  replyPrompt: (r: PromptReply) => window.glv.replyPrompt(r),
  pathForFile: (f: File) => window.glv.pathForFile(f)
}

export function errMsg(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function errCode(e: unknown): string | undefined {
  return (e as { code?: string })?.code
}
