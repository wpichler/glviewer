import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { DocInfo, Row } from '@shared/types'
import { api } from '../api'
import { formatTs } from '../time'

export interface Selection {
  anchor: number
  focus: number
}

export interface LogViewHandle {
  scrollToIndex(v: number, align?: 'top' | 'center' | 'nearest'): void
  scrollToTime(ts: number, align?: 'top' | 'center'): Promise<number>
  focus(): void
  topIndex(): number
  copySelection(): Promise<void>
}

interface Props {
  info: DocInfo
  displayTz: string
  fontSize: number
  showTime: boolean
  showLineNumbers: boolean
  showHost: boolean
  highlight: RegExp | null
  currentMatch: number | null
  syncMark: number | null
  selection: Selection | null
  /** Start scrolled to the end and stick there while new lines arrive. */
  startAtEnd?: boolean
  onSelect(sel: Selection | null): void
  /** User scrolled / selected: report time for synchronized panes. */
  onSync(ts: number, align: 'top' | 'center'): void
  onSelectedRow?(row: Row | null): void
}

const BLOCK = 256
const MAX_RENDER_CHARS = 3000

export function formatRowText(r: Row, tz: string, isJournal: boolean): string {
  if (!isJournal) return r.text
  const t = r.ts !== null ? formatTs(r.ts, tz) : ''
  const who = (r.ident || r.unit || '') + (r.pid ? `[${r.pid}]` : '')
  return `${t} ${r.host ?? ''} ${who}: ${r.text}`
}

