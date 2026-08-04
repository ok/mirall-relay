import neostandard from 'neostandard'

export default [
  ...neostandard({ noStyle: false }),
  {
    ignores: ['node_modules/**', 'coverage/**']
  }
]
