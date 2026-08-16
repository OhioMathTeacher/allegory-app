import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Check, Dices, Loader2, RotateCcw, X } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getMixTypes, MAX_MIXES, type MixGroup, type MixType } from '../lib/api'

/**
 * "Which mixes?" — the catalogue behind the Discover page's three cards.
 *
 * Allegory can make far more mixes than fit on a page, and which three are
 * worth a slot is a matter of taste, not of ranking. So the whole list is here
 * and you keep three of it.
 *
 * Kinds the library can't currently produce stay in the list, greyed, with the
 * reason attached. Hiding them would make the catalogue change size as you
 * listen, which is harder to learn than a fixed list that fills in — and "your
 * log doesn't reach back a year yet" is information worth having.
 */
interface MixPickerProps {
  /** The current picks, in card order. Empty means Allegory is choosing. */
  chosen: string[]
  onChange: (ids: string[]) => void
  onClose: () => void
}

const GROUPS: { id: MixGroup; title: string; note: string }[] = [
  { id: 'history', title: 'From your listening', note: 'Built from the play log' },
  { id: 'shelf', title: 'From your shelves', note: 'Works without any history' },
  { id: 'genre', title: 'By genre', note: 'From your genre tags' },
]

export function MixPicker({ chosen, onChange, onClose }: MixPickerProps) {
  const conn = useConnected()
  const types = useQuery({
    queryKey: ['mix-types', conn.serverUrl],
    queryFn: () => getMixTypes(conn),
    staleTime: 1000 * 60 * 5,
  })

  /**
   * Picking a fourth drops the one you picked first. The alternative — a dead
   * click once three are chosen — makes you deselect before you can select,
   * which is two steps to say one thing.
   */
  function toggle(id: string) {
    if (chosen.includes(id)) {
      onChange(chosen.filter((x) => x !== id))
      return
    }
    onChange([...chosen, id].slice(-MAX_MIXES))
  }

  function surprise() {
    const pool = (types.data ?? []).filter((t) => t.available)
    const picked: string[] = []
    while (picked.length < Math.min(MAX_MIXES, pool.length)) {
      const next = pool[Math.floor(Math.random() * pool.length)]
      if (!picked.includes(next.id)) picked.push(next.id)
    }
    onChange(picked)
  }

  const count = chosen.length

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <motion.div
        initial={{ scale: 0.96, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose your mixes"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl shadow-black/60 sm:max-h-[80vh] sm:rounded-3xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Choose your mixes</h2>
            <p className="mt-0.5 text-xs text-white/45">
              {count === 0
                ? `Allegory is picking ${MAX_MIXES} for you`
                : `${count} of ${MAX_MIXES} picked — a fourth replaces the first`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {types.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/45">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading your library
            </div>
          ) : (
            GROUPS.map((group) => {
              const rows = (types.data ?? []).filter((t) => t.group === group.id)
              if (rows.length === 0) return null
              return (
                <section key={group.id} className="mb-5 last:mb-0">
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold text-white/80">{group.title}</h3>
                    <span className="shrink-0 text-xs text-white/30">{group.note}</span>
                  </div>
                  {/* Two columns on desktop; one on a phone, where a row's
                      subtitle needs the full width to stay readable. */}
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {rows.map((type) => (
                      <Row
                        key={type.id}
                        type={type}
                        picked={chosen.includes(type.id)}
                        onPick={() => toggle(type.id)}
                      />
                    ))}
                  </div>
                </section>
              )
            })
          )}
          {/* Genres come from two places and may be empty in both, so an empty
              shelf here is a state worth naming rather than a silent gap. */}
          {!types.isLoading &&
            (types.data ?? []).every((t) => t.group !== 'genre') && (
              <p className="text-xs text-white/30">
                Genre mixes come from the genre tag on your files and from your
                artists' tags. Set a genre in an album's tag editor, or browse an
                artist page to fill their tags in.
              </p>
            )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={surprise}
            disabled={!types.data}
            className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            <Dices className="h-3.5 w-3.5" />
            Surprise me
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={count === 0}
            className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Let Allegory pick
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-full px-4 py-1.5 text-sm font-semibold text-black transition-transform hover:scale-105"
            style={{ background: 'var(--accent)' }}
          >
            Done
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

interface RowProps {
  type: MixType
  picked: boolean
  onPick: () => void
}

function Row({ type, picked, onPick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!type.available}
      aria-pressed={picked}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        picked
          ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
          : 'border-line hover:bg-white/[0.04]'
      } ${type.available ? '' : 'cursor-not-allowed opacity-40'}`}
    >
      <span
        aria-hidden
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          picked ? 'border-transparent' : 'border-white/25'
        }`}
        style={picked ? { background: 'var(--accent)' } : undefined}
      >
        {picked && <Check className="h-3 w-3 text-black" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white">
          {type.title}
        </span>
        <span className="block text-xs text-white/45">
          {type.available ? type.subtitle : type.reason}
        </span>
      </span>
    </button>
  )
}
