import neostandard from 'neostandard'

export default [
  ...neostandard({ noStyle: false }),
  {
    // Shipped to the browser, not run by Node. Everything else they touch
    // (document, fetch, navigator, timers) neostandard already knows.
    files: [
      'src/operator/status/refresh.client.js',
      'src/operator/members/members.client.js',
      'src/operator/copy-button.js'
    ],
    languageOptions: { globals: { location: 'readonly', sessionStorage: 'readonly' } }
  },
  {
    ignores: ['node_modules/**', 'coverage/**']
  }
]
