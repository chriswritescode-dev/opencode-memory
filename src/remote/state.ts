import type { SshClient } from './ssh-client'
import type { SyncManager } from './mutagen-sync'
import type { RemoteSyncRegistry } from './sync-registry'
import type { Logger, RemoteConfig } from '../types'
import { initializeRemote } from './init'

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
  toggleOn(config: RemoteConfig, directory: string, projectId: string): Promise<void>
  toggleOff(): Promise<void>
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

    async toggleOn(remoteConfig: RemoteConfig, directory: string, projectId: string) {
      if (busyCount > 0) {
        throw new Error('Cannot enable remote while a tool is executing')
      }
      if (enabled) {
        throw new Error('Remote is already enabled')
      }
      if (!remoteConfig) {
        throw new Error('Cannot enable remote: no remote configuration found')
      }
      const result = await initializeRemote(remoteConfig, directory, projectId, logger)
      sshClient = result.sshClient
      syncManager = result.syncManager
      syncRegistry = result.syncRegistry
      host = remoteConfig.host
      projectDir = result.sshClient.getProjectDir(projectId)
      enabled = true
      logger.log('Remote: enabled via toggle')
    },

    async toggleOff() {
      if (busyCount > 0) {
        throw new Error('Cannot disable remote while a tool is executing')
      }
      if (!enabled) {
        throw new Error('Remote is already disabled')
      }
      await this.disable()
      logger.log('Remote: disabled via toggle')
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

export async function processRemoteCommand(
  kvService: { get: <T>(projectId: string, key: string) => T | null; set: (projectId: string, key: string, data: unknown, ttlMs?: number) => void; delete: (projectId: string, key: string) => void },
  projectId: string,
  remoteStateManager: RemoteStateManager,
  config: { remote?: RemoteConfig },
  directory: string,
  logger: Logger,
): Promise<void> {
  const command = kvService.get<{ action: 'enable' | 'disable' }>(projectId, 'remote:command')
  if (!command) return

  kvService.delete(projectId, 'remote:command')

  try {
    if (command.action === 'enable') {
      if (!config.remote) {
        logger.log('Remote: cannot enable - no remote configuration found')
        return
      }
      await remoteStateManager.toggleOn(config.remote, directory, projectId)
    } else if (command.action === 'disable') {
      await remoteStateManager.toggleOff()
    }
  } catch (err) {
    logger.error(`Remote: toggle ${command.action} failed`, err)
  }

  kvService.set(projectId, 'remote:state', remoteStateManager.getState())
}
