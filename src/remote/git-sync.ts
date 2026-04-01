import { execSync } from 'child_process'
import type { SshClient } from './ssh-client'
import type { Logger } from '../types'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

class HostGitManager {
  private operationQueue: Promise<void> = Promise.resolve()

  hasRepo(cwd: string): boolean {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd, encoding: 'utf-8' })
      return true
    } catch {
      return false
    }
  }

  async pushToRemote(remoteName: string, sshUrl: string, branch: string, cwd: string, logger?: Logger): Promise<boolean> {
    const previousQueue = this.operationQueue
    
    const pushPromise = (async () => {
      await previousQueue
      
      try {
        execSync(`git remote remove ${remoteName}`, { cwd, encoding: 'utf-8' })
      } catch (err) {
        if (logger) {
          logger.debug(`Git: remote remove ${remoteName} failed (may not exist)`)
        }
      }

      execSync(`git remote add ${remoteName} ${sshUrl}`, { cwd, encoding: 'utf-8' })

      for (let i = 0; i < 3; i++) {
        try {
          execSync(`git push ${remoteName} HEAD:${branch}`, { cwd, encoding: 'utf-8' })
          return
        } catch (err) {
          if (i === 2) {
            throw err
          }
          await sleep(500 * Math.pow(2, i))
        }
      }
    })()

    this.operationQueue = pushPromise.catch((err: unknown) => {
      logger?.error('Remote: push operation failed', err)
    })

    try {
      await pushPromise
      return true
    } catch {
      return false
    }
  }

  async pull(remoteName: string, sshUrl: string, branch: string, cwd: string, localBranch: string, logger?: Logger): Promise<void> {
    const previousQueue = this.operationQueue
    
    const pullPromise = (async () => {
      await previousQueue
      
      try {
        execSync(`git remote remove ${remoteName}`, { cwd, encoding: 'utf-8' })
      } catch (err) {
        if (logger) {
          logger.debug(`Git: remote remove ${remoteName} failed (may not exist)`)
        }
      }

      execSync(`git remote add ${remoteName} ${sshUrl}`, { cwd, encoding: 'utf-8' })

      for (let i = 0; i < 3; i++) {
        try {
          execSync(`git fetch ${remoteName} ${branch}`, { cwd, encoding: 'utf-8' })
          execSync(`git update-ref refs/heads/${localBranch} FETCH_HEAD`, { cwd, encoding: 'utf-8' })
          execSync(`git reset --hard refs/heads/${localBranch}`, { cwd, encoding: 'utf-8' })
          return
        } catch (err) {
          if (i === 2) {
            throw err
          }
          await sleep(500 * Math.pow(2, i))
        }
      }
    })()

    this.operationQueue = pullPromise.catch(() => {})
    await pullPromise
  }
}

class RemoteGitManager {
  constructor(private sshClient: SshClient, private logger: Logger) {}

  async ensureDirectory(projectDir: string): Promise<void> {
    await this.sshClient.exec(`mkdir -p "${projectDir}"`)
  }

  async ensureRepo(projectDir: string): Promise<void> {
    await this.ensureDirectory(projectDir)

    const result = await this.sshClient.exec('git rev-parse --is-inside-work-tree', projectDir)
    if (result.exitCode !== 0) {
      await this.sshClient.exec('git init', projectDir)
      await this.sshClient.exec('git config user.email "remote@container"', projectDir)
      await this.sshClient.exec('git config user.name "Remote Container"', projectDir)
    }
  }

  async autoCommit(projectDir: string): Promise<boolean> {
    const statusResult = await this.sshClient.exec('git status --porcelain', projectDir)
    if (!statusResult.stdout.trim()) {
      return false
    }

    await this.sshClient.exec('git add .', projectDir)
    await this.sshClient.exec('git commit -am "Auto-commit from remote sync"', projectDir)
    return true
  }

  async resetToRemote(projectDir: string, branch: string): Promise<void> {
    await this.sshClient.exec(`git checkout -B ${branch}`, projectDir)
    await this.sshClient.exec('git reset --hard', projectDir)
    await this.sshClient.exec('git clean -fd', projectDir)
  }
}

export interface GitSyncManager {
  initializeAndSync(): Promise<void>
  autoCommitAndPull(): Promise<boolean>
}

export function createGitSyncManager(
  sshClient: SshClient,
  remoteDir: string,
  localDir: string,
  branchSuffix: string,
  logger: Logger,
): GitSyncManager {
  const hostGit = new HostGitManager()
  const remoteGit = new RemoteGitManager(sshClient, logger)
  const projectDir = remoteDir

  const sanitizedSuffix = branchSuffix.replace(/[^a-zA-Z0-9-]/g, '-')
  const branch = `opencode/remote/${sanitizedSuffix}`
  const localBranch = `opencode/remote/${sanitizedSuffix}`
  const remoteName = 'container-' + sanitizedSuffix

  function getSshUrl() {
    return sshClient.getSshUrl(remoteDir)
  }

  return {
    async initializeAndSync() {
      if (!hostGit.hasRepo(localDir)) {
        logger.log('Remote: no local git repo, skipping initialization')
        await remoteGit.ensureDirectory(projectDir)
        return
      }

      await remoteGit.ensureRepo(projectDir)

      const sshUrl = getSshUrl()
      const pushSuccess = await hostGit.pushToRemote(remoteName, sshUrl, branch, localDir, logger)

      if (pushSuccess) {
        await remoteGit.resetToRemote(projectDir, branch)
        logger.log('Remote: initial sync complete')
      } else {
        logger.error('Remote: initial push failed')
      }
    },

    async autoCommitAndPull() {
      if (!hostGit.hasRepo(localDir)) {
        return false
      }

      await remoteGit.ensureRepo(projectDir)

      let stashed = false
      try {
        const status = execSync('git status --porcelain', { cwd: localDir, encoding: 'utf-8' })
        if (status.trim()) {
          execSync('git stash push -m "opencode-remote-sync-auto-stash"', { cwd: localDir, encoding: 'utf-8' })
          stashed = true
          logger.log('Remote: stashed local changes before pull')
        }
      } catch (err) {
        logger.log('Remote: failed to check for local changes before pull', err)
      }

      const hasChanges = await remoteGit.autoCommit(projectDir)
      if (!hasChanges && !stashed) {
        return false
      }

      const sshUrl = getSshUrl()
      await hostGit.pull(remoteName, sshUrl, branch, localDir, localBranch, logger)

      if (stashed) {
        try {
          execSync('git stash pop', { cwd: localDir, encoding: 'utf-8' })
          logger.log('Remote: restored stashed local changes')
        } catch (err) {
          logger.error('Remote: failed to restore stashed changes - changes remain in stash. Run "git stash pop" to restore')
          return false
        }
      }

      logger.log('Remote: auto-commit and pull complete')
      return true
    },
  }
}
