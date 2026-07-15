/** @type {import('tailwindcss').Config} */
//
// Theme-able colors are CSS variables so we can swap palettes by toggling
// a class on <html>. The RGB-triplet + `<alpha-value>` placeholder is
// Tailwind's idiomatic way to keep alpha modifiers (e.g. `bg-card-bg/50`)
// working against var-backed colors.
//
// Channel/status colors are intentionally NOT themed — they're semantic
// brand identities (PPG = red, IMU = blue, etc.) that stay constant
// across light/dark to preserve data-viz continuity.
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'window-bg':   'rgb(var(--color-window-bg) / <alpha-value>)',
        'card-bg':     'rgb(var(--color-card-bg) / <alpha-value>)',
        'card-border': 'rgb(var(--color-card-border) / <alpha-value>)',
        'card-hover':  'rgb(var(--color-card-hover) / <alpha-value>)',

        'text-primary':   'rgb(var(--color-text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--color-text-secondary) / <alpha-value>)',
        'text-muted':     'rgb(var(--color-text-muted) / <alpha-value>)',

        // Accent — project's primary action color. Brand navy
        // (#1A2F65 at -soft, lifted #4F6DC9 at default for dark-bg
        // visibility). Use bg-accent for solid CTAs, bg-accent/20
        // for soft tints, text-accent for highlighted text,
        // border-accent for focus rings. -hover for solid button
        // hover, -soft is the unmodified brand value (good for
        // active-row backgrounds via /20 alpha).
        'accent':       'rgb(var(--color-accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--color-accent-hover) / <alpha-value>)',
        'accent-soft':  'rgb(var(--color-accent-soft) / <alpha-value>)',
        'accent-deep':  'rgb(var(--color-accent-deep) / <alpha-value>)',

        // Warm secondary accent — copper/tan (#B27A4E from brand).
        // Use sparingly for character moments — recording indicator,
        // timeline marker, key transitions. Avoid solid CTAs (low
        // contrast on text); great as bg-accent-warm/15 fills or
        // text-accent-warm icons.
        'accent-warm':  'rgb(var(--color-accent-warm) / <alpha-value>)',

        // Status colors — semantic and slightly desaturated so they
        // read as alerts without fighting the cool body palette.
        'status-success': 'rgb(var(--color-status-success) / <alpha-value>)',
        'status-warning': 'rgb(var(--color-status-warning) / <alpha-value>)',
        'status-danger':  'rgb(var(--color-status-danger) / <alpha-value>)',

        // Brand-stable channel colors — kept constant across light/dark
        // so chart legends stay recognizable. Not theme-able by design.
        'ch-ppg': '#FF4757',
        'ch-imu': '#3B82F6',
        'ch-env': '#22C55E',
        'ch-gsr': '#A855F7',
        'ch-audio': '#F97316',
        'ch-ble': '#06B6D4',

        // Legacy aliases for the old status names — point at the new
        // CSS-var-driven tokens so any unmigrated component still
        // renders correctly (the channel colors above stay hard-coded).
        'status-connected':    'rgb(var(--color-status-success) / <alpha-value>)',
        'status-disconnected': 'rgb(var(--color-status-danger)  / <alpha-value>)',
      },
      fontFamily: {
        'sans': ['Inter', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
