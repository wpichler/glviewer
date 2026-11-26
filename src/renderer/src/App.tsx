import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, DEFAULT_SYSLOG, type SyslogConfig, type DocInfo, type HostProfile, type HostStatus, type JournalQuery, type PromptRequest, type Settings } from '@shared/types'
import { api, errCode, errMsg } from './api'
import { Icon } from './icons'
import { allTimeZones, isValidTz, tzLabel } from './time'
import { Sidebar, type OpenTarget } from './components/Sidebar'
import { LogPane } from './components/LogPane'
import type { LogViewHandle } from './components/LogView'
import { ComboInput } from './components/ComboInput'
import { HostDialog, JournalDialog, PromptDialog, SyslogDialog } from './components/Dialogs'

interface Pane {
  id: string
  tabs: string[]
  active: string | null
  synced: boolean
  flex: number
}

interface Toast {
  id: number
  msg: string
  kind: 'error' | 'info'
  action?: { label: string; run(): void }
}

let paneSeq = 1
const newPane = (tabs: string[] = []): Pane => ({ id: 'p' + paneSeq++, tabs, active: tabs[0] ?? null, synced: true, flex: 1 })

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [platform, setPlatform] = useState('linux')
  const [canElevate, setCanElevate] = useState(false)
  const canElevateRef = useRef(false)
  const [docs, setDocs] = useState<Record<string, DocInfo>>({})
  const [panes, setPanes] = useState<Pane[]>(() => [newPane()])
  const [focused, setFocused] = useState<string>(() => 'p1')
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [status, setStatus] = useState<Record<string, HostStatus>>({})
  const [journalDlg, setJournalDlg] = useState<{ hostId?: string } | null>(null)
  const [hostDlg, setHostDlg] = useState<{ host?: HostProfile } | null>(null)
  const [syslogDlg, setSyslogDlg] = useState(false)
  const [prompts, setPrompts] = useState<PromptRequest[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [syncMarks, setSyncMarks] = useState<Record<string, number | null>>({})
  const [sidebar, setSidebar] = useState(true)
  const [tzInput, setTzInput] = useState('local')
  const [busy, setBusy] = useState(0)
  const handles = useRef<Record<string, LogViewHandle | null>>({})
  const panesRef = useRef(panes)
  panesRef.current = panes
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const docsRef = useRef(docs)
  docsRef.current = docs

  const toast = useCallback((msg: string, kind: Toast['kind'] = 'error', action?: Toast['action']) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, msg, kind, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 12000 : 6000)
  }, [])

  const refreshHosts = useCallback(() => api.hosts().then(setHosts, (e) => toast(errMsg(e))), [toast])

  // ---- document management --------------------------------------------------

  const addDoc = useCallback((info: DocInfo, opts: { newPane?: boolean; paneId?: string; replace?: string } = {}) => {
    setDocs((d) => {
      const n = { ...d, [info.id]: info }
      if (opts.replace) delete n[opts.replace]
      return n
    })
    setPanes((ps) => {
      if (opts.replace) {
        return ps.map((p) =>
          p.tabs.includes(opts.replace!) ? { ...p, tabs: p.tabs.map((t) => (t === opts.replace ? info.id : t)), active: p.active === opts.replace ? info.id : p.active } : p
        )
      }
      if (opts.newPane || ps.length === 0) {
        // reuse an empty pane if there is one
        const empty = ps.find((p) => p.tabs.length === 0)
        if (empty) {
          setFocused(empty.id)
          return ps.map((p) => (p === empty ? { ...p, tabs: [info.id], active: info.id } : p))
        }
        const np = newPane([info.id])
        setFocused(np.id)
        return [...ps, np]
      }
      const target = ps.find((p) => p.id === (opts.paneId ?? focusedRef.current)) ?? ps[0]
      return ps.map((p) => (p === target ? { ...p, tabs: [...p.tabs, info.id], active: info.id } : p))
    })
  }, [])

  const withBusy = async <T,>(p: Promise<T>): Promise<T> => {
    setBusy((b) => b + 1)
    try {
      return await p
    } finally {
      setBusy((b) => b - 1)
    }
  }

  const openTarget = useCallback(
    async (t: OpenTarget, extra: { encoding?: string; replace?: string } = {}) => {
      // without administrator access (e.g. Flatpak), try a normal open and explain on failure
      if (!t.hostId && t.sudo && !canElevateRef.current) t = { ...t, sudo: false }
      try {
        const info = await withBusy(
          t.hostId
            ? api.openRemoteFile(t.hostId, t.path, { elevated: t.sudo, encoding: extra.encoding })
            : api.openFile(t.path, { elevated: t.sudo, encoding: extra.encoding })
        )
        addDoc(info, { newPane: t.newPane, replace: extra.replace })
        if (!t.hostId) api.settings().then(setSettings, () => {})
      } catch (e) {
        if (errCode(e) === 'EACCES' && !t.sudo && !t.hostId && !canElevateRef.current) {
          toast(`${errMsg(e)}. Administrator access is not available in this version (Flatpak sandbox).`)
        } else if (errCode(e) === 'EACCES' && !t.sudo) {
          toast(`${errMsg(e)}`, 'error', {
            label: t.hostId ? 'Open with sudo' : 'Open as administrator',
            run: () => void openTarget({ ...t, sudo: true }, extra)
          })
        } else toast(errMsg(e))
      }
    },
    [addDoc, toast]
  )

  const openJournal = useCallback(
    async (q: JournalQuery, hostId: string | undefined, follow: boolean, opts: { newPane?: boolean; replace?: string } = {}) => {
      try {
        const info = await withBusy(api.openJournal(q, hostId, follow))
        addDoc(info, opts)
      } catch (e) {
        toast(errMsg(e))
      }
    },
    [addDoc, toast]
  )

  const openSyslog = useCallback(
    async (cfg: SyslogConfig, opts: { newPane?: boolean; replace?: string } = {}) => {
      try {
        const info = await withBusy(api.startSyslog(cfg))
        addDoc(info, opts)
        setSettings((s) => ({ ...s, syslog: cfg }))
      } catch (e) {
        toast(errMsg(e))
      }
    },
    [addDoc, toast]
  )

  const quickJournal = (hostId?: string, inNewPane?: boolean): void =>
    void openJournal({ limit: settings.journalLimit, boot: '0' }, hostId, false, { newPane: inNewPane })

  const closeDoc = useCallback((id: string) => {
    void api.closeDoc(id).catch(() => {})
    setDocs((d) => {
      const n = { ...d }
      delete n[id]
      return n
    })
    setPanes((ps) => {
      const res = ps.map((p) => {
        if (!p.tabs.includes(id)) return p
        const idx = p.tabs.indexOf(id)
        const tabs = p.tabs.filter((t) => t !== id)
        return { ...p, tabs, active: p.active === id ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : p.active }
      })
      // drop empty panes except the last remaining one
      const nonEmpty = res.filter((p) => p.tabs.length > 0)
      return nonEmpty.length ? nonEmpty : [res[0]]
    })
  }, [])

  const reopen = useCallback(
    (id: string, opts: { follow?: boolean } = {}) => {
      const info = docsRef.current[id]
      if (!info) return
      const s = info.source
      if (s.kind === 'syslog' && s.syslog) {
        // the old listener must release the port before a new one can bind it
        const cfg = s.syslog
        void api.closeDoc(id).then(() => openSyslog(cfg, { replace: id }))
      } else if (s.kind === 'journal' && s.journal) {
        void openJournal(s.journal, s.hostId, opts.follow ?? info.following, { replace: id }).then(() => void api.closeDoc(id).catch(() => {}))
      } else if (s.path) {
        void openTarget({ hostId: s.hostId, path: s.path, sudo: s.elevated }, { encoding: info.encoding, replace: id }).then(() => void api.closeDoc(id).catch(() => {}))
      }
    },
    [openJournal, openTarget, openSyslog]
  )

  // ---- startup & events --------------------------------------------------------

  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s)
      setTzInput(s.displayTz)
    }, () => {})
    void refreshHosts()
    api.sshStatus().then((l) => setStatus(Object.fromEntries(l.map((s) => [s.id, s]))), () => {})
    const offs = [
      api.onDocUpdate((e) => setDocs((d) => (d[e.info.id] ? { ...d, [e.info.id]: e.info } : d))),
      api.onSshStatus((s) => setStatus((st) => ({ ...st, [s.id]: s }))),
      api.onPrompt((p) => setPrompts((q) => [...q, p])),
      api.onOpenFiles((files) => files.forEach((f) => void openTarget({ path: f })))
    ]
    api.appInfo().then(async (inf) => {
      setPlatform(inf.platform)
      setCanElevate(inf.canElevate)
      canElevateRef.current = inf.canElevate
      if (inf.initialJournal) await openJournal({ limit: DEFAULT_SETTINGS.journalLimit, boot: '0' }, undefined, false, { newPane: true })
      for (const f of inf.initialFiles) await openTarget({ path: f, newPane: true })
    }, () => {})
    return () => offs.forEach((o) => o())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const updateSettings = (p: Partial<Settings>): void => {
    setSettings((s) => ({ ...s, ...p }))
    void api.saveSettings(p).catch(() => {})
  }

  // ---- time synchronisation -----------------------------------------------------

  const onSync = useCallback((fromPane: string, ts: number, align: 'top' | 'center') => {
    for (const p of panesRef.current) {
      if (p.id === fromPane || !p.synced || !p.active) continue
      const h = handles.current[p.id]
      if (!h) continue
      void h.scrollToTime(ts, align).then(
        (v) => setSyncMarks((m) => ({ ...m, [p.id]: v })),
        () => {}
      )
    }
    setSyncMarks((m) => ({ ...m, [fromPane]: null }))
  }, [])

  // ---- splitter -----------------------------------------------------------------

  const workspaceRef = useRef<HTMLDivElement>(null)
  const startResize = (i: number, e: React.PointerEvent): void => {
    e.preventDefault()
    const ws = workspaceRef.current!
    const total = ws.clientWidth
    const startX = e.clientX
    const a = panesRef.current[i], b = panesRef.current[i + 1]
    const sum = a.flex + b.flex
    const totalFlex = panesRef.current.reduce((x, p) => x + p.flex, 0)
    const aPx = (a.flex / totalFlex) * total
    const pairPx = (sum / totalFlex) * total
    const move = (ev: PointerEvent): void => {
      const na = Math.max(200, Math.min(pairPx - 200, aPx + ev.clientX - startX))
      const fa = (na / pairPx) * sum
      setPanes((ps) => ps.map((p) => (p.id === a.id ? { ...p, flex: fa } : p.id === b.id ? { ...p, flex: sum - fa } : p)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const moveTab = (docId: string, toPane: string | 'new'): void => {
    setPanes((ps) => {
      let res = ps.map((p) => {
        if (!p.tabs.includes(docId)) return p
        const tabs = p.tabs.filter((t) => t !== docId)
        return { ...p, tabs, active: p.active === docId ? (tabs[0] ?? null) : p.active }
      })
      if (toPane === 'new') {
        const np = newPane([docId])
        res = [...res, np]
        setFocused(np.id)
      } else res = res.map((p) => (p.id === toPane ? { ...p, tabs: [...p.tabs, docId], active: docId } : p))
      const nonEmpty = res.filter((p) => p.tabs.length > 0)
      return nonEmpty.length ? nonEmpty : [res[0]]
    })
  }

  // ---- drag & drop files ------------------------------------------------------------

  const onDrop = (e: React.DragEvent): void => {
    if (e.dataTransfer.types.includes('application/x-glv-doc')) return
    e.preventDefault()
    const files = [...e.dataTransfer.files]
    files.forEach((f, i) => {
      const p = api.pathForFile(f)
      if (p) void openTarget({ path: p, newPane: i > 0 || files.length > 1 })
    })
  }

  // ---- host actions ---------------------------------------------------------------

  const connect = async (h: HostProfile): Promise<void> => {
    try {
      await api.connect(h.id)
    } catch (e) {
      toast(`${h.name}: ${errMsg(e)}`)
    }
  }

  const multi = panes.filter((p) => p.active).length > 1
  const isMac = platform === 'darwin'
  const activeDoc = docs[panes.find((p) => p.id === focused)?.active ?? '']

  return (
    <div className={'app' + (isMac ? ' mac' : '')} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="headerbar">
        <div className="hb-start">
          <button className={'flat' + (sidebar ? ' on' : '')} title="Toggle sidebar" onClick={() => setSidebar(!sidebar)}>
            <Icon name="sidebar" />
          </button>
          <button className="flat" title="Open file (Ctrl+O)" onClick={() => void api.openFileDialog().then((ps) => ps.forEach((p, i) => void openTarget({ path: p, newPane: i > 0 })))}>
            <Icon name="folder-open" />
          </button>
          <button className="flat" title="Open system journal" onClick={() => setJournalDlg({})}>
            <Icon name="journal" />
          </button>
          <button className="flat" title="New pane (side by side)" onClick={() => setPanes((ps) => [...ps, newPane()])}>
            <Icon name="split" />
          </button>
        </div>
        <div className="hb-title">
          <span className="title">{activeDoc ? activeDoc.title : 'GLViewer'}</span>
          {activeDoc && <span className="subtitle">{activeDoc.subtitle}</span>}
        </div>
        <div className="hb-end">
          {busy > 0 && <span className="spinner" title="Loading…" />}
          <label className="tzpicker" title={'Display time zone: ' + tzLabel(settings.displayTz)}>
            <Icon name="clock" />
            <ComboInput
              className={isValidTz(tzInput) ? '' : 'invalid'}
              value={tzInput}
              options={allTimeZones()}
              onFocus={(e) => e.target.select()}
              onChange={(v) => {
                setTzInput(v)
                if (v && isValidTz(v)) updateSettings({ displayTz: v })
              }}
            />
          </label>
          <div className="linked">
            <button className="flat" title="Smaller text" onClick={() => updateSettings({ fontSize: Math.max(9, settings.fontSize - 1) })}>
              A−
            </button>
            <button className="flat" title="Larger text" onClick={() => updateSettings({ fontSize: Math.min(24, settings.fontSize + 1) })}>
              A+
            </button>
          </div>
          <button
            className={'flat' + (settings.showLineNumbers ? ' on' : '')}
            title="Line numbers"
            onClick={() => updateSettings({ showLineNumbers: !settings.showLineNumbers })}
          >
            #
          </button>
        </div>
      </header>
      <div className="main">
        {sidebar && (
          <Sidebar
            hosts={hosts}
            status={status}
            recent={settings.recentFiles}
            onOpenFile={(t) => void openTarget(t)}
            onOpenFileDialog={() => void api.openFileDialog().then((ps) => ps.forEach((p, i) => void openTarget({ path: p, newPane: i > 0 })))}
            onJournal={(hostId) => setJournalDlg({ hostId })}
            onQuickJournal={quickJournal}
            onSyslog={() => setSyslogDlg(true)}
            onAddHost={() => setHostDlg({})}
            onEditHost={(h) => setHostDlg({ host: h })}
            onDeleteHost={(h) => void api.deleteHost(h.id).then(refreshHosts)}
            onConnect={(h) => void connect(h)}
            onDisconnect={(h) => void api.disconnect(h.id)}
          />
        )}
        <div className="workspace" ref={workspaceRef}>
          {panes.map((p, i) => {
            const info = p.active ? docs[p.active] : undefined
            return (
              <div key={p.id} className="pane-wrap" style={{ flex: p.flex }}>
                <div
                  className={'pane' + (p.id === focused && panes.length > 1 ? ' focused' : '')}
                  onMouseDown={() => setFocused(p.id)}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('application/x-glv-doc')) e.preventDefault()
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('application/x-glv-doc')
                    if (id) {
                      e.preventDefault()
                      e.stopPropagation()
                      moveTab(id, p.id)
                    }
                  }}
                >
                  <div className="tabs">
                    {p.tabs.map((t) => {
                      const d = docs[t]
                      if (!d) return null
                      return (
                        <div
                          key={t}
                          className={'tab' + (p.active === t ? ' active' : '')}
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData('application/x-glv-doc', t)}
                          onClick={() => setPanes((ps) => ps.map((x) => (x.id === p.id ? { ...x, active: t } : x)))}
                          onAuxClick={(e) => e.button === 1 && closeDoc(t)}
                          title={`${d.title}\n${d.subtitle}`}
                        >
                          <Icon name={d.source.kind === 'journal' ? 'journal' : d.source.kind === 'syslog' ? 'antenna' : d.source.hostId ? 'server' : 'file'} size={14} />
                          <span className="tab-title">{d.title}</span>
                          {d.loading && <span className="spinner small" />}
                          {d.following && <span className="live">●</span>}
                          <button
                            className="flat tiny"
                            onClick={(e) => {
                              e.stopPropagation()
                              closeDoc(t)
                            }}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      )
                    })}
                    <span className="spacer" />
                    {p.active && p.tabs.length > 1 && (
                      <button className="flat small" title="Move tab to a new pane" onClick={() => moveTab(p.active!, 'new')}>
                        <Icon name="split" size={14} />
                      </button>
                    )}
                    {panes.length > 1 && (
                      <button
                        className="flat small"
                        title="Close pane"
                        onClick={() => {
                          p.tabs.forEach((t) => void api.closeDoc(t).catch(() => {}))
                          setPanes((ps) => ps.filter((x) => x.id !== p.id))
                        }}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </div>
                  {info ? (
                    <LogPane
                      key={info.id}
                      info={info}
                      displayTz={settings.displayTz}
                      view={{ fontSize: settings.fontSize, showLineNumbers: settings.showLineNumbers }}
                      synced={p.synced}
                      syncAvailable={multi}
                      syncMark={syncMarks[p.id] ?? null}
                      onToggleSync={() => setPanes((ps) => ps.map((x) => (x.id === p.id ? { ...x, synced: !x.synced } : x)))}
                      onSync={(ts, align) => onSync(p.id, ts, align)}
                      registerView={(h) => (handles.current[p.id] = h)}
                      onInfo={(ni) => setDocs((d) => ({ ...d, [ni.id]: ni }))}
                      onReopen={(o) => reopen(info.id, o)}
                      onError={(m) => toast(m)}
                      onFocus={() => setFocused(p.id)}
                    />
                  ) : (
                    <Welcome
                      onJournal={() => quickJournal()}
                      onJournalQuery={() => setJournalDlg({})}
                      onOpen={() => void api.openFileDialog().then((ps) => ps.forEach((x) => void openTarget({ path: x })))}
                      onHost={() => setHostDlg({})}
                      onSyslog={() => setSyslogDlg(true)}
                      first={i === 0 && Object.keys(docs).length === 0}
                    />
                  )}
                </div>
                {i < panes.length - 1 && <div className="splitter" onPointerDown={(e) => startResize(i, e)} />}
              </div>
            )
          })}
        </div>
      </div>

      {journalDlg && (
        <JournalDialog
          hostId={journalDlg.hostId}
          hostName={hosts.find((h) => h.id === journalDlg.hostId)?.name}
          defaultLimit={settings.journalLimit}
          canElevate={canElevate}
          displayTz={settings.displayTz}
          onClose={() => setJournalDlg(null)}
          onOpen={(q, follow) => {
            setJournalDlg(null)
            void openJournal(q, journalDlg.hostId, follow)
          }}
        />
      )}
      {syslogDlg && (
        <SyslogDialog
          initial={settings.syslog ?? DEFAULT_SYSLOG}
          platform={platform}
          onClose={() => setSyslogDlg(false)}
          onStart={(cfg) => {
            setSyslogDlg(false)
            void openSyslog(cfg)
          }}
        />
      )}
      {hostDlg && (
        <HostDialog
          host={hostDlg.host}
          onClose={() => setHostDlg(null)}
          onSave={(h) => {
            setHostDlg(null)
            void api.saveHost(h).then(refreshHosts, (e) => toast(errMsg(e)))
          }}
        />
      )}
      {prompts.length > 0 && <PromptDialog key={prompts[0].reqId} req={prompts[0]} onDone={() => setPrompts((q) => q.slice(1))} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind}>
            <span>{t.msg}</span>
            {t.action && (
              <button
                onClick={() => {
                  setToasts((x) => x.filter((y) => y.id !== t.id))
                  t.action!.run()
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="flat tiny" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Welcome(props: { onJournal(): void; onJournalQuery(): void; onOpen(): void; onHost(): void; onSyslog(): void; first: boolean }) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-icon">
          <Icon name="journal" size={56} />
        </div>
        <h1>{props.first ? 'GLViewer' : 'Empty pane'}</h1>
        <p className="dim">{props.first ? 'View the systemd journal, local log files, logs on remote hosts and syslog from other devices.' : 'Open something here to compare it side by side.'}</p>
        <div className="welcome-actions">
          <button className="pill suggested" onClick={props.onJournal}>
            <Icon name="journal" /> System journal (current boot)
          </button>
          <button className="pill" onClick={props.onJournalQuery}>
            <Icon name="filter" /> Journal query…
          </button>
          <button className="pill" onClick={props.onOpen}>
            <Icon name="folder-open" /> Open log file…
          </button>
          <button className="pill" onClick={props.onHost}>
            <Icon name="server" /> Add remote host…
          </button>
          <button className="pill" onClick={props.onSyslog}>
            <Icon name="antenna" /> Receive syslog…
          </button>
        </div>
        <p className="dim small">Drop files here to open them. Ctrl+F search · Ctrl+L filter · F3 next match</p>
      </div>
    </div>
  )
}
