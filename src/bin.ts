#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { isMainThread } from 'node:worker_threads'
import { runCli } from './cli/cli.ts'
import { mark, marked, traceWith } from './core/trace.ts'
import { capsFor, useCaps } from './tui/keycaps.ts'

function closedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EPIPE') {
    throw error
  }
}

const LONG_LIVED = 5000

function behind(origin: number): number {
  const edge = Date.now()
  let wall = edge

  while (wall === edge) {
    wall = Date.now()
  }

  return wall - (origin + performance.now())
}

function traceInto(file: string): void {
  const origin = performance.timeOrigin
  traceWith(() => performance.now())
  mark('proc.start', process.argv.slice(2).join(' '), 0)
  mark('proc.main')

  process.on('exit', (code) => {
    mark('proc.exit', String(code))
    const end = performance.now()
    const lean = end > LONG_LIVED ? behind(origin) / end : 0

    const lines = marked().map(
      (each) =>
        `${((origin + each.at * (1 + lean)) / 1000).toFixed(6)}\t${process.pid}\t${process.ppid}\tnode\t${each.name}\t${each.detail.replace(/[\t\n\r]/g, ' ')}\n`,
    )

    try {
      appendFileSync(file, lines.join(''))
    } catch {}
  })
}

if (isMainThread) {
  process.stdout.on('error', closedPipe)
  process.stderr.on('error', closedPipe)

  if (process.env.TTHEME_DEBUG && typeof Bun === 'undefined' && !process.sourceMapsEnabled) {
    const child = spawnSync(process.execPath, ['--enable-source-maps', ...process.argv.slice(1)], { stdio: 'inherit' })
    process.exitCode = child.status ?? 1
  } else {
    if (process.env.TTHEME_TRACE) {
      traceInto(process.env.TTHEME_TRACE)
    }

    useCaps(capsFor(process.env, process.platform))
    process.exitCode = await runCli(process.argv.slice(2))
  }
}
