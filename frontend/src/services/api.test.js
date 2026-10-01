import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let store
let service

beforeEach(async () => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  })
  vi.resetModules()
  service = await import('./api.js')
})

afterEach(() => vi.unstubAllGlobals())

describe('client identity headers', () => {
  it('keeps a device id between requests and rotates the session id explicitly', async () => {
    const requestConfig = () => service.api.interceptors.request.handlers[0].fulfilled({ headers: {} })
    const first = await requestConfig()
    const second = await requestConfig()
    expect(first.headers['X-Device-ID']).toBeTruthy()
    expect(second.headers['X-Device-ID']).toBe(first.headers['X-Device-ID'])
    expect(second.headers['X-Session-ID']).toBe(first.headers['X-Session-ID'])

    service.rotateSessionId()
    const afterRotation = await requestConfig()
    expect(afterRotation.headers['X-Session-ID']).not.toBe(first.headers['X-Session-ID'])
    expect(afterRotation.headers['X-Device-ID']).toBe(first.headers['X-Device-ID'])
  })
})
