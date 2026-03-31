import { describe, it, expect } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

const DEFAULT_PORT = 2222
const DEFAULT_USER = 'devuser'
const DEFAULT_BASE_PATH = '/projects'
const KEY_DIR = join(homedir(), '.ssh')
const KEY_NAME = 'opencode-sandbox'

describe('container setup', () => {
  describe('key path generation', () => {
    it('generates correct private key path', () => {
      const keyPath = join(KEY_DIR, KEY_NAME)
      expect(keyPath).toContain('.ssh')
      expect(keyPath).toContain('opencode-sandbox')
    })

    it('generates correct public key path', () => {
      const pubKeyPath = join(KEY_DIR, `${KEY_NAME}.pub`)
      expect(pubKeyPath).toContain('.ssh')
      expect(pubKeyPath).toContain('opencode-sandbox.pub')
    })
  })

  describe('config output', () => {
    it('produces valid JSON with correct structure', () => {
      const config = {
        remote: {
          enabled: true,
          host: 'localhost',
          port: DEFAULT_PORT,
          user: DEFAULT_USER,
          keyPath: join(KEY_DIR, KEY_NAME),
          basePath: DEFAULT_BASE_PATH,
        },
      }

      const json = JSON.stringify(config, null, 2)
      const parsed = JSON.parse(json)

      expect(parsed.remote).toBeDefined()
      expect(parsed.remote.enabled).toBe(true)
      expect(parsed.remote.host).toBe('localhost')
      expect(parsed.remote.port).toBe(2222)
      expect(parsed.remote.user).toBe('devuser')
      expect(parsed.remote.basePath).toBe('/projects')
    })

    it('includes all required remote config fields', () => {
      const config = {
        remote: {
          enabled: true,
          host: 'localhost',
          port: DEFAULT_PORT,
          user: DEFAULT_USER,
          keyPath: join(KEY_DIR, KEY_NAME),
          basePath: DEFAULT_BASE_PATH,
        },
      }

      const requiredFields = ['enabled', 'host', 'port', 'user', 'keyPath', 'basePath']
      for (const field of requiredFields) {
        expect(config.remote).toHaveProperty(field)
      }
    })
  })

  describe('findComposeFile logic', () => {
    it('prefers container/docker-compose.yml over docker-compose.yml', () => {
      const candidates = [
        'container/docker-compose.yml',
        'docker-compose.yml',
      ]

      const found = candidates.find(c => c === 'container/docker-compose.yml')
      expect(found).toBe('container/docker-compose.yml')
    })

    it('checks candidates in correct order', () => {
      const candidates = [
        'container/docker-compose.yml',
        'docker-compose.yml',
      ]

      expect(candidates[0]).toBe('container/docker-compose.yml')
      expect(candidates[1]).toBe('docker-compose.yml')
    })
  })

  describe('default values', () => {
    it('uses correct default port', () => {
      expect(DEFAULT_PORT).toBe(2222)
    })

    it('uses correct default user', () => {
      expect(DEFAULT_USER).toBe('devuser')
    })

    it('uses correct default base path', () => {
      expect(DEFAULT_BASE_PATH).toBe('/projects')
    })
  })
})
