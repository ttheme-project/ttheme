export interface Marked {
  at: number
  name: string
  detail: string
}

let clock: (() => number) | undefined

const marks: Marked[] = []

export function traceWith(now: () => number): void {
  clock = now
}

export function tracing(): boolean {
  return clock !== undefined
}

export function mark(name: string, detail = '', at?: number): void {
  if (clock) {
    marks.push({ at: at ?? clock(), name, detail })
  }
}

export function marked(): readonly Marked[] {
  return marks
}
