import neostandard from 'neostandard'

export default [
  ...neostandard({ noStyle: false }),
  {
    // Shipped to the browser, not run by Node. Everything else they touch
    // (document, fetch, navigator, timers) neostandard already knows.
    files: ['src/ui.js', 'src/admin-page.client.js'],
    languageOptions: { globals: { location: 'readonly', sessionStorage: 'readonly' } }
  },
  {
    ignores: ['node_modules/**', 'coverage/**']
  }
]