export const LogView = forwardRef<LogViewHandle, Props>(function LogView(props, ref) {
  const { info, fontSize } = props
  const rowH = Math.round(fontSize * 1.6)
  const count = info.viewCount
  const isJournal = info.source.kind !== 'file' // journal or syslog: structured columns

  const viewportRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [vpH, setVpH] = useState(400)
  const [top, setTopState] = useState(0)
  const topRef = useRef(0)
  const [, setTick] = useState(0)
  const cache = useRef(new Map<number, Row>())
  const blocks = useRef(new Map<number, number>()) // block -> rows loaded (or -1 = in flight)
  const cacheKey = useRef('')
  const [minWidth, setMinWidth] = useState(0)
  const userScroll = useRef(false)
  const propsRef = useRef(props)
  propsRef.current = props

  const visible = vpH / rowH
  const maxTop = Math.max(0, count - Math.floor(visible) + 0.0)
  const clampTop = useCallback((t: number) => Math.max(0, Math.min(Math.max(0, propsRef.current.info.viewCount - Math.floor(vpH / rowH)), t)), [vpH, rowH])

  // whether the view sticks to the end when lines are appended
  const stick = useRef(!!props.startAtEnd)

  const setTop = useCallback(
    (t: number, user: boolean) => {
      const c = clampTop(t)
      if (user) {
        userScroll.current = true
        const max = Math.max(0, propsRef.current.info.viewCount - Math.floor(vpH / rowH))
        stick.current = c >= max - 0.5
      }
      topRef.current = c
      setTopState(c)
    },
    [clampTop, vpH, rowH]
  )

  // reset caches when the document content changes
  const key = info.id + ':' + info.version
  if (cacheKey.current !== key) {
    const sameDoc = cacheKey.current.startsWith(info.id + ':')
    cacheKey.current = key
    cache.current = new Map()
    blocks.current = new Map()
    if (!sameDoc) {
      topRef.current = 0
      stick.current = !!props.startAtEnd
    }
  }

  // stick to the end while loading / following (if the user is at the end)
  useLayoutEffect(() => {
    if (stick.current) setTop(count, false)
    else if (topRef.current > maxTop) setTop(maxTop, false)
  }, [count, vpH, rowH, maxTop, setTop])

  // keep top in range
  useEffect(() => {
    if (top !== topRef.current) setTopState(topRef.current)
  })

  // observe viewport size
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setVpH(el.clientHeight))
    ro.observe(el)
    setVpH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // fetch rows for the visible range
  const first = Math.floor(top)
  const last = Math.min(count - 1, first + Math.ceil(visible) + 1)
  useEffect(() => {
    if (count === 0) return
    const from = Math.max(0, first - 64)
    const to = Math.min(count - 1, last + 64)
    const myKey = cacheKey.current
    for (let b = Math.floor(from / BLOCK); b <= Math.floor(to / BLOCK); b++) {
      const loaded = blocks.current.get(b)
      const start = b * BLOCK
      const want = Math.min(BLOCK, count - start)
      if (loaded === -1 || (loaded !== undefined && loaded >= want)) continue
      blocks.current.set(b, -1)
      api.rows(info.id, start, BLOCK).then(
        (rows) => {
          if (cacheKey.current !== myKey) return
          for (const r of rows) cache.current.set(r.v, r)
          blocks.current.set(b, rows.length)
          setTick((x) => x + 1)
        },
        () => {
          if (cacheKey.current === myKey) blocks.current.delete(b)
        }
      )
    }
  })

  // report top row time to synchronized panes
  useEffect(() => {
    if (!userScroll.current) return
    const r = cache.current.get(Math.floor(topRef.current))
    if (r && r.ts !== null) {
      userScroll.current = false
      propsRef.current.onSync(r.ts, 'top')
    }
  })

  // measure content width for horizontal scrolling
  useLayoutEffect(() => {
    const w = innerRef.current?.scrollWidth ?? 0
    if (w > minWidth) setMinWidth(w)
  })
  useEffect(() => setMinWidth(0), [info.id, fontSize, props.showTime])

  // selected row details
  const selFocus = props.selection?.focus ?? null
  useEffect(() => {
    if (!props.onSelectedRow) return
    if (selFocus === null) return props.onSelectedRow(null)
    const r = cache.current.get(selFocus)
    if (r) props.onSelectedRow(r)
    else api.rows(info.id, selFocus, 1).then((rs) => props.onSelectedRow?.(rs[0] ?? null), () => {})
  }, [selFocus, key]) // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToIndex = useCallback(
    (v: number, align: 'top' | 'center' | 'nearest' = 'center') => {
      const vis = vpH / rowH
      stick.current = v >= propsRef.current.info.viewCount - 1
      if (align === 'top') setTop(v, false)
      else if (align === 'center') setTop(v - vis / 2 + 0.5, false)
      else {
        const t = topRef.current
        if (v < t) setTop(v, false)
        else if (v > t + vis - 1) setTop(v - vis + 1, false)
      }
    },
    [vpH, rowH, setTop]
  )

  const copySelection = useCallback(async () => {
    const sel = propsRef.current.selection
    if (!sel) return
    const a = Math.min(sel.anchor, sel.focus)
    const b = Math.max(sel.anchor, sel.focus)
    const n = Math.min(b - a + 1, 100000)
    const out: string[] = []
    for (let s = a; s < a + n; s += 5000) {
      const rows = await api.rows(propsRef.current.info.id, s, Math.min(5000, a + n - s))
      for (const r of rows) out.push(formatRowText(r, propsRef.current.displayTz, isJournal))
    }
    await navigator.clipboard.writeText(out.join('\n'))
  }, [isJournal])

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex,
      scrollToTime: async (ts, align = 'top') => {
        const v = await api.findTime(propsRef.current.info.id, ts)
        scrollToIndex(v, align)
        return v
      },
      focus: () => viewportRef.current?.focus(),
      topIndex: () => Math.floor(topRef.current),
      copySelection
    }),
    [scrollToIndex, copySelection]
  )

  // ---- input handling -------------------------------------------------------

  const onWheel = (e: React.WheelEvent): void => {
    const el = viewportRef.current!
    let dy = e.deltaY
    let dx = e.deltaX
    if (e.deltaMode === 1) {
      dy *= rowH
      dx *= 8
    } else if (e.deltaMode === 2) dy *= vpH
    if (e.shiftKey && dx === 0) {
      dx = dy
      dy = 0
    }
    if (dx) el.scrollLeft += dx
    if (dy) setTop(topRef.current + dy / rowH, true)
  }

  const select = (v: number, extend: boolean): void => {
    const sel = propsRef.current.selection
    const s: Selection = extend && sel ? { anchor: sel.anchor, focus: v } : { anchor: v, focus: v }
    propsRef.current.onSelect(s)
    const r = cache.current.get(v)
    if (r && r.ts !== null) propsRef.current.onSync(r.ts, 'center')
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const vis = Math.max(1, Math.floor(vpH / rowH) - 1)
    const sel = props.selection
    const cur = sel ? sel.focus : Math.floor(topRef.current)
    let next: number | null = null
    switch (e.key) {
      case 'ArrowDown':
        next = cur + 1
        break
      case 'ArrowUp':
        next = cur - 1
        break
      case 'PageDown':
        next = cur + vis
        break
      case 'PageUp':
        next = cur - vis
        break
      case 'Home':
        if (e.ctrlKey || !sel) {
          next = 0
        } else return
        break
      case 'End':
        if (e.ctrlKey || !sel) {
          next = count - 1
        } else return
        break
      case 'ArrowLeft':
        viewportRef.current!.scrollLeft -= 40
        e.preventDefault()
        return
      case 'ArrowRight':
        viewportRef.current!.scrollLeft += 40
        e.preventDefault()
        return
      case 'Escape':
        props.onSelect(null)
        return
      case 'c':
      case 'C':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          void copySelection()
        }
        return
      case 'a':
        if ((e.ctrlKey || e.metaKey) && count > 0) {
          e.preventDefault()
          props.onSelect({ anchor: 0, focus: count - 1 })
        }
        return
      default:
        return
    }
    e.preventDefault()
    if (count === 0) return
    next = Math.max(0, Math.min(count - 1, next))
    select(next, e.shiftKey)
    scrollToIndex(next, 'nearest')
  }

  // ---- scrollbar -----------------------------------------------------------

  const trackRef = useRef<HTMLDivElement>(null)
  const trackH = vpH
  const thumbH = count > 0 ? Math.max(28, Math.min(trackH, (trackH * visible) / Math.max(count, 1))) : trackH
  const thumbTop = maxTop > 0 ? ((trackH - thumbH) * top) / maxTop : 0
  const drag = useRef<{ y: number; top: number } | null>(null)

  const onThumbDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, top: topRef.current }
  }
  const onThumbMove = (e: React.PointerEvent): void => {
    if (!drag.current) return
    const dy = e.clientY - drag.current.y
    const range = trackH - thumbH
    if (range <= 0) return
    setTop(drag.current.top + (dy / range) * maxTop, true)
  }
  const onThumbUp = (e: React.PointerEvent): void => {
    drag.current = null
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }
  const onTrackDown = (e: React.PointerEvent): void => {
    const rect = trackRef.current!.getBoundingClientRect()
    const y = e.clientY - rect.top
    const frac = Math.max(0, Math.min(1, (y - thumbH / 2) / Math.max(1, trackH - thumbH)))
    setTop(frac * maxTop, true)
  }

  // ---- rendering -------------------------------------------------------------

  const sel = props.selection
  const selA = sel ? Math.min(sel.anchor, sel.focus) : -1
  const selB = sel ? Math.max(sel.anchor, sel.focus) : -2
  const digits = String(info.lineCount).length
  const offsetY = -(top - first) * rowH

  const rows: ReactNode[] = []
  for (let v = first; v <= last; v++) {
    const r = cache.current.get(v)
    const cls =
      'row' +
      (r ? ' lvl' + r.level : ' pending') +
      (v >= selA && v <= selB ? ' sel' : '') +
      (v === props.currentMatch ? ' match' : '') +
      (v === props.syncMark ? ' sync' : '')
    rows.push(
      <div
        key={v}
        className={cls}
        style={{ height: rowH, lineHeight: rowH + 'px' }}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          select(v, e.shiftKey)
        }}
      >
        <span className="gutter">
          {props.showLineNumbers && (
            <span className="ln" style={{ width: digits + 1 + 'ch' }}>
              {r ? r.i + 1 : ''}
            </span>
          )}
          <span className={'lvbar lv' + (r?.level ?? 8)} />
          {props.showTime && <span className={'ts' + (r?.inh ? ' inh' : '')}>{r && r.ts !== null ? formatTs(r.ts, props.displayTz) : ''}</span>}
        </span>
        {r && isJournal && (
          <>
            {props.showHost && <span className="host">{r.host}</span>}
            <span className="ident" title={r.unit}>
              {(r.ident || r.unit || '') + (r.pid ? `[${r.pid}]` : '')}
            </span>
          </>
        )}
        <span className="text">{r ? renderText(r.text, props.highlight) : ''}</span>
      </div>
    )
  }

  return (
    <div className="logview" style={{ fontSize }}>
      <div
        className="viewport"
        ref={viewportRef}
        tabIndex={0}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <div className="rows" ref={innerRef} style={{ transform: `translateY(${offsetY}px)`, minWidth: minWidth || undefined }}>
          {rows}
        </div>
        {count === 0 && !info.loading && <div className="empty">{info.error ? info.error : info.lineCount === 0 ? 'No entries' : 'No lines match the current filter'}</div>}
      </div>
      <div className="vscroll" ref={trackRef} onPointerDown={onTrackDown}>
        <div
          className="thumb"
          style={{ height: thumbH, transform: `translateY(${thumbTop}px)` }}
          onPointerDown={onThumbDown}
          onPointerMove={onThumbMove}
          onPointerUp={onThumbUp}
        />
      </div>
    </div>
  )
})

function renderText(text: string, hl: RegExp | null): ReactNode {
  let t = text.length > MAX_RENDER_CHARS ? text.slice(0, MAX_RENDER_CHARS) + ' …' : text
  if (t.includes('\n')) t = t.replace(/\n/g, ' ⏎ ')
  if (!hl) return t
  const re = new RegExp(hl.source, hl.flags.includes('g') ? hl.flags : hl.flags + 'g')
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(t)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    if (m.index > last) out.push(t.slice(last, m.index))
    out.push(<mark key={k++}>{m[0]}</mark>)
    last = m.index + m[0].length
    if (k > 200) break
  }
  if (out.length === 0) return t
  if (last < t.length) out.push(t.slice(last))
  return out
}
