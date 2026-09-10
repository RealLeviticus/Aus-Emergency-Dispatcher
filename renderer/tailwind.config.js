module.exports = {
  content: [
    './renderer/pages/**/*.{js,ts,jsx,tsx}',
    './renderer/components/**/*.{js,ts,jsx,tsx}',
    './node_modules/flyonui/dist/js/*.js'
  ],
  theme: {
    extend: {
      colors: {
        'quasi-white': '#FAFAFA',
        navy: {
          DEFAULT: '#171E2C',
          light: '#1F2A3C',
          lightest: '#273347',
          dark: '#0E131B',
        },
        cyan: {
          DEFAULT: '#00E0FE',
          medium: '#00C4F5',
        },
        dodger: {
          light: '#00BBFF',
        },
        red: {
          DEFAULT: '#FC3A3A',
          dark: '#F70404',
        },
      },
      fontFamily: {
        inter: ['Inter', 'Segoe UI', 'sans-serif'],
        manrope: ['Manrope', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
      borderRadius: {
        'sm-md': '4px',
      },
    },
  },
  plugins: [
    require('flyonui'),
  ],
};
