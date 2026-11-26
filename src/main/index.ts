import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { join, basename, posix } from 'node:path'
import { writeFile, readdir, stat, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { SyslogConfig, RemoteEntry, DocInfo, FilterSpec, HostProfile, JournalQuery, OpenFileOptions, PromptReply, PromptRequest, SearchSpec, Settings } from '@shared/types'
import { LogDoc } from './core/LogDoc'
import { makeStreamDecoder } from './core/encoding'
import { decodeInto, followLocalFile, isCompressed, loadBytes, maybeDecompress, openLocalFile } from './sources/files'
import { listBoots, listFieldValues, localRunner, openJournal, type Runner } from './sources/journal'
import { SshManager } from './sources/ssh'
import { startSyslog } from './sources/syslog'
import { readSshConfigHosts } from './sources/sshconfig'
import { addRecentFile, loadSettings, saveSettings } from './settings'

const docs = new Map<string, LogDoc>()
let win: BrowserWindow | null = null

// ---- events to the renderer ---------------------------------------------

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const pendingUpdates = new Map<string, { appended: number; timer: NodeJS.Timeout }>()
function notifyDoc(doc: LogDoc, appended = 0): void {
  const p = pendingUpdates.get(doc.id)
  if (p) {
    p.appended += appended
    return
  }
  const entry = {
    appended,
    timer: setTimeout(() => {
      pendingUpdates.delete(doc.id)
      if (docs.has(doc.id)) send('doc:update', { info: doc.info(), appended: entry.appended })
    }, 120)
  }
  pendingUpdates.set(doc.id, entry)
}

// ---- prompts (passwords, host keys) ---------------------------------------

const pendingPrompts = new Map<string, (r: PromptReply) => void>()
function prompt(req: Omit<PromptRequest, 'reqId'>): Promise<PromptReply> {
  return new Promise((resolve) => {
    const reqId = randomUUID()
    pendingPrompts.set(reqId, resolve)
    send('prompt', { ...req, reqId })
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

let ssh: SshManager

// ---- helpers ----------------------------------------------------------------

function getDoc(id: string): LogDoc {
  const d = docs.get(id)
  if (!d) throw Object.assign(new Error('Document is closed'), { code: 'ENODOC' })
  return d
}

function register(doc: LogDoc): DocInfo {
  docs.set(doc.id, doc)
  return doc.info()
}

function runnerFor(hostId?: string): Runner {
  return hostId ? ssh.runner(hostId) : localRunner
}

function allHosts(): HostProfile[] {
  const saved = loadSettings().hosts
  const cfg = readSshConfigHosts().filter((c) => !saved.some((s) => s.name === c.name))
  return [...saved, ...cfg]
}

function hostById(id: string): HostProfile {
  const h = allHosts().find((x) => x.id === id)
  if (!h) throw Object.assign(new Error('Unknown host ' + id), { code: 'ENOHOST' })
  return h
}

/** Wrap handlers so errors arrive in the renderer with code + message. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return { ok: true, value: await fn(...(args as A)) }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return { ok: false, error: { code: err.code ?? 'ERROR', message: err.message ?? String(e) } }
    }
  })
}

async function openRemoteFile(hostId: string, path: string, opts: OpenFileOptions): Promise<LogDoc> {
  const host = hostById(hostId)
  const st = ssh.status(hostId)
  const doc = new LogDoc({ kind: 'file', hostId, path, elevated: opts.elevated }, posix.basename(path))
  doc.subtitle = `${host.name}:${posix.dirname(path)}`
  if (st.remoteTz) doc.sourceTz = st.remoteTz
  const { data, mtime } = await ssh.readFile(hostId, path, !!opts.elevated)
  doc.refMs = mtime
  loadBytes(doc, maybeDecompress(data, path), opts.encoding)
  doc.loading = false
  return doc
}

async function startSyslogDoc(doc: LogDoc): Promise<void> {
  const cfg = doc.source.syslog!
  const l = await startSyslog(cfg, (entries) => {
    const n = doc.appendJournal(entries)
    notifyDoc(doc, n)
  })
  doc.onDispose.push(() => l.close())
  doc.following = true
  doc.subtitle = 'listening on ' + l.endpoints.join(', ')
}

async function startFollow(doc: LogDoc): Promise<void> {
  if (doc.following) return
  const src = doc.source
  if (src.kind === 'syslog') return startSyslogDoc(doc)
  if (src.kind === 'journal') {
    // journals are followed by re-opening with -f (handled in journal:open)
    throw Object.assign(new Error('Re-open the journal with "Follow" enabled'), { code: 'EUNSUPPORTED' })
  }
  if (doc.raw && isCompressed(doc.raw)) throw Object.assign(new Error('Compressed files cannot be followed'), { code: 'EUNSUPPORTED' })
  if (src.hostId) {
    const decoder = makeStreamDecoder(doc.encoding ?? 'utf-8')
    const from = doc.fullRaw().length
    void ssh
      .tail(src.hostId, src.path!, from, !!src.elevated, (b) => {
        doc.appendRaw(Buffer.from(b))
        const n = doc.appendTextLines(decoder.write(b))
        if (n) notifyDoc(doc, n)
      })
      .then((stop) => doc.onDispose.push(stop))
  } else {
    if (src.elevated) throw Object.assign(new Error('Files opened with administrator rights cannot be followed'), { code: 'EUNSUPPORTED' })
    const stop = followLocalFile(
      doc,
      (n) => notifyDoc(doc, n),
      () => notifyDoc(doc, 0)
    )
    doc.onDispose.push(stop)
  }
  doc.following = true
}

function stopFollow(doc: LogDoc): void {
  for (const f of doc.onDispose) f()
  doc.onDispose = []
  doc.following = false
  if (doc.source.kind === 'syslog') doc.subtitle = 'stopped'
}

// ---- IPC ----------------------------------------------------------------------

function registerIpc(): void {
  handle('settings:get', () => loadSettings())
  handle('settings:set', (patch: Partial<Settings>) => saveSettings(patch))
  handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    initialFiles: initialFiles,
    initialJournal
  }))

  handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open log files',
      defaultPath: process.platform === 'win32' ? undefined : '/var/log',
      properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
      filters: [
        { name: 'Log files', extensions: ['log', 'txt', 'gz', 'out', 'err', '1', '2', '3', 'old', 'zst'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })

  handle('file:open', async (path: string, opts: OpenFileOptions = {}) => {
    const doc = await openLocalFile(path, opts)
    addRecentFile(path)
    return register(doc)
  })

  handle('remote:openFile', async (hostId: string, path: string, opts: OpenFileOptions = {}) => {
    return register(await openRemoteFile(hostId, path, opts))
  })

  handle('local:list', async (path: string) => {
    const ents = await readdir(path, { withFileTypes: true })
    const out: RemoteEntry[] = []
    for (const e of ents) {
      const full = join(path, e.name)
      try {
        const st = await stat(full)
        let readable = true
        try {
          await access(full, st.isDirectory() ? fsConstants.R_OK | fsConstants.X_OK : fsConstants.R_OK)
        } catch {
          readable = false
        }
        out.push({ name: e.name, path: full, isDir: st.isDirectory(), isLink: e.isSymbolicLink(), size: st.size, mtime: st.mtimeMs, readable })
      } catch {
        /* dangling link etc. */
      }
    }
    return out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })))
  })

  handle('remote:list', (hostId: string, path: string, sudo?: boolean) => ssh.listDir(hostId, path, !!sudo))

  handle('journal:open', async (q: JournalQuery, hostId: string | undefined, follow: boolean) => {
    const host = hostId ? hostById(hostId) : undefined
    const title = (host ? host.name + ' — ' : '') + (q.scope === 'user' ? 'User journal' : 'Journal')
    const doc = await openJournal(runnerFor(hostId), q, title, hostId, follow, (d, n) => notifyDoc(d, n))
    return register(doc)
  })
  handle('syslog:start', async (cfg: SyslogConfig) => {
    saveSettings({ syslog: cfg })
    const proto = [cfg.udp && 'UDP', cfg.tcp && 'TCP'].filter(Boolean).join('+')
    const doc = new LogDoc({ kind: 'syslog', syslog: cfg }, `Syslog :${cfg.port} ${proto}`)
    doc.sourceTz = 'UTC'
    doc.loading = false
    await startSyslogDoc(doc)
    return register(doc)
  })
  handle('net:addresses', () => {
    const out: { name: string; address: string; family: string }[] = []
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const a of list ?? []) if (!a.internal) out.push({ name, address: a.address, family: a.family })
    }
    return out
  })
  handle('journal:boots', (hostId?: string, sudo?: boolean) => listBoots(runnerFor(hostId), sudo))
  handle('journal:fields', (hostId: string | undefined, field: string, sudo?: boolean) => listFieldValues(runnerFor(hostId), field, sudo))

  handle('doc:close', (id: string) => {
    const d = docs.get(id)
    if (d) {
      d.dispose()
      docs.delete(id)
    }
  })
  handle('doc:info', (id: string) => getDoc(id).info())
  handle('doc:rows', (id: string, start: number, count: number) => getDoc(id).rows(start, count))
  handle('doc:setFilter', async (id: string, f: FilterSpec | null) => {
    const d = getDoc(id)
    await d.setFilter(f)
    return d.info()
  })
  handle('doc:search', (id: string, s: SearchSpec, from: number, dir: 1 | -1) => getDoc(id).search(s, from, dir))
  handle('doc:count', (id: string, s: SearchSpec) => getDoc(id).countMatches(s))
  handle('doc:findTime', (id: string, t: number) => getDoc(id).findTime(t))
  handle('doc:setEncoding', async (id: string, enc: string) => {
    const d = getDoc(id)
    if (d.source.kind !== 'file') throw new Error('Encoding can only be changed for files')
    d.encoding = enc === 'auto' ? d.detectedEncoding : enc
    decodeInto(d)
    await d.refilter()
    return d.info()
  })
  handle('doc:setSourceTz', async (id: string, tz: string) => {
    const d = getDoc(id)
    d.setSourceTz(tz)
    await d.refilter()
    return d.info()
  })
  handle('doc:setTsFormat', async (id: string, fmt: string) => {
    const d = getDoc(id)
    d.setTimestampFormat(fmt)
    await d.refilter()
    return d.info()
  })
  handle('doc:follow', async (id: string, on: boolean) => {
    const d = getDoc(id)
    if (on) await startFollow(d)
    else stopFollow(d)
    return d.info()
  })
  handle('doc:text', (id: string, views: number[]) => {
    const d = getDoc(id)
    return views.map((v) => d.textRange(v, v + 1)[0] ?? '')
  })
  handle('doc:distinct', (id: string, col: 'unit' | 'ident' | 'host') => getDoc(id).distinct(col))
  handle('doc:export', async (id: string, lines: string[] | null) => {
    const d = getDoc(id)
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export visible lines',
      defaultPath: d.title.replace(/[^\w.-]+/g, '_') + (d.filter ? '-filtered' : '') + '.log'
    })
    if (r.canceled || !r.filePath) return false
    const text = lines ?? d.textRange(0, d.viewCount)
    await writeFile(r.filePath, text.join('\n') + '\n', 'utf8')
    return true
  })

  handle('ssh:hosts', () => allHosts())
  handle('ssh:saveHost', (h: HostProfile) => {
    const s = loadSettings()
    const prof: HostProfile = { ...h, id: h.origin === 'saved' && h.id ? h.id : 'h:' + randomUUID(), origin: 'saved' }
    const hosts = s.hosts.some((x) => x.id === prof.id) ? s.hosts.map((x) => (x.id === prof.id ? prof : x)) : [...s.hosts, prof]
    saveSettings({ hosts })
    return prof
  })
  handle('ssh:deleteHost', (id: string) => {
    ssh.disconnect(id)
    saveSettings({ hosts: loadSettings().hosts.filter((h) => h.id !== id) })
  })
  handle('ssh:connect', (id: string) => ssh.connect(hostById(id)))
  handle('ssh:disconnect', (id: string) => {
    for (const d of docs.values()) if (d.source.hostId === id) stopFollow(d)
    ssh.disconnect(id)
  })
  handle('ssh:status', () => ssh.allStatus())

  handle('shell:showItem', (p: string) => shell.showItemInFolder(p))

  ipcMain.on('prompt:reply', (_e, r: PromptReply) => {
    const f = pendingPrompts.get(r.reqId)
    if (f) {
      pendingPrompts.delete(r.reqId)
      f(r)
    }
  })
}

