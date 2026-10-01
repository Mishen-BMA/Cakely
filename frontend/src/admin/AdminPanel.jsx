import { Fragment, useEffect, useState } from 'react'
import { Boxes, BrainCircuit, ChevronRight, ClipboardList, LayoutDashboard, LogOut, Menu, PackagePlus, Pencil, Plus, Search, ShieldCheck, Sparkles, Tag, Trash2, Users, X } from 'lucide-react'
import { api, rotateSessionId, unwrap } from '../services/api'
import { useNavigate } from 'react-router-dom'

const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK')}`
const tabs = [
  ['dashboard', 'Dashboard', LayoutDashboard],
  ['products', 'Products', Boxes],
  ['orders', 'Orders', ClipboardList],
  ['customers', 'Customers', Users],
  ['coupons', 'Coupons', Tag],
  ['events', 'Events', ShieldCheck],
  ['rulelock', 'RuleLock AI', BrainCircuit],
]

function Stat({ label, value, tone = '' }) {
  return <div className={`admin-stat ${tone}`}><span>{label}</span><strong>{value}</strong></div>
}

function Empty({ text }) {
  return <div className="admin-empty">{text}</div>
}

function Table({ children }) {
  return <div className="admin-table-wrap"><table className="admin-table"><tbody>{children}</tbody></table></div>
}

function Header({ title, onMenu }) {
  return (
    <div className="admin-header">
      <button className="admin-mobile-menu" onClick={onMenu} aria-label="Open admin navigation"><Menu size={20} /></button>
      <div>
        <p className="admin-kicker">Cakely operations</p>
        <h1>{title}</h1>
      </div>
      <div className="admin-user">
        <span className="admin-avatar">A</span>
        <span>Administrator</span>
      </div>
    </div>
  )
}

function Dashboard({ data, onNavigate }) {
  const stats = data || {}
  return (
    <>
      <Header title="Dashboard" />
      <div className="admin-stats">
        <Stat label="Total orders" value={stats.orders ?? 0} />
        <Stat label="Pending" value={stats.pending ?? 0} tone="warm" />
        <Stat label="Preparing" value={stats.preparing ?? 0} />
        <Stat label="Completed" value={stats.completed ?? 0} tone="green" />
        <Stat label="Customers" value={stats.customerCount ?? stats.customers?.length ?? 0} />
        <Stat label="Products" value={stats.productCount ?? stats.products?.length ?? 0} />
        <Stat label="Active coupons" value={stats.couponCount ?? stats.coupons?.length ?? 0} />
        <Stat label="Total sales" value={money(stats.revenue)} tone="accent" />
      </div>
      <div className="admin-columns">
        <section className="admin-card">
          <div className="admin-card-head">
            <div>
              <p className="admin-kicker">Latest activity</p>
              <h2>Recent orders</h2>
            </div>
            <button className="admin-link" onClick={() => onNavigate('orders')}>View all <ChevronRight size={15} /></button>
          </div>
          {stats.recentOrders?.length ? (
            <Table>
              {stats.recentOrders.map((order) => (
                <tr key={order.id}>
                  <td><strong>{order.orderNumber}</strong><small>{order.customer || 'Guest'}</small></td>
                  <td><span className={`admin-badge ${String(order.status).toLowerCase()}`}>{order.status}</span></td>
                  <td className="align-right">{money(order.total)}</td>
                </tr>
              ))}
            </Table>
          ) : <Empty text="No orders have been placed yet." />}
        </section>
        <section className="admin-card">
          <div className="admin-card-head">
            <div>
              <p className="admin-kicker">Business trail</p>
              <h2>Recent events</h2>
            </div>
            <button className="admin-link" onClick={() => onNavigate('events')}>Open log <ChevronRight size={15} /></button>
          </div>
          {stats.events?.length ? (
            <Table>
              {stats.events.map((event) => (
                <tr key={event.id}>
                  <td><strong>{event.eventType}</strong><small>{event.eventId}</small></td>
                  <td className="align-right"><small>{new Date(event.createdAt).toLocaleString('en-LK')}</small></td>
                </tr>
              ))}
            </Table>
          ) : <Empty text="Events will appear as the store is used." />}
        </section>
      </div>
    </>
  )
}

