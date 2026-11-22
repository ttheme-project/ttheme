import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const OUTPUTS = new Set(['frame.write', 'osc.write', 'reload'])

const BOUNDS = new Set([
  'input.bytes',
  'input.key',
  'focus.in',
  'focus.done',
  'verb.start',
  'verb.end',
  'cli.start',
  'cli.end',
  'proc.start',
  'proc.main',
  'proc.exit',
  'shell.start',
  'shell.ready',
  'prompt',
])

const PROCESS = /^(cli|proc|shell)\./
const GRACE = 300
const QUIET = 250
const BYTES_WAIT = 250
const STEADY_SHARE = 0.05
const SAME_CELL = 6
const SAME_CELLS = 2
const BLANK_SPREAD = 12
const BLANK_SHARE = 0.5

interface Mark {
  at: number
  pid: number
  proc: string
  name: string
  detail: string
}

interface Shot {
  at: number
  kind: string
  cells: Uint8Array | undefined
}

interface Segment {
  label: string
  stage: 'A' | 'B' | 'C' | 'D'
  from: number
  to: number
}

interface Span {
  name: string
  pid: number
  tid: number
  from: number
  to: number
}

interface Interaction {
  anchor: Mark
  run: number
  ordinal: number
  end: number
  segments: Segment[]
  first: number | undefined
  done: number | undefined
  written: number | undefined
  shown: boolean
  dropped: boolean
  between: number
  later: number
  blank: number
  spans: Span[]
}

function readMarks(file: string): Mark[] {
  const marks: Mark[] = []

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [ts, pid, proc, name, ...rest] = line.split('\t')

    if (!ts || !name || Number.isNaN(Number(ts))) {
      continue
    }

    marks.push({ at: Number(ts) * 1000, pid: Number(pid), proc: proc ?? '', name, detail: rest.join(' ') })
  }

  return marks.sort((a, b) => a.at - b.at)
}

function readShots(file: string | undefined): Shot[] {
  if (!file || !existsSync(file)) {
    return []
  }

  const shots: Shot[] = []

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [ts, kind, , cells] = line.split('\t')

    if (!ts || !kind) {
      continue
    }

    shots.push({ at: Number(ts) * 1000, kind, cells: cells ? Uint8Array.from(Buffer.from(cells, 'hex')) : undefined })
  }

  return shots.sort((a, b) => a.at - b.at)
}

function differs(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) {
    return true
  }

  let moved = 0

  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > SAME_CELL && ++moved > SAME_CELLS) {
      return true
    }
  }

  return false
}

function spreadOf(cells: Uint8Array | undefined): number {
  if (!cells || cells.length === 0) {
    return Number.NaN
  }

  let low = 255
  let high = 0

  for (const cell of cells) {
    low = Math.min(low, cell)
    high = Math.max(high, cell)
  }

  return high - low
}

function blankOf(cells: Uint8Array | undefined, around: readonly (Uint8Array | undefined)[] = []): boolean {
  const spread = spreadOf(cells)

  const others = around.flatMap((each) => {
    const value = spreadOf(each)

    return Number.isNaN(value) ? [] : [value]
  })

  return spread <= Math.max(BLANK_SPREAD, others.length > 0 ? Math.min(...others) * BLANK_SHARE : 0)
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)

  if (sorted.length === 0) {
    return Number.NaN
  }

  const at = (sorted.length - 1) * q
  const low = Math.floor(at)
  const high = Math.ceil(at)

  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (at - low)
}

function namesOf(marks: readonly Mark[]): Map<number, string> {
  const names = new Map<number, string>()

  for (const each of marks) {
    if (names.has(each.pid)) {
      continue
    }

    if (each.proc === 'node') {
      const verb = marks.find((m) => m.pid === each.pid && m.name === 'proc.start')?.detail.split(' ')[0]
      names.set(each.pid, `node ${verb || 'ttheme'}`)
    } else {
      names.set(each.pid, each.proc)
    }
  }

  return names
}

