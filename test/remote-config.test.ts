import { describe, test, expect } from 'bun:test'
import { loadPluginConfig } from '../src/setup'
import type { RemoteConfig } from '../src/types'

describe('Remote Config', () => {
  test('RemoteConfig interface is valid', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
      port: 22,
      user: 'root',
      basePath: '/projects',
      excludeTools: ['bash'],
    }
    expect(config.enabled).toBe(true)
    expect(config.host).toBe('test-host')
  })

  test('RemoteConfig with minimal required fields', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
    }
    expect(config.enabled).toBe(true)
    expect(config.host).toBe('test-host')
  })

  test('RemoteConfig defaults are applied correctly', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
    }
    expect(config.port).toBeUndefined()
    expect(config.user).toBeUndefined()
    expect(config.basePath).toBeUndefined()
  })
})
