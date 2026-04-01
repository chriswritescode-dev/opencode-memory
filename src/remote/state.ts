import type { SshClient } from './ssh-client'
import type { GitSyncManager } from './git-sync'
import type { RemoteSyncRegistry } from './sync-registry'
import type { Logger } from '../types'

export interface RemoteState {
  enabled: boolean
  connected: boolean
  host?: string
  projectDir?: string
}

export interface RemoteStateManager {
  isEnabled(): boolean
  enable(sshClient: SshClient, gitSync: GitSyncManager, syncRegistry: RemoteSyncRegistry): void
  disable(): Promise<void>
  toggle(currentSshClient?: SshClient): Promise<boolean>
  getState(): RemoteState
  setConnectionInfo(host: string, projectDir: string): void
}

export function createRemoteStateManager(
  initialEnabled: boolean,
  logger: Logger
): RemoteStateManager {
  let enabled = initialEnabled
  let sshClient: SshClient | null = null
  let gitSync: GitSyncManager | null = null
  let syncRegistry: RemoteSyncRegistry | null = null
  let host: string | undefined
  let projectDir: string | undefined

  return {
    isEnabled() {
      return enabled
    },

    enable(client: SshClient, syncManager: GitSyncManager, registry: RemoteSyncRegistry) {
      enabled = true
      sshClient = client
      gitSync = syncManager
      syncRegistry = registry
      logger.log('Remote: enabled')
    },

    async disable() {
      enabled = false
      sshClient = null
      gitSync = null
      syncRegistry = null
      logger.log('Remote: disabled')
    },

    async toggle(currentClient?: SshClient) {
      enabled = !enabled
      if (!enabled) {
        sshClient = null
        gitSync = null
        syncRegistry = null
        logger.log('Remote: toggled off')
      }
      logger.log(`Remote: toggled ${enabled ? 'on' : 'off'}`)
      return enabled
    },

    getState(): RemoteState {
      return {
        enabled,
        connected: enabled && sshClient !== null,
        host,
        projectDir,
      }
    },

    setConnectionInfo(h: string, dir: string) {
      host = h
      projectDir = dir
    },
  }
}
