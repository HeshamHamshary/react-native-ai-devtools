export interface Palette {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  userBubble: string;
  code: string;
  ok: string;
  warn: string;
  error: string;
  scrim: string;
}

export function palette(dark: boolean): Palette {
  return dark
    ? {
        bg: '#1D1C1A',
        surface: '#272623',
        border: '#3A3833',
        text: '#F2F0EB',
        muted: '#A29F97',
        accent: '#D97757',
        accentText: '#FFFFFF',
        userBubble: '#3A3833',
        code: '#141310',
        ok: '#4CAF73',
        warn: '#D9A441',
        error: '#E06A5C',
        scrim: 'rgba(0,0,0,0.35)',
      }
    : {
        bg: '#FFFFFF',
        surface: '#F6F5F2',
        border: '#E6E3DC',
        text: '#1F1E1C',
        muted: '#6F6C65',
        accent: '#D97757',
        accentText: '#FFFFFF',
        userBubble: '#EFEDE7',
        code: '#F1EFE9',
        ok: '#2F8A50',
        warn: '#B9851F',
        error: '#C9483A',
        scrim: 'rgba(0,0,0,0.15)',
      };
}

export const mono = { fontFamily: 'Menlo' } as const;
