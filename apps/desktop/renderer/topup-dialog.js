/** Shell-owned top-up dialog; the main process supplies configuration, prices, and order state. */

const api = window.dshTopUpDialog
const dialog = document.getElementById('dialog')
const titleNode = document.getElementById('title')
const balanceLabel = document.getElementById('balance-label')
const balanceValue = document.getElementById('balance-value')
const amountLabel = document.getElementById('amount-label')
const customLabel = document.getElementById('custom-label')
const optionsNode = document.getElementById('options')
const customInput = document.getElementById('custom-amount')
const hintNode = document.getElementById('hint')
const methodsNode = document.getElementById('methods')
const errorNode = document.getElementById('error')
const formNode = document.getElementById('form')
const progressNode = document.getElementById('progress')
const progressText = document.getElementById('progress-text')
const doneNode = document.getElementById('done')
const doneText = document.getElementById('done-text')
const doneBalanceLabel = document.getElementById('done-balance-label')
const doneBalanceValue = document.getElementById('done-balance-value')
const payButton = document.getElementById('pay')
const finishButton = document.getElementById('finish')
const closeButton = document.getElementById('close')

/** Current main-owned view, once the shell has loaded the site's configuration. */
let view
/** Whole-dollar amount the user selected, or undefined while quoting a custom amount. */
let amount
/** Payment provider the order uses. */
let method
/** Selected amount's formatted price. */
let price = ''
/** Trade number of the order being polled. */
let tradeNo
let pollTimer
let quoteTimer
let quoteSeq = 0
let closed = false

function bridge() {
  return typeof api === 'object' && api !== null ? api : undefined
}

/** Show one section and hide the others. */
function section(name) {
  formNode.hidden = name !== 'form'
  progressNode.hidden = name !== 'progress'
  doneNode.hidden = name !== 'done'
  finishButton.hidden = name !== 'done'
  payButton.hidden = name === 'done'
}

/** Disable or enable the amount inputs while a request is in flight. */
function lock(busy) {
  for (const button of optionsNode.querySelectorAll('button')) button.disabled = busy
  for (const button of methodsNode.querySelectorAll('button')) button.disabled = busy
  customInput.disabled = busy
  payButton.disabled = busy || amount === undefined || price === ''
}

function showError(text) {
  errorNode.textContent = text
  errorNode.hidden = text === ''
}

/** Reflect the selected amount in the preset buttons and the pay label. */
function select(nextAmount) {
  amount = nextAmount
  for (const button of optionsNode.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', Number(button.dataset.amount) === nextAmount ? 'true' : 'false')
  }
  payButton.textContent = nextAmount === undefined ? view.payLabel : `${view.payLabel} ${price}`
  lock(false)
}

/** Ask the shell for the price of one custom whole-dollar amount. */
function quoteCustom() {
  const value = Number(customInput.value)
  const seq = ++quoteSeq
  if (!Number.isInteger(value) || value < view.minAmount || value > 1_000_000) {
    amount = undefined
    price = ''
    showError('')
    payButton.textContent = view.payLabel
    lock(false)
    return
  }
  for (const button of optionsNode.querySelectorAll('button')) button.setAttribute('aria-pressed', 'false')
  amount = value
  price = ''
  payButton.disabled = true
  quoteTimer = setTimeout(() => {
    void bridge()?.quote(value).then((money) => {
      if (seq !== quoteSeq || amount !== value) return
      price = money
      payButton.textContent = `${view.payLabel} ${view.moneyPrefix}${money}`
      showError('')
      lock(false)
    }).catch(() => {
      if (seq !== quoteSeq) return
      amount = undefined
      price = ''
      showError(view.failedText)
      lock(false)
    })
  }, 250)
}

