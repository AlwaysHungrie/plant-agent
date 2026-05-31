import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/** PlantAgent brand palette — leaf green accent used across the app. */
export const Brand = {
  primary: '#16A34A',
  /** logo image background green — banner matches it so the logo blends seamlessly */
  bannerBg: '#15803D',
  /** translucent fills for pills / soft backgrounds */
  faint: '#16A34A20',
} as const;

export const Fonts = Platform.select({
  ios: { mono: 'ui-monospace' },
  web: { mono: 'var(--font-mono)' },
  default: { mono: 'monospace' },
})!;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 34, android: 56 }) ?? 0;
export const MaxContentWidth = 800;
