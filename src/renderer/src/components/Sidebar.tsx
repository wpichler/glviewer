import { useEffect, useState } from 'react'
import type { HostProfile, HostStatus, RemoteEntry } from '@shared/types'
import { api, errCode, errMsg } from '../api'
import { Icon } from '../icons'
import { formatBytes } from '../time'

export interface OpenTarget {
  hostId?: string
  path: string
  sudo?: boolean
  newPane?: boolean
}

interface Props {
  hosts: HostProfile[]
  status: Record<string, HostStatus>
  recent: string[]
  onOpenFile(t: OpenTarget): void
  onOpenFileDialog(): void
  onJournal(hostId?: string): void
  onQuickJournal(hostId?: string, newPane?: boolean): void
  onAddHost(): void
  onEditHost(h: HostProfile): void
  onDeleteHost(h: HostProfile): void
  onConnect(h: HostProfile): void
  onDisconnect(h: HostProfile): void
}

/** Lazily loaded directory tree (local or remote). */
function Tree(props: { hostId?: string; path: string; depth: number; onOpen(t: OpenTarget): void; sudo?: boolean }) {
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null)
  const [err, setErr] = useState<{ msg: string; code?: string } | null>(null)
  const [sudo, setSudo] = useState(!!props.sudo)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const load = (useSudo: boolean): void => {
    setErr(null)
    const p = props.hostId ? api.listRemote(props.hostId, props.path, useSudo) : api.listLocal(props.path)
    p.then(setEntries, (e) => setErr({ msg: errMsg(e), code: errCode(e) }))
  }
  useEffect(() => load(sudo), [props.hostId, props.path]) // eslint-disable-line react-hooks/exhaustive-deps

  const pad = { paddingLeft: 8 + props.depth * 14 }
  if (err)
    return (
      <div className="tree-msg" style={pad}>
        <span className="err">{err.code === 'EACCES' || /denied/i.test(err.msg) ? 'Permission denied' : err.msg}</span>
        {props.hostId && !sudo && (
          <button
            className="link"
            onClick={() => {
              setSudo(true)
              load(true)
            }}
          >
            list with sudo
          </button>
        )}
      </div>
    )
  if (!entries)
    return (
      <div className="tree-msg dim" style={pad}>
        Loading…
      </div>
    )
  if (entries.length === 0)
    return (
      <div className="tree-msg dim" style={pad}>
        empty
      </div>
    )
  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <div
            className={'tree-row' + (e.readable ? '' : ' locked')}
            style={pad}
            title={`${e.path}\n${e.isDir ? 'directory' : formatBytes(e.size)} · ${new Date(e.mtime).toLocaleString()}${e.readable ? '' : '\nnot readable without elevated rights'}`}
            onClick={(ev) => {
              if (e.isDir) setOpen({ ...open, [e.path]: !open[e.path] })
              else props.onOpen({ hostId: props.hostId, path: e.path, sudo: sudo || !e.readable, newPane: ev.ctrlKey || ev.metaKey })
            }}
            onAuxClick={(ev) => {
              if (ev.button === 1 && !e.isDir) props.onOpen({ hostId: props.hostId, path: e.path, sudo: sudo || !e.readable, newPane: true })
            }}
          >
            {e.isDir ? <Icon name={open[e.path] ? 'chevron-down' : 'chevron-right'} size={12} /> : <span className="tw" />}
            <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
            <span className="name">{e.name}</span>
            {!e.readable && <Icon name="lock" size={12} className="dim" />}
            {!e.isDir && <span className="size">{formatBytes(e.size)}</span>}
          </div>
          {e.isDir && open[e.path] && <Tree hostId={props.hostId} path={e.path} depth={props.depth + 1} onOpen={props.onOpen} sudo={sudo} />}
        </div>
      ))}
    </>
  )
}