function anchorsOf(marks: readonly Mark[]): Mark[] {
  const sent = marks.some((each) => each.name === 'input.sent')

  const keys = marks.filter(
    (each) =>
      each.name === 'input.sent' ||
      each.name === 'focus.in' ||
      (each.name === 'input.key' && (!sent || each.detail === 'paste' || each.detail.startsWith('mouse.'))),
  )

  return keys.map((each) => {
    if (each.name !== 'input.key') {
      return each
    }

    const bytes = marks.findLast(
      (other) =>
        other.name === 'input.bytes' &&
        other.pid === each.pid &&
        other.at <= each.at &&
        each.at - other.at < BYTES_WAIT,
    )

    return bytes ? { ...bytes, detail: each.detail } : each
  })
}

function spansOf(inside: readonly Mark[]): Span[] {
  const spans: Span[] = []
  const open = new Map<string, Mark>()

  for (const each of inside) {
    if (each.name === 'net.start') {
      open.set(`net ${each.pid} ${each.detail}`, each)
    } else if (each.name === 'net.head' || each.name === 'net.fail' || each.name === 'net.body') {
      const url = each.name === 'net.head' ? each.detail.slice(each.detail.indexOf(' ') + 1) : each.detail
      const key = `net ${each.pid} ${url}`
      const began = open.get(key)

      if (began) {
        spans.push({ name: `net ${url}`, pid: each.pid, tid: 2, from: began.at, to: each.at })

        if (each.name !== 'net.head') {
          open.delete(key)
        }
      }
    } else if (each.name === 'render.start') {
      open.set(`render ${each.pid} ${each.detail.split(' ')[0]}`, each)
    } else if (each.name === 'render.end') {
      const key = `render ${each.pid} ${each.detail}`
      const began = open.get(key)

      if (began) {
        spans.push({ name: `render ${began.detail}`, pid: each.pid, tid: 3, from: began.at, to: each.at })
        open.delete(key)
      }
    }
  }

  return spans
}

function settledOf(written: readonly Mark[], inside: readonly Mark[]): Mark[] {
  const kept = written.slice(0, 1)

  for (const [k, next] of written.entries()) {
    const prev = written[k - 1]

    if (!prev) {
      continue
    }

    const busy = inside.some(
      (each) => each.at > prev.at && each.at < next.at && !OUTPUTS.has(each.name) && !each.name.startsWith('input.'),
    )

    if (next.at - prev.at > QUIET && !busy) {
      break
    }

    kept.push(next)
  }

  return kept
}

function stageOf(from: Mark, to: Mark): Segment['stage'] {
  if (from.name === 'input.sent') {
    return 'A'
  }

  if (to.proc === 'screen') {
    return 'D'
  }

  return PROCESS.test(from.name) || PROCESS.test(to.name) ? 'C' : 'B'
}

interface Cadence {
  usual: number
  limit: number
  steady: boolean
}

function cadenceOf(shots: readonly Shot[]): Cadence {
  const beats = shots.filter((shot) => shot.kind === 'frame' || shot.kind === 'same' || shot.kind === 'idle')
  const gaps = beats.slice(1).map((shot, i) => shot.at - (beats[i]?.at ?? shot.at))
  const usual = gaps.length > 0 ? quantile(gaps, 0.5) : Number.NaN
  const limit = Math.max(25, usual * 2.5)
  const late = gaps.filter((gap) => gap > usual * 1.5).length

  return { usual, limit, steady: gaps.length > 0 && late / gaps.length < STEADY_SHARE }
}

