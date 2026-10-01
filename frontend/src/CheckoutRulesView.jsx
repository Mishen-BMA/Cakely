import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, CreditCard, MapPin, Tag } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, rotateSessionId, unwrap } from './services/api'

const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK')}`

function DemoCardFields({ card, setCard }) {
  const change = (field, value) => setCard({ ...card, [field]: value })
  return (
    <section className="demo-payment" aria-label="Demo payment gateway">
      <div className="demo-payment-head"><span className="demo-card-icon"><CreditCard size={19} /></span><div><strong>Secure demo payment</strong><small>No real payment is taken or stored.</small></div></div>
      <label>Cardholder name<input required value={card.name} onChange={(event) => change('name', event.target.value)} placeholder="Any name" /></label>
      <label>Card number<input required value={card.number} onChange={(event) => change('number', event.target.value)} placeholder="Any number" inputMode="numeric" /></label>
      <div className="demo-payment-row"><label>Expiry<input required value={card.expiry} onChange={(event) => change('expiry', event.target.value)} placeholder="MM / YY" /></label><label>CVV<input required value={card.cvv} onChange={(event) => change('cvv', event.target.value)} placeholder="Any 3 digits" inputMode="numeric" /></label></div>
      <p>This is for demonstration only. You can use placeholder details to complete the order.</p>
    </section>
  )
}

