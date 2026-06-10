/** Three bars bouncing to signal the currently playing track. */
export function Equalizer() {
  return (
    <div className="flex h-3.5 items-end gap-[2.5px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-full"
          style={{
            height: '100%',
            background: 'var(--accent)',
            transformOrigin: 'bottom',
            animation: `eq 0.85s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </div>
  )
}
