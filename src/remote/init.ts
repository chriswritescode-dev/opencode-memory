import type { RemoteConfig, Logger } from '../types'
import type { SshClient } from './ssh-client'
import type { SyncManager } from './mutagen-sync'
import type { RemoteSyncRegistry } from './sync-registry'
import { createSshClient } from './ssh-client'
import { checkMutagenInstalled, createMutagenSyncManager } from './mutagen-sync'
import { createRemoteSyncRegistry } from './sync-registry'

export interface RemoteInitResult {
  sshClient: SshClient
  syncManager: SyncManager
  syncRegistry: RemoteSyncRegistry
}

export async function initializeRemote(
  config: RemoteConfig,
  directory: string,
  projectId: string,
  logger: Logger,
): Promise<RemoteInitResult> {
  const sshClient = createSshClient(config, logger)
  const healthy = await sshClient.healthCheck()
  if (!healthy) {
    throw new Error('Remote container health check failed')
  }

  if (!checkMutagenInstalled()) {
    throw new Error('Mutagen is not installed. Install with: brew install mutagen-io/mutagen/mutagen')
  }

  const syncManager = createMutagenSyncManager(
    config,
    directory,
    sshClient.getProjectDir(projectId),
    `opencode-${projectId}`,
    logger,
    sshClient,
  )

  await syncManager.initializeAndSync()

  const syncRegistry = createRemoteSyncRegistry(sshClient, syncManager, logger, config)

  return { sshClient, syncManager, syncRegistry }
}
