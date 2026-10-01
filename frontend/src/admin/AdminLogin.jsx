import { useState } from 'react'
import { ArrowRight, CakeSlice } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, rotateSessionId, unwrap } from '../services/api'

export default function AdminLogin() {
  const navigate = useNavigate()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault()
    setError('')
    try {
      const result = await unwrap(api.post('/auth/admin-login', { identifier, password }))
      if (!result.data.user.isAdmin) throw new Error('Administrator access required.')
      localStorage.setItem('cakely_token', result.data.token)
      rotateSessionId()
      navigate('/admin')
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Unable to sign in.')
    }
  }
  return <main className="admin-login-page"><div className="admin-login-art"><span className="brand-mark"><CakeSlice size={20}/></span><p>cakely operations</p><h1>Welcome<br/><em>back.</em></h1></div><form className="admin-login-form" onSubmit={submit}><p className="admin-kicker">Administrator login</p><h2>Sign in to Cakely</h2><label>Username<input autoComplete="username" required value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="admin"/></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••"/></label>{error && <p className="admin-login-error">{error}</p>}<button className="admin-primary">Sign in <ArrowRight size={17}/></button></form></main>
}
