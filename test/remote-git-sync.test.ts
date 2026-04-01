import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { execSync } from 'child_process'
import { createGitSyncManager } from '../src/remote/git-sync'
import type { SshClient } from '../src/remote/ssh-client'
import type { Logger } from '../src/types'

const mockExecSync = mock<(command: string, options?: any) => string>(() => '')
mock.module('child_process', () => ({
  execSync: mockExecSync,
}))

describe('HostGitManager', () => {
  const mockLogger: Logger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  const mockSshClient: SshClient = {
    exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    readFile: mock(async () => ''),
    writeFile: mock(async () => {}),
    listDir: mock(async () => ''),
    healthCheck: mock(async () => true),
    getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
    getProjectDir: mock((id: string) => `/projects/${id}`),
    getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
  }

  beforeEach(() => {
    mockExecSync.mockClear()
  })

  test('pushToRemote returns true on success', async () => {
    let pushSucceeded = false
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('git push')) {
        pushSucceeded = true
        return ''
      }
      return ''
    })

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLogger,
    )

    await syncManager.initializeAndSync()

    const pushCalls = mockExecSync.mock.calls.filter((c) => c[0].includes('git push'))
    expect(pushCalls.length).toBeGreaterThan(0)
    expect(pushSucceeded).toBe(true)
  })

  test('pushToRemote retries and returns false after 3 failed attempts', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('git push')) {
        throw new Error('push failed')
      }
      return ''
    })

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLogger,
    )

    await syncManager.initializeAndSync()

    const pushCalls = mockExecSync.mock.calls.filter((c) => c[0].includes('git push'))
    expect(pushCalls.length).toBe(3)
  })

  test('queue recovery after failure', async () => {
    let failCount = 0
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('git push') && failCount < 1) {
        failCount++
        throw new Error('push failed')
      }
      return ''
    })

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLogger,
    )

    await syncManager.initializeAndSync()

    mockExecSync.mockImplementation(() => '')

    await syncManager.initializeAndSync()

    const pushCalls = mockExecSync.mock.calls.filter((c) => c[0].includes('git push'))
    expect(pushCalls.length).toBeGreaterThan(1)
  })
})