function Section(props: { title: string; children: React.ReactNode; actions?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  return (
    <div className="section">
      <div className="section-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <span>{props.title}</span>
        <span className="spacer" />
        <span onClick={(e) => e.stopPropagation()}>{props.actions}</span>
      </div>
      {open && props.children}
    </div>
  )
}

function HostItem(props: { h: HostProfile; st?: HostStatus } & Pick<Props, 'onConnect' | 'onDisconnect' | 'onEditHost' | 'onDeleteHost' | 'onJournal' | 'onQuickJournal' | 'onOpenFile'>) {
  const { h, st } = props
  const state = st?.state ?? 'disconnected'
  const [expanded, setExpanded] = useState(false)
  const [logsOpen, setLogsOpen] = useState(true)
  const [customPath, setCustomPath] = useState('')
  useEffect(() => {
    if (state === 'connected') setExpanded(true)
  }, [state])
  return (
    <div className="host">
      <div
        className="item"
        onClick={() => (state === 'connected' ? setExpanded(!expanded) : state !== 'connecting' && props.onConnect(h))}
        title={`${h.username}@${h.host}:${h.port}${h.origin === 'ssh-config' ? '\n(from ~/.ssh/config)' : ''}${st?.error ? '\n' + st.error : ''}`}
      >
        <span className={'status-dot ' + state} />
        <Icon name="server" />
        <span className="name">
          {h.name}
          <small>
            {h.username}@{h.host}
            {h.port !== 22 ? ':' + h.port : ''}
          </small>
        </span>
        <span className="item-actions" onClick={(e) => e.stopPropagation()}>
          {state === 'connected' ? (
            <button className="flat small" title="Disconnect" onClick={() => props.onDisconnect(h)}>
              <Icon name="disconnect" size={14} />
            </button>
          ) : (
            <button className="flat small" title="Connect" disabled={state === 'connecting'} onClick={() => props.onConnect(h)}>
              <Icon name="plug" size={14} />
            </button>
          )}
          {h.origin === 'saved' && (
            <>
              <button className="flat small" title="Edit" onClick={() => props.onEditHost(h)}>
                <Icon name="edit" size={14} />
              </button>
              <button className="flat small" title="Remove" onClick={() => props.onDeleteHost(h)}>
                <Icon name="trash" size={14} />
              </button>
            </>
          )}
        </span>
      </div>
      {state === 'error' && st?.error && <div className="host-error">{st.error}</div>}
      {state === 'connecting' && <div className="tree-msg dim">Connecting…</div>}
      {state === 'connected' && expanded && (
        <div className="host-body">
          <div className="tree-row" style={{ paddingLeft: 22 }} onClick={(e) => props.onQuickJournal(h.id, e.ctrlKey || e.metaKey)} title="Open the current boot's journal">
            <span className="tw" />
            <Icon name="journal" size={14} />
            <span className="name">Journal (current boot)</span>
          </div>
          <div className="tree-row" style={{ paddingLeft: 22 }} onClick={() => props.onJournal(h.id)}>
            <span className="tw" />
            <Icon name="filter" size={14} />
            <span className="name">Journal query…</span>
          </div>
          <div className="tree-row" style={{ paddingLeft: 8 }} onClick={() => setLogsOpen(!logsOpen)}>
            <Icon name={logsOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            <Icon name="folder-open" size={14} />
            <span className="name">/var/log</span>
            {st?.remoteTz && <span className="size">{st.remoteTz}</span>}
          </div>
          {logsOpen && <Tree hostId={h.id} path="/var/log" depth={2} onOpen={props.onOpenFile} />}
          <form
            className="pathform"
            onSubmit={(e) => {
              e.preventDefault()
              if (customPath.trim()) props.onOpenFile({ hostId: h.id, path: customPath.trim() })
            }}
          >
            <input placeholder="Open remote path…" value={customPath} onChange={(e) => setCustomPath(e.target.value)} />
          </form>
        </div>
      )}
    </div>
  )
}

export function Sidebar(props: Props) {
  const [localLogs, setLocalLogs] = useState(false)
  return (
    <aside className="sidebar">
      <Section title="This computer">
        <div className="item" onClick={(e) => props.onQuickJournal(undefined, e.ctrlKey || e.metaKey)} title="Open the current boot's journal">
          <Icon name="journal" />
          <span className="name">System journal</span>
          <span className="item-actions" onClick={(e) => e.stopPropagation()}>
            <button className="flat small" title="Journal query…" onClick={() => props.onJournal()}>
              <Icon name="filter" size={14} />
            </button>
          </span>
        </div>
        <div className="item" onClick={props.onOpenFileDialog}>
          <Icon name="file" />
          <span className="name">Open file…</span>
        </div>
        <div className="item" onClick={() => setLocalLogs(!localLogs)}>
          <Icon name={localLogs ? 'folder-open' : 'folder'} />
          <span className="name">/var/log</span>
          <Icon name={localLogs ? 'chevron-down' : 'chevron-right'} size={12} />
        </div>
        {localLogs && <Tree path="/var/log" depth={1} onOpen={props.onOpenFile} />}
      </Section>
      <Section
        title="Remote hosts"
        actions={
          <button className="flat small" title="Add host" onClick={props.onAddHost}>
            <Icon name="plus" size={14} />
          </button>
        }
      >
        {props.hosts.length === 0 && (
          <div className="tree-msg dim">
            No hosts yet. Add one, or define hosts in <code>~/.ssh/config</code>.
          </div>
        )}
        {props.hosts.map((h) => (
          <HostItem key={h.id} h={h} st={props.status[h.id]} {...props} />
        ))}
      </Section>
      {props.recent.length > 0 && (
        <Section title="Recent files" defaultOpen={false}>
          {props.recent.map((p) => (
            <div key={p} className="tree-row" style={{ paddingLeft: 12 }} title={p} onClick={(e) => props.onOpenFile({ path: p, newPane: e.ctrlKey || e.metaKey })}>
              <Icon name="file" size={14} />
              <span className="name">{p.split(/[\\/]/).pop()}</span>
            </div>
          ))}
        </Section>
      )}
      <div className="sidebar-hint dim">Ctrl+click or middle-click opens in a new pane</div>
    </aside>
  )
}
