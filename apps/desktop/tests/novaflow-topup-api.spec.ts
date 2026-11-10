import { describe, expect, it, vi } from 'vitest'
import {
  quoteNewApiTopUp, readNewApiTopUpInfo, readNewApiTopUpState, startNewApiTopUp,
} from '../src/novaflow/new-api.ts'
import type { RelayAccess } from '../src/novaflow/relay-broker.ts'

const ORIGIN = 'https://api.novaflow.test'
const access: RelayAccess = { accessToken: 'session-token', deviceSessionId: 'device', group: 'default' }
const signal = () => new AbortController().signal


function route(routes: Record<string, unknown>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname
    calls.push(path)
    const payload = routes[path]
    if (payload === undefined) return Response.json({ message: 'unexpected' }, { status: 404 })
    return Response.json(payload)
  })
  return { fetch: fn, calls }
}

describe('site top-up configuration', () => {
  it('reads shortcut amounts, the minimum, and the online payment methods', async () => {
    const { fetch } = route({ '/api/user/topup/info': { success: true, data: {
      amount_options: [4, 15, 'x', -1, 50], min_topup: 2, enable_online_topup: true,
      pay_methods: [{ type: 'alipay', name: '支付宝' }],
    } } })
    await expect(readNewApiTopUpInfo(fetch, ORIGIN, access, signal()))
      .resolves.toEqual({ amountOptions: [4, 15, 50], minTopUp: 2, payMethods: [{ type: 'alipay', name: '支付宝' }] })
  })

  it('offers no payment method when online top-up is disabled', async () => {
    const { fetch } = route({ '/api/user/topup/info': { success: true, data: {
      amount_options: [4], enable_online_topup: false, pay_methods: [{ type: 'alipay', name: 'A' }],
    } } })
    await expect(readNewApiTopUpInfo(fetch, ORIGIN, access, signal()))
      .resolves.toEqual({ amountOptions: [4], minTopUp: 1, payMethods: [] })
  })
})

describe('site top-up orders', () => {
  it('quotes the money the gateway will charge', async () => {
    const { fetch, calls } = route({ '/api/user/amount': { message: 'success', data: '7.00' } })
    await expect(quoteNewApiTopUp(fetch, ORIGIN, access, 4, signal())).resolves.toBe('7.00')
    expect(calls).toEqual(['/api/user/amount'])
  })

  it('refuses amounts the site cannot represent', async () => {
    const { fetch } = route({ '/api/user/amount': { message: 'success', data: '7.00' } })
    for (const amount of [0, -1, 1.5, Number.NaN]) {
      await expect(quoteNewApiTopUp(fetch, ORIGIN, access, amount, signal())).rejects.toThrow('invalid_response')
    }
  })

  it('creates an order with the gateway form and rejects an unsafe gateway URL', async () => {
    const order = { message: 'success', data: {
      out_trade_no: 'USR1NOabc', pid: '2026', sign: 'sig', money: '7.00', type: 'alipay', 'bad key': 'drop', count: 1,
    }, url: 'https://zpayz.cn/submit.php' }
    const { fetch } = route({ '/api/user/pay': order })
    await expect(startNewApiTopUp(fetch, ORIGIN, access, { amount: 1, method: 'alipay' }, signal()))
      .resolves.toEqual({ tradeNo: 'USR1NOabc', payUrl: 'https://zpayz.cn/submit.php',
        fields: { pid: '2026', sign: 'sig', money: '7.00', type: 'alipay' } })
    const unsafe = route({ '/api/user/pay': { ...order, url: 'http://zpayz.cn/submit.php' } })
    await expect(startNewApiTopUp(unsafe.fetch, ORIGIN, access, { amount: 1, method: 'alipay' }, signal()))
      .rejects.toThrow('invalid_response')
  })

  it('reads the order state from the authenticated top-up history', async () => {
    const page = (status: string) => ({ success: true, data: { items: [{ trade_no: 'USR1NOabc', status }] } })
    for (const [status, expected] of [['success', 'paid'], ['pending', 'pending'], ['failed', 'failed']] as const) {
      const { fetch } = route({ '/api/user/topup/self': page(status) })
      await expect(readNewApiTopUpState(fetch, ORIGIN, access, 'USR1NOabc', signal())).resolves.toBe(expected)
    }
    const missing = route({ '/api/user/topup/self': page('pending') })
    await expect(readNewApiTopUpState(missing.fetch, ORIGIN, access, 'USR1NOother', signal()))
      .rejects.toThrow('invalid_response')
  })
})
