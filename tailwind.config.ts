import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Trustworthy blue palette for TAKE THE L33D.
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
          800: '#1e3a8a',
          900: '#0f2452',
        },
        accent: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        card: '0 18px 55px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        cardLg: '0 28px 90px rgba(0, 0, 0, 0.42), 0 0 44px rgba(37, 99, 235, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
      },
      backgroundImage: {
        'underline-accent':
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'><path d='M2 8 Q 50 0 100 6 T 198 8' stroke='%2338bdf8' stroke-width='4' fill='none' stroke-linecap='round'/></svg>\")",
      },
    },
  },
  plugins: [],
};

export default config;