const emptyProduct = { name: '', slug: '', description: '', category: 'Classic cakes', basePrice: '', flavours: 'Vanilla, Chocolate', sizes: '{"1 kg": 0}', active: true }
const emptyCoupon = { code: '', description: '', discountType: 'PERCENTAGE', discountValue: '', minimumOrder: 0, usageLimit: '', perUserLimit: '', expiresAt: '', active: true }

function ProductForm({ product, onClose, onSaved }) {
  const [form, setForm] = useState(product ? { ...product, flavours: (product.flavours || []).join(', '), sizes: JSON.stringify(product.sizes || {}) } : emptyProduct)
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(product?.image || '')
  const [error, setError] = useState('')
  const save = async (event) => {
    event.preventDefault(); setError('')
    try {
      if (!product && !file) throw new Error('Choose a product image before saving.')
      const { image: _image, ...editableFields } = form
      const payload = { ...editableFields, basePrice: Number(form.basePrice), flavours: form.flavours.split(',').map((item) => item.trim()).filter(Boolean), sizes: JSON.parse(form.sizes) }
      const result = product ? await unwrap(api.put(`/admin/products/${product.id}`, payload)) : await unwrap(api.post('/admin/products', payload))
      if (file) { const body = new FormData(); body.append('image', file); await unwrap(api.post(`/admin/products/${result.data.id}/image`, body)) }
      onSaved(); onClose()
    } catch (err) { setError(err.response?.data?.error?.message || err.message || 'Unable to save product.') }
  }
  return <div className="admin-modal"><form className="admin-editor" onSubmit={save}><div className="admin-card-head"><h2>{product ? 'Edit product' : 'New product'}</h2><button type="button" className="admin-icon-button" onClick={onClose}><X size={18}/></button></div>{[['name','Name'],['slug','Slug'],['category','Category'],['basePrice','Base price']].map(([key,label]) => <label key={key}>{label}<input required={key !== 'basePrice'} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/></label>)}<label>Description<textarea required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}/></label><label>Flavours<input value={form.flavours} onChange={(e) => setForm({ ...form, flavours: e.target.value })}/></label><label>Sizes JSON<textarea required value={form.sizes} onChange={(e) => setForm({ ...form, sizes: e.target.value })}/></label><label>Product image<input type="file" required={!product} accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => { const selected = e.target.files[0]; setFile(selected); if (selected) setPreview(URL.createObjectURL(selected)) }}/></label>{preview && <img className="admin-image-preview" src={preview} alt="Product preview"/>}{!preview && <p className="muted">No image uploaded yet.</p>}{error && <p className="error">{error}</p>}<button className="button primary">Save product <PackagePlus size={16}/></button></form></div>
}

function Products({ products, reload }) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const remove = async (product) => { if (!window.confirm(`Delete ${product.name}?`)) return; await unwrap(api.delete(`/admin/products/${product.id}`)); reload() }
  const visible = (products || []).filter((product) => product.name.toLowerCase().includes(query.toLowerCase()) || product.category.toLowerCase().includes(query.toLowerCase()))
  return (
    <>
      <Header title="Products" />
      <div className="admin-toolbar">
        <label className="admin-search"><Search size={17} /><input placeholder="Search products" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <button className="button primary" onClick={() => setCreating(true)}><Plus size={16}/> New product</button>
      </div>
      <div className="admin-card">
        <Table>
          {visible.map((product) => (
            <tr key={product.id}>
              <td><img className="admin-product-thumb" src={product.image} alt=""/><strong>{product.name}</strong><small>{product.slug}</small></td>
              <td>{product.category}</td>
              <td>{money(product.basePrice)}</td>
              <td className="align-right"><button className="admin-table-action" onClick={() => setEditing(product)}><Pencil size={14}/> Edit</button><button className="admin-table-action danger" onClick={() => remove(product)}><Trash2 size={14}/> Delete</button></td>
            </tr>
          ))}
        </Table>
        {!visible.length && <Empty text="No products match this search." />}
      </div>
      {(creating || editing) && <ProductForm product={editing} onClose={() => { setCreating(false); setEditing(null) }} onSaved={reload} />}
    </>
  )
}

