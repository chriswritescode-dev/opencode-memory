import type { SshClient } from './ssh-client'
import { createGitSyncManager, type GitSyncManager } from './git-sync'
import type { Logger } from '../types'

export interface RemoteSyncRegistry {
  getDefault(): GitSyncManager
  getForWorktree(worktreeName: string): GitSyncManager | null
  registerWorktree(worktreeName: string, localDir: string): Promise<GitSyncManager>
  unregisterWorktree(worktreeName: string): void
  resolveForSession(
    sessionId: string,
    resolveWorktreeName: (sid: string) => string | null,
    getWorktreeState: (name: string) => { worktree?: boolean } | null,
  ): GitSyncManager
  cleanupRemoteWorktree(worktreeName: string): Promise<void>
}

export function createRemoteSyncRegistry(
  sshClient: SshClient,
  defaultSyncManager: GitSyncManager,
  logger: Logger,
): RemoteSyncRegistry {
  const worktreeSyncs = new Map<string, GitSyncManager>()

  return {
    getDefault() {
      return defaultSyncManager
    },

    getForWorktree(worktreeName: string) {
      return worktreeSyncs.get(worktreeName) ?? null
    },

    async registerWorktree(worktreeName: string, localDir: string) {
      const remoteDir = sshClient.getWorktreeDir(worktreeName)
      const syncManager = createGitSyncManager(
        sshClient,
        remoteDir,
        localDir,
        worktreeName,
        logger,
      )
      await syncManager.initializeAndSync()
      worktreeSyncs.set(worktreeName, syncManager)
      logger.log(`Remote: registered worktree sync for ${worktreeName} -> ${remoteDir}`)
      return syncManager
    },

    unregisterWorktree(worktreeName: string) {
      worktreeSyncs.delete(worktreeName)
      logger.log(`Remote: unregistered worktree sync for ${worktreeName}`)
    },

    resolveForSession(sessionId, resolveWorktreeName, getWorktreeState) {
      const wtName = resolveWorktreeName(sessionId)
      if (!wtName) return defaultSyncManager
      const state = getWorktreeState(wtName)
      if (!state?.worktree) return defaultSyncManager
      return worktreeSyncs.get(wtName) ?? defaultSyncManager
    },

    async cleanupRemoteWorktree(worktreeName: string) {
      const remoteDir = sshClient.getWorktreeDir(worktreeName)
      if (worktreeName.includes('..') || worktreeName.startsWith('/')) {
        logger.error(`Remote: invalid worktree name (path traversal attempt): ${worktreeName}`)
        return
      }
      try {
        await sshClient.exec(`rm -rf "${remoteDir}"`)
        logger.log(`Remote: cleaned up worktree dir ${remoteDir}`)
      } catch (err) {
        logger.error(`Remote: failed to cleanup worktree dir ${remoteDir}`, err)
      }
      worktreeSyncs.delete(worktreeName)
    },
  }
}
