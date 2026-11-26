// Small symbolic icon set (16px, stroke based, inherits currentColor).

const P: Record<string, string> = {
  search: 'M7 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9zM10.5 10.5l3.5 3.5',
  folder: 'M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1h-6l-1.5-2h-3.5a1 1 0 0 0-1 1z',
  'folder-open': 'M1.5 12.5v-9a1 1 0 0 1 1-1h3.5l1.5 2h5a1 1 0 0 1 1 1v1.5M1.5 12.5l2-5.5h11l-2 5.5z',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5',
  journal: 'M2.5 2.5h11v11h-11zM5 5.5h6M5 8h6M5 10.5h4',
  server: 'M2.5 2.5h11v4.5h-11zM2.5 9h11v4.5h-11zM4.5 4.75h.01M4.5 11.25h.01',
  plus: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  split: 'M2.5 2.5h11v11h-11zM8 2.5v11',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1',
  filter: 'M2 3h12l-4.5 5.5v4.5l-3 1.5v-6z',
  play: 'M5 3l8 5l-8 5z',
  pause: 'M5 3v10M11 3v10',
  'chevron-right': 'M6 3.5l4.5 4.5l-4.5 4.5',
  'chevron-down': 'M3.5 6l4.5 4.5l4.5-4.5',
  up: 'M4 10l4-4l4 4',
  down: 'M4 6l4 4l4-4',
  menu: 'M3 4.5h10M3 8h10M3 11.5h10',
  refresh: 'M13 3v3.5h-3.5M12.6 6.5a5 5 0 1 0 .4 3',
  export: 'M8 2v8M5 5l3-3l3 3M2.5 9.5v4h11v-4',
  sidebar: 'M2.5 2.5h11v11h-11zM6 2.5v11',
  clock: 'M8 2a6 6 0 1 1 0 12a6 6 0 0 1 0-12zM8 4.5v3.5l2.5 1.5',
  lock: 'M4 7h8v6.5h-8zM5.5 7v-2a2.5 2.5 0 0 1 5 0v2',
  disconnect: 'M3 13l10-10M6 4.5l-1.5 1.5a2.5 2.5 0 0 0 0 3.5l.5.5M10 11.5l1.5-1.5a2.5 2.5 0 0 0 0-3.5l-.5-.5',
  plug: 'M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5v3',
  edit: 'M10.5 2.5l3 3l-8 8h-3v-3z',
  trash: 'M3 4.5h10M6 4.5v-2h4v2M4.5 4.5l.5 9h6l.5-9',
  regex: 'M10.5 2v6M8 3.5l5 3M8 6.5l5-3M3.5 11.5a1.5 1.5 0 1 1 0 .01',
  case: 'M1.5 12l3-8l3 8M2.5 9.5h4M10 7.5a2 2 0 1 1 0 4.5a2 2 0 0 1 0-4.5zM12.5 7v5',
  warning: 'M8 2l6.5 11.5h-13zM8 6.5v3.5M8 12h.01',
  info: 'M8 2a6 6 0 1 1 0 12a6 6 0 0 1 0-12zM8 7.5v4M8 5h.01',
  'arrow-bottom': 'M8 2.5v9M4.5 8l3.5 3.5l3.5-3.5M3 13.5h10',
  columns: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h11M6 3.5v9',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3'
}

export function Icon({ name, size = 16, className }: { name: keyof typeof P | string; size?: number; className?: string }) {
  const d = P[name] ?? P.info
  return (
    <svg
      className={'icon ' + (className ?? '')}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}