function interactionsOf(marks: readonly Mark[], shots: readonly Shot[], names: Map<number, string>): Interaction[] {
  const anchors = anchorsOf(marks)
  const starts = marks.filter((each) => each.name === 'run.start')
  const frames = shots.filter((shot) => shot.kind === 'frame')
  const beats = shots.filter((shot) => shot.kind === 'frame' || shot.kind === 'same' || shot.kind === 'idle')
  const { limit: gapLimit, steady } = cadenceOf(shots)
  const ordinals = new Map<number, number>()
  const found: Interaction[] = []

  for (const [i, anchor] of anchors.entries()) {
    const run = starts.filter((start) => start.at <= anchor.at).length
    const ordinal = (ordinals.get(run) ?? 0) + 1
    ordinals.set(run, ordinal)
    const nextRun = starts.find((start) => start.at > anchor.at)?.at ?? Number.POSITIVE_INFINITY

    const end = Math.min(
      anchors[i + 1]?.at ?? Number.POSITIVE_INFINITY,
      nextRun,
      (marks.at(-1)?.at ?? anchor.at) + GRACE,
    )

    const inside = marks.filter((each) => each.at > anchor.at && each.at < end && each !== anchor)
    const written = inside.filter((each) => OUTPUTS.has(each.name))
    const firstOut = written[0]
    const kept = settledOf(written, inside)
    const doneOut = kept.at(-1)
    const limit = doneOut?.at ?? end
    const picks = new Map<string, Mark>()

    for (const each of inside) {
      if (each.at <= limit && BOUNDS.has(each.name) && !picks.has(`${each.pid} ${each.name}`)) {
        picks.set(`${each.pid} ${each.name}`, each)
      }
    }

    const chain: Mark[] = [anchor, ...picks.values()]

    if (firstOut && firstOut !== doneOut) {
      chain.push(firstOut)
    }

    if (doneOut) {
      chain.push({ ...doneOut, name: `${doneOut.name} (last)` })
    }

    const shownFirst = firstOut && frames.find((shot) => shot.at >= firstOut.at && shot.at <= end + GRACE)
    const shownDone = doneOut && frames.find((shot) => shot.at >= doneOut.at && shot.at <= end + GRACE)

    if (shownDone) {
      chain.push({ at: shownDone.at, pid: 0, proc: 'screen', name: 'settled', detail: '' })
    }

    chain.sort((a, b) => a.at - b.at)
    const segments: Segment[] = []

    for (let k = 1; k < chain.length; k++) {
      const from = chain[k - 1]
      const to = chain[k]

      if (from && to) {
        segments.push({
          label: `${from.pid ? names.get(from.pid) : from.proc} ${from.name} → ${to.pid ? names.get(to.pid) : to.proc} ${to.name}`,
          stage: stageOf(from, to),
          from: from.at,
          to: to.at,
        })
      }
    }

    const lead = shownDone ? beats.findLast((shot) => shot.at < shownDone.at) : undefined
    const dropped = steady && shownDone !== undefined && lead !== undefined && shownDone.at - lead.at > gapLimit
    const before = frames.findLast((shot) => shot.at < anchor.at)
    const middle = shownDone ? frames.filter((shot) => shot.at > anchor.at && shot.at < shownDone.at) : []
    const odd = middle.filter((shot) => differs(shot.cells, before?.cells) && differs(shot.cells, shownDone?.cells))

    found.push({
      anchor,
      run,
      ordinal,
      end,
      segments,
      first: shownFirst ? shownFirst.at - anchor.at : undefined,
      done: shownDone ? shownDone.at - anchor.at : undefined,
      written: doneOut ? doneOut.at - anchor.at : undefined,
      shown: shots.length > 0,
      dropped,
      between: odd.length,
      later: written.length - kept.length,
      blank: odd.filter((shot) => blankOf(shot.cells, [before?.cells, shownDone?.cells])).length,
      spans: spansOf(inside),
    })
  }

  return found
}

function labelOf(interaction: Interaction): string {
  const { anchor } = interaction

  const what =
    anchor.name === 'input.sent' || anchor.name === 'input.bytes'
      ? anchor.detail
      : `${anchor.name} ${anchor.detail}`.trim()

  return interaction.run > 0 ? `#${interaction.ordinal} ${what}` : what
}

function ms(value: number): string {
  return Number.isNaN(value) ? '-' : value.toFixed(1)
}

