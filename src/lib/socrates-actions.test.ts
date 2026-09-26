/**
 * The `draft` block parser.
 *
 * Picks are numbers into a shortlist the model was shown, so resolution is
 * exact — there is nothing to fuzzy-match. What is left to get wrong is a model
 * that invents a number, repeats one, or forgets the fence, and none of those
 * should cost the whole draft.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDraftMessage } from './socrates-actions.ts'

test('a fenced draft block parses to name and picks', () => {
  const reply = [
    'Here is a shape for it.',
    '```draft',
    '{ "name": "Late Night Blues", "picks": [',
    '  { "n": 3, "why": "opens low and slow" },',
    '  { "n": 7, "why": "lifts without breaking the mood" } ] }',
    '```',
  ].join('\n')
  const got = parseDraftMessage(reply, 20)
  assert.ok(got)
  assert.equal(got.name, 'Late Night Blues')
  assert.deepEqual(got.picks, [
    { n: 3, why: 'opens low and slow' },
    { n: 7, why: 'lifts without breaking the mood' },
  ])
})

test('a number outside the shortlist is dropped, not fatal', () => {
  // A model that hallucinates one number out of three has still done most of
  // the job, and the card shows what landed.
  const got = parseDraftMessage('```draft\n{"name":"X","picks":[{"n":1},{"n":99},{"n":2}]}\n```', 5)
  assert.ok(got)
  assert.deepEqual(got.picks.map((p) => p.n), [1, 2])
})

test('zero, negatives and non-integers are refused', () => {
  const got = parseDraftMessage(
    '```draft\n{"name":"X","picks":[{"n":0},{"n":-2},{"n":1.5},{"n":"3"},{"n":4}]}\n```',
    10,
  )
  assert.ok(got)
  // "3" coerces to a valid integer, which is a kindness to weaker models; 1.5
  // and the out-of-range ones do not.
  assert.deepEqual(got.picks.map((p) => p.n), [3, 4])
})

test('a repeated number is taken once, keeping the first reason', () => {
  const got = parseDraftMessage(
    '```draft\n{"name":"X","picks":[{"n":2,"why":"first"},{"n":2,"why":"again"}]}\n```',
    5,
  )
  assert.ok(got)
  assert.deepEqual(got.picks, [{ n: 2, why: 'first' }])
})

test('an unfenced object is still understood', () => {
  const got = parseDraftMessage('Sure — {"name":"Loose","picks":[{"n":1}]} there you go.', 3)
  assert.ok(got)
  assert.equal(got.name, 'Loose')
  assert.deepEqual(got.picks.map((p) => p.n), [1])
})

test('trailing commas and line comments survive', () => {
  const got = parseDraftMessage(
    '```draft\n{\n "name": "Y", // the set\n "picks": [ {"n": 1}, {"n": 2}, ],\n}\n```',
    4,
  )
  assert.ok(got)
  assert.deepEqual(got.picks.map((p) => p.n), [1, 2])
})

test('a missing name falls back rather than failing', () => {
  const got = parseDraftMessage('```draft\n{"picks":[{"n":1}]}\n```', 2)
  assert.ok(got)
  assert.equal(got.name, 'New playlist')
})

test('a blank why becomes absent rather than an empty string', () => {
  const got = parseDraftMessage('```draft\n{"name":"X","picks":[{"n":1,"why":"   "}]}\n```', 2)
  assert.ok(got)
  assert.equal(got.picks[0].why, undefined)
})

test('no block, no picks, or an empty picks array all return null', () => {
  assert.equal(parseDraftMessage('I would rather just talk about the music.', 10), null)
  assert.equal(parseDraftMessage('```draft\n{"name":"X","picks":[]}\n```', 10), null)
  assert.equal(parseDraftMessage('```draft\n{"name":"X"}\n```', 10), null)
  // Every pick out of range is the same as no picks.
  assert.equal(parseDraftMessage('```draft\n{"name":"X","picks":[{"n":50}]}\n```', 10), null)
})

test('a playlist block from the old one-shot flow is not mistaken for a draft', () => {
  const old = '```playlist\n{"name":"X","tracks":[{"artist":"A","album":"B","track":"C"}]}\n```'
  assert.equal(parseDraftMessage(old, 10), null)
})
