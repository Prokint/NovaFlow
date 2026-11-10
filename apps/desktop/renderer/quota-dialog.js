/** Shell-owned balance dialog; the main process supplies every string and response index. */

const dialog = document.getElementById('dialog')
const titleNode = document.getElementById('title')
const messageNode = document.getElementById('message')
const detailNode = document.getElementById('detail')
const balanceNode = document.getElementById('balance')
const balanceLabelNode = document.getElementById('balance-label')
const balanceValueNode = document.getElementById('balance-value')
const actions = document.getElementById('actions')
const close = document.getElementById('close')

/** @type {{ revision: number, cancelId: number } | undefined} */
let view

/**
 * Show one main-owned view. A null view hides the dialog while the window
 * fades out, so a replacement never flashes an empty card.
 * @param {unknown} next - View pushed by the preload bridge.
 */
function apply(next) {
  const bridge = window.dshQuotaDialog
  if (typeof next !== 'object' || next === null || typeof bridge !== 'object' || bridge === null) {
    dialog.hidden = true
    return
  }
  view = next
  document.title = next.title
  titleNode.textContent = next.title
  messageNode.textContent = next.message
  detailNode.textContent = next.detail
  detailNode.hidden = next.detail === ''
  balanceNode.hidden = next.balanceValue === ''
  balanceLabelNode.textContent = next.balanceLabel
  balanceValueNode.textContent = next.balanceValue
  close.setAttribute('aria-label', next.closeLabel)
  actions.replaceChildren(...next.buttons.map((label, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = index === 0 ? 'primary' : 'secondary'
    button.textContent = label
    button.addEventListener('click', () => { void bridge.respond(next.revision, index) })
    return button
  }))
  dialog.hidden = false
  requestAnimationFrame(() => { document.body.classList.add('visible') })
  dialog.focus()
}

/** Respond with the cancel action for a close control or Escape press. */
function dismiss() {
  const bridge = window.dshQuotaDialog
  if (view === undefined || typeof bridge !== 'object' || bridge === null) return
  void bridge.respond(view.revision, view.cancelId)
}

close.addEventListener('click', dismiss)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismiss()
})

const bridge = window.dshQuotaDialog
if (typeof bridge === 'object' && bridge !== null) {
  bridge.status().then(apply).catch(() => {})
  bridge.subscribe(apply)
}
// Lets a shell-only preview render one sample view without the preload bridge.
window.__quotaDialogPreview = apply
