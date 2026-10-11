import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const apiPath = require.resolve('../api.js')
const user = { id: 7, username: 'customer', email: 'customer@example.test', is_admin: false, rate_limited_until: null }
const admin = { id: 1, username: 'admin', is_admin: true }
const product = { id: 12, name: 'Cake', slug: 'cake', active: true, base_price: 1000, image: 'data:image/png;base64,aGVsbG8=', flavours: ['Vanilla', 'Chocolate'], sizes: { '1 kg': 1000 } }

function makeDatabase() {
  const state = { orders: [], events: [], couponUsages: [], user: { ...user, password_hash: null }, admin: { ...admin, email: 'admin@cakely.lk', password_hash: null }, enabled: true, nextOrderId: 20, rpcCalls: [], ranges: [], firstOrderOnly: false }
  const resolve = (query) => {
    const { table, operation, payload, filters } = query
    const match = (row) => filters.every(([key, value, mode]) => mode === 'neq' ? row?.[key] !== value : mode === 'in' ? value.map(String).includes(String(row?.[key])) : String(row?.[key]) === String(value))
    if (table === 'users') {
      if (operation === 'select') {
        const idFilter = filters.find(([key]) => key === 'id')
        if (idFilter) {
          if (Array.isArray(idFilter[1])) return { data: [state.user, state.admin].filter((candidate) => idFilter[1].map(String).includes(String(candidate.id))), error: null }
          return { data: String(idFilter[1]) === String(state.admin.id) ? state.admin : String(idFilter[1]) === String(state.user.id) ? state.user : null, error: null }
        }
        const identity = filters.find(([key]) => key === 'username' || key === 'email')
        if (identity) {
          const [key, value] = identity
          return { data: String(state.admin[key]).toLowerCase() === String(value).toLowerCase() ? state.admin : String(state.user[key]).toLowerCase() === String(value).toLowerCase() ? state.user : null, error: null }
        }
        if (filters.some(([key, value]) => key === 'is_admin' && value === false)) return { data: [state.user], count: 1, error: null }
        return { data: null, error: null }
      }
      if (operation === 'update') {
        if (String(filters.find(([key]) => key === 'id')?.[1]) === String(state.admin.id)) { Object.assign(state.admin, payload); return { data: state.admin, error: null } }
        state.user = { ...state.user, ...payload }; return { data: state.user, error: null }
      }
      if (operation === 'insert') { state.registeredUser = payload; return { data: { ...payload, id: 9 }, error: null } }
      return { data: null, error: null }
    }
    if (table === 'products') return { data: [product], count: 1, error: null }
    if (table === 'platform_settings') {
      if (operation === 'upsert') { state.enabled = payload.rulelock_enabled; return { data: { rulelock_enabled: state.enabled }, error: null } }
      return { data: { rulelock_enabled: state.enabled }, error: null }
    }
    if (table === 'coupons') {
      const code = filters.find(([key]) => key === 'code')?.[1]
      if (!['SAVE500', 'FREEDESSERT', 'PCT10', 'PCT20'].includes(code)) return { data: null, error: null }
      const percentage = code === 'PCT10' || code === 'PCT20'
      return { data: { id: ({ SAVE500: 3, FREEDESSERT: 4, PCT10: 5, PCT20: 6 })[code], code, active: true, discount_type: percentage ? 'PERCENTAGE' : 'FIXED', discount_value: code === 'SAVE500' ? 500 : code === 'PCT10' ? 10 : code === 'PCT20' ? 20 : 0, minimum_order: 0, can_stack: false, allowed_payment_methods: percentage ? ['CARD'] : ['COD'], free_delivery: code === 'FREEDESSERT', first_order_only: state.firstOrderOnly } , error: null }
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
      const rows = filters.some(([key, , mode]) => key === 'id' && mode !== 'neq') ? state.orders.find(match) || null : state.orders.filter(match)
      return { data: Array.isArray(rows) && query.range ? rows.slice(query.range[0], query.range[1] + 1) : rows, count: Array.isArray(rows) ? rows.length : rows ? 1 : 0, error: null }
    }
    if (table === 'transaction_events') {
      if (operation === 'insert') { state.events.push(payload); return { data: payload, error: null } }
      return { data: query.range ? state.events.slice(query.range[0], query.range[1] + 1) : state.events, count: state.events.length, error: null }
    }
    return { data: null, error: null }
  }
  const client = { rpc(name, args) {
    state.rpcCalls.push([name, args])
    if (name === 'record_coupon_usages') {
      for (const coupon_id of args.p_coupon_ids) state.couponUsages.push({ coupon_id, user_id: args.p_user_id, order_id: args.p_order_id })
      return Promise.resolve({ data: null, error: null })
    }
    if (name === 'admin_dashboard_metrics') return Promise.resolve({ data: [{ order_count: state.orders.length, pending_count: state.orders.filter((row) => row.status === 'PENDING').length, preparing_count: state.orders.filter((row) => row.status === 'PREPARING').length, completed_count: state.orders.filter((row) => row.status === 'COMPLETED').length, revenue: state.orders.reduce((total, row) => total + Number(row.total || 0), 0), customer_count: 1 }], error: null })
    if (name === 'admin_dashboard_customer_stats') return Promise.resolve({ data: args.p_user_ids.map((user_id) => ({ user_id, orders: state.orders.filter((row) => String(row.user_id) === String(user_id)).length, spending: state.orders.filter((row) => String(row.user_id) === String(user_id)).reduce((total, row) => total + Number(row.total || 0), 0) })), error: null })
    return Promise.resolve({ data: null, error: { message: 'Unknown RPC' } })
  }, from(table) {
    const query = { table, operation: 'select', filters: [], payload: null }
    const chain = {
      select() { return chain },
      insert(payload) { query.operation = 'insert'; query.payload = Array.isArray(payload) ? payload[0] : payload; return chain },
      update(payload) { query.operation = 'update'; query.payload = payload; return chain },
      upsert(payload) { query.operation = 'upsert'; query.payload = payload; return chain },
      delete() { query.operation = 'delete'; return chain },
      eq(key, value) { query.filters.push([key, value]); return chain },
      neq(key, value) { query.filters.push([key, value, 'neq']); return chain },
      in(key, value) { query.filters.push([key, value, 'in']); return chain },
      order() { return chain },
      limit() { return chain },
      range(from, to) { query.range = [from, to]; state.ranges.push({ table, from, to }); return chain },
      single() { return Promise.resolve(resolve(query)).then((result) => ({ ...result, data: Array.isArray(result.data) ? result.data[0] || null : result.data })) },
      maybeSingle() { return Promise.resolve(resolve(query)).then((result) => ({ ...result, data: Array.isArray(result.data) ? result.data[0] || null : result.data })) },
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
  vi.stubEnv('JWT_SECRET_KEY', 'unit-test-jwt-secret')
  vi.stubEnv('ADMIN_USERNAME', 'admin')
  vi.stubEnv('ADMIN_PASSWORD', 'admin-password')
  vi.stubEnv('RULELOCK_API_URL', 'https://rulelock.example')
  vi.stubEnv('RULELOCK_API_TOKEN', 'test-token')
  
  db = makeDatabase()
  db.state.admin.password_hash = bcrypt.hashSync('admin-password', 4)
  db.state.user.password_hash = bcrypt.hashSync('customer-password', 4)
  globalThis.__CAKELY_SUPABASE_CLIENT__ = db.client
  delete require.cache[apiPath]
  app = require('../api.js').app
  token = jwt.sign({ sub: String(user.id), role: 'customer' }, 'unit-test-jwt-secret', { algorithm: 'HS256' })
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  delete globalThis.__CAKELY_SUPABASE_CLIENT__
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const checkout = (extra = {}) => request(app).post('/checkout')
  .set('Authorization', `Bearer ${jwt.sign({ sub: String(user.id), role: 'customer' }, 'unit-test-jwt-secret')}`)
  .set('X-Session-ID', 'session-test')
  .set('X-Device-ID', 'device-test')
  .send({ items: [{ productId: 12, size: '1 kg', quantity: 1 }], address: { name: 'Casey', phone: '+94 77 123 4567', address: '12 Cake Street', city: 'Colombo', district: 'Colombo' }, paymentMethod: 'CARD', fulfillmentMethod: 'DELIVERY', coupons: [], ...extra })

function rulelockResponse(decision, customer_message = 'Order received.') {
  return { order_id: 20, decision, payment_action: 'none', reason: 'internal-only', customer_message, account_action: null, rule_result: {}, anomaly_result: {}, enforcement_result: {}, pipeline: {
    c1_data_collection: { status: 'complete', events_in_session: 2, session_features: { velocity: 1, device_reuse: 0, address_reuse: 0, account_age: 10 }, account: { user_id: 7, username: 'customer', account_age_days: 10, completed_orders: 1, cod_orders: 2, cod_bad_orders: 0 } },
    c2_rule_engine: { status: 'pass', checks: [{ code: 'valid', label: 'Valid order', passed: true, detail: 'All checks passed' }], violations: [] },
    c3_anomaly: { status: 'normal', score: 0.1, hold_threshold: 0.5, reject_threshold: 0.8 },
    c4_enforcement: { decision, action: decision, reason: 'internal-only', account_action: null },
  } }
}

describe('RuleLock checkout contract', () => {
  it('posts the v3 request body to /review-order and accepts only after a valid decision', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    const response = await checkout().expect(201)
    const [url, options] = fetch.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(url).toBe('https://rulelock.example/review-order')
    expect(options.headers.Authorization).toBe('Bearer test-token')
    expect(options.headers['X-Session-ID']).toBe('session-test')
    expect(body).toMatchObject({ order_id: 20, order_reference: expect.stringMatching(/^CK-\d{14}-[A-Z0-9]{4}$/), account_id: '7', payment_method: 'CARD', items: [{ sku: 'sku-12', name: 'Cake', size: '1 kg', quantity: 1, unit_price: 1000 }] })
    expect(body.order_reference).toBe(db.state.orders[0].order_number)
    expect(response.body.data.orderNumber).toBe(db.state.orders[0].order_number)
    expect(Object.keys(body).sort()).toEqual(['order_id', 'order_reference', 'account_id', 'user_id', 'customer_name', 'session_id', 'device_id', 'phone_hash', 'address_hash', 'payment_method', 'items', 'coupons_applied', 'discount_value', 'subtotal', 'total', 'account_verified', 'past_orders', 'past_refusals'].sort())
    expect(Object.keys(body.items[0]).sort()).toEqual(['sku', 'name', 'size', 'quantity', 'unit_price'].sort())
    expect(body.phone_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(body.address_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(body).not.toHaveProperty('phone')
    expect(body).not.toHaveProperty('address')
    expect(rulelockResponse('accept')).toHaveProperty('pipeline.c4_enforcement.decision', 'accept')
    expect(db.state.orders[0]).toMatchObject({ payment_status: 'PAID', status: 'PENDING' })
    expect(db.state.orders[0].rulelock_review).toMatchObject({ decision: 'accept', reason: 'internal-only', pipeline: { c3_anomaly: { score: 0.1 } } })
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

  it('returns the rejected order details and saves the review without recording coupon usage', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('reject', 'We could not accept this order.') })
    const response = await checkout({ paymentMethod: 'COD', coupons: ['SAVE500'] }).expect(201)
    expect(response.body.data).toMatchObject({ status: 'REJECTED', decision: 'reject', customerMessage: 'We could not accept this order.', review: { reason: 'internal-only' } })
    expect(response.body.data.review.reason).toBe('internal-only')
    expect(db.state.orders[0]).toMatchObject({ status: 'REJECTED', payment_status: 'VOIDED' })
    expect(db.state.orders[0].rulelock_review.pipeline.c4_enforcement.decision).toBe('reject')
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
      { id: 3, user_id: 7, payment_method: 'COD', status: 'CANCELLED', cancelled_by: 'CUSTOMER' },
      { id: 4, user_id: 7, payment_method: 'COD', status: 'REJECTED' },
      { id: 5, user_id: 7, payment_method: 'COD', status: 'REFUSED' },
      { id: 7, user_id: 7, payment_method: 'COD', status: 'CANCELLED', cancelled_by: 'ADMIN' },
      { id: 8, user_id: 7, payment_method: 'COD', status: 'CANCELLED' },
      { id: 6, user_id: 7, payment_method: 'CARD', status: 'COMPLETED' },
    )
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout({ paymentMethod: 'COD' }).expect(201)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ past_orders: 5, past_refusals: 2, account_verified: true })
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
    db.state.orders.push({ id: 42, user_id: 7, payment_method: 'COD', status: 'PENDING_REVIEW', payment_status: 'ON_HOLD' })
    const authorization = `Bearer ${jwt.sign({ sub: '1', role: 'admin' }, 'unit-test-jwt-secret')}`
    await request(app).patch('/admin/orders/42').set('Authorization', authorization).send({ action: 'release' }).expect(200)
    expect(db.state.orders.find((order) => order.id === 42).status).toBe('PENDING')
    const override = db.state.events.find((event) => event.event_type === 'RULELOCK_OVERRIDE')
    expect(override.metadata).toMatchObject({ order_id: 42, action: 'release', admin_id: 1, previous_decision: 'hold' })
    await request(app).patch('/admin/orders/42').set('Authorization', authorization).send({ status: 'REFUSED' }).expect(200)
    expect(db.state.orders.find((order) => order.id === 42).status).toBe('REFUSED')
    await request(app).patch('/admin/orders/42').set('Authorization', authorization).send({ status: 'CANCELLED' }).expect(200)
    expect(db.state.orders.find((order) => order.id === 42)).toMatchObject({ status: 'CANCELLED', cancelled_by: 'ADMIN' })
  })

  it('allows only the owner to cancel pending orders and records customer attribution', async () => {
    db.state.orders.push({ id: 43, user_id: 7, payment_method: 'COD', status: 'PENDING_REVIEW', payment_status: 'ON_HOLD' })
    const authorization = `Bearer ${jwt.sign({ sub: String(user.id), role: 'customer' }, 'unit-test-jwt-secret')}`
    await request(app).post('/orders/43/cancel').set('Authorization', authorization).expect(200)
    expect(db.state.orders.find((order) => order.id === 43)).toMatchObject({ status: 'CANCELLED', cancelled_by: 'CUSTOMER' })
    expect(db.state.events.find((event) => event.event_type === 'ORDER_CANCELLED')).toMatchObject({ user_id: 7, order_id: 43, metadata: { cancelled_by: 'CUSTOMER' } })
    await request(app).post('/orders/43/cancel').set('Authorization', authorization).expect(400)
    await request(app).post('/orders/43/cancel').set('Authorization', `Bearer ${jwt.sign({ sub: '1', role: 'admin' }, 'unit-test-jwt-secret')}`).expect(401)
  })

  it('normalizes a RuleLock URL that already ends in /review-order/', async () => {
    vi.stubEnv('RULELOCK_API_URL', 'https://rulelock.example/review-order///')
    delete require.cache[apiPath]
    app = require('../api.js').app
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout().expect(201)
    expect(fetch.mock.calls[0][0]).toBe('https://rulelock.example/review-order')
  })

  it('removes the quantity cap and allows percentage coupon stacking in research mode', async () => {
    vi.stubEnv('CAKELY_SECURITY_MODE', 'research')
    delete require.cache[apiPath]
    app = require('../api.js').app
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout({ items: [{ productId: 12, size: '1 kg', quantity: 50 }], coupons: ['PCT10', 'PCT20'], discount: 15000 }).expect(201)
    expect(db.state.orders[0].items[0].quantity).toBe(50)
    expect(db.state.orders[0]).toMatchObject({ discount: 15000, subtotal: 50000 })
    expect(db.state.couponUsages).toHaveLength(2)
  })

  it('stores the RuleLock toggle in platform_settings and progresses pending orders', async () => {
    db.state.orders.push({ id: 52, user_id: 7, payment_method: 'CARD', status: 'PENDING', payment_status: 'PAID' })
    const authorization = `Bearer ${jwt.sign({ sub: '1', role: 'admin' }, 'unit-test-jwt-secret')}`
    await request(app).patch('/admin/rulelock').set('Authorization', authorization).send({ enabled: false }).expect(200)
    expect(db.state.enabled).toBe(false)
    expect(db.state.events.some((event) => event.event_type === 'RULELOCK_SETTING_CHANGED')).toBe(false)
    await request(app).patch('/admin/orders/52').set('Authorization', authorization).send({ status: 'PREPARING' }).expect(200)
    await request(app).patch('/admin/orders/52').set('Authorization', authorization).send({ status: 'COMPLETED' }).expect(200)
    expect(db.state.orders.find((order) => order.id === 52).status).toBe('COMPLETED')
  })

  it('ignores client COD promotion claims and calculates fees on the server', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout({ paymentMethod: 'COD', codPromotion: true }).expect(201)
    expect(db.state.orders[0]).toMatchObject({ delivery_fee: 500, total: 1500 })
  })

  it('enforces first-order coupons based on prior order status', async () => {
    db.state.firstOrderOnly = true
    db.state.orders.push({ id: 4, user_id: 7, status: 'CANCELLED' }, { id: 5, user_id: 7, status: 'REJECTED' })
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout({ paymentMethod: 'COD', coupons: ['SAVE500'] }).expect(201)
    expect(db.state.orders.at(-1).discount).toBe(500)
    expect(db.state.couponUsages).toHaveLength(1)

    db.state.orders.push({ id: 6, user_id: 7, status: 'COMPLETED' })
    await checkout({ paymentMethod: 'COD', coupons: ['SAVE500'] }).expect(201)
    expect(db.state.orders.at(-1).discount).toBe(0)
    expect(db.state.couponUsages).toHaveLength(1)
  })

  it('honors database free_delivery independently of discount type', async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout({ paymentMethod: 'COD', coupons: ['FREEDESSERT'] }).expect(201)
    expect(db.state.orders[0]).toMatchObject({ discount: 0, delivery_fee: 150, total: 1150 })
  })

  it('keeps customer and administrator authentication roles separate', async () => {
    const customerLogin = await request(app).post('/auth/login').send({ identifier: 'customer', password: 'customer-password' }).expect(200)
    expect(jwt.decode(customerLogin.body.data.token).role).toBe('customer')
    await request(app).post('/auth/login').send({ identifier: 'admin', password: 'admin-password' }).expect(403)
    const adminLogin = await request(app).post('/auth/admin-login').send({ identifier: 'admin', password: 'admin-password' }).expect(200)
    const adminClaims = jwt.decode(adminLogin.body.data.token)
    expect(adminClaims.role).toBe('admin')
    expect(adminClaims.exp - adminClaims.iat).toBe(8 * 60 * 60)
    await request(app).post('/auth/admin-login').send({ identifier: 'customer', password: 'customer-password' }).expect(401)
  })

  it('validates identifiers before querying authentication records', async () => {
    await request(app).post('/auth/login').send({ identifier: 'x",email.eq.admin@example.test', password: 'anything' }).expect(400)
    await request(app).post('/auth/register').send({ username: 'x",or(id.gt.0)', email: 'not-an-email', password: 'long-enough-password' }).expect(400)
  })

  it('validates a requested product flavour against the database flavours', async () => {
    await checkout({ items: [{ productId: 12, size: '1 kg', quantity: 1, flavour: 'Pistachio' }] }).expect(400)
    expect(db.state.orders).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()

    fetch.mockResolvedValue({ status: 200, json: async () => rulelockResponse('accept') })
    await checkout({ items: [{ productId: 12, size: '1 kg', quantity: 1, flavour: 'Chocolate' }] }).expect(201)
    expect(db.state.orders[0].items[0].flavour).toBe('Chocolate')
  })

  it('returns image URLs instead of base64 on product lists and serves cached image bytes', async () => {
    const listing = await request(app).get('/products').expect(200)
    expect(listing.body.data[0].image).toBe('/api/products/cake/image')
    expect(JSON.stringify(listing.body)).not.toContain('aGVsbG8=')
    const image = await request(app).get('/products/cake/image').expect(200)
    expect(image.headers['content-type']).toMatch(/^image\/png/)
    expect(image.headers['cache-control']).toContain('max-age=3600')
    expect(image.body.toString()).toBe('hello')
  })

  it('paginates dashboard orders, customers, and events with totals', async () => {
    db.state.orders.push(...Array.from({ length: 25 }, (_, index) => ({ id: index + 1, user_id: 7, status: 'PENDING', total: 100, created_at: new Date().toISOString() })))
    db.state.events.push(...Array.from({ length: 25 }, (_, index) => ({ id: index + 1, event_id: `event-${index}`, event_type: 'LOGIN', created_at: new Date().toISOString() })))
    const authorization = `Bearer ${jwt.sign({ sub: '1', role: 'admin' }, 'unit-test-jwt-secret')}`
    const response = await request(app).get('/admin/dashboard?ordersPage=2&customersPage=1&eventsPage=2').set('Authorization', authorization).expect(200)
    expect(response.body.data.allOrders).toHaveLength(5)
    expect(response.body.data.events).toHaveLength(5)
    expect(response.body.data.products[0].image).toBe('/api/products/cake/image')
    expect(response.body.data.pagination.orders).toMatchObject({ page: 2, pageSize: 20, total: 25, pages: 2 })
    expect(response.body.data.pagination.events).toMatchObject({ page: 2, total: 25, pages: 2 })
    expect(db.state.ranges).toEqual(expect.arrayContaining([{ table: 'orders', from: 20, to: 39 }, { table: 'users', from: 0, to: 19 }, { table: 'transaction_events', from: 20, to: 39 }]))
  })
})


