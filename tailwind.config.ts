import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Premium black and red palette for Take the L33d.
        brand: {
          50: '#fff1f2',
          100: '#ffe4e6',
          200: '#fecdd3',
          300: '#fda4af',
          400: '#fb7185',
          500: '#e11d2e',
          600: '#be1022',
          700: '#9f0b1d',
          800: '#7f0918',
          900: '#45040c',
        },
        accent: {
          50: '#fff5f5',
          100: '#ffe1e4',
          200: '#ffb8c0',
          300: '#ff8491',
          400: '#ff465c',
          500: '#e5092a',
          600: '#b90722',
          700: '#8f061b',
          800: '#6b0617',
          900: '#3b0209',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        card: '0 18px 55px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        cardLg: '0 28px 90px rgba(0, 0, 0, 0.42), 0 0 40px rgba(225, 29, 46, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
      },
      backgroundImage: {
        'underline-accent':
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'><path d='M2 8 Q 50 0 100 6 T 198 8' stroke='%23e5092a' stroke-width='4' fill='none' stroke-linecap='round'/></svg>\")",
      },
    },
  },
  plugins: [],
};

export default config;
