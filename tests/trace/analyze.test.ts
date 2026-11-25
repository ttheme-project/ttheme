import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze, type Interaction, parseMarks, parseShots } from './analyze.ts'

const EPOCH = 1_800_000_000
const BEAT = 1000 / 60

type Row = [at: number, pid: number, ppid: number, proc: string, name: string, detail?: string]

function stamp(at: number): string {
  return (EPOCH + at / 1000).toFixed(6)
}

function marks(rows: readonly Row[]) {
  return parseMarks(
    rows
      .map(([at, pid, ppid, proc, name, detail = '']) => `${stamp(at)}\t${pid}\t${ppid}\t${proc}\t${name}\t${detail}`)
      .join('\n'),
  )
}

function capture(
  from: number,
  to: number,
  changes: readonly [number, number][],
  gaps: readonly [number, number][] = [],
) {
  const due = [...changes]
  const lines: string[] = []

  for (let at = from; at < to; at += BEAT) {
    if (gaps.some(([a, b]) => at > a && at < b)) {
      continue
    }

    const next = due[0]

    if (next && next[0] <= at) {
      due.shift()
      lines.push(`${stamp(at)}\tframe\t2560\t${Buffer.alloc(2560, next[1]).toString('hex')}`)
    } else {
      lines.push(`${stamp(at)}\tsame`)
    }
  }

  return parseShots(lines.join('\n'))
}

function chain(interaction: Interaction | undefined): string[] {
  return (interaction?.segments ?? []).map(
    ({ from, to, stage }) => `${stage} ${from.mark.pid}:${from.mark.name} > ${to.mark.pid}:${to.mark.name}`,
  )
}

test('a last write that changes nothing settles nowhere, and the next key keeps its own frame', () => {
  const found = analyze(
    marks([
      [1000, 900, 1, 'keys', 'input.sent', 'x'],
      [1004, 100, 1, 'zsh', 'input.bytes'],
      [1004.5, 100, 1, 'zsh', 'input.key', 'x'],
      [1010, 100, 1, 'zsh', 'frame.write'],
      [1500, 900, 1, 'keys', 'input.sent', 'y'],
      [1504, 100, 1, 'zsh', 'input.bytes'],
      [1504.5, 100, 1, 'zsh', 'input.key', 'y'],
      [1510, 100, 1, 'zsh', 'frame.write'],
    ]),
    capture(900, 2000, [
      [900, 40],
      [1510, 80],
    ]),
  ).interactions

  assert.equal(found[0]?.done, undefined)
  assert.equal(found[0]?.unseen, true)
  assert.ok(Math.abs((found[1]?.done ?? 0) - (900 + 37 * BEAT - 1500)) < 0.01)
})

test('a run that settled after a gap in the capture keeps its time and says where the change could have landed', () => {
  const found = analyze(
    marks([
      [1000, 900, 1, 'keys', 'input.sent', 'a'],
      [1004, 100, 1, 'zsh', 'input.bytes'],
      [1004.5, 100, 1, 'zsh', 'input.key', 'a'],
      [1010, 100, 1, 'zsh', 'frame.write'],
    ]),
    capture(
      900,
      2000,
      [
        [900, 40],
        [1010, 80],
      ],
      [[1010, 1130]],
    ),
  ).interactions

  assert.ok(Math.abs((found[0]?.done ?? 0) - (900 + 14 * BEAT - 1000)) < 0.01)
  assert.equal(found[0]?.floor, 10)
})

test('a background job of the same shell stays out of the stages of the key that opened Browse', () => {
  const found = analyze(
    marks([
      [999.9, 100, 1, 'zsh', 'input.bytes'],
      [1000.3, 100, 1, 'zsh', 'input.key', 'tab'],
      [1000.8, 300, 100, 'zsh', 'cli.start', 'latest'],
      [1001, 100, 1, 'zsh', 'cli.start', 'browse'],
      [1003, 301, 300, 'node', 'proc.start', 'latest'],
      [1005, 201, 100, 'node', 'proc.start', 'browse'],
      [1045, 301, 300, 'node', 'proc.main'],
      [1050, 301, 300, 'node', 'net.start', 'https://index.example/latest'],
      [1060, 201, 100, 'node', 'proc.main'],
      [1090, 301, 300, 'node', 'net.head', '200 https://index.example/latest'],
      [1095, 301, 300, 'node', 'proc.exit', '0'],
      [1099, 300, 100, 'zsh', 'cli.end', 'latest 0'],
      [1140, 201, 100, 'node', 'frame.write', '40'],
    ]),
    [],
  ).interactions

  assert.deepEqual(chain(found[0]), [
    'B 100:input.bytes > 100:input.key',
    'B 100:input.key > 100:cli.start',
    'C 100:cli.start > 201:proc.start',
    'C 201:proc.start > 201:proc.main',
    'B 201:proc.main > 201:frame.write',
  ])

  assert.deepEqual(found[0]?.beside.sort(), [300, 301])
  assert.deepEqual(found[0]?.spans, [])
})