function Orders({ orders, reload }) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const visible = (orders || []).filter((order) => `${order.orderNumber} ${order.customer || ''} ${order.status}`.toLowerCase().includes(query.toLowerCase()))

  const act = async (order, body, description) => {
    if (!window.confirm(`${description} for order ${order.orderNumber}?`)) return
    setBusyId(order.id)
    setError('')
    try {
      await unwrap(api.patch(`/admin/orders/${order.id}`, body))
      await reload()
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Unable to cancel this order.')
    } finally {
      setBusyId(null)
    }
  }
  return (
    <>
      <Header title="Orders" />
      <div className="admin-toolbar">
        <label className="admin-search"><Search size={17} /><input placeholder="Search order number or customer" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      {error && <div className="admin-error" role="alert">{error}</div>}
      <div className="admin-card">
        <Table>
          {visible.map((order) => (
            <Fragment key={order.id}>
              <tr key={order.id}>
                <td><strong>{order.orderNumber}</strong><small>{order.customer || 'Guest customer'}</small></td>
                <td><span className={`admin-badge ${String(order.paymentMethod).toLowerCase()}`}>{order.paymentMethod}</span></td>
                <td>{money(order.total)}</td>
                <td><span className={`admin-badge ${String(order.status).toLowerCase()}`}>{order.status}</span></td>
                <td><button type="button" className="admin-table-action" aria-expanded={Boolean(expanded[order.id])} onClick={() => setExpanded((current) => ({ ...current, [order.id]: !current[order.id] }))}>{expanded[order.id] ? 'Hide details' : 'View details'}</button></td>
                <td className="align-right">
                  {order.status === 'PENDING_REVIEW' && <><button type="button" className="admin-table-action" disabled={busyId === order.id} onClick={() => act(order, { action: 'release' }, 'Release')}>Release</button><button type="button" className="admin-table-action danger" disabled={busyId === order.id} onClick={() => act(order, { action: 'reject' }, 'Reject')}>Reject</button></>}
                  {order.status === 'PENDING' && <button type="button" className="admin-table-action" disabled={busyId === order.id} onClick={() => act(order, { status: 'PREPARING' }, 'Start preparing')}>Prepare</button>}
                  {order.status === 'PREPARING' && <button type="button" className="admin-table-action" disabled={busyId === order.id} onClick={() => act(order, { status: 'COMPLETED' }, 'Complete')}>Complete</button>}
                  {order.paymentMethod === 'COD' && !['CANCELLED', 'REJECTED', 'REFUSED'].includes(order.status) && <button type="button" className="admin-table-action danger" disabled={busyId === order.id} onClick={() => act(order, { status: 'REFUSED' }, 'Mark refused at door')}>Refused</button>}
                  {!['CANCELLED', 'REJECTED', 'REFUSED', 'COMPLETED'].includes(order.status) && <button type="button" className="admin-table-action danger" disabled={busyId === order.id} onClick={() => act(order, { status: 'CANCELLED' }, 'Cancel')}>Cancel</button>}
                  <small>{new Date(order.createdAt).toLocaleDateString('en-LK')}</small>
                </td>
              </tr>
              {expanded[order.id] && <tr className="admin-order-detail" key={`${order.id}-details`}><td colSpan="6">
                <div className="admin-order-detail-grid">
                  <section><strong>Items</strong>{(order.items || []).map((item, index) => <small key={`${item.productId || item.name}-${index}`}>{item.quantity} × {item.name} · {item.size} · {item.flavour} ({money(item.unitPrice)})</small>)}</section>
                  <section><strong>Customer and fulfillment</strong><small>{order.address?.recipient || order.address?.name || order.customer || 'Guest customer'}{order.customerEmail ? ` · ${order.customerEmail}` : ''}</small><small>{order.address?.phone || 'No phone provided'}</small><small>{order.fulfillmentMethod === 'PICKUP' ? `Self pickup · ${order.address?.pickupLocation || 'Cakely Colombo'}` : [order.address?.address, order.address?.city, order.address?.district, order.address?.postalCode].filter(Boolean).join(', ') || 'No delivery address'}</small></section>
                  <section><strong>Payment and totals</strong><small>{order.paymentMethod} · {order.paymentStatus || 'PENDING'}</small><small>Subtotal: {money(order.subtotal)} · Discount: {money(order.discount)}</small><small>Delivery and fees: {money(order.deliveryFee)} · Total: {money(order.total)}</small></section>
                </div>
              </td></tr>}
            </Fragment>
          ))}
        </Table>
        {!visible.length && <Empty text="No orders match this search." />}
      </div>
    </>
  )
}

