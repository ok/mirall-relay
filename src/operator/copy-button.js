// Clipboard writes require a user gesture and are unavailable in some HTTP contexts.
// Keep the fallback selectable so the ticket can still be copied.
// Returns whether the clipboard took it. `onFallback` runs only when it did not,
// and returns the node to select — so a caller that has to put the text on screen
// to make it selectable does that work only in the case that needs it.
export async function copyText (text, onFallback) {
  try {
    // The Clipboard API is absent on plain HTTP to a non-localhost host, which
    // is exactly how a platform proxy serves these pages. Selecting the text is
    // the normal path there, not an exotic fallback.
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    selectNode(typeof onFallback === 'function' ? onFallback() : onFallback)
    return false
  }
}

export function selectNode (node) {
  if (!node) return
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

export function attachCopy (button, target, { idle, done = 'Copied', fallback = 'Selected — press ⌘C / Ctrl+C', resetMs = 2500 } = {}) {
  let timer = null

  button.addEventListener('click', async () => {
    clearTimeout(timer)
    const node = typeof target === 'function' ? target() : target
    const copied = await copyText(node ? node.textContent : '', node)

    button.textContent = copied ? done : fallback
    timer = setTimeout(() => { button.textContent = idle }, resetMs)
  })
}