/** Render the configuration the shell loaded, keeping the first shortcut selected. */
function render(next) {
  view = next
  if (next === undefined || next === null) {
    dialog.hidden = true
    return
  }
  document.title = next.title
  titleNode.textContent = next.title
  balanceLabel.textContent = next.balanceLabel
  balanceValue.textContent = next.balanceValue
  amountLabel.textContent = next.amountLabel
  customLabel.textContent = next.customLabel
  doneBalanceLabel.textContent = next.balanceLabel
  closeButton.setAttribute('aria-label', next.closeLabel)
  finishButton.textContent = next.finishLabel
  customInput.placeholder = String(next.minAmount)
  progressText.textContent = next.waitingText
  hintNode.textContent = [next.exchangeHint, next.minHint].filter(text => text !== '').join(' · ')
  customInput.min = String(next.minAmount)

  optionsNode.replaceChildren(...next.options.map((option) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'option'
    button.dataset.amount = String(option.amount)
    button.textContent = option.label
    button.addEventListener('click', () => {
      customInput.value = ''
      amount = option.amount
      price = option.label
      showError('')
      select(option.amount)
    })
    return button
  }))
  methodsNode.replaceChildren(...next.methods.map((entry, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'method'
    button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false')
    button.textContent = entry.name
    button.addEventListener('click', () => {
      method = entry.type
      for (const other of methodsNode.querySelectorAll('button')) other.setAttribute('aria-pressed', other === button ? 'true' : 'false')
    })
    return button
  }))
  method = next.methods[0]?.type

  if (next.options.length === 0 && next.noMethod) {
    showError(next.noMethod)
    payButton.disabled = true
    payButton.textContent = next.payLabel
  } else if (next.options.length === 0) {
    customInput.value = String(next.minAmount)
    quoteCustom()
  } else {
    const first = next.options[0]
    amount = first.amount
    price = first.label
    select(first.amount)
  }
  if (next.options.length > 0) select(next.options[0].amount)
  payButton.textContent = amount === undefined ? next.payLabel : `${next.payLabel} ${price}`
  section('form')
  dialog.hidden = false
  requestAnimationFrame(() => { document.body.classList.add('visible') })
  dialog.focus()
}

/** Show the success section with the refreshed balance. */
function succeed(balance) {
  clearInterval(pollTimer)
  pollTimer = undefined
  doneText.textContent = view.successText
  doneBalanceValue.textContent = balance
  balanceValue.textContent = balance
  section('done')
  finishButton.focus()
}

/** Return to the form after a failed or abandoned payment. */
function fail(text) {
  clearInterval(pollTimer)
  pollTimer = undefined
  showError(text)
  progressNode.hidden = true
  section('form')
}

/** Create the order and poll the site until it reports the payment. */
async function pay() {
  const shell = bridge()
  if (shell === undefined || view === undefined || amount === undefined || method === undefined) return
  lock(true)
  showError('')
  section('progress')
  progressText.textContent = view.payingText
  let order
  try {
    order = await shell.pay(amount, method)
  } catch (_error) {
    lock(false)
    fail(view.failedText)
    return
  }
  tradeNo = order.tradeNo
  progressText.textContent = view.waitingText
  const deadline = Date.now() + 10 * 60_000
  pollTimer = setInterval(() => {
    if (closed) return
    if (Date.now() > deadline) { fail(view.failedText); return }
    void shell.poll(tradeNo).then((result) => {
      if (closed || result.tradeNo !== tradeNo) return
      if (result.state === 'paid') succeed(result.balanceValue)
      else if (result.state === 'failed') fail(view.failedText)
    }).catch(() => { /* A transient read failure retries on the next tick. */ })
  }, 2000)
}

payButton.addEventListener('click', () => { void pay() })
finishButton.addEventListener('click', () => { void bridge()?.close() })
closeButton.addEventListener('click', () => { void bridge()?.close() })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void bridge()?.close()
})
customInput.addEventListener('input', () => { clearTimeout(quoteTimer); quoteCustom() })

const shell = bridge()
if (shell !== undefined) {
  shell.status().then(render).catch(() => {})
  shell.subscribe((next) => { if (view === undefined) render(next) })
}
// Lets a shell-only preview render one sample view without the preload bridge.
window.__topUpDialogPreview = render
