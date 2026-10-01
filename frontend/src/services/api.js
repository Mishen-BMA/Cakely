import axios from 'axios'

const configuredBase = import.meta.env.VITE_API_URL || '/api'
const baseURL = configuredBase.replace(/\/$/, '').endsWith('/api') ? configuredBase.replace(/\/$/, '') : `${configuredBase.replace(/\/$/, '')}/api`
export const api = axios.create({ baseURL, headers: { 'Content-Type': 'application/json' } })
function randomId(prefix) {
	return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
export function rotateSessionId() {
	const id = randomId('sess')
	localStorage.setItem('cakely_session_id', id)
	return id
}
function getSessionId() {
	let id = localStorage.getItem('cakely_session_id')
	if (!id) {
		id = rotateSessionId()
	}
	return id
}
function getDeviceId() {
	let id = localStorage.getItem('cakely_device_id')
	if (!id) {
		id = randomId('device')
		localStorage.setItem('cakely_device_id', id)
	}
	return id
}
api.interceptors.request.use((config) => { const token = localStorage.getItem('cakely_token'); if (token) config.headers.Authorization = `Bearer ${token}`; config.headers['X-Session-ID'] = getSessionId(); config.headers['X-Device-ID'] = getDeviceId(); return config })
api.interceptors.request.use((config) => {
	if (typeof FormData !== 'undefined' && config.data instanceof FormData) delete config.headers['Content-Type']
	return config
})
export const unwrap = (request) => request.then((response) => response.data)
