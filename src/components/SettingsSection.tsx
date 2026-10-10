import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * One collapsible block of the Settings dialog. The Library tab had grown to
 * eight stacked panels -- one of them a seventy-row tag list -- so the dialog
 * scrolled for screens. Each block now folds to a single row with its title
 * and a one-line note, closed by default, and remembers per device whether
 * you left it open.
 *
 * A compact cousin of AccordionSection (Recently, Discover), whose page-sized
 * headers would dwarf a dialog.
 */
export function SettingsSection({
  id,
  title,
  icon,
  note,
  defaultOpen = false,
  children,
}: {
  /** Key for remembering open/closed; stable across releases. */
  id: string
  title: string
  icon?: React.ReactNode
  /** Kept visible while closed, e.g. "70 tags" or "measured". */
  note?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const key = `allegory.settings.open.${id}`
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? defaultOpen : v === '1'
    } catch {
      return defaultOpen
    }
  })
  function toggle() {
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? '0' : '1')
      } catch {
        // Non-fatal: it just won't be remembered.
      }
      return !o
    })
  }
  return (
    <div className="border-t border-line/60">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-3 text-left text-sm text-white/85 transition-colors hover:text-white"
      >
        {icon && <span className="text-white/70">{icon}</span>}
        <span className="flex-1 font-medium">{title}</span>
        {note && <span className="shrink-0 text-xs text-white/50">{note}</span>}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-white/60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="pb-4">{children}</div>}
    </div>
  )
}
