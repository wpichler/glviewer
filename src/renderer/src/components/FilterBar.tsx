import { useEffect, useRef, useState } from 'react'
import { type DocInfo, type FilterSpec, type Level } from '@shared/types'
import { Icon } from '../icons'
import { fromLocalInput, toLocalInput } from '../time'
import { api } from '../api'

interface Props {
  info: DocInfo
  filter: FilterSpec
  displayTz: string
  selectedTs: number | null
  onChange(f: FilterSpec): void
  error?: string | null
}

const LEVEL_CHIPS: { label: string; levels: Level[]; cls: string }[] = [
  { label: 'Emerg/Alert/Crit', levels: [0, 1, 2], cls: 'lv2' },
  { label: 'Error', levels: [3], cls: 'lv3' },
  { label: 'Warning', levels: [4], cls: 'lv4' },
  { label: 'Notice', levels: [5], cls: 'lv5' },
  { label: 'Info', levels: [6], cls: 'lv6' },
  { label: 'Debug', levels: [7], cls: 'lv7' },
  { label: 'Other', levels: [8], cls: 'lv8' }
]

export function FilterBar({ info, filter, displayTz, selectedTs, onChange, error }: Props) {
  const [inc, setInc] = useState(filter.include)
  const [exc, setExc] = useState(filter.exclude)
  const [unit, setUnit] = useState(filter.unit ?? '')
  const [host, setHost] = useState(filter.host ?? '')
  const [units, setUnits] = useState<string[]>([])
  const [hosts, setHosts] = useState<string[]>([])
  const isJournal = info.source.kind !== 'file'
  const timer = useRef<number | null>(null)
  const latest = useRef(filter)
  latest.current = filter

  useEffect(() => {
    setInc(filter.include)
    setExc(filter.exclude)
    setUnit(filter.unit ?? '')
    setHost(filter.host ?? '')
  }, [info.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isJournal || info.loading) return
    Promise.all([api.distinct(info.id, 'ident'), api.distinct(info.id, 'unit'), api.distinct(info.id, 'host')]).then(
      ([a, b, h]) => {
        setUnits([...new Set([...b, ...a])])
        setHosts(h)
      },
      () => {}
    )
  }, [info.id, info.loading, isJournal])

  const debounced = (patch: Partial<FilterSpec>): void => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onChange({ ...latest.current, ...patch }), 280)
  }

  const allLevels: Level[] = [0, 1, 2, 3, 4, 5, 6, 7, 8]
  const active = new Set<Level>(filter.levels && filter.levels.length ? filter.levels : allLevels)
  const toggleChip = (lv: Level[]): void => {
    const on = lv.every((l) => active.has(l))
    const next = new Set(active)
    for (const l of lv) on ? next.delete(l) : next.add(l)
    const arr = [...next].sort() as Level[]
    onChange({ ...filter, levels: arr.length === 9 ? undefined : arr })
  }
  const onlyChip = (lv: Level[]): void => {
    // "this level and more severe"
    const max = Math.max(...lv)
    const arr = allLevels.filter((l) => l <= max && l !== 8)
    onChange({ ...filter, levels: arr })
  }

  const isActive =
    filter.include || filter.exclude || (filter.levels && filter.levels.length) || filter.from || filter.to || filter.unit || filter.host

  return (
    <div className="filterbar">
      <div className="frow">
        <div className={'entry grow' + (error ? ' error' : '')}>
          <Icon name="filter" />
          <input
            placeholder="Show lines containing…"
            value={inc}
            onChange={(e) => {
              setInc(e.target.value)
              debounced({ include: e.target.value })
            }}
          />
        </div>
        <div className="entry grow">
          <Icon name="close" />
          <input
            placeholder="Hide lines containing…"
            value={exc}
            onChange={(e) => {
              setExc(e.target.value)
              debounced({ exclude: e.target.value })
            }}
          />
        </div>
        <button
          className={'toggle' + (filter.regex ? ' on' : '')}
          title="Regular expressions"
          onClick={() => onChange({ ...filter, regex: !filter.regex })}
        >
          .*
        </button>
        <button
          className={'toggle' + (filter.caseSensitive ? ' on' : '')}
          title="Case sensitive"
          onClick={() => onChange({ ...filter, caseSensitive: !filter.caseSensitive })}
        >
          Aa
        </button>
        <button
          className="flat"
          disabled={!isActive}
          title="Clear all filters"
          onClick={() => {
            setInc('')
            setExc('')
            setUnit('')
            setHost('')
            onChange({ include: '', exclude: '', regex: filter.regex, caseSensitive: filter.caseSensitive })
          }}
        >
          Clear
        </button>
      </div>
      <div className="frow">
        <div className="chips" title="Click to toggle, double-click to show this level and more severe">
          {LEVEL_CHIPS.map((c) => (
            <button
              key={c.label}
              className={'chip ' + c.cls + (c.levels.every((l) => active.has(l)) ? ' on' : '')}
              onClick={() => toggleChip(c.levels)}
              onDoubleClick={() => onlyChip(c.levels)}
            >
              <span className={'dot lv' + c.levels[c.levels.length - 1]} />
              {c.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <label className="timefield" title={'Interpreted in display time zone ' + displayTz}>
          From
          <input
            type="datetime-local"
            step="1"
            value={toLocalInput(filter.from, displayTz)}
            onChange={(e) => onChange({ ...filter, from: fromLocalInput(e.target.value, displayTz) })}
          />
          <button className="flat small" disabled={selectedTs === null} title="Use time of selected line" onClick={() => onChange({ ...filter, from: selectedTs })}>
            <Icon name="clock" size={14} />
          </button>
        </label>
        <label className="timefield">
          To
          <input
            type="datetime-local"
            step="1"
            value={toLocalInput(filter.to, displayTz)}
            onChange={(e) => onChange({ ...filter, to: fromLocalInput(e.target.value, displayTz) })}
          />
          <button className="flat small" disabled={selectedTs === null} title="Use time of selected line" onClick={() => onChange({ ...filter, to: selectedTs })}>
            <Icon name="clock" size={14} />
          </button>
        </label>
      </div>
      {isJournal && (
        <div className="frow">
          <div className="entry grow">
            <span className="lbl">{info.source.kind === 'syslog' ? 'App' : 'Unit'}</span>
            <input
              list={'units-' + info.id}
              placeholder={info.source.kind === 'syslog' ? 'app name or facility (substring)' : 'unit or identifier (substring)'}
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value)
                debounced({ unit: e.target.value })
              }}
            />
            <datalist id={'units-' + info.id}>
              {units.slice(0, 2000).map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>
          <div className="entry grow">
            <span className="lbl">Host</span>
            <input
              list={'hosts-' + info.id}
              placeholder="hostname (substring)"
              value={host}
              onChange={(e) => {
                setHost(e.target.value)
                debounced({ host: e.target.value })
              }}
            />
            <datalist id={'hosts-' + info.id}>
              {hosts.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>
        </div>
      )}
      {error && <div className="ferror">{error}</div>}
    </div>
  )
}
