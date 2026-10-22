/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // evondev UI/UX — flat dark (navy base + teal accent), 1px borders, no glow.
        vira: {
          bg: '#0b1220',
          panel: '#111a2e',
          card: '#16213a',
          border: '#273350',
          accent: '#2dd4bf',
          accentHover: '#5eead4',
          muted: '#94a3b8'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif']
      }
    }
  },
  plugins: []
}
