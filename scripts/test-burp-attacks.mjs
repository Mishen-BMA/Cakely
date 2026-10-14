// Automated Attack Simulation & Verification Script
// Simulates Burp Suite / proxy request manipulation against Cakely + RuleLock AI
// Usage: node scripts/test-burp-attacks.mjs

const CAKELY_URL = (process.env.CAKELY_URL || 'https://cakely-sg55.onrender.com').replace(/\/+$/, '')
const API_URL = `${CAKELY_URL.replace(/\/api$/i, '')}/api`
const USERNAME = process.env.TEST_USER || 'kaveesha'
const PASSWORD = process.env.TEST_PASSWORD || 'Missing1002@#'

console.log(`=================================================================`)
console.log(`  RuleLock AI + Cakely - Business Logic Abuse Attack Simulation  `)
console.log(`  Target: ${API_URL}`)
console.log(`  User:   ${USERNAME}`)
console.log(`=================================================================\n`)

async function request(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Session-ID': `sess-burp-${Date.now()}`,
      'X-Device-ID': 'device-burp-test-suite'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, body: json }
}

async function run() {
  // 1. Authenticate
  console.log(`[Step 1] Authenticating customer account (${USERNAME})...`)
  const loginRes = await request('/auth/login', {
    method: 'POST',
    body: { identifier: USERNAME, password: PASSWORD }
  })
  if (!loginRes.ok || !loginRes.body.data?.token) {
    throw new Error(`Login failed (${loginRes.status}): ${JSON.stringify(loginRes.body)}`)
  }
  const token = loginRes.body.data.token
  console.log(`  Authentication successful! Token acquired.\n`)

  // 2. Fetch Catalog
  const productsRes = await request('/products', { token })
  const products = productsRes.body.data || []
  if (!products.length) throw new Error('No products found in catalog.')
  const targetProduct = products[0]
  console.log(`[Catalog] Selected "${targetProduct.name}" (Base Price: Rs. ${targetProduct.basePrice})\n`)

  const baseAddress = {
    name: 'Kaveesha Test',
    phone: '+94771234567',
    address: '42 Lotus Road',
    city: 'Colombo',
    district: 'Colombo',
    fulfillmentMethod: 'DELIVERY'
  }

  // =========================================================================
  // ATTACK 1: Quantity Manipulation (Line Ceiling Bypass)
  // =========================================================================
  console.log(`-----------------------------------------------------------------`)
  console.log(`[ATTACK 1] Quantity Manipulation (Burp Suite Intercept)`)
  console.log(`Attempting to order quantity=50 (Exceeding max ceiling limit of 20)...`)
  
  const qtyAttackRes = await request('/checkout', {
    token,
    method: 'POST',
    body: {
      items: [{ productId: targetProduct.id, size: '1 kg', flavour: 'Vanilla', quantity: 50 }],
      address: baseAddress,
      fulfillmentMethod: 'DELIVERY',
      paymentMethod: 'CARD',
      coupons: [],
      discount: 0
    }
  })

  console.log(`HTTP Status: ${qtyAttackRes.status}`)
  const qtyData = qtyAttackRes.body.data || {}
  const qtyReview = qtyData.review || {}
  console.log(`Order Status:   ${qtyData.status || 'N/A'}`)
  console.log(`RuleLock Dec:   ${qtyData.decision || qtyReview.decision || 'N/A'}`)
  console.log(`Reason:         ${qtyReview.reason || qtyAttackRes.body.error?.message || 'N/A'}`)
  if (qtyReview.pipeline?.c2_rule_engine) {
    console.log(`Rule Engine:    ${qtyReview.pipeline.c2_rule_engine.status.toUpperCase()} (Violations: ${JSON.stringify(qtyReview.pipeline.c2_rule_engine.violations)})`)
  }
  console.log(`Customer Msg:   "${qtyData.customerMessage || 'N/A'}"`)
  console.log(`Result: ${qtyData.status === 'REJECTED' || qtyData.decision === 'reject' ? 'DEFENSE SUCCESS (Manipulated quantity blocked)' : 'Review completed'}\n`)

  // =========================================================================
  // ATTACK 2: Coupon Stacking (Multi-Coupon Injection)
  // =========================================================================
  console.log(`-----------------------------------------------------------------`)
  console.log(`[ATTACK 2] Coupon Stacking (Multi-Coupon Injection)`)
  console.log(`Attempting to apply stacked coupons ['CAKE10', 'CAKE20'] with manipulated discount...`)

  const stackAttackRes = await request('/checkout', {
    token,
    method: 'POST',
    body: {
      items: [{ productId: targetProduct.id, size: '1 kg', flavour: 'Vanilla', quantity: 1 }],
      address: baseAddress,
      fulfillmentMethod: 'DELIVERY',
      paymentMethod: 'CARD',
      coupons: ['CAKE10', 'CAKE20'],
      discount: 540
    }
  })

  console.log(`HTTP Status: ${stackAttackRes.status}`)
  const stackData = stackAttackRes.body.data || {}
  const stackReview = stackData.review || {}
  console.log(`Order Status:   ${stackData.status || 'N/A'}`)
  console.log(`RuleLock Dec:   ${stackData.decision || stackReview.decision || 'N/A'}`)
  console.log(`Reason:         ${stackReview.reason || 'N/A'}`)
  if (stackReview.pipeline?.c2_rule_engine) {
    console.log(`Rule Engine:    ${stackReview.pipeline.c2_rule_engine.status.toUpperCase()} (Violations: ${JSON.stringify(stackReview.pipeline.c2_rule_engine.violations)})`)
  }
  console.log(`Total Charged:  Rs. ${stackData.total}`)
  console.log(`Result: ${stackData.decision === 'void_discount' || stackReview.decision === 'void_discount' ? 'DEFENSE SUCCESS (Stacked discount voided)' : 'Discount handled'}\n`)

  // =========================================================================
  // ATTACK 3: COD Abuse & Repeated Cancellations (Account Rate Limiting / Ban)
  // =========================================================================
  console.log(`-----------------------------------------------------------------`)
  console.log(`[ATTACK 3] COD Abuse & Automated Account Ban`)
  console.log(`Simulating abusive pattern: Rapid COD orders followed by immediate cancellation...\n`)

  for (let cycle = 1; cycle <= 3; cycle++) {
    console.log(`  -> Cycle ${cycle}: Placing COD order...`)
    const codRes = await request('/checkout', {
      token,
      method: 'POST',
      body: {
        items: [{ productId: targetProduct.id, size: '1 kg', flavour: 'Vanilla', quantity: 1 }],
        address: { ...baseAddress, fulfillmentMethod: 'PICKUP' },
        fulfillmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        coupons: [],
        discount: 0
      }
    })

    if (codRes.status === 429) {
      console.log(`  -> Account has been BANNED / Rate-limited! HTTP 429 received: ${codRes.body.error?.message}`)
      break
    }

    const order = codRes.body.data || {}
    console.log(`     Placed Order #${order.id} (${order.orderNumber}), Status: ${order.status}, Decision: ${order.decision}`)

    if (['PENDING', 'PENDING_REVIEW'].includes(order.status)) {
      console.log(`     Customer cancels Order #${order.id}...`)
      const cancelRes = await request(`/orders/${order.id}/cancel`, { token, method: 'POST' })
      console.log(`     Order #${order.id} cancelled: ${cancelRes.ok ? 'SUCCESS' : 'FAILED'}`)
    }
  }

  console.log(`\n  -> Testing subsequent checkout after repeated COD cancellations...`)
  const finalCheckRes = await request('/checkout', {
    token,
    method: 'POST',
    body: {
      items: [{ productId: targetProduct.id, size: '1 kg', flavour: 'Vanilla', quantity: 1 }],
      address: { ...baseAddress, fulfillmentMethod: 'PICKUP' },
      fulfillmentMethod: 'PICKUP',
      paymentMethod: 'COD',
      coupons: [],
      discount: 0
    }
  })

  console.log(`HTTP Status: ${finalCheckRes.status}`)
  if (finalCheckRes.status === 429) {
    console.log(`DEFENSE SUCCESS: Account has been temporarily BANNED due to COD abuse: "${finalCheckRes.body.error?.message}"`)
  } else {
    const fData = finalCheckRes.body.data || {}
    console.log(`Order Status: ${fData.status}, Decision: ${fData.decision}, Reason: ${fData.review?.reason}`)
  }

  console.log(`\n=================================================================`)
  console.log(`  Attack Simulation Complete!`)
  console.log(`=================================================================`)
}

run().catch((err) => {
  console.error('Test execution error:', err.message)
})
