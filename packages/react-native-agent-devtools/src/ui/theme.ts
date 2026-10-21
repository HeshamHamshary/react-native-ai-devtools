import { Platform } from 'react-native';

export interface Palette {
  /** Panel background. */
  bg: string;
  /** Raised surfaces inside the panel (tool rows, cards, inputs). */
  surface: string;
  /** Hairlines and outlines. */
  border: string;
  text: string;
  muted: string;
  /** Brand accent: buttons, selection, inspect highlight. */
  accent: string;
  accentText: string;
  /** Translucent accent for highlights over the app. */
  accentFill: string;
  userBubble: string;
  code: string;
  ok: string;
  warn: string;
  error: string;
  /** Background of the launcher button. */
  launcher: string;
  scrim: string;
}

const LIGHT: Palette = {
  bg: '#FFFFFF',
  surface: '#F4F5F7',
  border: '#E1E3E8',
  text: '#16181D',
  muted: '#646A76',
  accent: '#4F5BD5',
  accentText: '#FFFFFF',
  accentFill: 'rgba(79,91,213,0.16)',
  userBubble: '#EBEDF5',
  code: '#EEF0F4',
  ok: '#1F8A4C',
  warn: '#A86B00',
  error: '#C8372D',
  launcher: '#FFFFFF',
  scrim: 'rgba(10,12,20,0.18)',
};

const DARK: Palette = {
  bg: '#16181D',
  surface: '#1F2229',
  border: '#2E323C',
  text: '#ECEEF3',
  muted: '#9AA0AD',
  accent: '#8C95FF',
  accentText: '#0E1020',
  accentFill: 'rgba(140,149,255,0.20)',
  userBubble: '#2A2E3A',
  code: '#0F1115',
  ok: '#4CC27E',
  warn: '#E0A43A',
  error: '#F0675C',
  launcher: '#1F2229',
  scrim: 'rgba(0,0,0,0.4)',
};

export type ThemeSetting = 'system' | 'light' | 'dark';

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const radius = { sm: 8, md: 12, lg: 18 } as const;
