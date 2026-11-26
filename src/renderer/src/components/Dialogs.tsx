import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BootInfo, HostProfile, JournalQuery, PromptRequest } from '@shared/types'
import { api, errMsg } from '../api'
import { formatTs } from '../time'

export function Dialog(props: { title: string; children: ReactNode; onClose(): void; footer: ReactNode; wide?: boolean }) {
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        className={'dialog' + (props.wide ? ' wide' : '')}
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose()
        }}
      >
        <div className="dialog-title">{props.title}</div>
        <div className="dialog-body">{props.children}</div>
        <div className="dialog-footer">{props.footer}</div>
      </div>
    </div>
  )
}

// ---- journal query ------------------------------------------------------------

const PRIORITIES = ['0 emerg', '1 alert', '2 crit', '3 err', '4 warning', '5 notice', '6 info', '7 debug']

export function JournalDialog(props: {
  hostId?: string
  hostName?: string
  defaultLimit: number
  displayTz: string
  onOpen(q: JournalQuery, follow: boolean): void
  onClose(): void
}) {
  const [limit, setLimit] = useState(props.defaultLimit)
  const [boot, setBoot] = useState<string>('0')
  const [boots, setBoots] = useState<BootInfo[] | null>(null)
  const [units, setUnits] = useState<string[]>([])
  const [unitInput, setUnitInput] = useState('')
  const [knownUnits, setKnownUnits] = useState<string[]>([])
  const [priority, setPriority] = useState(7)
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [scope, setScope] = useState<'all' | 'system' | 'user'>('all')
  const [kernel, setKernel] = useState(false)
  const [grep, setGrep] = useState('')
  const [follow, setFollow] = useState(false)
  const [sudo, setSudo] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.boots(props.hostId, sudo).then(setBoots, (e) => {
      setBoots([])
      setErr(errMsg(e))
    })
    api.journalFields(props.hostId, '_SYSTEMD_UNIT', sudo).then(setKnownUnits, () => {})
  }, [props.hostId, sudo])

  const submit = (): void => {
    const all = [...units, ...(unitInput.trim() ? [unitInput.trim()] : [])]
    props.onOpen(
      {
        limit,
        boot: boot === 'all' ? undefined : boot,
        units: all.length ? all : undefined,
        priority: priority < 7 ? priority : undefined,
        since: since || undefined,
        until: until || undefined,
        scope,
        kernel,
        grep: grep || undefined,
        sudo
      },
      follow
    )
  }

  return (
    <Dialog
      title={props.hostName ? `Journal on ${props.hostName}` : 'System journal'}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button onClick={props.onClose}>Cancel</button>
          <button className="suggested" onClick={submit}>
            Open
          </button>
        </>
      }
    >
      <div className="form" onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && submit()}>
        <label className="field">
          <span>Boot</span>
          <select value={boot} onChange={(e) => setBoot(e.target.value)}>
            <option value="all">All boots</option>
            {boots === null && <option value="0">Current boot (loading list…)</option>}
            {boots?.map((b) => (
              <option key={b.bootId} value={String(b.index)}>
                {b.index === 0 ? 'Current boot' : `Boot ${b.index}`}
                {Number.isFinite(b.first) ? ` — ${formatTs(b.first, props.displayTz).slice(0, 16)} … ${formatTs(b.last, props.displayTz).slice(0, 16)}` : ''}
              </option>
            ))}
            {boots !== null && boots.length === 0 && <option value="0">Current boot</option>}
          </select>
        </label>
        <div className="field">
          <span>Units</span>
          <div className="chipsinput">
            {units.map((u) => (
              <span key={u} className="tag">
                {u}
                <button onClick={() => setUnits(units.filter((x) => x !== u))}>×</button>
              </span>
            ))}
            <input
              list="journal-units"
              placeholder={units.length ? '' : 'all units (type to add, e.g. sshd.service)'}
              value={unitInput}
              onChange={(e) => setUnitInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ',') && unitInput.trim()) {
                  e.preventDefault()
                  e.stopPropagation()
                  setUnits([...new Set([...units, unitInput.trim()])])
                  setUnitInput('')
                } else if (e.key === 'Backspace' && !unitInput && units.length) setUnits(units.slice(0, -1))
              }}
            />
            <datalist id="journal-units">
              {knownUnits.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="row2">
          <label className="field">
            <span>Max. priority</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITIES.map((p, i) => (
                <option key={p} value={i}>
                  {i === 7 ? 'all (up to debug)' : 'up to ' + p}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Scope</span>
            <select value={scope} onChange={(e) => setScope(e.target.value as 'all')}>
              <option value="all">System + user</option>
              <option value="system">System only</option>
              <option value="user">Current user only</option>
            </select>
          </label>
        </div>
        <div className="row2">
          <label className="field">
            <span>Since</span>
            <input placeholder='e.g. "-2h", "today", "2026-11-26 08:00"' value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
          <label className="field">
            <span>Until</span>
            <input placeholder='e.g. "now", "-10min"' value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        </div>
        <div className="row2">
          <label className="field">
            <span>Max. entries (newest)</span>
            <input type="number" min={0} step={1000} value={limit} onChange={(e) => setLimit(Math.max(0, Number(e.target.value)))} />
            <small>0 = no limit</small>
          </label>
          <label className="field">
            <span>Server-side grep</span>
            <input placeholder="PCRE pattern (optional)" value={grep} onChange={(e) => setGrep(e.target.value)} />
          </label>
        </div>
        <div className="checks">
          <label>
            <input type="checkbox" checked={kernel} onChange={(e) => setKernel(e.target.checked)} /> Kernel messages only
          </label>
          <label>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow new entries (live)
          </label>
          <label title={props.hostId ? 'Run journalctl via sudo on the remote host' : 'Run journalctl via pkexec (polkit)'}>
            <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} /> {props.hostId ? 'Use sudo' : 'As administrator (pkexec)'}
          </label>
        </div>
        {err && <div className="ferror">{err}</div>}
      </div>
    </Dialog>
  )
}

