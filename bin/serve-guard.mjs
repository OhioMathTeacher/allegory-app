// "There is ONE copy of Allegory, and it runs on the iMac." (CLAUDE.md)
//
// That rule lived only in prose, so a preview server got started on MacGuffey
// during screenshot work -- a second thing claiming to be Allegory, on the one
// port that must stay clear everywhere else. Now the rule refuses.
//
// Override deliberately with ALLEGORY_ALLOW_SERVE=1 when you really do mean to
// preview a build locally.
import { hostname } from 'node:os'

// Match the hostname EXACTLY, never as a substring. The substring form was
// `includes('fedora')`, which passes on ToddGPT -- whose hostname is literally
// `fedora` -- so the guard did not fire on the one machine where it matters
// most: ToddGPT holds FERPA-protected student coursework and must not serve
// anything to the network. Renaming it to `ToddGPT-fedora` would not have
// helped either; that still contains "fedora".
//
// Strip any DNS suffix (`imac-fedora.local`, `.tail7162dd.ts.net`) so the
// comparison is against the bare host label on every machine.
const SERVING_HOSTS = ['imac-fedora', 'imac']
const here = hostname().toLowerCase().split('.')[0]

if (process.env.ALLEGORY_ALLOW_SERVE === '1') {
  console.log(`[serve-guard] override set — previewing on ${here}`)
  process.exit(0)
}

if (!SERVING_HOSTS.includes(here)) {
  console.error(
    `\n[serve-guard] refusing to serve on "${here}".\n` +
    `  Allegory is served by allegory.service on the iMac, and a second\n` +
    `  preview is a second thing claiming to be the app.\n\n` +
    `  The live app:   http://100.95.103.93:4173/\n` +
    `  To develop:     npm run dev   (port 5173, this machine)\n` +
    `  If you really mean it:  ALLEGORY_ALLOW_SERVE=1 npm run preview\n`,
  )
  process.exit(1)
}
