import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gainFor, parseEbur128, TARGET_LUFS } from './loudness.ts'

// The tail ffmpeg 8.1 prints for `-af ebur128=peak=true:framelog=quiet`,
// copied from a real run on the iMac.
const SUMMARY = `
[Parsed_ebur128_0 @ 0x55f1eb1c3f00] Summary:

  Integrated loudness:
    I:          -9.8 LUFS
    Threshold: -20.0 LUFS

  Loudness range:
    LRA:         3.7 LU
    Threshold: -30.0 LUFS
    LRA low:   -12.3 LUFS
    LRA high:   -8.5 LUFS

  True peak:
    Peak:        1.1 dBFS
`

test('parseEbur128 reads integrated loudness and true peak from the summary', () => {
  assert.deepEqual(parseEbur128(SUMMARY), { i: -9.8, peak: 1.1 })
})

test('parseEbur128 returns null for silence or no summary', () => {
  assert.equal(parseEbur128('    I:         -inf LUFS\n'), null)
  assert.equal(parseEbur128('Invalid data found when processing input'), null)
})

test('gainFor turns loud tracks down to the target and never boosts', () => {
  assert.equal(gainFor({ i: -9.8 }), TARGET_LUFS + 9.8)
  assert.ok(gainFor({ i: -9.8 }) < 0)
  assert.equal(gainFor({ i: -22 }), 0)
})
