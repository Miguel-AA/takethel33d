import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand blue — sampled from the TAKE THE L33D icon (royal/cobalt blue).
        brand: {
          50: '#eef4ff',
          100: '#d9e6ff',
          200: '#b6ccff',
          300: '#84a8fb',
          400: '#4f7cf0',
          500: '#2a59df',
          600: '#1747c4',
          700: '#133a9e',
          800: '#15327d',
          900: '#152c63',
        },
        // Silver — the metallic gray from the icon, used for borders and accents.
        silver: {
          50: '#f6f7f9',
          100: '#eceef1',
          200: '#dde0e4',
          300: '#c9ced4',
          400: '#aab1ba',
          500: '#8d949d',
          600: '#71787f',
          700: '#565c63',
          800: '#3e434a',
          900: '#2a2e33',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        card: '0 10px 30px rgba(15, 23, 42, 0.08), 0 2px 6px rgba(15, 23, 42, 0.05)',
        cardLg:
          '0 24px 64px rgba(15, 23, 42, 0.12), 0 4px 12px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
      },
      backgroundImage: {
        'underline-accent':
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'><path d='M2 8 Q 50 0 100 6 T 198 8' stroke='%23aab1ba' stroke-width='4' fill='none' stroke-linecap='round'/></svg>\")",
      },
    },
  },
  plugins: [],
};

export default config;
