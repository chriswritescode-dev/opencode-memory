import { describe, test, expect } from 'bun:test'
import { createSandboxManager } from '../manager'
import type { DockerService } from '../docker'
import type { Logger } from '../../types'

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

function createMockDockerService() {
  const removeContainerCalls: string[] = []
  const createContainerCalls: Array<[string, string, string]> = []
  let containers = ['ocm-sandbox-foo', 'ocm-sandbox-bar']
  let runningContainers = new Set<string>()
  let shouldDockerBeAvailable = true
  let shouldImageExist = true

  const mock = {
    checkDocker: async () => shouldDockerBeAvailable,
    imageExists: async () => shouldImageExist,
    buildImage: async () => {},
    createContainer: async (name: string, projectDir: string, image: string) => {
      createContainerCalls.push([name, projectDir, image])
      runningContainers.add(name)
    },
    removeContainer: async (name: string) => {
      removeContainerCalls.push(name)
    },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    execPipe: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    isRunning: async (name: string) => runningContainers.has(name),
    containerName: (worktreeName: string) => `ocm-sandbox-${worktreeName}`,
    listContainersByPrefix: async (prefix: string) => {
      return containers.filter((name) => name.startsWith(prefix))
    },
    getRemoveContainerCalls: () => removeContainerCalls,
    getCreateContainerCalls: () => createContainerCalls,
    setContainers: (newContainers: string[]) => {
      containers = newContainers
    },
    setRunning: (name: string, running: boolean) => {
      if (running) {
        runningContainers.add(name)
      } else {
        runningContainers.delete(name)
      }
    },
    setDockerAvailable: (available: boolean) => {
      shouldDockerBeAvailable = available
    },
    setImageExists: (exists: boolean) => {
      shouldImageExist = exists
    },
  }
  return mock
}

describe('SandboxManager', () => {
  describe('cleanupOrphans', () => {
    test('with no whitelist kills all containers', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'ocm-sandbox:latest' },
        logger
      )

      const removed = await manager.cleanupOrphans()

      expect(removed).toBe(2)
      const calls = mockDocker.getRemoveContainerCalls()
      expect(calls).toContain('ocm-sandbox-foo')
      expect(calls).toContain('ocm-sandbox-bar')
      expect(manager.isActive('foo')).toBe(false)
      expect(manager.isActive('bar')).toBe(false)
    })

    test('with whitelist preserves matching containers', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'ocm-sandbox:latest' },
        logger
      )

      await manager.start('foo', '/path/foo')

      const removed = await manager.cleanupOrphans(['foo'])

      expect(removed).toBe(1)
      const calls = mockDocker.getRemoveContainerCalls()
      expect(calls).toContain('ocm-sandbox-bar')
      expect(calls).not.toContain('ocm-sandbox-foo')
      expect(manager.isActive('foo')).toBe(true)
    })
  })

  describe('restore', () => {
    test('repopulates map when container is running', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'ocm-sandbox:latest' },
        logger
      )

      mockDocker.setRunning('ocm-sandbox-foo', true)
      const startedAt = new Date().toISOString()

      await manager.restore('foo', '/path/foo', startedAt)

      const createCalls = mockDocker.getCreateContainerCalls()
      expect(createCalls.length).toBe(0)
      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('ocm-sandbox-foo')
      expect(active?.projectDir).toBe('/path/foo')
    })

    test('repopulates map with original startedAt when provided', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'ocm-sandbox:latest' },
        logger
      )

      mockDocker.setRunning('ocm-sandbox-foo', true)
      const originalStartedAt = '2025-01-01T00:00:00.000Z'

      await manager.restore('foo', '/path/foo', originalStartedAt)

      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.startedAt).toBe(originalStartedAt)
    })

    test('starts new container when not running', async () => {
      const mockDocker = createMockDockerService()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockDocker as unknown as DockerService,
        { image: 'ocm-sandbox:latest' },
        logger
      )

      mockDocker.setRunning('ocm-sandbox-foo', false)

      await manager.restore('foo', '/path/foo', new Date().toISOString())

      const createCalls = mockDocker.getCreateContainerCalls()
      expect(createCalls.length).toBe(1)
      expect(createCalls[0][0]).toBe('ocm-sandbox-foo')
      expect(createCalls[0][1]).toBe('/path/foo')
      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('ocm-sandbox-foo')
    })
  })
})
