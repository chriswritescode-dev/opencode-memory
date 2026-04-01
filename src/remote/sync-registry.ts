import type { SshClient } from './ssh-client'
import type { RemoteConfig, Logger } from '../types'
import { createMutagenSyncManager, type SyncManager } from './mutagen-sync'
import { sanitizeSessionName } from './mutagen-sync'

export interface RemoteSyncRegistry {
  getDefault(): SyncManager
  getForWorktree(worktreeName: string): SyncManager | null
  registerWorktree(worktreeName: string, localDir: string): Promise<SyncManager>
  unregisterWorktree(worktreeName: string): void
  resolveForSession(
    sessionId: string,
    resolveWorktreeName: (sid: string) => string | null,
    getWorktreeState: (name: string) => { worktree?: boolean } | null,
  ): SyncManager
  cleanupRemoteWorktree(worktreeName: string): Promise<void>
  terminateAll(): Promise<void>
}

export function createRemoteSyncRegistry(
  sshClient: SshClient,
  defaultSyncManager: SyncManager,
  logger: Logger,
  config: RemoteConfig,
): RemoteSyncRegistry {
  const worktreeSyncs = new Map<string, SyncManager>()

  return {
    getDefault() {
      return defaultSyncManager
    },

    getForWorktree(worktreeName: string) {
      return worktreeSyncs.get(worktreeName) ?? null
    },

    async registerWorktree(worktreeName: string, localDir: string) {
      const remoteDir = sshClient.getWorktreeDir(worktreeName)
      const sessionName = `opencode-wt-${sanitizeSessionName(worktreeName)}`
      const syncManager = createMutagenSyncManager(
        config,
        localDir,
        remoteDir,
        sessionName,
        logger,
        sshClient,
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
      const syncManager = worktreeSyncs.get(worktreeName)
      if (syncManager) {
        try {
          await syncManager.terminate()
        } catch (err) {
          logger.debug(`Remote: failed to terminate sync for ${worktreeName}`, err)
        }
        worktreeSyncs.delete(worktreeName)
      }
      try {
        await sshClient.exec(`rm -rf "${remoteDir}"`)
        logger.log(`Remote: cleaned up worktree dir ${remoteDir}`)
      } catch (err) {
        logger.error(`Remote: failed to cleanup worktree dir ${remoteDir}`, err)
      }
    },

    async terminateAll() {
      const entries = Array.from(worktreeSyncs.entries())
      for (const [name, sm] of entries) {
        try {
          await sm.terminate()
          logger.debug(`Remote: terminated worktree sync for ${name}`)
        } catch (err) {
          logger.debug(`Remote: failed to terminate worktree sync for ${name}`, err)
        }
      }
      worktreeSyncs.clear()
    },
  }
}
