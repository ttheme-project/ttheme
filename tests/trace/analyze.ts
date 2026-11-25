export const GRACE = 300
export const QUIET = 250
const BYTES_WAIT = 250
const IDLE = 2
const STEADY_SHARE = 0.05
const SAME_CELL = 6
const SAME_CELLS = 2
const BLANK_SPREAD = 12
const BLANK_SHARE = 0.5

const OUTPUTS = new Set(['frame.write', 'osc.write', 'reload'])
const WRITES = new Set([...OUTPUTS, 'frame.tick'])
const HARNESS = new Set(['keys', 'drive'])

const BOUNDS = new Set([
  'input.bytes',
  'input.key',
  'focus.in',
  'focus.done',
  'focus.out',
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

export interface Mark {
  at: number
  pid: number
  ppid: number
  proc: string
  depth: number
  name: string
  detail: string
}

export interface Shot {
  at: number
  kind: string
  cells: Uint8Array | undefined
}

export interface Proc {
  pid: number
  ppid: number
  proc: string
  depth: number
  name: string
  first: number
  last: number
}

export type Stage = 'A' | 'B' | 'C' | 'D' | 'H'

export type Role = 'anchor' | 'bound' | 'write' | 'last' | 'relay' | 'busy' | 'screen'

export interface Step {
  mark: Mark
  role: Role
}

export interface Segment {
  from: Step
  to: Step
  stage: Stage
}

export interface Span {
  name: string
  pid: number
  tid: number
  from: number
  to: number
}

export type Arrival = 'read' | 'pty' | 'none'

export interface Interaction {
  anchor: Mark
  run: number
  ordinal: number
  reader: number | undefined
  tree: ReadonlySet<number>
  end: number
  horizon: number
  segments: Segment[]
  first: number | undefined
  done: number | undefined
  floor: number | undefined
  written: number | undefined
  delivered: number | undefined
  unseen: boolean
  crossed: boolean
  queued: boolean
  arrival: Arrival
  between: number
  blank: number
  later: number
  spans: Span[]
  beside: number[]
}

export interface Cadence {
  usual: number
  limit: number
  steady: boolean
}

export interface Analysis {
  marks: Mark[]
  shots: Shot[]
  procs: Map<number, Proc>
  cadence: Cadence
  interactions: Interaction[]
}

export function parseMarks(text: string): Mark[] {
  const marks: Mark[] = []

  for (const line of text.split('\n')) {
    const [ts, pid, ppid, proc = '', name, ...rest] = line.split('\t')

    if (!ts || !name || Number.isNaN(Number(ts))) {
      continue
    }

    const [program = '', deep = '0'] = proc.split('/')

    marks.push({
      at: Number(ts) * 1000,
      pid: Number(pid),
      ppid: Number(ppid),
      proc: program,
      depth: Number(deep) || 0,
      name,
      detail: rest.join(' '),
    })
  }

  return marks.sort((a, b) => a.at - b.at)
}

export function parseShots(text: string): Shot[] {
  const shots: Shot[] = []

  for (const line of text.split('\n')) {
    const [ts, kind, , cells] = line.split('\t')

    if (!ts || !kind) {
      continue
    }

    shots.push({ at: Number(ts) * 1000, kind, cells: cells ? Uint8Array.from(Buffer.from(cells, 'hex')) : undefined })
  }

  return shots.sort((a, b) => a.at - b.at)
}

function after<T extends { at: number }>(items: readonly T[], at: number): number {
  let low = 0
  let high = items.length

  while (low < high) {
    const middle = (low + high) >> 1

    if ((items[middle]?.at ?? Number.POSITIVE_INFINITY) < at) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return low
}

function through<T extends { at: number }>(items: readonly T[], at: number): number {
  let low = 0
  let high = items.length

  while (low < high) {
    const middle = (low + high) >> 1

    if ((items[middle]?.at ?? Number.POSITIVE_INFINITY) <= at) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return low
}

function within<T extends { at: number }>(items: readonly T[], from: number, to: number): T[] {
  const out: T[] = []

  for (let k = after(items, from); k < items.length; k++) {
    const item = items[k]

    if (!item || item.at > to) {
      break
    }

    out.push(item)
  }

  return out
}

export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)

  if (sorted.length === 0) {
    return Number.NaN
  }

  const at = (sorted.length - 1) * q
  const low = Math.floor(at)
  const high = Math.ceil(at)

  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (at - low)
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

export function blankOf(cells: Uint8Array | undefined, around: readonly (Uint8Array | undefined)[] = []): boolean {
  const spread = spreadOf(cells)

  const others = around.flatMap((each) => {
    const value = spreadOf(each)

    return Number.isNaN(value) ? [] : [value]
  })

  return spread <= Math.max(BLANK_SPREAD, others.length > 0 ? Math.min(...others) * BLANK_SHARE : 0)
}

function nameOf(mark: Mark): string {
  if (mark.proc === 'node') {
    return mark.name === 'proc.start' ? `node ${mark.detail.split(' ')[0] || 'ttheme'}` : 'node ttheme'
  }

  if (mark.proc === 'drive') {
    return 'sandbox'
  }

  return mark.proc === 'zsh' && mark.depth > 0 ? 'zsh $(…)' : mark.proc
}

export function procsOf(marks: readonly Mark[]): Map<number, Proc> {
  const procs = new Map<number, Proc>()

  for (const each of marks) {
    const known = procs.get(each.pid)

    if (!known) {
      procs.set(each.pid, {
        pid: each.pid,
        ppid: each.ppid,
        proc: each.proc,
        depth: each.depth,
        name: nameOf(each),
        first: each.at,
        last: each.at,
      })

      continue
    }

    known.last = each.at

    if (each.name === 'proc.start') {
      known.name = nameOf(each)
    }
  }

  return procs
}

function waitedOf(procs: Map<number, Proc>, marks: readonly Mark[]): Map<number, boolean> {
  const brackets = new Map<number, Mark[]>()

  for (const each of marks) {
    if (each.name === 'cli.start' || each.name === 'cli.end') {
      const list = brackets.get(each.pid) ?? []
      list.push(each)
      brackets.set(each.pid, list)
    }
  }

  const waited = new Map<number, boolean>()

  for (const child of procs.values()) {
    const parent = procs.get(child.ppid)

    if (!parent || HARNESS.has(child.proc) || HARNESS.has(parent.proc) || parent.proc !== 'zsh') {
      waited.set(child.pid, false)
    } else if (child.proc === 'node') {
      const list = brackets.get(parent.pid) ?? []
      waited.set(child.pid, list[through(list, child.first) - 1]?.name === 'cli.start')
    } else {
      waited.set(child.pid, child.proc === 'zsh' && child.depth > parent.depth)
    }
  }

  return waited
}

function treeOf(reader: number, procs: Map<number, Proc>, waited: Map<number, boolean>): Set<number> {
  let root = reader
  const climbed = new Set<number>()

  while (waited.get(root) === true && !climbed.has(root)) {
    climbed.add(root)
    root = procs.get(root)?.ppid ?? root
  }

  const tree = new Set([root])
  let grew = true

  while (grew) {
    grew = false

    for (const each of procs.values()) {
      if (!tree.has(each.pid) && tree.has(each.ppid) && waited.get(each.pid) === true) {
        tree.add(each.pid)
        grew = true
      }
    }
  }

  return tree
}

function anchorsOf(marks: readonly Mark[]): Mark[] {
  const sent = marks.filter((each) => each.name === 'input.sent')

  if (sent.length > 0) {
    return sent
  }

  const read = new Map<number, Mark[]>()

  for (const each of marks) {
    if (each.name === 'input.bytes') {
      const list = read.get(each.pid) ?? []
      list.push(each)
      read.set(each.pid, list)
    }
  }

  const keys = marks.filter(
    (each) => each.name === 'focus.in' || (each.name === 'input.key' && each.detail !== 'mouse.move'),
  )

  return keys.map((each) => {
    if (each.name !== 'input.key') {
      return each
    }

    const list = read.get(each.pid) ?? []
    const bytes = list[through(list, each.at) - 1]

    return bytes && each.at - bytes.at < BYTES_WAIT ? { ...bytes, detail: each.detail } : each
  })
}

interface Heard {
  key: Mark | undefined
  bytes: Mark | undefined
  reader: number | undefined
}

function heardOf(anchor: Mark, inside: readonly Mark[]): Heard {
  if (anchor.name !== 'input.sent') {
    return { key: anchor, bytes: anchor.name === 'input.bytes' ? anchor : undefined, reader: anchor.pid }
  }

  const ttheme = inside.filter((each) => !HARNESS.has(each.proc))
  const key = ttheme.find((each) => each.name === 'input.key' || each.name === 'focus.in' || each.name === 'focus.out')

  const bytes = key
    ? ttheme.find((each) => each.name === 'input.bytes' && each.pid === key.pid && each.at <= key.at)
    : ttheme.find((each) => each.name === 'input.bytes')

  return { key, bytes, reader: (key ?? bytes ?? ttheme[0])?.pid }
}

function settledOf(written: readonly Mark[], own: readonly Mark[]): Mark[] {
  const kept = written.slice(0, 1)

  for (const [k, next] of written.entries()) {
    const prev = written[k - 1]

    if (!prev) {
      continue
    }

    const busy = own.some(
      (each) => each.at > prev.at && each.at < next.at && !OUTPUTS.has(each.name) && !each.name.startsWith('input.'),
    )

    if (next.at - prev.at > QUIET && !busy) {
      break
    }

    kept.push(next)
  }

  return kept
}

function deliveredOf(relays: readonly Mark[], at: number): Mark | undefined {
  let k = after(relays, at - IDLE)
  const first = relays[k]

  if (!first || first.at > at + IDLE) {
    return undefined
  }

  while (k + 1 < relays.length && (relays[k + 1]?.at ?? Number.POSITIVE_INFINITY) - (relays[k]?.at ?? 0) <= IDLE) {
    k++
  }

  return relays[k]
}

function spansOf(own: readonly Mark[]): Span[] {
  const spans: Span[] = []
  const open = new Map<string, Mark>()

  for (const each of own) {
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

export function stageOf(from: Step, to: Step): Stage {
  if (to.role === 'screen') {
    return 'D'
  }

  if (to.role === 'busy' || from.role === 'busy') {
    return 'B'
  }

  if (from.mark.proc === 'keys') {
    return 'A'
  }

  if (from.mark.proc === 'drive' || to.mark.proc === 'drive') {
    return 'H'
  }

  if (from.mark.pid !== to.mark.pid || to.mark.name === 'proc.main' || to.mark.name === 'proc.exit') {
    return 'C'
  }

  return 'B'
}

export function cadenceOf(shots: readonly Shot[]): Cadence {
  const beats = shots.filter((shot) => shot.kind === 'frame' || shot.kind === 'same' || shot.kind === 'idle')
  const gaps = beats.slice(1).map((shot, i) => shot.at - (beats[i]?.at ?? shot.at))
  const usual = gaps.length > 0 ? quantile(gaps, 0.5) : Number.NaN
  const limit = Math.max(25, usual * 2.5)
  const late = gaps.filter((gap) => gap > usual * 1.5).length

  return { usual, limit, steady: gaps.length > 0 && late / gaps.length < STEADY_SHARE }
}

interface Input {
  steps: Step[]
  busy: Mark | undefined
}

function inputOf(anchor: Mark, heard: Heard, inside: readonly Mark[], own: readonly Mark[]): Input {
  const bytes = heard.bytes

  const relayed =
    anchor.proc === 'keys' && bytes
      ? inside.findLast((each) => each.name === 'relay.in' && each.at <= bytes.at)
      : undefined

  const ready = relayed?.at ?? (anchor.proc === 'drive' ? anchor.at : undefined)
  const steps: Step[] = relayed ? [{ mark: relayed, role: 'relay' }] : []

  const busy =
    bytes && ready !== undefined
      ? own.findLast(
          (each) => each.pid === bytes.pid && each.at > ready && each.at < bytes.at && !each.name.startsWith('input.'),
        )
      : undefined

  if (busy) {
    steps.push({ mark: busy, role: 'busy' })
  }

  return { steps, busy }
}

function boundsOf(own: readonly Mark[], limit: number, busy: Mark | undefined): Step[] {
  const picks = new Map<string, Mark>()

  for (const each of own) {
    const key = `${each.pid} ${each.name}`

    if (each !== busy && each.at <= limit && BOUNDS.has(each.name) && !picks.has(key)) {
      picks.set(key, each)
    }
  }

  const steps: Step[] = []

  for (const mark of picks.values()) {
    steps.push({ mark, role: 'bound' })
  }

  return steps
}

function segmentsOf(steps: readonly Step[]): Segment[] {
  const sorted = [...steps].sort((a, b) => a.mark.at - b.mark.at)
  const segments: Segment[] = []

  for (let k = 1; k < sorted.length; k++) {
    const from = sorted[k - 1]
    const to = sorted[k]

    if (from && to) {
      segments.push({ from, to, stage: stageOf(from, to) })
    }
  }

  return segments
}

function arrivalOf(anchor: Mark, heard: Heard, inside: readonly Mark[]): Arrival {
  if (anchor.name !== 'input.sent' || heard.key || heard.bytes) {
    return 'read'
  }

  return anchor.proc === 'drive' || inside.some((each) => each.name === 'relay.in') ? 'pty' : 'none'
}

export function analyze(marks: Mark[], shots: Shot[]): Analysis {
  const procs = procsOf(marks)
  const waited = waitedOf(procs, marks)
  const anchors = anchorsOf(marks)
  const starts = marks.filter((each) => each.name === 'run.start')
  const writes = marks.filter((each) => WRITES.has(each.name))
  const relays = marks.filter((each) => each.name === 'relay.out')
  const frames = shots.filter((shot) => shot.kind === 'frame')
  const beats = shots.filter((shot) => shot.kind === 'frame' || shot.kind === 'same' || shot.kind === 'idle')
  const cadence = cadenceOf(shots)
  const last = marks.at(-1)?.at ?? 0
  const ordinals = new Map<number, number>()
  const interactions: Interaction[] = []

  for (const [i, anchor] of anchors.entries()) {
    const run = through(starts, anchor.at)
    const ordinal = (ordinals.get(run) ?? 0) + 1
    ordinals.set(run, ordinal)
    const nextRun = starts[run]?.at ?? Number.POSITIVE_INFINITY
    const end = Math.min(anchors[i + 1]?.at ?? Number.POSITIVE_INFINITY, nextRun, last + GRACE)
    const inside = within(marks, anchor.at, end).filter((each) => each.at > anchor.at && each.at < end)
    const heard = heardOf(anchor, inside)
    const tree = heard.reader === undefined ? new Set<number>() : treeOf(heard.reader, procs, waited)
    const own = inside.filter((each) => tree.has(each.pid))
    const written = own.filter((each) => OUTPUTS.has(each.name))
    const kept = settledOf(written, own)
    const firstOut = written[0]
    const doneOut = kept.at(-1)
    const horizon = Math.min(writes[after(writes, end)]?.at ?? Number.POSITIVE_INFINITY, end + GRACE)
    const input = inputOf(anchor, heard, inside, own)
    const handed = doneOut && deliveredOf(relays, doneOut.at)
    const base = doneOut && Math.max(doneOut.at, handed?.at ?? Number.NEGATIVE_INFINITY)
    const settled = base === undefined ? undefined : within(frames, base, horizon)[0]
    const firstHanded = firstOut && deliveredOf(relays, firstOut.at)
    const firstBase = firstOut && Math.max(firstOut.at, firstHanded?.at ?? Number.NEGATIVE_INFINITY)
    const shown = firstBase === undefined ? undefined : within(frames, firstBase, horizon)[0]

    const steps: Step[] = [
      { mark: anchor, role: 'anchor' },
      ...input.steps,
      ...boundsOf(own, doneOut?.at ?? end, input.busy),
    ]

    if (firstOut && firstOut !== doneOut) {
      steps.push({ mark: firstOut, role: 'write' })
    }

    if (doneOut) {
      steps.push({ mark: doneOut, role: 'last' })
    }

    if (doneOut && handed && handed.at > doneOut.at) {
      steps.push({ mark: handed, role: 'relay' })
    }

    if (settled) {
      steps.push({
        mark: { at: settled.at, pid: 0, ppid: 0, proc: 'screen', depth: 0, name: 'settled', detail: '' },
        role: 'screen',
      })
    }

    const lead = settled && beats[after(beats, settled.at) - 1]
    const gapped = cadence.steady && settled !== undefined && lead !== undefined && settled.at - lead.at > cadence.limit
    const before = frames[after(frames, anchor.at) - 1]

    const odd = settled
      ? within(frames, anchor.at, settled.at).filter(
          (shot) =>
            shot.at > anchor.at &&
            shot !== settled &&
            differs(shot.cells, before?.cells) &&
            differs(shot.cells, settled.cells),
        )
      : []

    const crossed =
      doneOut !== undefined &&
      settled !== undefined &&
      within(writes, doneOut.at, settled.at).some(
        (each) => each !== doneOut && each.at > doneOut.at && each.at < settled.at,
      )

    interactions.push({
      anchor,
      run,
      ordinal,
      reader: heard.reader,
      tree,
      end,
      horizon,
      segments: segmentsOf(steps),
      first: shown ? shown.at - anchor.at : undefined,
      done: settled ? settled.at - anchor.at : undefined,
      floor: gapped && lead && base !== undefined ? Math.max(lead.at, base) - anchor.at : undefined,
      written: doneOut ? doneOut.at - anchor.at : undefined,
      delivered: handed && base !== undefined ? base - anchor.at : undefined,
      unseen: shots.length > 0 && doneOut !== undefined && settled === undefined,
      crossed,
      queued: input.busy !== undefined,
      arrival: arrivalOf(anchor, heard, inside),
      between: odd.length,
      blank: odd.filter((shot) => blankOf(shot.cells, [before?.cells, settled?.cells])).length,
      later: written.length - kept.length,
      spans: spansOf(own),
      beside: [...new Set(inside.flatMap((each) => (tree.has(each.pid) || HARNESS.has(each.proc) ? [] : [each.pid])))],
    })
  }

  return { marks, shots, procs, cadence, interactions }
}
