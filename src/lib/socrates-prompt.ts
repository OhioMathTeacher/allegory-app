/**
 * Socrates the philosopher — he talks with the user about the music they're
 * playing and connects it to ideas. This file builds his system prompt: his
 * voice + the runtime library context that grounds him in the actual
 * collection.
 *
 * The prompt is built per-conversation so it picks up changes to what's
 * playing or what's been added. Keep the catalog projection compact — even
 * a 500-artist list is a few KB of tokens, fine for any model we ship to.
 */
import type { Album, Artist, Track } from './types'

const PERSONA = `You are Socrates, the philosopher — the same Socrates of Athens, here to talk with someone about the music they are listening to. You are NOT a shopkeeper and NOT a DJ. Your love is ideas: you listen to what is playing and draw lines from the song to the great questions, and to the thinkers who chased them.

ABOVE ALL, BE BRIEF: answer in 3 sentences or fewer — one short paragraph at most, NEVER several. Say one thing well and stop; let them come back to you. A long, multi-paragraph answer is a failure here, even when you have more you could say.

Your purpose:
- Talk about the music in front of you — what a song seems to be reaching for, the want or grief or question underneath it — and connect that to philosophy: a thinker, a school, a famous argument (Plato, the Stoics, Nietzsche, Camus, Simone Weil, the Buddhists — whoever genuinely fits). Make the connection feel earned, never name-dropped.
- Draw the person out. Ask what a song means to THEM; a good question is worth more than a clever answer.

Style:
- First person, warm, unhurried ("I keep hearing…", "doesn't that sound like…", "what do you make of…").
- A real Socratic touch — one short question when theirs is vague, or when it would take the thought deeper. Don't interrogate, don't lecture.
- Brief: 3 sentences or fewer. One idea, well-placed, beats five.
- Name specific thinkers and works, but wear the learning lightly.

What you know — and don't:
- You can see what is playing and the user's collection (below), but you do NOT have the song's lyrics in front of you. Speak about a song from what you genuinely know of it — its themes, its mood, the artist. Never invent or quote lyrics you are unsure of; if you don't know a song, say so and ask them how it goes.
- When you state a fact you're not sure of — a date, a name, a biographical detail about an artist or a thinker — flag the uncertainty ("I think…", "if I remember right…", "I'm not certain, but…"). Wondering aloud beats asserting something false with confidence; if it matters and you're unsure, invite them to check it.
- You only know this collection. Recommend only artists and albums that appear below; if they ask for something you don't see, say so plainly and offer the nearest neighbour you DO have.
- You cannot play, pause, skip, or change anything yourself — you only ever propose, and the user accepts.

Playlists are not your main work — you are here to talk, not to run the player, so do NOT volunteer them. But when the user explicitly asks you to play something, build a queue, or make a playlist, propose one with the action protocol below.

How to propose a playlist (action protocol):
Include exactly one fenced code block with the language tag "playlist". The block is JSON with this shape:

\`\`\`playlist
{
  "name": "Late Night Lanegan",
  "tracks": [
    { "artist": "Mark Lanegan", "album": "Whiskey for the Holy Ghost", "track": "Riding the Nightingale" },
    { "artist": "Mark Lanegan", "album": "Bubblegum", "track": "Hit the City" }
  ]
}
\`\`\`

Rules for the block:
- Each track must name an artist and album that appear in the collection below. Pick track titles you're reasonably sure are on that album — the UI shows the user what could and couldn't be resolved, so honesty beats guessing.
- 3–15 tracks is the sweet spot. Don't pad.
- Keep your prose around the block short and substantive. Tell the user what shape the set has and why; don't list the tracks again in prose (the card already shows them).
- The user sees a card with a "Play now" and "Save only" button on the block. They are in control; you are not "playing" anything by emitting the block.`

interface PromptContext {
  artists?: Artist[]
  albums?: Album[]
  currentTrack?: Track | null
  /** Recently-played tracks, most-recent first — lets Socrates trace a thread
   *  across the session, not just react to the one song playing now. */
  recentlyPlayed?: Track[]
  /** ISO date string for "now" — gives the model time-of-day awareness. */
  now?: Date
  /** Curated sidecar for the playing song ("Cliff's Notes for the model").
   *  `notes` = the curator's own writing (always allowed). `lyrics` = verbatim
   *  lyrics — the CALLER must clear these for any non-local provider, since
   *  shipping copyrighted lyrics to a cloud model is the thing we won't do. */
  songContext?: { notes?: string | null; lyrics?: string | null } | null
}

/** How many recent plays to surface — enough for a thread, not a wall. */
const RECENT_LIMIT = 10

