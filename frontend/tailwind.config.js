/**
 * HADS design tokens (docs/DESIGN_SYSTEM.md). Colour values live as RGB triplets in CSS variables
 * (src/index.css) so every token supports Tailwind's `/opacity` modifier, e.g. `bg-brand-500/10`.
 * Never hard-code hex in components — use these tokens (or `rgb(var(--brand-500))` inside raw SVG/HTML).
 */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['14px', { lineHeight: '20px' }],
        base: ['16px', { lineHeight: '24px' }],
        lg: ['18px', { lineHeight: '28px' }],
        xl: ['20px', { lineHeight: '28px' }],
        '2xl': ['24px', { lineHeight: '32px' }],
        '3xl': ['30px', { lineHeight: '36px' }],
        '4xl': ['36px', { lineHeight: '40px' }],
        '5xl': ['48px', { lineHeight: '1.05' }],
      },
      colors: {
        brand: {
          50: v('brand-50'), 100: v('brand-100'), 200: v('brand-200'), 400: v('brand-400'),
          500: v('brand-500'), 600: v('brand-600'), 700: v('brand-700'), DEFAULT: v('brand-500'),
        },
        ink: { 900: v('ink-900'), 700: v('ink-700'), 500: v('ink-500'), 400: v('ink-400') },
        line: { DEFAULT: v('line'), strong: v('line-strong'), soft: v('line-soft') },
        canvas: v('canvas'),
        surface: v('surface'),
        success: { DEFAULT: v('success'), bg: v('success-bg'), fg: v('success-fg') },
        info: { DEFAULT: v('info'), bg: v('info-bg'), fg: v('info-fg') },
        warning: { DEFAULT: v('warning'), bg: v('warning-bg'), fg: v('warning-fg') },
        danger: { DEFAULT: v('brand-500'), bg: v('brand-50'), fg: v('brand-600') },
        violet: { DEFAULT: v('violet'), bg: v('violet-bg'), fg: v('violet-fg') },
        orange: { DEFAULT: v('orange'), bg: v('orange-bg'), fg: v('orange-fg') },
        teal: { DEFAULT: v('teal'), bg: v('teal-bg'), fg: v('teal-fg') },
        // Legacy alias kept so pre-v2 pages compile until the screen agents migrate them. Prefer `brand`.
        sos: { DEFAULT: v('brand-500'), dark: v('brand-600'), light: v('brand-400') },
      },
      borderRadius: {
        sm: '8px', md: '12px', lg: '16px', xl: '20px', '2xl': '24px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)',
        raised: '0 10px 30px -8px rgba(16,24,40,.16)',
        sheet: '0 -10px 30px -6px rgba(16,24,40,.14)',
        focus: '0 0 0 3px rgb(var(--brand-500) / .28)',
      },
      zIndex: {
        map: '0', 'map-overlay': '400', sticky: '30', sheet: '40', modal: '50', toast: '60',
      },
      transitionDuration: { micro: '150ms', standard: '220ms' },
      transitionTimingFunction: { out: 'cubic-bezier(.16,1,.3,1)' },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-ring': { '0%': { transform: 'scale(.6)', opacity: '.7' }, '100%': { transform: 'scale(2.4)', opacity: '0' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        shimmer: 'shimmer 1.4s infinite',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(.16,1,.3,1) infinite',
        'fade-in': 'fade-in 220ms ease-out both',
      },
      maxWidth: { panel: '420px' },
      width: { panel: '420px' },
    },
  },
  plugins: [],
};
