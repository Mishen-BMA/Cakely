import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const apiPath = require.resolve('../api.js')
const user = { id: 7, username: 'customer', email: 'customer@example.test', is_admin: false, rate_limited_until: null }
const admin = { id: 1, username: 'admin', is_admin: true }
const product = { id: 12, name: 'Cake', active: true, base_price: 1000, flavours: ['Vanilla'], sizes: { '1 kg': 1000 } }

function makeDatabase() {
  const state = { orders: [], events: [], couponUsages: [], user: { ...user }, enabled: true, nextOrderId: 20 }
  const resolve = (query) => {
    const { table, operation, payload, filters } = query
    const match = (row) => filters.every(([key, value, mode]) => mode === 'neq' ? row?.[key] !== value : mode === 'or' ? true : String(row?.[key]) === String(value))
    if (table === 'users') {
      if (operation === 'select') {
        if (filters.some(([key]) => key === 'or')) return { data: admin, error: null }
        return { data: filters.some(([key]) => key === 'id') ? state.user : null, error: null }
      }
      if (operation === 'update') {
        if (String(filters.find(([key]) => key === 'id')?.[1]) === String(admin.id)) return { data: admin, error: null }
        state.user = { ...state.user, ...payload }; return { data: state.user, error: null }
      }
      return { data: null, error: null }
    }
    if (table === 'products') return { data: product, error: null }
    if (table === 'platform_settings') {
      if (operation === 'upsert') { state.enabled = payload.rulelock_enabled; return { data: { rulelock_enabled: state.enabled }, error: null } }
      return { data: { rulelock_enabled: state.enabled }, error: null }
    }
    if (table === 'coupons') {
      const code = filters.find(([key]) => key === 'code')?.[1]
      return { data: code === 'SAVE500' ? { id: 3, code: 'SAVE500', active: true, discount_type: 'FIXED', discount_value: 500, minimum_order: 0, can_stack: false, cod_applicable: true } : null, error: null }
    }
    if (table === 'coupon_usages') {
      if (operation === 'insert') { state.couponUsages.push(payload); return { data: payload, error: null } }
      return { data: null, count: 0, error: null }
    }
    if (table === 'orders') {
      if (operation === 'insert') {
        const row = { ...payload, id: state.nextOrderId++, created_at: new Date().toISOString() }
        state.orders.push(row)
        return { data: row, error: null }
      }
      if (operation === 'update') {
        const row = state.orders.find((item) => match(item))
        if (!row) return { data: null, error: null }
        Object.assign(row, payload)
        return { data: row, error: null }
      }
      return { data: filters.some(([key, , mode]) => key === 'id' && mode !== 'neq') ? state.orders.find(match) || null : state.orders.filter(match), error: null }
    }
    if (table === 'transaction_events') {
      if (operation === 'insert') { state.events.push(payload); return { data: payload, error: null } }
      return { data: null, count: 0, error: null }
    }
    return { data: null, error: null }
  }
  const client = { from(table) {
    const query = { table, operation: 'select', filters: [], payload: null }
    const chain = {
      select() { return chain },
      insert(payload) { query.operation = 'insert'; query.payload = Array.isArray(payload) ? payload[0] : payload; return chain },
      update(payload) { query.operation = 'update'; query.payload = payload; return chain },
      upsert(payload) { query.operation = 'upsert'; query.payload = payload; return chain },
      delete() { query.operation = 'delete'; return chain },
      eq(key, value) { query.filters.push([key, value]); return chain },
      neq(key, value) { query.filters.push([key, value, 'neq']); return chain },
      or(value) { query.filters.push(['or', value, 'or']); return chain },
      order() { return chain },
      limit() { return chain },
      single() { return Promise.resolve(resolve(query)) },
      maybeSingle() { return Promise.resolve(resolve(query)) },
      then(yes, no) { return Promise.resolve(resolve(query)).then(yes, no) },
    }
    return chain
  } }
  return { state, client }
}

let db
let app
let token