function table(group: readonly Interaction[]): string[] {
  const usable = group.filter((each) => !each.dropped)
  const rows = new Map<string, { stage: string; values: number[]; offsets: number[] }>()

  for (const each of group) {
    for (const segment of each.segments) {
      if (segment.stage === 'D' && each.dropped) {
        continue
      }

      const row = rows.get(segment.label) ?? { stage: segment.stage, values: [], offsets: [] }
      row.values.push(segment.to - segment.from)
      row.offsets.push(segment.from - each.anchor.at)
      rows.set(segment.label, row)
    }
  }

  const ordered = [...rows.entries()].sort((a, b) => quantile(a[1].offsets, 0.5) - quantile(b[1].offsets, 0.5))

  const slowest = ordered.reduce<string | undefined>(
    (best, [label, row]) =>
      best === undefined || quantile(row.values, 0.5) > quantile(rows.get(best)?.values ?? [], 0.5) ? label : best,
    undefined,
  )

  const width = Math.max(30, ...ordered.map(([label]) => label.length))

  const lines = [
    `  ${'stage'.padEnd(width + 2)}${'n'.padStart(4)}${'median'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}`,
  ]

  for (const [label, row] of ordered) {
    const mark = label === slowest ? '  ← slowest' : ''
    lines.push(
      `  ${row.stage} ${label.padEnd(width)}${String(row.values.length).padStart(4)}${ms(quantile(row.values, 0.5)).padStart(9)}${ms(quantile(row.values, 0.95)).padStart(9)}${ms(Math.max(...row.values)).padStart(9)}${mark}`,
    )
  }

  const totals: [string, number[]][] = group[0]?.shown
    ? [
        ['to the first change on screen', usable.flatMap((each) => (each.first === undefined ? [] : [each.first]))],
        ['to the screen settled', usable.flatMap((each) => (each.done === undefined ? [] : [each.done]))],
      ]
    : [['to the last write (no capture)', group.flatMap((each) => (each.written === undefined ? [] : [each.written]))]]

  for (const [label, values] of totals) {
    if (values.length > 0) {
      lines.push(
        `  = ${label.padEnd(width)}${String(values.length).padStart(4)}${ms(quantile(values, 0.5)).padStart(9)}${ms(quantile(values, 0.95)).padStart(9)}${ms(Math.max(...values)).padStart(9)}`,
      )
    }
  }

  const waits = group.flatMap((each) => each.spans)

  if (waits.length > 0) {
    const net = waits.flatMap((span) => (span.tid === 2 ? [span.to - span.from] : []))
    const render = waits.flatMap((span) => (span.tid === 3 ? [span.to - span.from] : []))
    lines.push(
      `  meanwhile: ${net.length} network requests (longest ${ms(Math.max(0, ...net))} ms), ${render.length} renders (longest ${ms(Math.max(0, ...render))} ms)`,
    )
  }

  if (group[0]?.shown) {
    const between = group.reduce((sum, each) => sum + each.between, 0)
    const blank = group.reduce((sum, each) => sum + each.blank, 0)
    const dropped = group.length - usable.length
    const later = group.filter((each) => each.later > 0).length
    lines.push(
      `  frames in between: ${between} (blank ${blank}) over ${usable.length} runs${dropped ? `, ${dropped} left out: the capture had a gap just before the screen settled` : ''}${later ? `; ${later} runs wrote again after ${QUIET} ms of nothing, left out of settled` : ''}`,
    )
  }

  return lines
}

