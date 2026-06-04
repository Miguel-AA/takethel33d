import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Soft cornflower blue from the Gifted Grads logo.
        brand: {
          50: '#f0f7fd',
          100: '#dceefa',
          200: '#bfdcf3',
          300: '#9cc6e8',
          400: '#7eb1dc',
          500: '#5b9bd5',
          600: '#4685c1',
          700: '#386ba0',
          800: '#2e5680',
          900: '#244463',
        },
        // Warm yellow / gold from the lightning bolt.
        accent: {
          50: '#fffaeb',
          100: '#fff1c5',
          200: '#ffe18a',
          300: '#ffcb4d',
          400: '#f5c518',
          500: '#f5a623',
          600: '#d18414',
          700: '#a16310',
          800: '#7a4b0e',
          900: '#5c390b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 14px rgba(15, 23, 42, 0.06)',
        cardLg: '0 4px 18px rgba(59, 107, 160, 0.10), 0 1px 3px rgba(15, 23, 42, 0.05)',
      },
      backgroundImage: {
        'underline-accent':
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'><path d='M2 8 Q 50 0 100 6 T 198 8' stroke='%23f5a623' stroke-width='4' fill='none' stroke-linecap='round'/></svg>\")",
      },
    },
  },
  plugins: [],
};

export default config;
