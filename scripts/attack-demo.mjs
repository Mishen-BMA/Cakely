const origin = (process.env.CAKELY_URL || 'http://localhost:8888').replace(/\/+$/, '')
const api = `${origin.replace(/\/api$/i, '')}/api`
const username = process.env.DEMO_USER
const password = process.env.DEMO_PASSWORD

if (!username || !password) throw new Error('Set DEMO_USER and DEMO_PASSWORD.')

async function call(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${payload.error?.message || payload.customerMessage || payload.customer_message || 'request failed'}`)
  return payload.data || payload
}

function summary(label, response) {
  const review = response.review || response.rulelockReview || {}
  const pipeline = review.pipeline || {}
  console.log(`\n${label}: decision=${response.decision || review.decision || 'unknown'}, status=${response.status || 'unknown'}`)
  console.log(`  C2 ${pipeline.c2_rule_engine?.status || 'n/a'} · C3 ${pipeline.c3_anomaly?.status || 'n/a'} score=${pipeline.c3_anomaly?.score ?? 'n/a'} · C4 ${pipeline.c4_enforcement?.decision || 'n/a'}`)
  if (review.reason) console.log(`  Cause: ${review.reason}`)
}

const session = await call('/auth/login', { method: 'POST', body: { identifier: username, password } })
const token = session.token
if (!token) throw new Error('Login succeeded but the API did not return a token.')
const [products, couponResponse] = await Promise.all([call('/products', { token }), call('/coupons', { token })])
const product = products[0]
if (!product) throw new Error('No active product is available for the attack demo.')
const item = { productId: product.id, size: Object.keys(product.sizes || {})[0] || '1 kg', flavour: product.flavours?.[0] || 'Vanilla', quantity: 1 }
const percentages = couponResponse.filter((coupon) => coupon.discountType === 'PERCENTAGE').slice(0, 2)
if (percentages.length < 2) throw new Error('The demo needs at least two active percentage coupons.')
const address = { name: username, phone: '+94770000000', address: '1 Demo Street', city: 'Colombo', district: 'Colombo' }
const checkout = (extra = {}) => call('/checkout', { token, method: 'POST', body: { items: [item], address, fulfillmentMethod: 'DELIVERY', paymentMethod: 'CARD', coupons: [], ...extra } })

const stacked = await checkout({ coupons: percentages.map((coupon) => coupon.code) })
summary('Attack A · stacked percentage coupons', stacked)

const quantity = await checkout({ items: [{ ...item, quantity: 50 }] })
summary('Attack B · quantity 50', quantity)

for (let index = 1; index <= 3; index += 1) {
  const codOrder = await checkout({ paymentMethod: 'COD', coupons: [] })
  summary(`Attack C${index} · COD order`, codOrder)
  if (['PENDING', 'PENDING_REVIEW'].includes(codOrder.status)) {
    await call(`/orders/${codOrder.id}/cancel`, { token, method: 'POST', body: {} })
    console.log(`  Cancelled order ${codOrder.orderNumber} as the customer.`)
  } else {
    console.log(`  Order ${codOrder.orderNumber} was not customer cancellable; continuing demo.`)
  }
}
const fourthCod = await checkout({ paymentMethod: 'COD', coupons: [] })
summary('Attack C4 · fourth COD order after three customer cancellations', fourthCod)