// ---- host editor ----------------------------------------------------------------

export function HostDialog(props: { host?: HostProfile; onSave(h: HostProfile): void; onClose(): void }) {
  const h = props.host
  const [name, setName] = useState(h?.name ?? '')
  const [host, setHost] = useState(h?.host ?? '')
  const [port, setPort] = useState(h?.port ?? 22)
  const [username, setUsername] = useState(h?.username ?? '')
  const [identityFile, setIdentityFile] = useState(h?.identityFile ?? '')
  const valid = host.trim() && username.trim() && port > 0 && port < 65536
  const save = (): void => {
    if (!valid) return
    props.onSave({
      id: h?.origin === 'saved' ? h.id : '',
      name: name.trim() || host.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      identityFile: identityFile.trim() || undefined,
      origin: 'saved'
    })
  }
  return (
    <Dialog
      title={h ? 'Edit host' : 'Add remote host'}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>Cancel</button>
          <button className="suggested" disabled={!valid} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form" onKeyDown={(e) => e.key === 'Enter' && save()}>
        <label className="field">
          <span>Host name or IP</span>
          <input autoFocus value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.example.com" />
        </label>
        <div className="row2">
          <label className="field">
            <span>User</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </label>
          <label className="field narrow">
            <span>Port</span>
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
        </div>
        <label className="field">
          <span>Display name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={host || 'optional'} />
        </label>
        <label className="field">
          <span>Private key file</span>
          <input value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} placeholder="optional, e.g. ~/.ssh/id_ed25519" />
          <small>Authentication tries the SSH agent, this key, the default keys in ~/.ssh, then asks for a password.</small>
        </label>
      </div>
    </Dialog>
  )
}

// ---- prompts from the main process ------------------------------------------------

export function PromptDialog(props: { req: PromptRequest; onDone(): void }) {
  const { req } = props
  const fields = req.kind === 'keyboard' ? (req.prompts ?? []) : req.kind === 'hostkey' ? [] : [{ prompt: req.kind === 'passphrase' ? 'Passphrase' : 'Password', echo: false }]
  const [values, setValues] = useState<string[]>(fields.map(() => ''))
  const [remember, setRemember] = useState(true)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const reply = (ok: boolean): void => {
    api.replyPrompt({ reqId: req.reqId, ok, values: ok ? values : undefined, remember })
    props.onDone()
  }
  return (
    <Dialog
      title={req.title}
      onClose={() => reply(false)}
      footer={
        <>
          <button onClick={() => reply(false)}>{req.kind === 'hostkey' ? 'Reject' : 'Cancel'}</button>
          <button className={req.kind === 'hostkey' ? 'destructive' : 'suggested'} onClick={() => reply(true)}>
            {req.kind === 'hostkey' ? 'Trust and connect' : 'OK'}
          </button>
        </>
      }
    >
      <div className="form" onKeyDown={(e) => e.key === 'Enter' && req.kind !== 'hostkey' && reply(true)}>
        {req.message && <p className="msg">{req.message}</p>}
        {req.kind === 'hostkey' && (
          <>
            <div className="fingerprint">
              <div className="dim">{req.keyType}</div>
              <code>{req.fingerprint}</code>
            </div>
            <label className="checks">
              <span>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this host key
              </span>
            </label>
          </>
        )}
        {fields.map((f, i) => (
          <label className="field" key={i}>
            <span>{f.prompt.replace(/:\s*$/, '')}</span>
            <input
              ref={i === 0 ? first : undefined}
              type={f.echo ? 'text' : 'password'}
              value={values[i]}
              onChange={(e) => setValues(values.map((v, k) => (k === i ? e.target.value : v)))}
            />
          </label>
        ))}
      </div>
    </Dialog>
  )
}