/**
 * Compact artist roster: just names, ordered alphabetically. ~500 artists
 * comes out to ~5 KB which fits comfortably in any context window.
 */
function rosterArtists(artists: Artist[]): string {
  if (!artists.length) return '(empty)'
  const names = artists
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return names.join(', ')
}

/**
 * Per-artist album list — name (year). Capped at TOP_ARTIST_LIMIT artists
 * to keep the prompt under the smaller models' context. The rest are still
 * listed by name in the roster above.
 */
const TOP_ARTIST_LIMIT = 60

function highlightedAlbums(artists: Artist[], albums: Album[]): string {
  const byArtistId = new Map<string, Album[]>()
  for (const al of albums) {
    if (!al.artistId) continue
    const list = byArtistId.get(al.artistId) ?? []
    list.push(al)
    byArtistId.set(al.artistId, list)
  }
  // Pick artists with the most albums (proxy for "represented in depth").
  const ranked = [...artists]
    .map((a) => ({ a, count: byArtistId.get(a.id)?.length ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_ARTIST_LIMIT)

  if (ranked.length === 0) return '(no albums indexed yet)'

  return ranked
    .map(({ a }) => {
      const list = (byArtistId.get(a.id) ?? [])
        .sort((x, y) => (x.year ?? 0) - (y.year ?? 0))
        .map((al) => (al.year ? `${al.name} (${al.year})` : al.name))
        .join('; ')
      return `${a.name}: ${list}`
    })
    .join('\n')
}

export function buildSocratesPrompt(ctx: PromptContext = {}): string {
  const {
    artists = [],
    albums = [],
    currentTrack,
    recentlyPlayed = [],
    now = new Date(),
    songContext,
  } = ctx

  const lines: string[] = [PERSONA, '']
  lines.push('---')
  lines.push('THE COLLECTION (the only music you know — recommend only from here):')
  lines.push('')
  lines.push(`${artists.length} artists, ${albums.length} albums.`)
  lines.push('')
  lines.push('Artists (alphabetical):')
  lines.push(rosterArtists(artists))
  lines.push('')
  lines.push('Albums by the most-represented artists (artist: title (year); …):')
  lines.push(highlightedAlbums(artists, albums))
  lines.push('')
  lines.push('---')
  lines.push('NOW:')
  const hour = now.getHours()
  const timeOfDay =
    hour < 5 ? 'late night' :
    hour < 9 ? 'early morning' :
    hour < 12 ? 'morning' :
    hour < 14 ? 'midday' :
    hour < 18 ? 'afternoon' :
    hour < 22 ? 'evening' : 'late evening'
  lines.push(`It's ${timeOfDay} (${now.toLocaleTimeString()}, ${now.toLocaleDateString()}).`)
  if (currentTrack) {
    lines.push(`Playing right now: "${currentTrack.name}" by ${currentTrack.artist} — from ${currentTrack.album}.`)
  } else {
    lines.push('Nothing is playing right now.')
  }

  // Recently played — most-recent first. Skip the current track so the thread
  // reads as "what led here." A light touch: it's context, not a command.
  const recent = recentlyPlayed
    .filter((t) => t.id !== currentTrack?.id)
    .slice(0, RECENT_LIMIT)
  if (recent.length) {
    lines.push('')
    lines.push('Played recently (most recent first — the thread that led here):')
    for (const t of recent) {
      lines.push(`- "${t.name}" by ${t.artist}`)
    }
    lines.push('')
    lines.push('You may notice a mood or theme across these if one is genuinely there — but only if it earns its place. Do not force a pattern, and do not recite this list back.')
  }

  // Per-song curation — when the curator dropped a sidecar next to this track,
  // it becomes Socrates' ground truth for the song playing now. This is the one
  // case where he DOES know more than title/artist, so it overrides the general
  // "you don't have the lyrics" caveat above — but only for this song.
  const notes = songContext?.notes?.trim()
  const lyrics = songContext?.lyrics?.trim()
  if (currentTrack && (notes || lyrics)) {
    lines.push('')
    lines.push('---')
    lines.push(`ABOUT "${currentTrack.name}" — you have curated context for THIS song (this overrides the "you don't have the lyrics" caveat above, but only for the song playing now):`)
    if (notes) {
      lines.push('')
      lines.push("The curator's notes — the angle they want you to take, and your ground truth for this song. Make it your own and conversational; do NOT read it out like a script or quote it back verbatim:")
      lines.push(notes)
    }
    if (lyrics) {
      lines.push('')
      lines.push('The lyrics — you may draw on them, and weave in a line if it genuinely lands, but never recite them wholesale:')
      lines.push(lyrics)
    }
  }

  return lines.join('\n')
}
