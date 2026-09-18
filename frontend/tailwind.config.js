/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // The emergency palette: a single saturated red reserved for urgency,
        // on a deep neutral ground so it never competes with itself.
        emergency: {
          50: '#fff1f2',
          100: '#ffe4e6',
          200: '#fecdd3',
          300: '#fda4af',
          400: '#fb7185',
          500: '#f43f5e',
          600: '#e11d48',
          700: '#be123c',
          800: '#9f1239',
          900: '#881337',
        },
        ink: {
          950: '#08090d',
          900: '#0c0e14',
          850: '#11141c',
          800: '#161a24',
          700: '#1e2331',
          600: '#2a3040',
          500: '#3a4255',
          400: '#5b6478',
          300: '#8a92a6',
          200: '#b9c0d0',
          100: '#e2e6ef',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        // The SOS button's halo: two offset rings so the pulse reads as
        // continuous rather than a single repeating blink.
        halo: {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '70%': { transform: 'scale(1.9)', opacity: '0' },
          '100%': { transform: 'scale(1.9)', opacity: '0' },
        },
        breathe: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.035)' },
        },
        'slide-up': {
          from: { transform: 'translateY(12px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        halo: 'halo 2.4s cubic-bezier(0, 0, 0.2, 1) infinite',
        'halo-delayed': 'halo 2.4s cubic-bezier(0, 0, 0.2, 1) 1.2s infinite',
        breathe: 'breathe 2.4s ease-in-out infinite',
        'slide-up': 'slide-up 0.35s ease-out',
        shimmer: 'shimmer 1.8s infinite',
      },
    },
  },
  plugins: [],
};