export default function CheckoutRulesView({ cart, setCart }) {
  const navigate = useNavigate()
  const location = useLocation()
  const checkoutCart = location.state?.buyNow && location.state.item ? [location.state.item] : cart
  const [coupons, setCoupons] = useState([])
  const [addresses, setAddresses] = useState([])
  const [selected, setSelected] = useState([])
  const [form, setForm] = useState({ name: '', phone: '', address: '', city: 'Colombo', district: 'Colombo', postalCode: '', paymentMethod: 'COD', fulfillmentMethod: 'DELIVERY' })
  const [card, setCard] = useState({ name: '', number: '', expiry: '', cvv: '' })
  const [error, setError] = useState('')
  const isPickup = form.fulfillmentMethod === 'PICKUP'
  const subtotal = useMemo(() => checkoutCart.reduce((sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 1), 0), [checkoutCart])
  const selectedCoupons = coupons.filter((coupon) => selected.includes(coupon.code))
  const estimatedDiscount = selectedCoupons.reduce((sum, coupon) => {
    if (coupon.discountType === 'PERCENTAGE') return sum + (subtotal * Number(coupon.discountValue || 0)) / 100
    if (coupon.discountType === 'FIXED') return sum + Number(coupon.discountValue || 0)
    return sum
  }, 0)
  const freeDelivery = selectedCoupons.some((coupon) => coupon.freeDelivery)
  const deliveryFee = isPickup || freeDelivery ? 0 : 350
  const codFee = form.paymentMethod === 'COD' && !isPickup ? 150 : 0
  const total = Math.max(0, subtotal - estimatedDiscount + deliveryFee + codFee)

  useEffect(() => {
    api.get('/rulelock/warm').catch(() => {})
    Promise.all([unwrap(api.get('/auth/me')), unwrap(api.get('/coupons')), unwrap(api.get('/addresses'))])
      .then(([, couponData, addressData]) => {
        setCoupons(Array.isArray(couponData.data) ? couponData.data : [])
        const saved = Array.isArray(addressData.data) ? addressData.data : []
        setAddresses(saved)
        if (saved[0]) setForm((current) => ({ ...current, ...saved[0], postalCode: saved[0].postal_code || '' }))
      })
      .catch(() => navigate('/login'))
  }, [navigate])

  useEffect(() => {
    setSelected((current) => current.filter((code) => {
      const allowedMethods = coupons.find((coupon) => coupon.code === code)?.allowedPaymentMethods || []
      return !allowedMethods.length || allowedMethods.includes(form.paymentMethod)
    }))
  }, [form.paymentMethod, coupons])

  const isPercentage = (coupon) => coupon.discountType === 'PERCENTAGE'
  const isDisabled = (coupon) => {
    const allowedMethods = coupon.allowedPaymentMethods || []
    if (allowedMethods.length && !allowedMethods.includes(form.paymentMethod)) return true
    return !selected.includes(coupon.code) && isPercentage(coupon) && selectedCoupons.some((item) => isPercentage(item))
  }
  const disabledReason = (coupon) => {
    const allowedMethods = coupon.allowedPaymentMethods || []
    if (allowedMethods.length && !allowedMethods.includes(form.paymentMethod)) return `${allowedMethods.join(' or ')} only`
    if (isPercentage(coupon) && selectedCoupons.some((item) => isPercentage(item))) return 'Only one percentage coupon'
    return ''
  }
  const toggleCoupon = (coupon) => {
    if (isDisabled(coupon)) return
    setSelected((current) => current.includes(coupon.code) ? current.filter((item) => item !== coupon.code) : [...current, coupon.code])
  }
  const useSavedAddress = (value) => {
    const saved = addresses.find((address) => String(address.id) === value)
    setForm(saved ? { ...form, ...saved, savedAddressId: value, postalCode: saved.postal_code || '' } : { ...form, savedAddressId: '' })
  }
  const submit = async (event) => {
    event.preventDefault()
    setError('')
    try {
      const address = isPickup ? { name: form.name, phone: form.phone, fulfillmentMethod: 'PICKUP' } : { ...form, fulfillmentMethod: 'DELIVERY' }
      const result = await unwrap(api.post('/checkout', { items: checkoutCart, address, fulfillmentMethod: form.fulfillmentMethod, paymentMethod: form.paymentMethod, coupons: selected, discount: estimatedDiscount }))
      setCart([])
      rotateSessionId()
      navigate('/account', { state: { order: result.data } })
    } catch (err) {
      setError(err.response?.data?.customer_message || err.response?.data?.error?.message || 'Unable to place your order.')
    }
  }

  return <main className="checkout"><div><p className="eyebrow">Almost yours</p><h1>Complete<br /><em>your order.</em></h1><p className="muted">Fresh cakes, made to order in Colombo.</p><div className="checkout-summary"><span>Subtotal</span><strong>{money(subtotal)}</strong><span>Estimated discount</span><strong>- {money(estimatedDiscount)}</strong><span>{isPickup ? 'Collection' : 'Delivery'}</span><strong>{isPickup || freeDelivery ? 'Free' : money(deliveryFee)}</strong><span>COD fee</span><strong>{codFee ? money(codFee) : 'None'}</strong><span className="checkout-total-label">Total</span><strong className="checkout-total-value">{money(total)}</strong></div></div><form className="checkout-form" onSubmit={submit}><h2>Order details</h2><fieldset><legend>How would you like your cake?</legend><label><input type="radio" checked={!isPickup} onChange={() => setForm({ ...form, fulfillmentMethod: 'DELIVERY' })} /> Delivery across Colombo</label><label><input type="radio" checked={isPickup} onChange={() => setForm({ ...form, fulfillmentMethod: 'PICKUP' })} /> Self pickup <small>Free collection</small></label></fieldset><label>Your name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Phone<input required value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>{isPickup ? <section className="pickup-note"><MapPin size={19}/><div><strong>Pick up from Cakely, Colombo</strong><small>We’ll confirm the collection time after your order is placed.</small></div></section> : <><h3 className="checkout-subhead">Delivery address</h3>{addresses.length > 0 && <label>Saved address<select value={form.savedAddressId || ''} onChange={(event) => useSavedAddress(event.target.value)}><option value="">Enter a new address</option>{addresses.map((address) => <option value={address.id} key={address.id}>{address.label} · {address.address}</option>)}</select></label>}{['address', 'city', 'district', 'postalCode'].map((field) => <label key={field}>{field === 'postalCode' ? 'Postal code' : field[0].toUpperCase() + field.slice(1)}<input required value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} /></label>)}</>}<section className="coupon-box"><div className="coupon-heading"><div><p className="eyebrow">Make it sweeter</p><h3>Available coupons</h3></div><Tag size={20} /></div><p className="coupon-rule-note">One percentage coupon at a time. Payment-specific coupons are disabled automatically.</p>{coupons.length ? coupons.map((coupon) => { const disabled = isDisabled(coupon); const reason = disabledReason(coupon); return <button type="button" disabled={disabled} className={`${selected.includes(coupon.code) ? 'coupon-option selected' : 'coupon-option'}${disabled ? ' disabled' : ''}`} key={coupon.code} onClick={() => toggleCoupon(coupon)}><span><strong>{coupon.code}</strong><small>{coupon.description}{reason ? ` · ${reason}` : ''}</small></span>{selected.includes(coupon.code) ? <Check size={17} /> : <span>{coupon.discountType === 'PERCENTAGE' ? `${coupon.discountValue}%` : coupon.freeDelivery ? 'FREE' : money(coupon.discountValue)}</span>}</button> }) : <p className="muted">No coupons are available right now.</p>}</section><fieldset><legend>Payment method</legend><label><input type="radio" checked={form.paymentMethod === 'COD'} onChange={() => setForm({ ...form, paymentMethod: 'COD' })} /> Cash on delivery {!isPickup && <small>+ Rs. 150</small>}</label><label><input type="radio" checked={form.paymentMethod === 'CARD'} onChange={() => setForm({ ...form, paymentMethod: 'CARD' })} /> Card payment</label></fieldset>{form.paymentMethod === 'CARD' && <DemoCardFields card={card} setCard={setCard} />}{error && <p className="error">{error}</p>}<button className="button primary wide">{form.paymentMethod === 'CARD' ? 'Pay and place order' : 'Place order'} <ArrowRight size={17} /></button></form></main>
}