function Customers({ customers }) {
  return (
    <>
      <Header title="Customers" />
      <div className="admin-card">
        <Table>
          {(customers || []).map((customer) => (
            <tr key={customer.id}>
              <td><strong>{customer.username}</strong><small>{customer.email}</small></td>
              <td>{customer.orders} orders</td>
              <td>{money(customer.spending)}</td>
            </tr>
          ))}
        </Table>
        {!customers?.length && <Empty text="No registered customers yet." />}
      </div>
    </>
  )
}

function CouponForm({ coupon, onClose, onSaved }) {
  const [form, setForm] = useState(coupon ? { ...coupon } : emptyCoupon)
  const save = async (event) => { event.preventDefault(); await unwrap(coupon ? api.put(`/admin/coupons/${coupon.id}`, form) : api.post('/admin/coupons', form)); onSaved(); onClose() }
  return <div className="admin-modal"><form className="admin-editor" onSubmit={save}><div className="admin-card-head"><h2>{coupon ? 'Edit coupon' : 'New coupon'}</h2><button type="button" className="admin-icon-button" onClick={onClose}><X size={18}/></button></div>{[['code','Code'],['description','Description'],['discountValue','Discount value'],['minimumOrder','Minimum order'],['usageLimit','Usage limit'],['perUserLimit','Per-user limit'],['expiresAt','Expires at']].map(([key,label]) => <label key={key}>{label}<input value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}/></label>)}<label>Type<select value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value })}><option>PERCENTAGE</option><option>FIXED</option><option>FREE_DELIVERY</option></select></label><button className="button primary">Save coupon <Tag size={16}/></button></form></div>
}

function Coupons({ coupons, reload }) {
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const remove = async (coupon) => { if (!window.confirm(`Deactivate ${coupon.code}?`)) return; await unwrap(api.delete(`/admin/coupons/${coupon.id}`)); reload() }
  return (
    <>
      <Header title="Coupons" />
      <div className="admin-toolbar"><span className="muted">Create and manage customer discounts.</span><button className="button primary" onClick={() => setCreating(true)}><Plus size={16}/> New coupon</button></div>
      <div className="admin-card">
        <Table>
          {(coupons || []).map((coupon) => (
            <tr key={coupon.id}>
              <td><strong>{coupon.code}</strong><small>{coupon.description}</small></td>
              <td>{coupon.discountType}</td>
              <td>{money(coupon.discountValue || 0)}</td>
              <td><span className={`admin-badge ${coupon.active ? 'completed' : 'cancelled'}`}>{coupon.active ? 'ACTIVE' : 'INACTIVE'}</span></td>
              <td className="align-right"><button className="admin-table-action" onClick={() => setEditing(coupon)}><Pencil size={14}/> Edit</button><button className="admin-table-action danger" onClick={() => remove(coupon)}><Trash2 size={14}/> Deactivate</button></td>
            </tr>
          ))}
        </Table>
        {!coupons?.length && <Empty text="No coupons have been created yet." />}
      </div>
      {(creating || editing) && <CouponForm coupon={editing} onClose={() => { setCreating(false); setEditing(null) }} onSaved={reload} />}
    </>
  )
}

