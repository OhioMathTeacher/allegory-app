import { useState } from 'react'
import { Speaker, Check } from 'lucide-react'
import { usePlayer } from '../lib/player'

/**
 * Audio output-device picker — routes playback to a chosen speaker /
 * headphones / Bluetooth device via HTMLMediaElement.setSinkId.
 *
 * Renders nothing when the browser can't switch outputs (needs a secure
 * context — https:// or localhost).
 */
export function OutputPicker() {
  const player = usePlayer()
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  if (!player.outputSupported) return null

  async function refresh() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(all.filter((d) => d.kind === 'audiooutput'))
    } catch {
      setDevices([])
    }
  }

  function toggle() {
    if (!open) void refresh()
    setOpen((o) => !o)
  }

  const current = player.outputDeviceId || 'default'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        title="Audio output device"
        aria-label="Audio output device"
        className={`transition-colors ${
          open ? 'text-white' : 'text-white/70 hover:text-white'
        }`}
      >
        <Speaker className="h-4 w-4" />
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-8 right-0 z-40 min-w-[230px] rounded-lg border border-line bg-surface p-1.5 shadow-xl shadow-black/50">
            <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-white/66">
              Output device
            </div>
            {devices.length === 0 && (
              <div className="px-2.5 py-2 text-sm text-white/74">
                No output devices found
              </div>
            )}
            {devices.map((device, i) => {
              const selected = device.deviceId === current
              return (
                <button
                  key={device.deviceId || i}
                  type="button"
                  onClick={() => {
                    player.setOutputDevice(device.deviceId)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/5"
                >
                  <Check
                    className={`h-3.5 w-3.5 shrink-0 ${
                      selected ? 'opacity-100' : 'opacity-0'
                    }`}
                    style={selected ? { color: 'var(--accent)' } : undefined}
                  />
                  <span className="truncate">{deviceLabel(device, i)}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** A friendly name, falling back when the browser withholds the label. */
function deviceLabel(device: MediaDeviceInfo, index: number): string {
  if (device.label) return device.label
  if (device.deviceId === 'default') return 'System default'
  return `Output ${index + 1}`
}
