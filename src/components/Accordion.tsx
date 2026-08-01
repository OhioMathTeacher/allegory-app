import { motion, AnimatePresence } from 'motion/react'
import { ChevronDown } from 'lucide-react'

/**
 * The collapsible section used by Recently and Discover.
 *
 * Sections open and close independently and the set is persisted, so a page
 * reopens the way it was left — including fully collapsed. Lifted out of
 * Recently.tsx when Discover needed the same behaviour; keeping one copy means
 * the two pages can't drift apart in how they animate or what they remember.
 */

// Shared easing with the rest of the app.
const EASE = [0.22, 1, 0.36, 1] as const

interface AccordionSectionProps {
  title: string
  icon?: React.ReactNode
  /** Shown in the header, and kept visible while collapsed — a count here is
   *  what tells you a filter above the section actually did something. */
  note?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}

export function AccordionSection({
  title,
  icon,
  note,
  open,
  onToggle,
  children,
}: AccordionSectionProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        {icon && <span className="text-white">{icon}</span>}
        <span className="flex-1 text-xl font-semibold tracking-tight text-white">
          {title}
        </span>
        {note && <span className="shrink-0 text-xs text-white/35">{note}</span>}
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.26, ease: EASE }}
          className="text-white"
        >
          <ChevronDown className="h-6 w-6" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="border-t border-line/60 px-2 pb-2 pt-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
