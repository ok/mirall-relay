import neostandard from 'neostandard'

export default [
  ...neostandard({ noStyle: false }),
  {
    // src/ui.js is shipped to the browser, not run by Node. Everything else it
    // touches (document, fetch, navigator, timers) neostandard already knows.
    files: ['src/ui.js'],
    languageOptions: { globals: { location: 'readonly' } }
  },
  {
    ignores: ['node_modules/**', 'coverage/**']
  }
]
