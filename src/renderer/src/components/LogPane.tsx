import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_FILTER, ENCODINGS, LEVEL_NAMES, TIMESTAMP_FORMATS, type DocInfo, type FilterSpec, type Row } from '@shared/types'
import { api, errMsg } from '../api'
import { Icon } from '../icons'
import { formatBytes, formatDuration, formatTs, isValidTz, tzLabel } from '../time'
import { FilterBar } from './FilterBar'
import { LogView, formatRowText, type LogViewHandle, type Selection } from './LogView'

export interface PaneViewSettings {
  fontSize: number
  showLineNumbers: boolean
}

interface Props {
  info: DocInfo
  displayTz: string
  view: PaneViewSettings
  synced: boolean
  syncAvailable: boolean
  syncMark: number | null
  onToggleSync(): void
  onSync(ts: number, align: 'top' | 'center'): void
  registerView(h: LogViewHandle | null): void
  onInfo(info: DocInfo): void
  onReopen(opts?: { follow?: boolean }): void
  onError(msg: string): void
  onFocus(): void
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function LogPane(props: Props) {
  const { info, displayTz } = props
  const isJournal = info.source.kind === 'journal'
  const viewRef = useRef<LogViewHandle | null>(null)

  const [filter, setFilter] = useState<FilterSpec>(EMPTY_FILTER)
  const [filterErr, setFilterErr] = useState<string | null>(null)
  const [filtering, setFiltering] = useState(false)
  const [showFilter, setShowFilter] = useState(false)
  const [query, setQuery] = useState('')
  const [qRegex, setQRegex] = useState(false)
  const [qCase, setQCase] = useState(false)
  const [matchV, setMatchV] = useState<number | null>(null)
  const [matchCount, setMatchCount] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selRow, setSelRow] = useState<Row | null>(null)
  const [showDetail, setShowDetail] = useState(true)
  const [showTime, setShowTime] = useState(true)
  const [showHost, setShowHost] = useState(false)
  const [menu, setMenu] = useState(false)
  const [tzInput, setTzInput] = useState(info.sourceTz)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => setTzInput(info.sourceTz), [info.sourceTz])

  const setViewRef = useCallback(
    (h: LogViewHandle | null) => {
      viewRef.current = h
      props.registerView(h)
    },
    [props.registerView] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const highlight = useMemo(() => {
    if (!query) return null
    try {
      return new RegExp(qRegex ? query : escapeRe(query), qCase ? 'g' : 'gi')
    } catch {
      return null
    }
  }, [query, qRegex, qCase])

  // ---- filter ---------------------------------------------------------------
  const applyFilter = async (f: FilterSpec): Promise<void> => {
    setFilter(f)
    setFiltering(true)
    try {
      const keepTs = selRow?.ts ?? null
      const ni = await api.setFilter(info.id, f)
      setFilterErr(null)
      setSelection(null)
      setMatchV(null)
      setMatchCount(null)
      props.onInfo(ni)
      if (keepTs !== null) setTimeout(() => void viewRef.current?.scrollToTime(keepTs, 'center'), 30)
    } catch (e) {
      setFilterErr(errMsg(e))
    } finally {
      setFiltering(false)
    }
  }

  // ---- search ---------------------------------------------------------------
  const doSearch = async (dir: 1 | -1): Promise<void> => {
    if (!query) return
    const spec = { query, regex: qRegex, caseSensitive: qCase }
    const start = matchV !== null ? matchV + dir : selection ? selection.focus : viewRef.current?.topIndex() ?? 0
    setSearching(true)
    try {
      const v = await api.search(info.id, spec, start, dir)
      if (v < 0) {
        setMatchV(null)
        setMatchCount(0)
      } else {
        setMatchV(v)
        setSelection({ anchor: v, focus: v })
        viewRef.current?.scrollToIndex(v, 'center')
        if (matchCount === null) api.count(info.id, spec).then(setMatchCount, () => {})
      }
    } catch (e) {
      props.onError(errMsg(e))
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    setMatchV(null)
    setMatchCount(null)
  }, [query, qRegex, qCase, info.version])

  // keyboard shortcuts while the pane has focus
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (e.key === 'F3') {
      e.preventDefault()
      void doSearch(e.shiftKey ? -1 : 1)
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      e.preventDefault()
      setShowFilter((s) => !s)
    }
  }

  // ---- doc settings ---------------------------------------------------------
  const change = async (fn: () => Promise<DocInfo>): Promise<void> => {
    try {
      props.onInfo(await fn())
    } catch (e) {
      props.onError(errMsg(e))
    }
  }

  const toggleFollow = async (): Promise<void> => {
    if (isJournal) {
      if (info.following) await change(() => api.follow(info.id, false))
      else props.onReopen({ follow: true })
      return
    }
    await change(() => api.follow(info.id, !info.following))
  }

  const span = info.firstTs !== undefined && info.lastTs !== undefined ? info.lastTs - info.firstTs : null

  return (
    <div className="logpane" onKeyDown={onKeyDown} onMouseDown={props.onFocus}>
      <div className="toolbar">
        <div className="entry search">
          <Icon name="search" />
          <input
            ref={searchRef}
            placeholder="Search (Enter / Shift+Enter)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void doSearch(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                setQuery('')
                viewRef.current?.focus()
              }
            }}
          />
          {query && (
            <span className="count">{searching ? '…' : matchCount === null ? '' : matchCount === 0 ? 'no match' : matchCount.toLocaleString()}</span>
          )}
          <button className={'toggle tiny' + (qRegex ? ' on' : '')} title="Regular expression" onClick={() => setQRegex(!qRegex)}>
            .*
          </button>
          <button className={'toggle tiny' + (qCase ? ' on' : '')} title="Case sensitive" onClick={() => setQCase(!qCase)}>
            Aa
          </button>
        </div>
        <div className="linked">
          <button className="flat" title="Previous match (Shift+F3)" onClick={() => void doSearch(-1)} disabled={!query}>
            <Icon name="up" />
          </button>
          <button className="flat" title="Next match (F3)" onClick={() => void doSearch(1)} disabled={!query}>
            <Icon name="down" />
          </button>
        </div>
        <button
          className={'flat' + (showFilter ? ' on' : '') + (filter !== EMPTY_FILTER && (filter.include || filter.exclude || filter.levels || filter.from || filter.to || filter.unit || filter.host) ? ' accent' : '')}
          title="Filter (Ctrl+L)"
          onClick={() => setShowFilter(!showFilter)}
        >
          <Icon name="filter" />
        </button>
        <button className={'flat' + (info.following ? ' on accent' : '')} title={info.following ? 'Stop following' : 'Follow (live tail)'} onClick={() => void toggleFollow()}>
          <Icon name={info.following ? 'pause' : 'play'} />
        </button>
        {props.syncAvailable && (
          <button className={'flat' + (props.synced ? ' on accent' : '')} title="Synchronize scrolling by timestamp with other panes" onClick={props.onToggleSync}>
            <Icon name="link" />
          </button>
        )}
        <button className="flat" title="Jump to end" onClick={() => viewRef.current?.scrollToIndex(info.viewCount, 'top')}>
          <Icon name="arrow-bottom" />
        </button>
        <div className="popover-anchor">
          <button className={'flat' + (menu ? ' on' : '')} title="Document options" onClick={() => setMenu(!menu)}>
            <Icon name="menu" />
          </button>
          {menu && (
            <>
              <div className="popover-backdrop" onMouseDown={() => setMenu(false)} />
              <div className="popover">
                {info.source.kind === 'file' && (
                  <>
                    <label className="field">
                      <span>Encoding</span>
                      <select value={info.encoding} onChange={(e) => void change(() => api.setEncoding(info.id, e.target.value))}>
                        {[...new Set([info.detectedEncoding ?? 'utf-8', ...ENCODINGS])].map((enc) => (
                          <option key={enc} value={enc}>
                            {enc}
                            {enc === info.detectedEncoding ? ` (detected${info.encodingConfidence !== undefined ? ', ' + info.encodingConfidence + '%' : ''})` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Timestamp format</span>
                      <select value={info.timestampFormat} onChange={(e) => void change(() => api.setTsFormat(info.id, e.target.value))}>
                        {TIMESTAMP_FORMATS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                            {f.id === 'auto' && info.detectedTimestampFormat ? ` → ${info.detectedTimestampFormat}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Log time zone</span>
                      <input
                        list="tz-list"
                        className={isValidTz(tzInput) ? '' : 'invalid'}
                        value={tzInput}
                        onChange={(e) => {
                          setTzInput(e.target.value)
                          if (isValidTz(e.target.value) && e.target.value) void change(() => api.setSourceTz(info.id, e.target.value))
                        }}
                      />
                      <small>
                        {info.hasNaiveTimestamps
                          ? 'Timestamps in this file carry no UTC offset; they are interpreted in this zone.'
                          : 'Timestamps in this file include a UTC offset; this setting has no effect.'}
                      </small>
                    </label>
                  </>
                )}
                <div className="checks">
                  <label>
                    <input type="checkbox" checked={showTime} onChange={(e) => setShowTime(e.target.checked)} /> Normalized time column
                  </label>
                  {isJournal && (
                    <label>
                      <input type="checkbox" checked={showHost} onChange={(e) => setShowHost(e.target.checked)} /> Host column
                    </label>
                  )}
                  <label>
                    <input type="checkbox" checked={showDetail} onChange={(e) => setShowDetail(e.target.checked)} /> Detail panel
                  </label>
                </div>
                <div className="menu-buttons">
                  <button
                    onClick={() => {
                      setMenu(false)
                      props.onReopen()
                    }}
                  >
                    <Icon name="refresh" /> Reload
                  </button>
                  <button
                    onClick={async () => {
                      setMenu(false)
                      try {
                        let lines: string[] | null = null
                        if (isJournal) {
                          lines = []
                          for (let s = 0; s < info.viewCount; s += 20000) {
                            const rows = await api.rows(info.id, s, 20000)
                            for (const r of rows) lines.push(formatRowText(r, displayTz, true))
                          }
                        }
                        await api.exportDoc(info.id, lines)
                      } catch (e) {
                        props.onError(errMsg(e))
                      }
                    }}
                  >
                    <Icon name="export" /> Export {info.viewCount !== info.lineCount ? 'filtered' : 'all'} lines…
                  </button>
                  <button
                    disabled={!selection}
                    onClick={() => {
                      setMenu(false)
                      void viewRef.current?.copySelection()
                    }}
                  >
                    <Icon name="copy" /> Copy selected lines
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {showFilter && <FilterBar info={info} filter={filter} displayTz={displayTz} selectedTs={selRow?.ts ?? null} onChange={(f) => void applyFilter(f)} error={filterErr} />}
      {info.loading && <div className="progress" />}
      <LogView
        ref={setViewRef}
        info={info}
        displayTz={displayTz}
        fontSize={props.view.fontSize}
        showTime={showTime}
        showLineNumbers={props.view.showLineNumbers}
        showHost={showHost}
        highlight={highlight}
        currentMatch={matchV}
        syncMark={props.syncMark}
        selection={selection}
        startAtEnd={isJournal}
        onSelect={setSelection}
        onSync={(ts, align) => {
          if (props.synced) props.onSync(ts, align)
        }}
        onSelectedRow={setSelRow}
      />
      {showDetail && selRow && (
        <div className="detail">
          <div className="detail-head">
            <span className={'badge lv' + selRow.level}>{LEVEL_NAMES[selRow.level]}</span>
            <span>line {(selRow.i + 1).toLocaleString()}</span>
            {selRow.ts !== null && (
              <span title="Display time zone">
                {formatTs(selRow.ts, displayTz)} <small>{tzLabel(displayTz)}</small>
              </span>
            )}
            {selRow.ts !== null && <span className="dim">UTC {new Date(selRow.ts).toISOString().replace('T', ' ').replace('Z', '')}</span>}
            {selRow.inh && <span className="dim">(time inherited from previous line)</span>}
            {selRow.unit && <span>unit {selRow.unit}</span>}
            {selRow.ident && <span>{selRow.ident}</span>}
            {selRow.pid && <span>pid {selRow.pid}</span>}
            {selRow.host && <span>host {selRow.host}</span>}
            <span className="spacer" />
            {selection && selection.anchor !== selection.focus && <span className="dim">{Math.abs(selection.anchor - selection.focus) + 1} lines selected</span>}
            <button className="flat small" title="Copy" onClick={() => void navigator.clipboard.writeText(selRow.text)}>
              <Icon name="copy" size={14} />
            </button>
            <button className="flat small" title="Close" onClick={() => setShowDetail(false)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <pre className="detail-text">{selRow.text}</pre>
        </div>
      )}
      <div className="statusbar">
        <span>
          {filtering ? 'Filtering… ' : ''}
          {info.viewCount !== info.lineCount ? `${info.viewCount.toLocaleString()} of ` : ''}
          {info.lineCount.toLocaleString()} {isJournal ? 'entries' : 'lines'}
          {info.loading ? ' (loading…)' : ''}
        </span>
        {info.source.kind === 'file' && (
          <span title="Encoding">
            {info.encoding}
            {info.encoding === info.detectedEncoding ? ' (auto)' : ''}
          </span>
        )}
        {info.source.kind === 'file' && info.hasNaiveTimestamps && <span title="Time zone used to interpret the log's timestamps">log TZ {info.sourceTz}</span>}
        {info.source.kind === 'file' && <span title="Timestamp format">{info.timestampFormat === 'auto' ? info.detectedTimestampFormat : info.timestampFormat}</span>}
        {info.sizeBytes !== undefined && <span>{formatBytes(info.sizeBytes)}</span>}
        {span !== null && <span title="Time span">{formatDuration(span)}</span>}
        {info.following && <span className="live">● live</span>}
        {info.source.elevated && (
          <span>
            <Icon name="lock" size={12} /> elevated
          </span>
        )}
        {info.error && <span className="err">{info.error}</span>}
      </div>
    </div>
  )
}