function Events({ events }) {
  return (
    <>
      <Header title="Events & security" />
      <div className="admin-card">
        <Table>
          {(events || []).map((event) => (
            <tr key={event.id}>
              <td><strong>{event.eventType}</strong><small>{event.eventId}</small></td>
              <td>{event.orderId ? `Order #${event.orderId}` : 'System'}</td>
              <td className="align-right"><small>{new Date(event.createdAt).toLocaleString('en-LK')}</small></td>
            </tr>
          ))}
        </Table>
        {!events?.length && <Empty text="No events recorded yet." />}
      </div>
    </>
  )
}

function RuleLock({ enabled, configured, reload }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toggle = async () => {
    setSaving(true); setError('')
    try { await unwrap(api.patch('/admin/rulelock', { enabled: !enabled })); await reload() } catch (err) { setError(err.response?.data?.error?.message || 'Unable to update RuleLock AI.') } finally { setSaving(false) }
  }
  return <><Header title="RuleLock AI" /><section className="admin-card rulelock-card"><div className="rulelock-heading"><div className="rulelock-icon"><BrainCircuit size={24} /></div><div><p className="admin-kicker">Integration control</p><h2>RuleLock AI</h2></div></div><p className="rulelock-copy">When enabled, each checkout is reviewed by the configured RuleLock AI service before it is accepted.</p><div className="rulelock-control"><div><strong>{enabled ? 'RuleLock AI is on' : 'RuleLock AI is off'}</strong><small>{enabled ? 'New checkouts are sent to RuleLock for review.' : configured ? 'Enable RuleLock to review new checkouts.' : 'Configure RULELOCK_API_URL in the API service before enabling RuleLock.'}</small></div><button type="button" className={enabled ? 'rulelock-switch enabled' : 'rulelock-switch'} onClick={toggle} disabled={saving} aria-pressed={enabled} aria-label={enabled ? 'Turn RuleLock AI off' : 'Turn RuleLock AI on'}><span /></button></div>{error && <p className="error">{error}</p>}</section></>
}

export default function AdminPanel() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('dashboard')
  const [open, setOpen] = useState(false)
  const [data, setData] = useState({})
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const result = await unwrap(api.get('/admin/dashboard'))
      setData(result.data || {})
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Admin session expired.')
    }
  }

  useEffect(() => { load() }, [])

  const content = tab === 'dashboard' ? <Dashboard data={data} onNavigate={setTab} />
    : tab === 'products' ? <Products products={data.products || []} reload={load} />
    : tab === 'orders' ? <Orders orders={data.allOrders || []} reload={load} />
    : tab === 'customers' ? <Customers customers={data.customers || []} />
    : tab === 'coupons' ? <Coupons coupons={data.coupons || []} reload={load} />
    : tab === 'events' ? <Events events={data.events || []} />
    : <RuleLock enabled={data.rulelockEnabled === true} configured={data.rulelockConfigured === true} reload={load} />

  return (
    <div className="admin-shell">
      <aside className={open ? 'admin-sidebar open' : 'admin-sidebar'}>
        <div className="admin-brand">
          <span className="brand-mark"><Sparkles size={17} /></span>
          <div><strong>cakely</strong><small>Admin Dashboard</small></div>
          <button className="admin-icon-button close-sidebar" onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
        <nav>
          {tabs.map(([key, label, Icon]) => (
            <button className={tab === key ? 'selected' : ''} key={key} onClick={() => { setTab(key); setOpen(false) }}>
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <button className="admin-logout" onClick={() => { localStorage.removeItem('cakely_token'); rotateSessionId(); navigate('/login') }}><LogOut size={17} /> Logout</button>
      </aside>
      <main className="admin-main">
        {error ? <div className="admin-error"><ShieldCheck size={20} /><span>{error}</span></div> : content}
      </main>
    </div>
  )
}
