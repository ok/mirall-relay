// Clipboard writes require a user gesture and are unavailable in some HTTP contexts.
// Keep the fallback selectable so the ticket can still be copied.
export function attachCopy (button, target, { idle, done = 'Copied', fallback = 'Selected — press ⌘C / Ctrl+C', resetMs = 2500 } = {}) {
  let timer = null

  button.addEventListener('click', async () => {
    clearTimeout(timer)
    const node = typeof target === 'function' ? target() : target
    const text = node ? node.textContent : ''
    let copied = false

    try {
      // The Clipboard API is absent on plain HTTP to a non-localhost host, which
      // is exactly how a platform proxy serves these pages. Selecting the text is
      // the normal path there, not an exotic fallback.
      await navigator.clipboard.writeText(text)
      copied = true
    } catch {
      select(node)
    }

    button.textContent = copied ? done : fallback
    timer = setTimeout(() => { button.textContent = idle }, resetMs)
  })
}

function select (node) {
  if (!node) return
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}
