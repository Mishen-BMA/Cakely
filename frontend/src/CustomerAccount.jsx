import { useEffect, useState } from 'react'
import { ArrowLeft, CircleUserRound, Home, LogOut, Package, ShieldCheck, Trash2 } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { api, rotateSessionId, unwrap } from './services/api'

const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK')}`
const blankAddress = { label: 'Home', recipient: '', phone: '', address: '', city: 'Colombo', district: 'Colombo', postalCode: '', isDefault: false }

export default function CustomerAccount() {
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [orders, setOrders] = useState([])
  const [addresses, setAddresses] = useState([])
  const [addressForm, setAddressForm] = useState(blankAddress)
  const [addressError, setAddressError] = useState('')
  const load = () => Promise.all([unwrap(api.get('/auth/me')), unwrap(api.get('/orders')), unwrap(api.get('/addresses'))])
    .then(([identity, orderData, addressData]) => {
      setProfile(identity.data)
      setOrders(Array.isArray(orderData.data) ? orderData.data : [])
      setAddresses(Array.isArray(addressData.data) ? addressData.data : [])
    })
    .catch(() => { localStorage.removeItem('cakely_token'); rotateSessionId(); navigate('/login') })

  useEffect(() => {
    load()
    const timer = window.setInterval(() => { unwrap(api.get('/orders')).then((result) => setOrders(Array.isArray(result.data) ? result.data : [])).catch(() => {}) }, 10000)
    return () => window.clearInterval(timer)
  }, [navigate])

  const saveAddress = async (event) => {
    event.preventDefault()
    setAddressError('')
    try { await unwrap(api.post('/addresses', addressForm)); setAddressForm(blankAddress); await load() } catch (err) { setAddressError(err.response?.data?.error?.message || 'Unable to save address.') }
  }
  const removeAddress = async (id) => { await unwrap(api.delete(`/addresses/${id}`)); setAddresses((current) => current.filter((address) => address.id !== id)) }
  const logout = () => { localStorage.removeItem('cakely_token'); rotateSessionId(); navigate('/login') }

  if (!profile) return <main className="page narrow"><div className="empty"><p>Loading your account...</p></div></main>

  return <main className="page customer-account">
    <div className="account-hero">
      <div><p className="eyebrow accent">Your Cakely</p><h1>Hello, <em>{profile.username}.</em></h1><p className="muted">Your cakes, orders, and account details in one place.</p></div>
      <button className="account-logout" type="button" onClick={logout}><LogOut size={16} /> Log out</button>
    </div>
    <div className="account-grid">
      <section className="account-profile"><CircleUserRound size={30}/><p className="eyebrow">Profile</p><h2>{profile.username}</h2><p>{profile.email}</p><span><ShieldCheck size={14}/> Customer account</span></section>
      <section className="account-orders">
        <div className="account-section-head"><div><p className="eyebrow">Your history</p><h2>Orders</h2></div><Package size={22}/></div>
        {orders.some((order) => order.status === 'PENDING_REVIEW') && <div className="account-review-banner" role="status"><ShieldCheck size={18}/><span>One or more of your orders is under review. We’ll update you as soon as the review is complete.</span></div>}
        {orders.length ? orders.map((order) => <div className="customer-order" key={order.id}><div><strong>{order.orderNumber}</strong><small>{new Date(order.createdAt).toLocaleDateString('en-LK')} · {order.paymentMethod} · {order.fulfillmentMethod === 'PICKUP' ? 'Self pickup' : 'Delivery'}</small></div><span className={`status ${order.status.toLowerCase()}`}>{order.status}</span><strong>{money(order.total)}</strong></div>) : <div className="account-empty">No orders yet. <Link to="/cakes">Browse the bakehouse</Link></div>}
        <Link to="/cakes" className="account-browse"><ArrowLeft size={15}/> Continue shopping</Link>
      </section>
    </div>
    <section className="account-addresses">
      <div className="account-section-head"><div><p className="eyebrow">Saved for later</p><h2>Delivery addresses</h2></div><Home size={22}/></div>
      <div className="saved-addresses">{addresses.map((address) => <article className="saved-address" key={address.id}><strong>{address.label}{address.is_default ? ' · Default' : ''}</strong><span>{address.recipient} · {address.phone}</span><span>{address.address}, {address.city}, {address.district} {address.postal_code || ''}</span><button onClick={() => removeAddress(address.id)} aria-label={`Delete ${address.label}`}><Trash2 size={15}/></button></article>)}</div>
      <form className="address-form" onSubmit={saveAddress}><h3>Add an address</h3><div className="address-fields">{[['label', 'Label'], ['recipient', 'Recipient'], ['phone', 'Phone'], ['address', 'Address'], ['city', 'City'], ['district', 'District'], ['postalCode', 'Postal code']].map(([key, label]) => <label key={key}>{label}<input required={key !== 'postalCode'} value={addressForm[key]} onChange={(event) => setAddressForm({ ...addressForm, [key]: event.target.value })}/></label>)}</div><label className="checkbox-line"><input type="checkbox" checked={addressForm.isDefault} onChange={(event) => setAddressForm({ ...addressForm, isDefault: event.target.checked })}/> Make default</label>{addressError && <p className="error">{addressError}</p>}<button className="button primary">Save address</button></form>
    </section>
  </main>
}