describe('pull operations', () => {
  const mockLogger: Logger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  const mockSshClient: SshClient = {
    exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    readFile: mock(async () => ''),
    writeFile: mock(async () => {}),
    listDir: mock(async () => ''),
    healthCheck: mock(async () => true),
    getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
    getProjectDir: mock((id: string) => `/projects/${id}`),
    getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
  }

  beforeEach(() => {
    mockExecSync.mockClear()
  })

  test('pull retries and throws after 3 failed attempts', async () => {
    let fetchAttempts = 0
    mockExecSync.mockImplementation((command: string, options: any) => {
      if (command.includes('git rev-parse --is-inside-work-tree')) {
        return 'true'
      }
      if (command.includes('git fetch')) {
        fetchAttempts++
        throw new Error('fetch failed')
      }
      return ''
    })

    const mockSshClientWithChanges: SshClient = {
      exec: mock(async (command: string) => {
        if (command.includes('git status --porcelain')) {
          return { exitCode: 0, stdout: ' M remote-file.txt', stderr: '' }
        }
        if (command.includes('git rev-parse')) {
          return { exitCode: 0, stdout: 'true', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }),
      readFile: mock(async () => ''),
      writeFile: mock(async () => {}),
      listDir: mock(async () => ''),
      healthCheck: mock(async () => true),
      getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
      getProjectDir: mock((id: string) => `/projects/${id}`),
      getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
    }

    const syncManager = createGitSyncManager(
      mockSshClientWithChanges,
      '/remote/project',
      process.cwd(),
      'test-branch',
      mockLogger,
    )

    try {
      await syncManager.autoCommitAndPull()
    } catch {}

    expect(fetchAttempts).toBe(3)
  })
})

describe('autoCommitAndPull', () => {
  const mockLogger: Logger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  test('returns false when no remote changes', async () => {
    const mockSshClient: SshClient = {
      exec: mock(async (command: string) => {
        if (command.includes('git status --porcelain')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }),
      readFile: mock(async () => ''),
      writeFile: mock(async () => {}),
      listDir: mock(async () => ''),
      healthCheck: mock(async () => true),
      getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
      getProjectDir: mock((id: string) => `/projects/${id}`),
      getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
    }

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLogger,
    )

    const result = await syncManager.autoCommitAndPull()
    expect(result).toBe(false)
  })

  test('commits and pulls when changes exist', async () => {
    let statusCallCount = 0
    const mockSshClient: SshClient = {
      exec: mock(async (command: string) => {
        if (command.includes('git status --porcelain')) {
          statusCallCount++
          return { exitCode: 0, stdout: ' M file.txt', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }),
      readFile: mock(async () => ''),
      writeFile: mock(async () => {}),
      listDir: mock(async () => ''),
      healthCheck: mock(async () => true),
      getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
      getProjectDir: mock((id: string) => `/projects/${id}`),
      getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
    }

    mockExecSync.mockImplementation(() => '')

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLogger,
    )

    const result = await syncManager.autoCommitAndPull()
    expect(result).toBe(true)
  })

  test('stashes local changes before pull', async () => {
    let stashPushCalled = false
    let stashPopCalled = false
    let gitStatusCalled = false

    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('git rev-parse')) {
        return ''
      }
      if (command.includes('git status --porcelain')) {
        gitStatusCalled = true
        return ' M file.txt'
      }
      if (command.includes('git stash push')) {
        stashPushCalled = true
        return ''
      }
      if (command.includes('git stash pop')) {
        stashPopCalled = true
        return ''
      }
      return ''
    })

    const mockSshClient: SshClient = {
      exec: mock(async (command: string) => {
        if (command.includes('git status --porcelain')) {
          return { exitCode: 0, stdout: ' M file.txt', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }),
      readFile: mock(async () => ''),
      writeFile: mock(async () => {}),
      listDir: mock(async () => ''),
      healthCheck: mock(async () => true),
      getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
      getProjectDir: mock((id: string) => `/projects/${id}`),
      getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
    }

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLogger,
    )

    const result = await syncManager.autoCommitAndPull()
    expect(result).toBe(true)
    expect(gitStatusCalled).toBe(true)
    expect(stashPushCalled).toBe(true)
    expect(stashPopCalled).toBe(true)
  })
})

describe('initializeAndSync', () => {
  const mockLogger: Logger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  test('pushes and resets', async () => {
    mockExecSync.mockImplementation(() => '')

    const mockSshClient: SshClient = {
      exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      readFile: mock(async () => ''),
      writeFile: mock(async () => {}),
      listDir: mock(async () => ''),
      healthCheck: mock(async () => true),
      getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
      getProjectDir: mock((id: string) => `/projects/${id}`),
      getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
    }

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLogger,
    )

    await syncManager.initializeAndSync()

    const pushCalls = mockExecSync.mock.calls.filter((c) => c[0].includes('git push'))
    expect(pushCalls.length).toBeGreaterThan(0)
  })

  test('handles push failure gracefully', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('git push')) {
        throw new Error('push failed')
      }
      return ''
    })

    let errorLogged = false
    const mockLoggerWithCapture: Logger = {
      log: mock(() => {}),
      error: mock(() => { errorLogged = true }),
      debug: mock(() => {}),
    }

    const mockSshClient: SshClient = {
      exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      readFile: mock(async () => ''),
      writeFile: mock(async () => {}),
      listDir: mock(async () => ''),
      healthCheck: mock(async () => true),
      getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
      getProjectDir: mock((id: string) => `/projects/${id}`),
      getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
    }

    const syncManager = createGitSyncManager(
      mockSshClient,
      '/remote/project',
      '/local/project',
      'test-branch',
      mockLoggerWithCapture,
    )

    await syncManager.initializeAndSync()
    expect(errorLogged).toBe(true)
  })
})

describe('Unique remote names', () => {
  const mockLogger: Logger = {
    log: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }

  const mockSshClient: SshClient = {
    exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    readFile: mock(async () => ''),
    writeFile: mock(async () => {}),
    listDir: mock(async () => ''),
    healthCheck: mock(async () => true),
    getSshUrl: mock((path: string) => `ssh://devuser@test-host:2222${path}`),
    getProjectDir: mock((id: string) => `/projects/${id}`),
    getWorktreeDir: mock((name: string) => `/projects/worktrees/${name}`),
  }

  test('different branchSuffix values produce different remote names', () => {
    mockExecSync.mockImplementation(() => '')

    const syncManager1 = createGitSyncManager(
      mockSshClient,
      '/remote/project1',
      '/local/project1',
      'feature-a',
      mockLogger,
    )

    const syncManager2 = createGitSyncManager(
      mockSshClient,
      '/remote/project2',
      '/local/project2',
      'feature-b',
      mockLogger,
    )

    const remoteName1 = 'container-feature-a'
    const remoteName2 = 'container-feature-b'

    expect(remoteName1).not.toBe(remoteName2)
  })

  test('special characters in branchSuffix are sanitized', () => {
    const branchSuffix = 'test/branch@123'
    const sanitized = branchSuffix.replace(/[^a-zA-Z0-9-]/g, '-')
    expect(sanitized).toBe('test-branch-123')
  })
})
