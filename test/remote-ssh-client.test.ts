import { describe, test, expect, mock } from 'bun:test'
import { createSshClient } from '../src/remote/ssh-client'
import type { RemoteConfig, Logger } from '../src/types'

describe('createSshClient', () => {
  const mockLogger: Logger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  test('creates SSH client with default config', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
    }

    const client = createSshClient(config, mockLogger)
    expect(client).toBeDefined()
    expect(typeof client.exec).toBe('function')
    expect(typeof client.readFile).toBe('function')
    expect(typeof client.writeFile).toBe('function')
    expect(typeof client.healthCheck).toBe('function')
  })

  test('getProjectDir returns correct path', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
      basePath: '/projects',
    }

    const client = createSshClient(config, mockLogger)
    const projectDir = client.getProjectDir('test-project-123')
    expect(projectDir).toBe('/projects/test-project-123')
  })

  test('getProjectDir uses default basePath', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
    }

    const client = createSshClient(config, mockLogger)
    const projectDir = client.getProjectDir('test-project-123')
    expect(projectDir).toBe('/projects/test-project-123')
  })

  test('getSshUrl returns correct URL format without port', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
      user: 'root',
      basePath: '/projects',
    }

    const client = createSshClient(config, mockLogger)
    const url = client.getSshUrl('/projects/test-project')
    expect(url).toBe('ssh://root@test-host/projects/test-project')
  })

  test('getSshUrl includes port when not 22', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
      port: 2222,
      user: 'root',
      basePath: '/projects',
    }

    const client = createSshClient(config, mockLogger)
    const url = client.getSshUrl('/projects/test-project')
    expect(url).toBe('ssh://root@test-host:2222/projects/test-project')
  })

  test('getSshUrl without user omits user@', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
      basePath: '/projects',
    }

    const client = createSshClient(config, mockLogger)
    const url = client.getSshUrl('/projects/test-project')
    expect(url).toBe('ssh://test-host/projects/test-project')
  })

  test('getWorktreeDir returns correct path', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
      basePath: '/projects',
    }

    const client = createSshClient(config, mockLogger)
    const worktreeDir = client.getWorktreeDir('loop-feature-a')
    expect(worktreeDir).toBe('/projects/worktrees/loop-feature-a')
  })

  test('getWorktreeDir uses default basePath', () => {
    const config: RemoteConfig = {
      enabled: true,
      host: 'test-host',
    }

    const client = createSshClient(config, mockLogger)
    const worktreeDir = client.getWorktreeDir('loop-feature-a')
    expect(worktreeDir).toBe('/projects/worktrees/loop-feature-a')
  })
})