test('find run inside a command substitution stays in the chain, from its start to the redraw after it exits', () => {
  const found = analyze(
    marks([
      [999.9, 100, 1, 'zsh', 'input.bytes'],
      [1000.3, 100, 1, 'zsh', 'input.key', 'f'],
      [1001, 110, 100, 'zsh/1', 'cli.start', 'find'],
      [1005, 211, 110, 'node', 'proc.start', 'find'],
      [1050, 211, 110, 'node', 'proc.main'],
      [1100, 211, 110, 'node', 'frame.write', '40'],
      [1499.9, 211, 110, 'node', 'input.bytes'],
      [1500, 211, 110, 'node', 'input.key', 'escape'],
      [1510, 211, 110, 'node', 'proc.exit', '0'],
      [1515, 110, 100, 'zsh/1', 'cli.end', 'find 0'],
      [1530, 100, 1, 'zsh', 'frame.write'],
    ]),
    [],
  ).interactions

  assert.deepEqual(chain(found[0]), [
    'B 100:input.bytes > 100:input.key',
    'C 100:input.key > 110:cli.start',
    'C 110:cli.start > 211:proc.start',
    'C 211:proc.start > 211:proc.main',
    'B 211:proc.main > 211:frame.write',
  ])

  assert.deepEqual(chain(found[1]), [
    'B 211:input.bytes > 211:input.key',
    'C 211:input.key > 211:proc.exit',
    'C 211:proc.exit > 110:cli.end',
    'C 110:cli.end > 100:frame.write',
  ])
})

test('mouse motion over preview starts no interaction of its own', () => {
  const rows: Row[] = []

  for (const at of [1000, 2000, 3000]) {
    rows.push(
      [at, 100, 1, 'zsh', 'input.bytes'],
      [at + 0.3, 100, 1, 'zsh', 'input.key', 'down'],
      [at + 4, 100, 1, 'zsh', 'input.bytes'],
      [at + 4.2, 100, 1, 'zsh', 'input.key', 'mouse.move'],
      [at + 12, 100, 1, 'zsh', 'frame.write'],
    )
  }

  const found = analyze(marks(rows), []).interactions

  assert.deepEqual(
    found.map((each) => [each.anchor.detail, each.written]),
    [
      ['down', 12],
      ['down', 12],
      ['down', 12],
    ],
  )
})

test('the sandbox relay gets a stage of its own on the way in and out', () => {
  const found = analyze(
    marks([
      [1000, 900, 1, 'keys', 'input.sent', 'down'],
      [1004, 800, 1, 'drive', 'relay.in', '3'],
      [1004.05, 100, 800, 'zsh', 'input.bytes'],
      [1004.3, 100, 800, 'zsh', 'input.key', 'down'],
      [1010, 100, 800, 'zsh', 'frame.write'],
      [1010.5, 800, 1, 'drive', 'relay.out', '65536'],
      [1011.5, 800, 1, 'drive', 'relay.out', '65536'],
      [1013, 800, 1, 'drive', 'relay.out', '1200'],
    ]),
    capture(900, 1300, [
      [900, 40],
      [1013, 80],
    ]),
  ).interactions

  assert.deepEqual(
    chain(found[0]).map((each) => each.split(' ')[0]),
    ['A', 'H', 'B', 'B', 'H', 'D'],
  )

  assert.equal(found[0]?.delivered, 13)
})

test('a key that waits for a busy reader counts the wait in B', () => {
  const found = analyze(
    marks([
      [1000, 900, 1, 'keys', 'input.sent', 'down'],
      [1004, 800, 1, 'drive', 'relay.in', '3'],
      [1006, 100, 800, 'zsh', 'frame.tick', 'spin'],
      [1009, 100, 800, 'zsh', 'input.bytes'],
      [1009.3, 100, 800, 'zsh', 'input.key', 'down'],
    ]),
    [],
  ).interactions

  assert.equal(found[0]?.queued, true)

  assert.deepEqual(chain(found[0]).slice(0, 3), [
    'A 900:input.sent > 800:relay.in',
    'B 800:relay.in > 100:frame.tick',
    'B 100:frame.tick > 100:input.bytes',
  ])
})

test('a key the terminal dropped is told apart from one that reached the pty unread', () => {
  const found = analyze(
    marks([
      [1000, 900, 1, 'keys', 'input.sent', 'down'],
      [1500, 900, 1, 'keys', 'input.sent', 'up'],
      [1504, 800, 1, 'drive', 'relay.in', '3'],
    ]),
    [],
  ).interactions

  assert.deepEqual(
    found.map((each) => each.arrival),
    ['none', 'pty'],
  )
})
