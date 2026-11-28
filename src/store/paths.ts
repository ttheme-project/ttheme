import { homedir } from 'node:os'
import { join } from 'node:path'

type Env = Record<string, string | undefined>

export function configHome(env: Env = process.env, home = homedir()): string {
  return env.XDG_CONFIG_HOME || join(home, '.config')
}

export function dataHome(env: Env = process.env, home = homedir()): string {
  return env.XDG_DATA_HOME || join(home, '.local', 'share')
}

export function stateRoot(env: Env = process.env, home = homedir()): string {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'ttheme')
}

export function cacheRoot(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ttheme')
}
