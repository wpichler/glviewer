// Text input with a scrollable suggestion list. Replaces <datalist>, whose
// native popup in Chromium on Linux cannot scroll and runs off screen.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'>

interface Props extends InputProps {
  value: string
  options: string[]
  onChange(value: string): void
  /** Called when an option is chosen (click or Enter). Defaults to onChange. */
  onPick?(value: string): void
  /** Maximum number of rendered options; more are summarised. */
  maxItems?: number
}

export function ComboInput({ value, options, onChange, onPick, maxItems = 300, onKeyDown, onFocus, onBlur, ...rest }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)
  // after picking, show all options again instead of only the exact match
  const [showAll, setShowAll] = useState(false)

  const { items, total } = useMemo(() => {
    const q = value.trim().toLowerCase()
    let list = options
    if (q && !showAll) {
      const starts: string[] = []
      const contains: string[] = []
      for (const o of options) {
        const l = o.toLowerCase()
        if (l.startsWith(q)) starts.push(o)
        else if (l.includes(q)) contains.push(o)
      }
      list = [...starts, ...contains]
    }
    return { items: list.slice(0, maxItems), total: list.length }
  }, [value, options, maxItems, showAll])

  const place = (): void => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    const up = below < 180 && above > below
    const maxHeight = Math.max(120, Math.min(360, up ? above : below))
    const width = Math.max(r.width, 220)
    const left = Math.min(r.left, window.innerWidth - width - 8)
    setPos(up ? { left, bottom: window.innerHeight - r.top + 4, width, maxHeight } : { left, top: r.bottom + 4, width, maxHeight })
  }

  useLayoutEffect(() => {
    if (open) place()
  }, [open, items.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onMove = (e: Event): void => {
      // ignore scrolling inside the list itself
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return
      place()
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // keep the active option visible
  useEffect(() => {
    if (active < 0 || !listRef.current) return
    const el = listRef.current.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (v: string): void => {
    ;(onPick ?? onChange)(v)
    setOpen(false)
    setActive(-1)
    setShowAll(true)
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(0)
        return
      }
      const n = items.length
      if (n) setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n))
      return
    }
    if (e.key === 'Enter' && open && active >= 0 && active < items.length) {
      e.preventDefault()
      e.stopPropagation()
      pick(items[active])
      return
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      return
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      if (!open || !items.length) return
      e.preventDefault()
      const step = 10
      setActive((a) => Math.max(0, Math.min(items.length - 1, (a < 0 ? 0 : a) + (e.key === 'PageDown' ? step : -step))))
      return
    }
    onKeyDown?.(e)
  }

  return (
    <>
      <input
        {...rest}
        ref={inputRef}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        onChange={(e) => {
          onChange(e.target.value)
          setShowAll(false)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={(e) => {
          setOpen(true)
          onFocus?.(e)
        }}
        onClick={() => setOpen(true)}
        onBlur={(e) => {
          setOpen(false)
          setActive(-1)
          onBlur?.(e)
        }}
        onKeyDown={handleKey}
      />
      {open &&
        pos &&
        !rest.disabled &&
        items.length > 0 &&
        createPortal(
          <div
            className="combo-pop"
            role="listbox"
            ref={listRef}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
            // keep focus in the input while clicking / scrolling the list
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.map((o, i) => (
              <div
                key={o}
                role="option"
                aria-selected={i === active}
                className={'combo-item' + (i === active ? ' active' : '') + (o === value ? ' current' : '')}
                title={o}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                {o}
              </div>
            ))}
            {total > items.length && <div className="combo-more">{(total - items.length).toLocaleString()} more — type to narrow down</div>}
          </div>,
          document.body
        )}
    </>
  )
}
