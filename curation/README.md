# Curation — backup of the per-song notes ("Cliff's Notes for Socrates")

Version-controlled copies of the curator notes that ground Socrates for specific
songs. The **live** notes are sidecar `.md` files sitting next to each audio file
in the music library (`ALLEGORY_MUSIC_DIR`); the server reads them via
`readSidecar` in `server/router.ts`. This folder **mirrors that tree** so the
writing is backed up in git and can be moved between machines.

The paths here match the music-library layout exactly — to restore, copy a note
back to the same relative path under `ALLEGORY_MUSIC_DIR`.

## Syncing between machines

`bin/sync-curation-notes.sh` does the copy both ways (only `.md` is a note —
`.txt`/`.lrc` are lyrics/other and ignored):

```sh
./bin/sync-curation-notes.sh --export   # music tree -> this folder (then commit/push)
./bin/sync-curation-notes.sh            # this folder -> music tree (after a pull)
```

It finds the music dir from `ALLEGORY_MUSIC_DIR`, else `.allegory-cache/settings.json`,
else `/data/music`, and on import skips notes whose album folder isn't present
on that machine.

## Notes here (song → reading it pairs with)

- *I Found Out* — Lennon → **Allegory of the Cave** (reject the illusions)
- *Bright Horses* — Nick Cave → **Allegory of the Cave** (keep them, knowingly — counterpoint)
- *Waiting for You* — Nick Cave → **Ghosteen** (grief, presence across absence)
- *Once in a Lifetime* — Talking Heads → **A Doll's House** (waking from the sleepwalked life)
- *Old Man* — Neil Young → **Thanatopsis** (time, mortality, the generations)
- *Masters of War* — Dylan → **Hind Swaraj / Gandhi** (wrath vs. nonviolence)

These readings are also the texts in **Marginalia** — the two apps share a canon.