function perfetto(
  marks: readonly Mark[],
  shots: readonly Shot[],
  names: Map<number, string>,
  picked: readonly Interaction[],
) {
  const from = Math.min(...picked.map((each) => each.anchor.at)) - 50
  const to = Math.max(...picked.map((each) => each.end)) + GRACE
  const us = (at: number) => Math.round((at - from) * 1000)

  const events: object[] = [
    { ph: 'M', name: 'process_name', pid: 1, args: { name: 'stages' } },
    { ph: 'M', name: 'process_name', pid: 2, args: { name: 'screen' } },
  ]

  for (const [pid, name] of names) {
    events.push({ ph: 'M', name: 'process_name', pid: pid + 10, args: { name: `${name} ${pid}` } })
  }

  for (const each of marks) {
    if (each.at >= from && each.at <= to) {
      events.push({
        ph: 'i',
        s: 't',
        name: each.name,
        pid: each.pid + 10,
        tid: 1,
        ts: us(each.at),
        args: { detail: each.detail },
      })
    }
  }

  for (const shot of shots) {
    if (shot.kind === 'frame' && shot.at >= from && shot.at <= to) {
      events.push({
        ph: 'i',
        s: 't',
        name: blankOf(shot.cells) ? 'frame (blank)' : 'frame',
        pid: 2,
        tid: 1,
        ts: us(shot.at),
      })
    }
  }

  for (const each of picked) {
    events.push({
      ph: 'X',
      name: labelOf(each),
      pid: 1,
      tid: 1,
      ts: us(each.anchor.at),
      dur: us(each.end) - us(each.anchor.at),
    })

    for (const segment of each.segments) {
      events.push({
        ph: 'X',
        name: `${segment.stage} ${segment.label}`,
        pid: 1,
        tid: 2,
        ts: us(segment.from),
        dur: Math.max(1, us(segment.to) - us(segment.from)),
      })
    }

    for (const span of each.spans) {
      events.push({
        ph: 'X',
        name: span.name,
        pid: span.pid + 10,
        tid: span.tid,
        ts: us(span.from),
        dur: Math.max(1, us(span.to) - us(span.from)),
      })
    }
  }

  return { traceEvents: events, displayTimeUnit: 'ms' }
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { frames: { type: 'string' }, perfetto: { type: 'string' } },
  })

  const file = positionals[0]

  if (!file || !existsSync(file)) {
    process.stderr.write(`trace: no trace at ${file ?? '(none given)'}\n`)

    return 1
  }

  const framesFile = values.frames ?? (existsSync(`${file}.frames`) ? `${file}.frames` : undefined)
  const marks = readMarks(file)
  const shots = readShots(framesFile)
  const names = namesOf(marks)
  const found = interactionsOf(marks, shots, names)

  if (found.length === 0) {
    process.stderr.write(`trace: ${file} holds ${marks.length} marks and no key or focus to start from\n`)

    return 1
  }

  const groups = new Map<string, Interaction[]>()

  for (const each of found) {
    const label = labelOf(each)
    groups.set(label, [...(groups.get(label) ?? []), each])
  }

  const lost = found.filter(
    (each) =>
      each.anchor.name === 'input.sent' &&
      !marks.some((other) => other.name === 'input.bytes' && other.at > each.anchor.at && other.at < each.end),
  ).length

  if (lost > 0) {
    process.stderr.write(
      `trace: ${lost} of ${found.length} keys sent never arrived as bytes; the terminal may drop key events sent to it\n`,
    )
  }

  const runs = new Set(found.map((each) => each.run)).size
  const captured = shots.filter((shot) => shot.kind === 'frame').length
  process.stdout.write(
    `${file}\n  ${marks.length} marks, ${found.length} interactions${runs > 1 ? ` over ${runs} runs` : ''}, ${framesFile ? `${captured} changed frames captured` : 'no screen capture'}\n`,
  )
  const cadence = cadenceOf(shots)

  if (framesFile && !cadence.steady) {
    process.stdout.write(
      `  the terminal sent frames only when they changed (usually ${ms(cadence.usual)} ms apart, often more), so a skipped frame cannot be told from a still screen\n`,
    )
  }

  process.stdout.write('  A input, B ttheme, C process boundary, D terminal and screen; times in ms from the key\n')

  for (const [label, group] of groups) {
    process.stdout.write(`\n${label}\n${table(group).join('\n')}\n`)
  }

  const ranked = found
    .filter((each) => !each.dropped)
    .sort((a, b) => (b.done ?? b.written ?? 0) - (a.done ?? a.written ?? 0))

  const slowest = ranked[0] ?? found[0]

  if (slowest) {
    const picked = values.perfetto === 'all' ? found : [slowest]
    const out = file.replace(/\.tsv$/, '') + (values.perfetto === 'all' ? '.perfetto.json' : '.slowest.json')
    writeFileSync(out, JSON.stringify(perfetto(marks, shots, names, picked)))
    process.stdout.write(
      `\nslowest: ${labelOf(slowest)}${slowest.run ? ` in run ${slowest.run}` : ''}, ${ms(slowest.done ?? slowest.written ?? Number.NaN)} ms\nperfetto: ${out} (open it at ui.perfetto.dev)\n`,
    )
  }

  return 0
}

process.exitCode = main()
