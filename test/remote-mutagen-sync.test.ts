import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { buildMutagenUrl, sanitizeSessionName, checkMutagenInstalled, createMutagenSyncManager } from '../src/remote/mutagen-sync'
import type { RemoteConfig } from '../src/types'
import type { SshClient } from '../src/remote/ssh-client'

describe('buildMutagenUrl', () => {
  test('returns correct URL with full config', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'localhost',
      port: 2222,
      user: 'devuser',
      basePath: '/projects',
    }
    const url = buildMutagenUrl(config, '/projects/test')
    expect(url).toBe('devuser@localhost:2222:/projects/test')
  })

  test('returns correct URL without port', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'example.org',
      user: 'root',
    }
    const url = buildMutagenUrl(config, '/projects/test')
    expect(url).toBe('root@example.org:/projects/test')
  })

  test('returns correct URL without user', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'example.org',
    }
    const url = buildMutagenUrl(config, '/projects/test')
    expect(url).toBe('example.org:/projects/test')
  })

  test('handles default port 22 correctly', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'localhost',
      port: 22,
      user: 'root',
    }
    const url = buildMutagenUrl(config, '/projects/test')
    expect(url).toBe('root@localhost:/projects/test')
  })
})

describe('sanitizeSessionName', () => {
  test('replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeSessionName('test_project-123')).toBe('test-project-123')
    expect(sanitizeSessionName('my@worktree!')).toBe('my-worktree')
    expect(sanitizeSessionName('normal-name')).toBe('normal-name')
  })

  test('removes leading and trailing hyphens', () => {
    expect(sanitizeSessionName('---test---')).toBe('test')
    expect(sanitizeSessionName('!@#test!@#')).toBe('test')
  })

  test('handles empty strings', () => {
    expect(sanitizeSessionName('')).toBe('')
    expect(sanitizeSessionName('!!!')).toBe('')
  })
})

describe('checkMutagenInstalled', () => {
  test('returns true when mutagen is available', () => {
    const result = checkMutagenInstalled()
    expect(typeof result).toBe('boolean')
  })
})

describe('createMutagenSyncManager', () => {
  test('returns SyncManager with required methods', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'localhost',
      port: 2222,
      user: 'devuser',
    }
    const mockLogger = {
      log: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    }
    const mockSshClient = {
      exec: mock(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })),
      readFile: mock(() => Promise.resolve('')),
      writeFile: mock(() => Promise.resolve()),
      listDir: mock(() => Promise.resolve('')),
      healthCheck: mock(() => Promise.resolve(true)),
      getSshUrl: mock(() => 'ssh://localhost'),
      getProjectDir: mock(() => '/projects/test'),
      getWorktreeDir: mock(() => '/projects/worktrees/test'),
    } as unknown as SshClient

    const syncManager = createMutagenSyncManager(
      config,
      '/local/path',
      '/remote/path',
      'test-session',
      mockLogger,
      mockSshClient,
    )

    expect(typeof syncManager.initializeAndSync).toBe('function')
    expect(typeof syncManager.flush).toBe('function')
    expect(typeof syncManager.terminate).toBe('function')
  })
})