// ---- command line -------------------------------------------------------------

const argv = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('--') || a === '--journal')
const initialJournal = argv.includes('--journal')
const initialFiles = argv.filter((a) => a !== '--journal' && a !== '.' && !a.endsWith('.js'))

// ---- window -----------------------------------------------------------------

function overlayColors(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: dark ? '#2e2e32' : '#ebebed', symbolColor: dark ? '#ffffff' : '#2e3436', height: 46 }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    title: 'GLViewer',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#222226' : '#fafafb',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 16 } } : { titleBarOverlay: overlayColors() }),
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  nativeTheme.on('updated', () => {
    if (!isMac && win && !win.isDestroyed()) {
      try {
        win.setTitleBarOverlay(overlayColors())
      } catch {
        /* not supported */
      }
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  // Developer aid: GLV_SCREENSHOT=/path/to.png captures the window after load.
  const shot = app.isPackaged ? undefined : process.env.GLV_SCREENSHOT
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // GLV_EVAL: JS run in the renderer before the capture (developer testing only)
        if (process.env.GLV_EVAL) {
          try {
            const r = await win!.webContents.executeJavaScript(process.env.GLV_EVAL, true)
            console.log('GLV_EVAL:', JSON.stringify(r))
          } catch (e) {
            console.log('GLV_EVAL error:', e)
          }
          await new Promise((r) => setTimeout(r, Number(process.env.GLV_EVAL_WAIT ?? 1500)))
        }
        const img = await win!.webContents.capturePage()
        await writeFile(shot, img.toPNG())
        if (!process.env.GLV_KEEP_OPEN) app.quit()
      }, Number(process.env.GLV_SCREENSHOT_DELAY ?? 3000))
    })
  }
}

app.setName('GLViewer')
// developer aid: isolated profile directory
if (!app.isPackaged && process.env.GLV_USER_DATA) app.setPath('userData', process.env.GLV_USER_DATA)
if (!app.isPackaged && process.env.GLV_THEME) nativeTheme.themeSource = process.env.GLV_THEME as 'light' | 'dark'
const gotLock = !app.isPackaged && process.env.GLV_SCREENSHOT ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, args) => {
    const files = args.slice(1).filter((a) => !a.startsWith('-') && basename(a) !== '.' && !a.endsWith('.js'))
    if (files.length) send('app:openFiles', files)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    ssh = new SshManager(join(app.getPath('userData'), 'known_hosts'), prompt, (s) => send('ssh:status', s))
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    for (const d of docs.values()) d.dispose()
    docs.clear()
    ssh?.disconnectAll()
    if (process.platform !== 'darwin') app.quit()
  })
}
