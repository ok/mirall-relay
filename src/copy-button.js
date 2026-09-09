// The copy-to-clipboard button, shared by both browser surfaces: the status
// page's "Copy key" and the members page's "Copy invite".
//
// It was written twice, and the second copy immediately drifted — it lost the
// clearTimeout guard, so clicking twice in quick succession let the FIRST click's
// pending reset wipe the second's feedback and the copy looked like it failed.
// One definition, so the two cannot diverge again.
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
