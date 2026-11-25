import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  type Analysis,
  analyze,
  blankOf,
  GRACE,
  type Interaction,
  type Mark,
  type Proc,
  parseMarks,
  parseShots,
  QUIET,
  quantile,
  type Segment,
  type Step,
} from './analyze.ts'

function procName(mark: Mark, procs: Map<number, Proc>): string {
  return mark.pid ? (procs.get(mark.pid)?.name ?? mark.proc) : mark.proc
}

function stepName(step: Step, procs: Map<number, Proc>): string {
  const suffix = step.role === 'last' ? ' (last)' : step.role === 'busy' ? ' (busy)' : ''

  return `${procName(step.mark, procs)} ${step.mark.name}${suffix}`
}

function labelOf(segment: Segment, procs: Map<number, Proc>): string {
  return `${stepName(segment.from, procs)} → ${stepName(segment.to, procs)}`
}

function whatOf(interaction: Interaction, procs: Map<number, Proc>): string {
  const { anchor } = interaction

  const what =
    anchor.name === 'input.sent' || anchor.name === 'input.bytes'
      ? anchor.detail
      : `${anchor.name} ${anchor.detail}`.trim()

  if (interaction.run > 0) {
    return `#${interaction.ordinal} ${what}`
  }

  const reader = interaction.reader === undefined ? undefined : procs.get(interaction.reader)?.name

  return reader ? `${what} in ${reader}` : what
}

function ms(value: number): string {
  return Number.isNaN(value) ? '-' : value.toFixed(1)
}

function summary(label: string, values: readonly number[], width: number): string {
  return `  = ${label.padEnd(width)}${String(values.length).padStart(4)}${ms(quantile(values, 0.5)).padStart(9)}${ms(quantile(values, 0.95)).padStart(9)}${ms(Math.max(...values)).padStart(9)}`
}

function count(group: readonly Interaction[], test: (each: Interaction) => boolean): number {
  return group.filter(test).length
}

function runs(n: number): string {
  return n === 1 ? '1 run' : `${n} runs`
}

function notes(group: readonly Interaction[], procs: Map<number, Proc>, captured: boolean): string[] {
  const lines: string[] = []
  const waits = group.flatMap((each) => each.spans)

  if (waits.length > 0) {
    const net = waits.flatMap((span) => (span.tid === 2 ? [span.to - span.from] : []))
    const render = waits.flatMap((span) => (span.tid === 3 ? [span.to - span.from] : []))
    lines.push(
      `  meanwhile: ${net.length} network requests (longest ${ms(Math.max(0, ...net))} ms), ${render.length} renders (longest ${ms(Math.max(0, ...render))} ms)`,
    )
  }

  const beside = [...new Set(group.flatMap((each) => each.beside.map((pid) => procs.get(pid)?.name ?? String(pid))))]

  if (beside.length > 0) {
    lines.push(`  also running, left out of the stages: ${beside.join(', ')}`)
  }

  if (captured) {
    const between = group.reduce((sum, each) => sum + each.between, 0)
    const blank = group.reduce((sum, each) => sum + each.blank, 0)
    lines.push(`  frames in between: ${between} (blank ${blank}) over ${runs(group.length)}`)
  }

  const gapped = group.filter((each) => each.floor !== undefined)

  if (gapped.length > 0) {
    const ranges = gapped.map(
      (each) => `between +${ms(each.floor ?? Number.NaN)} and +${ms(each.done ?? Number.NaN)} ms`,
    )

    lines.push(
      `  ${runs(gapped.length)} settled after a gap in the capture, timed at the frame that showed the change; it landed ${ranges.join(', ')}`,
    )
  }

  const unseen = count(group, (each) => each.unseen)

  if (unseen > 0) {
    lines.push(`  ${runs(unseen)}: the last write changed nothing on screen before the next write, so no settle`)
  }

  const crossed = count(group, (each) => each.crossed)

  if (crossed > 0) {
    lines.push(
      `  ${runs(crossed)}: a spinner or another process wrote before the frame that settled, which may show that write`,
    )
  }

  const queued = count(group, (each) => each.queued)

  if (queued > 0) {
    lines.push(`  ${runs(queued)}: ttheme was still busy when the key's bytes were ready, counted in B (busy)`)
  }

  const later = count(group, (each) => each.later > 0)

  if (later > 0) {
    lines.push(`  ${runs(later)} wrote again after ${QUIET} ms of nothing, left out of settled`)
  }

  return lines
}

