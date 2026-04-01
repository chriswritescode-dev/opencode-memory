import { describe, test, expect, mock } from 'bun:test'
import { createRemoteSyncRegistry } from '../src/remote/sync-registry'
import { createSshClient } from '../src/remote/ssh-client'
import type { RemoteConfig, Logger } from '../src/types'
import type { GitSyncManager } from '../src/remote/git-sync'

describe('RemoteSyncRegistry', () => {
  const mockLogger: Logger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  const mockSshClient = createSshClient({ enabled: true, host: 'test-host' } as RemoteConfig, mockLogger)

  const mockSyncManager: GitSyncManager = {
    initializeAndSync: mock(async () => {}),
    autoCommitAndPull: mock(async () => true),
  }

  test('getDefault returns the default sync manager', () => {
    const registry = createRemoteSyncRegistry(mockSshClient, mockSyncManager, mockLogger)
    expect(registry.getDefault()).toBe(mockSyncManager)
  })

  test('getForWorktree returns null when not registered', () => {
    const registry = createRemoteSyncRegistry(mockSshClient, mockSyncManager, mockLogger)
    expect(registry.getForWorktree('loop-test')).toBeNull()
  })

  test('registerWorktree stores and returns a sync manager', async () => {
    const registry = createRemoteSyncRegistry(mockSshClient, mockSyncManager, mockLogger)
    const result = await registry.registerWorktree('loop-test', '/local/dir')
    expect(result).toBeDefined()
    expect(registry.getForWorktree('loop-test')).toBe(result)
  })

  test('unregisterWorktree removes the sync manager', async () => {
    const registry = createRemoteSyncRegistry(mockSshClient, mockSyncManager, mockLogger)
    await registry.registerWorktree('loop-test', '/local/dir')
    expect(registry.getForWorktree('loop-test')).not.toBeNull()
    registry.unregisterWorktree('loop-test')
    expect(registry.getForWorktree('loop-test')).toBeNull()
  })

  test('resolveForSession returns default for non-loop sessions', () => {
    const registry = createRemoteSyncRegistry(mockSshClient, mockSyncManager, mockLogger)
    const resolveWorktreeName = mock(() => null)
    const getWorktreeState = mock(() => null)
    const result = registry.resolveForSession('session-123', resolveWorktreeName, getWorktreeState)
    expect(result).toBe(mockSyncManager)
  })

  test('resolveForSession returns default when state has worktree: false', () => {
    const registry = createRemoteSyncRegistry(mockSshClient, mockSyncManager, mockLogger)
    const resolveWorktreeName = mock(() => 'loop-test')
    const getWorktreeState = mock(() => ({ worktree: false }))
    const result = registry.resolveForSession('session-123', resolveWorktreeName, getWorktreeState)
    expect(result).toBe(mockSyncManager)
  })

  test('resolveForSession returns worktree sync when state has worktree: true', async () => {
    const registry = createRemoteSyncRegistry(mockSshClient, mockSyncManager, mockLogger)
    const syncManager = await registry.registerWorktree('loop-test', '/local/dir')
    const resolveWorktreeName = mock(() => 'loop-test')
    const getWorktreeState = mock(() => ({ worktree: true }))
    const result = registry.resolveForSession('session-123', resolveWorktreeName, getWorktreeState)
    expect(result).toBe(syncManager)
  })

  test('cleanupRemoteWorktree calls sshClient.exec with rm -rf', async () => {
    const execMock = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const testSshClient = {
      ...mockSshClient,
      exec: execMock,
    }
    const registry = createRemoteSyncRegistry(testSshClient, mockSyncManager, mockLogger)
    await registry.registerWorktree('loop-test', '/local/dir')
    await registry.cleanupRemoteWorktree('loop-test')
    expect(execMock).toHaveBeenCalledWith('rm -rf "/projects/worktrees/loop-test"')
    expect(registry.getForWorktree('loop-test')).toBeNull()
  })
})
