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

        // Brand-stable channel colors
        'ch-ppg': '#FF4757',
        'ch-imu': '#3B82F6',
        'ch-env': '#22C55E',
        'ch-gsr': '#A855F7',
        'ch-audio': '#F97316',
        'ch-ble': '#06B6D4',

        'status-connected': '#22C55E',
        'status-disconnected': '#EF4444',
        'status-warning': '#F59E0B',
      },
      fontFamily: {
        'sans': ['Inter', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
