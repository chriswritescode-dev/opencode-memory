import type { SshClient } from './ssh-client'
import type { SyncManager } from './mutagen-sync'
import type { RemoteSyncRegistry } from './sync-registry'
import type { Logger } from '../types'

export interface RemoteState {
  enabled: boolean
  connected: boolean
  busy: boolean
  host?: string
  projectDir?: string
}

export interface RemoteStateManager {
  isEnabled(): boolean
  isBusy(): boolean
  incrementBusy(): void
  decrementBusy(): void
  enable(sshClient: SshClient, syncManager: SyncManager, syncRegistry: RemoteSyncRegistry): void
  disable(): Promise<void>
  getState(): RemoteState
  setConnectionInfo(host: string, projectDir: string): void
  getSyncManager(): SyncManager | null
  getSyncRegistry(): RemoteSyncRegistry | null
  getSshClient(): SshClient | null
}

export function createRemoteStateManager(
  initialEnabled: boolean,
  logger: Logger
): RemoteStateManager {
  let enabled = initialEnabled
  let busyCount = 0
  let sshClient: SshClient | null = null
  let syncManager: SyncManager | null = null
  let syncRegistry: RemoteSyncRegistry | null = null
  let host: string | undefined
  let projectDir: string | undefined

  return {
    isEnabled() {
      return enabled
    },

    isBusy() {
      return busyCount > 0
    },

    incrementBusy() {
      busyCount++
    },

    decrementBusy() {
      if (busyCount > 0) busyCount--
    },

    enable(client: SshClient, manager: SyncManager, registry: RemoteSyncRegistry) {
      enabled = true
      sshClient = client
      syncManager = manager
      syncRegistry = registry
      logger.log('Remote: enabled')
    },

    async disable() {
      if (busyCount > 0) {
        throw new Error('Cannot disable remote while a tool is executing')
      }
      if (syncRegistry) {
        try {
          await syncRegistry.terminateAll()
        } catch (err) {
          logger.debug('Remote: worktree sync cleanup failed during disable', err)
        }
      }
      if (syncManager) {
        try {
          await syncManager.terminate()
        } catch (err) {
          logger.debug('Remote: sync terminate failed during disable', err)
        }
      }
      enabled = false
      sshClient = null
      syncManager = null
      syncRegistry = null
      host = undefined
      projectDir = undefined
      logger.log('Remote: disabled')
    },

    getState(): RemoteState {
      return {
        enabled,
        connected: enabled && sshClient !== null,
        busy: busyCount > 0,
        host,
        projectDir,
      }
    },

    setConnectionInfo(h: string, dir: string) {
      host = h
      projectDir = dir
    },

    getSyncManager() {
      return syncManager
    },

    getSyncRegistry() {
      return syncRegistry
    },

    getSshClient() {
      return sshClient
    },
  }
}
