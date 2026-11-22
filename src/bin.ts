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

function wallClock(): () => number {
  const edge = Date.now()
  let now = edge

  while (now === edge) {
    now = Date.now()
  }

  const offset = now - performance.now()

  return () => offset + performance.now()
}

function traceInto(file: string): void {
  const now = wallClock()
  traceWith(now)
  mark('proc.start', process.argv.slice(2).join(' '), now() - performance.now())
  mark('proc.main')

  process.on('exit', (code) => {
    mark('proc.exit', String(code))

    const lines = marked().map(
      (each) =>
        `${(each.at / 1000).toFixed(6)}\t${process.pid}\tnode\t${each.name}\t${each.detail.replace(/[\t\n\r]/g, ' ')}\n`,
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
