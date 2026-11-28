import { type SimpleIcon, siCreativecommons, siDeviantart, siX } from 'simple-icons'
import type { Theme } from '@/lib/themes'

export interface CastMember {
  name: string
  face: number
  scale: number
}

export const CAST: readonly CastMember[] = [
  { name: 'souryuu-asuka-langley', face: 930 / 756, scale: 1 },
  { name: 'izumi-konata', face: 935 / 756, scale: 1 },
]

export interface StickerCredit {
  name: string
  who: string
  verb: string
  artist: string | null
  handle: string
  profile: string
  japanese: boolean
  site: string
  siteIcon: SimpleIcon
  post: string
  license: { brand: string; icon: SimpleIcon; terms: string; url: string } | null
  after: { work: string; holder: string; url: string } | null
}

export const STICKER_CREDITS: readonly StickerCredit[] = [
  {
    name: 'souryuu-asuka-langley',
    who: 'Souryuu Asuka Langley',
    verb: 'Art by',
    artist: 'kmym',
    handle: '@kmym97457689',
    profile: 'https://x.com/kmym97457689',
    japanese: false,
    site: 'X',
    siteIcon: siX,
    post: 'https://x.com/kmym97457689/status/2099432694958719085',
    license: null,
    after: null,
  },
  {
    name: 'izumi-konata',
    who: 'Izumi Konata',
    verb: 'Art by',
    artist: null,
    handle: 'lllP3lll',
    profile: 'https://www.deviantart.com/lllp3lll',
    japanese: false,
    site: 'DeviantArt',
    siteIcon: siDeviantart,
    post: 'https://www.deviantart.com/lllp3lll/art/Konata-53704375',
    license: {
      brand: 'Creative Commons',
      icon: siCreativecommons,
      terms: 'CC BY-NC-SA 3.0',
      url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
    },
    after: {
      work: "Comp H's Vol.3",
      holder: '©美水かがみ/らっきー☆ぱらだいす',
      url: 'https://yande.re/post/show/4380',
    },
  },
]

export const STICKER_SIZES = '(min-width: 1180px) min(148.4vh, 104.4vw, 1679px), 199vw'

export function stickerSet(stickers: Record<string, string>, name: string): string {
  return `${stickers[name]} 1410w, ${stickers[`${name}-2x`]} 2820w`
}

export function castOf(themes: readonly Theme[]): Theme[] {
  return CAST.flatMap((member) => themes.find((theme) => theme.name === member.name) ?? [])
}

export function isCast(name: string): boolean {
  return CAST.some((member) => member.name === name)
}