function table(group: readonly Interaction[], procs: Map<number, Proc>, captured: boolean): string[] {
  const rows = new Map<string, { stage: string; values: number[]; offsets: number[] }>()

  for (const each of group) {
    for (const segment of each.segments) {
      const label = labelOf(segment, procs)
      const row = rows.get(label) ?? { stage: segment.stage, values: [], offsets: [] }
      row.values.push(segment.to.mark.at - segment.from.mark.at)
      row.offsets.push(segment.from.mark.at - each.anchor.at)
      rows.set(label, row)
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

  const totals: [string, number[]][] = captured
    ? [
        ['to the first change on screen', group.flatMap((each) => (each.first === undefined ? [] : [each.first]))],
        ['to the screen settled', group.flatMap((each) => (each.done === undefined ? [] : [each.done]))],
      ]
    : [
        ['to the last write (no capture)', group.flatMap((each) => (each.written === undefined ? [] : [each.written]))],
        [
          'to the terminal (no capture)',
          group.flatMap((each) => (each.delivered === undefined ? [] : [each.delivered])),
        ],
      ]

  for (const [label, values] of totals) {
    if (values.length > 0) {
      lines.push(summary(label, values, width))
    }
  }

  return [...lines, ...notes(group, procs, captured)]
}

function perfetto(analysis: Analysis, picked: readonly Interaction[]) {
  const { marks, shots, procs } = analysis
  const from = Math.min(...picked.map((each) => each.anchor.at)) - 50
  const to = Math.max(...picked.map((each) => each.end)) + GRACE
  const us = (at: number) => Math.round((at - from) * 1000)

  const events: object[] = [
    { ph: 'M', name: 'process_name', pid: 1, args: { name: 'stages' } },
    { ph: 'M', name: 'process_name', pid: 2, args: { name: 'screen' } },
  ]

  for (const each of procs.values()) {
    events.push({
      ph: 'M',
      name: 'process_name',
      pid: each.pid + 10,
      args: { name: `${each.name} ${each.pid} (parent ${each.ppid})` },
    })
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
      name: whatOf(each, procs),
      pid: 1,
      tid: 1,
      ts: us(each.anchor.at),
      dur: us(each.end) - us(each.anchor.at),
    })

    for (const segment of each.segments) {
      events.push({
        ph: 'X',
        name: `${segment.stage} ${labelOf(segment, procs)}`,
        pid: 1,
        tid: 2,
        ts: us(segment.from.mark.at),
        dur: Math.max(1, us(segment.to.mark.at) - us(segment.from.mark.at)),
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

function warn(analysis: Analysis): void {
  const sent = analysis.interactions.filter((each) => each.anchor.name === 'input.sent')
  const none = count(sent, (each) => each.arrival === 'none')
  const pty = count(sent, (each) => each.arrival === 'pty')

  if (none > 0) {
    process.stderr.write(
      `trace: ${none} of ${sent.length} keys sent never reached ttheme's pty; the terminal may drop key events sent to it\n`,
    )
  }

  if (pty > 0) {
    process.stderr.write(`trace: ${pty} of ${sent.length} keys reached ttheme's pty and nothing read them\n`)
  }
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
  const marks = parseMarks(readFileSync(file, 'utf8'))
  const shots = framesFile && existsSync(framesFile) ? parseShots(readFileSync(framesFile, 'utf8')) : []
  const analysis = analyze(marks, shots)
  const found = analysis.interactions

  if (found.length === 0) {
    process.stderr.write(`trace: ${file} holds ${marks.length} marks and no key or focus to start from\n`)

    return 1
  }

  warn(analysis)
  const groups = new Map<string, Interaction[]>()

  for (const each of found) {
    const label = whatOf(each, analysis.procs)
    const group = groups.get(label) ?? []
    group.push(each)
    groups.set(label, group)
  }

  const runs = new Set(found.map((each) => each.run)).size
  const captured = shots.some((shot) => shot.kind === 'frame')
  const frames = shots.filter((shot) => shot.kind === 'frame').length

  process.stdout.write(
    `${file}\n  ${marks.length} marks, ${found.length} interactions${runs > 1 ? ` over ${runs} runs` : ''}, ${framesFile ? `${frames} changed frames captured` : 'no screen capture'}\n`,
  )

  if (framesFile && !analysis.cadence.steady) {
    process.stdout.write(
      `  the terminal sent frames only when they changed (usually ${ms(analysis.cadence.usual)} ms apart, often more), so a gap in the capture cannot be told from a still screen\n`,
    )
  }

  process.stdout.write(
    '  A input, B ttheme, C process start and end, D terminal and screen, H the sandbox relay; times in ms from the key\n',
  )

  for (const [label, group] of groups) {
    process.stdout.write(`\n${label}\n${table(group, analysis.procs, captured).join('\n')}\n`)
  }

  const ranked = [...found].sort(
    (a, b) => (b.done ?? b.delivered ?? b.written ?? 0) - (a.done ?? a.delivered ?? a.written ?? 0),
  )

  const slowest = ranked[0]

  if (slowest) {
    const picked = values.perfetto === 'all' ? found : [slowest]
    const out = file.replace(/\.tsv$/, '') + (values.perfetto === 'all' ? '.perfetto.json' : '.slowest.json')
    writeFileSync(out, JSON.stringify(perfetto(analysis, picked)))
    const took = slowest.done ?? slowest.delivered ?? slowest.written ?? Number.NaN
    process.stdout.write(
      `\nslowest: ${whatOf(slowest, analysis.procs)}${slowest.run ? ` in run ${slowest.run}` : ''}, ${ms(took)} ms\nperfetto: ${out} (open it at ui.perfetto.dev)\n`,
    )
  }

  return 0
}

process.exitCode = main()