beforeEach(() => {
  vi.stubEnv('RULELOCK_API_URL', 'https://rulelock.example')
  vi.stubEnv('RULELOCK_API_TOKEN', 'test-token')
  
  db = makeDatabase()
  globalThis.__CAKELY_SUPABASE_CLIENT__ = db.client
  delete require.cache[apiPath]
  app = require('../api.js').app
  token = jwt.sign({ sub: String(user.id) }, 'dev-only-change-me', { algorithm: 'HS256' })
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  delete globalThis.__CAKELY_SUPABASE_CLIENT__
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const checkout = (extra = {}) => request(app).post('/checkout')
  .set('Authorization', `Bearer ${jwt.sign({ sub: String(user.id) }, 'dev-only-change-me')}`)
  .set('X-Session-ID', 'session-test')
  .set('X-Device-ID', 'device-test')
  .send({ items: [{ productId: 12, size: '1 kg', quantity: 1 }], address: { name: 'Casey', phone: '+94 77 123 4567', address: '12 Cake Street', city: 'Colombo', district: 'Colombo' }, paymentMethod: 'CARD', fulfillmentMethod: 'DELIVERY', coupons: [], ...extra })

function rulelockResponse(decision, customer_message = 'Order received.') {
  return { order_id: 20, decision, payment_action: 'none', reason: 'internal-only', customer_message, account_action: null, rule_result: {}, anomaly_result: {}, enforcement_result: {} }
}

describe('RuleLock checkout contract', () => {
  it('posts the v2 body to /review-order and accepts only after a valid decision', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    const response = await checkout().expect(201)
    const [url, options] = fetch.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(url).toBe('https://rulelock.example/review-order')
    expect(options.headers.Authorization).toBe('Bearer test-token')
    expect(options.headers['X-Session-ID']).toBe('session-test')
    expect(body).toMatchObject({ order_id: 20, order_reference: expect.stringMatching(/^CK-\d{14}-[A-Z0-9]{4}$/), account_id: '7', payment_method: 'CARD', items: [{ sku: 'sku-12', name: 'Cake', size: '1 kg', quantity: 1, unit_price: 1000 }] })
    expect(body.phone_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(body.address_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(body).not.toHaveProperty('phone')
    expect(body).not.toHaveProperty('address')
    expect(db.state.orders[0]).toMatchObject({ payment_status: 'PAID', status: 'PENDING' })
    expect(response.body.data.status).toBe('PENDING')
    expect(db.state.events.some((event) => event.event_type === 'RULELOCK_REVIEW')).toBe(false)
    expect(db.state.events.some((event) => event.event_type === 'RULELOCK_DECISION_APPLIED')).toBe(true)
  })

  it('holds and retries malformed responses, leaving card payment on hold', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => ({ decision: 'accept' }) })
    const response = await checkout().expect(201)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(response.body.data.status).toBe('PENDING_REVIEW')
    expect(db.state.orders[0]).toMatchObject({ status: 'PENDING_REVIEW', payment_status: 'ON_HOLD' })
    expect(response.body.data.customerMessage).toBe('Your order is under review. We will update you soon.')
  })

  it('rejects with only the customer message and does not record coupon usage', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('reject', 'We could not accept this order.') })
    const response = await checkout({ paymentMethod: 'COD', coupons: ['SAVE500'] }).expect(403)
    expect(response.body).toEqual({ customer_message: 'We could not accept this order.' })
    expect(JSON.stringify(response.body)).not.toContain('internal-only')
    expect(db.state.orders[0]).toMatchObject({ status: 'REJECTED', payment_status: 'VOIDED' })
    expect(db.state.couponUsages).toHaveLength(0)
  })

  it('voids the discount before accepting and records no coupon usage', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('void_discount') })
    const response = await checkout({ paymentMethod: 'COD', coupons: ['SAVE500'] }).expect(201)
    expect(response.body.data.total).toBe(1500)
    expect(db.state.orders[0]).toMatchObject({ status: 'PENDING', payment_status: 'PENDING', discount: 0, total: 1500 })
    expect(db.state.couponUsages).toHaveLength(0)
  })

  it('records coupon use for held orders and hashes identifiers in checkout events', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('hold', 'Under review.') })
    const response = await checkout({ paymentMethod: 'COD', coupons: ['SAVE500'] }).expect(201)
    expect(db.state.couponUsages).toHaveLength(1)
    const couponEvent = db.state.events.find((event) => event.event_type === 'APPLY_COUPON')
    expect(couponEvent.metadata).toMatchObject({ coupon_code: 'SAVE500', session_id: 'session-test', device_id: 'device-test', account_id: '7' })
    expect(couponEvent.metadata.phone_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(db.state.events)).not.toContain('+94 77 123 4567')
    expect(JSON.stringify(db.state.events)).not.toContain('12 Cake Street')
  })

  it('sends only REFUSED COD history and completed-order verification', async () => {
    db.state.orders.push(
      { id: 3, user_id: 7, payment_method: 'COD', status: 'CANCELLED' },
      { id: 4, user_id: 7, payment_method: 'COD', status: 'REJECTED' },
      { id: 5, user_id: 7, payment_method: 'COD', status: 'REFUSED' },
      { id: 6, user_id: 7, payment_method: 'CARD', status: 'COMPLETED' },
    )
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout({ paymentMethod: 'COD' }).expect(201)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ past_orders: 3, past_refusals: 1, account_verified: true })
  })

  it('keeps an order on hold when the enabled service has no base URL', async () => {
    vi.stubEnv('RULELOCK_API_URL', '')
    delete require.cache[apiPath]
    app = require('../api.js').app
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await checkout().expect(201)
    expect(fetch).not.toHaveBeenCalled()
    expect(response.body.data.status).toBe('PENDING_REVIEW')
    expect(db.state.orders[0]).toMatchObject({ status: 'PENDING_REVIEW', payment_status: 'ON_HOLD' })
    expect(error).toHaveBeenCalledWith('RuleLock is enabled but RULELOCK_API_URL is missing')
    error.mockRestore()
  })

  it('persists the RuleLock account rate limit', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => ({ ...rulelockResponse('accept'), account_action: { type: 'rate_limit', minutes: 5 } }) })
    await checkout().expect(201)
    expect(new Date(db.state.user.rate_limited_until).getTime()).toBeGreaterThan(Date.now())
  })

  it('refuses a checkout while a stored account rate limit is active', async () => {
    db.state.user.rate_limited_until = new Date(Date.now() + 60_000).toISOString()
    await checkout().expect(429)
    expect(fetch).not.toHaveBeenCalled()
    expect(db.state.orders).toHaveLength(0)
  })

  it('supports COD refused status and records release overrides', async () => {
    db.state.user = { ...db.state.user, is_admin: true }
    db.state.orders.push({ id: 42, user_id: 7, payment_method: 'COD', status: 'PENDING_REVIEW', payment_status: 'ON_HOLD' })
    const authorization = `Bearer ${jwt.sign({ sub: '7' }, 'dev-only-change-me')}`
    await request(app).patch('/admin/orders/42').set('Authorization', authorization).send({ action: 'release' }).expect(200)
    expect(db.state.orders.find((order) => order.id === 42).status).toBe('PENDING')
    const override = db.state.events.find((event) => event.event_type === 'RULELOCK_OVERRIDE')
    expect(override.metadata).toMatchObject({ order_id: 42, action: 'release', admin_id: 7, previous_decision: 'hold' })
    await request(app).patch('/admin/orders/42').set('Authorization', authorization).send({ status: 'REFUSED' }).expect(200)
    expect(db.state.orders.find((order) => order.id === 42).status).toBe('REFUSED')
  })

  it('stores the RuleLock toggle in platform_settings and progresses pending orders', async () => {
    db.state.user = { ...db.state.user, is_admin: true }
    db.state.orders.push({ id: 52, user_id: 7, payment_method: 'CARD', status: 'PENDING', payment_status: 'PAID' })
    const authorization = `Bearer ${jwt.sign({ sub: '7' }, 'dev-only-change-me')}`
    await request(app).patch('/admin/rulelock').set('Authorization', authorization).send({ enabled: false }).expect(200)
    expect(db.state.enabled).toBe(false)
    expect(db.state.events.some((event) => event.event_type === 'RULELOCK_SETTING_CHANGED')).toBe(false)
    await request(app).patch('/admin/orders/52').set('Authorization', authorization).send({ status: 'PREPARING' }).expect(200)
    await request(app).patch('/admin/orders/52').set('Authorization', authorization).send({ status: 'COMPLETED' }).expect(200)
    expect(db.state.orders.find((order) => order.id === 52).status).toBe('COMPLETED')
  })
})


