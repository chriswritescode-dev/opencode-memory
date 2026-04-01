import { execSync } from 'child_process'
import { homedir } from 'os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { RemoteConfig, Logger } from '../types'
import type { SshClient } from './ssh-client'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface SyncManager {
  initializeAndSync(): Promise<void>
  flush(): Promise<void>
  terminate(): Promise<void>
}

export function buildMutagenUrl(config: RemoteConfig, remotePath: string): string {
  const portPart = config.port && config.port !== 22 ? `:${config.port}` : ''
  const userPart = config.user ? `${config.user}@` : ''
  return `${userPart}${config.host}${portPart}:${remotePath}`
}

export function checkMutagenInstalled(): boolean {
  try {
    execSync('mutagen version', { encoding: 'utf-8', stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function sanitizeSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

function ensureSshConfig(config: RemoteConfig, logger: Logger): void {
  const homeDir = homedir()
  const sshDir = `${homeDir}/.ssh`
  const sshConfigPath = `${sshDir}/config`
  
  const hostAlias = 'opencode-sandbox'
  const port = config.port && config.port !== 22 ? config.port : 22
  const user = config.user || 'root'
  const identityFile = config.keyPath || `${sshDir}/opencode-sandbox`

  try {
    if (!existsSync(sshDir)) {
      mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    }

    let configContent = ''
    if (existsSync(sshConfigPath)) {
      configContent = readFileSync(sshConfigPath, 'utf-8')
    }

    const hostRegex = new RegExp(`^Host\\s+${hostAlias}\\s*$`, 'm')
    if (hostRegex.test(configContent)) {
      logger.debug(`SSH config already has entry for ${hostAlias}`)
      return
    }

    const newEntry = `
Host ${hostAlias}
  HostName ${config.host}
  Port ${port}
  User ${user}
  IdentityFile ${identityFile}
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR

`

    writeFileSync(sshConfigPath, configContent + newEntry, 'utf-8')
    logger.log(`SSH config entry created for ${hostAlias}`)
  } catch (err) {
    logger.error('Failed to write SSH config entry', err)
  }
}

export function createMutagenSyncManager(
  config: RemoteConfig,
  localDir: string,
  remoteDir: string,
  sessionName: string,
  logger: Logger,
  sshClient: SshClient,
): SyncManager {
  const sanitizedSessionName = sanitizeSessionName(sessionName)
  const mutagenUrl = buildMutagenUrl(config, remoteDir)

  return {
    async initializeAndSync() {
      if (!checkMutagenInstalled()) {
        logger.error('Mutagen is not installed. Install with: brew install mutagen-io/mutagen/mutagen')
        throw new Error('Mutagen CLI not found')
      }

      ensureSshConfig(config, logger)

      try {
        const listResult = execSync(
          `mutagen sync list --label-selector=name=${sanitizedSessionName}`,
          { encoding: 'utf-8' }
        )
        if (listResult.trim()) {
          logger.debug(`Session ${sanitizedSessionName} already exists, terminating first`)
          try {
            execSync(`mutagen sync terminate ${sanitizedSessionName}`, { encoding: 'utf-8' })
            await sleep(500)
          } catch (err) {
            logger.debug('Failed to terminate existing session', err)
          }
        }
      } catch (err) {
        logger.debug('No existing session found, will create new one')
      }

      try {
        await sshClient.exec(`mkdir -p "${remoteDir}"`)
      } catch (err) {
        logger.error('Failed to ensure remote directory exists', err)
      }

      const keyPath = config.keyPath || `${process.env.HOME || '~'}/.ssh/opencode-sandbox`
      const sshFlags = `-i ${keyPath} -p ${config.port || 22} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`

      logger.log(`Remote: creating Mutagen sync session ${sanitizedSessionName}`)
      execSync(
        `mutagen sync create --name=${sanitizedSessionName} --sync-mode=two-way-resolved --ignore-vcs -i "node_modules" -i ".mutagen" --ssh-flags="${sshFlags}" '${localDir}' '${mutagenUrl}'`,
        { encoding: 'utf-8' }
      )

      logger.log(`Remote: flushing initial sync for ${sanitizedSessionName}`)
      execSync(`mutagen sync flush ${sanitizedSessionName}`, {
        encoding: 'utf-8',
        timeout: 120000,
      })

      logger.log('Remote: initial sync complete')
    },

    async flush() {
      try {
        execSync(`mutagen sync flush ${sanitizedSessionName}`, {
          encoding: 'utf-8',
          timeout: 120000,
        })
        logger.debug(`Remote: flush completed for ${sanitizedSessionName}`)
      } catch (err) {
        logger.error(`Remote: flush failed for ${sanitizedSessionName}`, err)
        throw err
      }
    },

    async terminate() {
      try {
        execSync(`mutagen sync terminate ${sanitizedSessionName}`, { encoding: 'utf-8' })
        logger.log(`Remote: terminated sync session ${sanitizedSessionName}`)
      } catch (err) {
        logger.debug(`Remote: terminate failed for ${sanitizedSessionName} (may not exist)`, err)
      }
    },
  }
}
