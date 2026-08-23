// "There is ONE copy of Allegory, and it runs on the iMac." (CLAUDE.md)
//
// That rule lived only in prose, so a preview server got started on MacGuffey
// during screenshot work -- a second thing claiming to be Allegory, on the one
// port that must stay clear everywhere else. Now the rule refuses.
//
// It used to refuse by hostname, and it could not have worked. The serving
// machine is the Fedora iMac on the top floor of the house -- and its static
// hostname is `ToddGPT-fedora`, which is the name of a DIFFERENT machine: the
// one on the Miami University campus holding FERPA-protected student
// coursework, which must never serve anything to a network. So the allowlist
// ['imac-fedora', 'imac'] refused on the only machine allowed to serve, and
// the obvious repair -- adding 'toddgpt-fedora' -- would have handed
// permission to the campus box instead. Verified 2026-08-23: the machine at
// the tailnet name `imac-fedora`, holding /media/MUSIC and running
// allegory.service, reports `ToddGPT-fedora`.
//
// There is no hostname that separates them, so this no longer asks. Serving is
// opt-in per machine and anything that has not opted in is refused. Default
// deny is the right direction when one failure mode is "the music doesn't
// start" and the other is "student coursework is on the network".
//
// A machine opts in either way:
//
//   .allegory-cache/serving    marker file, and the durable answer. The cache
//                              dir is gitignored and bin/allegory-update lands
//                              with `git reset --hard` (never `git clean`), so
//                              the marker outlives every in-app update.
//   ALLEGORY_ALLOW_SERVE=1     one-off, for previewing a build by hand.
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const MARKER = join(REPO, '.allegory-cache', 'serving')
const here = hostname()

if (process.env.ALLEGORY_ALLOW_SERVE === '1') {
  console.log(`[serve-guard] ALLEGORY_ALLOW_SERVE=1 — previewing on ${here}`)
  process.exit(0)
}

if (existsSync(MARKER)) {
  console.log(`[serve-guard] serving on ${here} (${MARKER})`)
  process.exit(0)
}

console.error(
  `\n[serve-guard] refusing to serve on "${here}".\n` +
  `  Allegory is served by allegory.service on the Fedora iMac, and a second\n` +
  `  preview is a second thing claiming to be the app.\n\n` +
  `  The live app:   http://100.95.103.93:4173/\n` +
  `  To develop:     npm run dev   (port 5173, this machine)\n` +
  `  If this IS the serving machine:  touch .allegory-cache/serving\n` +
  `  Just this once:  ALLEGORY_ALLOW_SERVE=1 npm run preview\n`,
)
process.exit(1)
