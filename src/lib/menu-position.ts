export interface MenuPos {
  top?: number
  bottom?: number
  left?: number
  right?: number
  maxHeight: number
}

/**
 * Where to put a popover anchored to a button, so all of it is on screen.
 *
 * Anchoring to the button's bottom and trusting max-height is not enough: on a
 * row low in a list the box starts near the foot of the window and runs off
 * the screen, and its own scrollbar cannot help because the scroll
 * container's bottom edge is off-screen too. So measure the room on each side,
 * open into whichever is larger, and cap the height to what is actually there.
 *
 * Horizontally: open leftward from a button in the right half of the window
 * (a list row's ⋮), rightward from one on the left (next to a title).
 *
 * Shared by every ⋮ menu. It used to live inside TrackMenu alone, which is how
 * AlbumMenu and PlaylistEditMenu kept the bug it fixed.
 */
export function menuPosition(r: DOMRect): MenuPos {
  const GAP = 6
  const MARGIN = 12 // never touch the very edge of the window
  const below = window.innerHeight - r.bottom - GAP - MARGIN
  const above = r.top - GAP - MARGIN
  const dropUp = below < 220 && above > below
  const leftward = r.right > window.innerWidth / 2
  return {
    top: dropUp ? undefined : r.bottom + GAP,
    bottom: dropUp ? window.innerHeight - r.top + GAP : undefined,
    left: leftward ? undefined : r.left,
    right: leftward ? window.innerWidth - r.right : undefined,
    maxHeight: Math.max(160, Math.min(dropUp ? above : below, window.innerHeight * 0.6)),
  }
}
