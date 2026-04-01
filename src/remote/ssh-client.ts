import { spawnSync } from 'child_process'
import type { RemoteConfig, Logger } from '../types'

export interface SshClient {
  exec(command: string, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFile(remotePath: string): Promise<string>
  writeFile(remotePath: string, content: string): Promise<void>
  listDir(remotePath: string): Promise<string>
  healthCheck(): Promise<boolean>
  getSshUrl(path: string): string
  getProjectDir(projectId: string): string
  getWorktreeDir(worktreeName: string): string
}

export function createSshClient(config: RemoteConfig, logger: Logger): SshClient {
  const baseArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
  
  if (config.port && config.port !== 22) {
    baseArgs.push('-p', String(config.port))
  }
  
  if (config.keyPath) {
    baseArgs.push('-i', config.keyPath)
  }
  
  const hostTarget = config.user ? `${config.user}@${config.host}` : config.host
  const basePath = config.basePath ?? '/projects'

  return {
    async exec(command: string, cwd?: string) {
      const escapedCwd = cwd?.replace(/'/g, "'\\''")
      const finalCommand = escapedCwd ? `cd '${escapedCwd}' && ${command}` : command
      logger.debug(`SSH exec: ${finalCommand}`)
      
      const result = spawnSync('ssh', [...baseArgs, hostTarget, finalCommand], {
        encoding: 'utf-8',
        timeout: 120000,
      })
      
      if (result.status === null) {
        logger.error('SSH command timed out after 120s')
        return { exitCode: 124, stdout: '', stderr: 'SSH command timed out after 120s' }
      }
      
      const exitCode = result.status ?? 1
      
      return {
        exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    },

    async readFile(remotePath: string) {
      const escapedPath = remotePath.replace(/'/g, "'\\''")
      const result = await this.exec(`cat -- '${escapedPath}'`)
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read ${remotePath}: ${result.stderr}`)
      }
      return result.stdout
    },

    async writeFile(remotePath: string, content: string) {
      const escapedPath = remotePath.replace(/'/g, "'\\''")
      const dirResult = await this.exec(`mkdir -p -- "$(dirname '${escapedPath}')"`)
      if (dirResult.exitCode !== 0) {
        throw new Error(`Failed to create directory for ${remotePath}: ${dirResult.stderr}`)
      }
      
      const result = spawnSync('ssh', [...baseArgs, hostTarget, `cat > '${escapedPath}'`], {
        input: content,
        encoding: 'utf-8',
        timeout: 120000,
      })
      
      if (result.status === null) {
        throw new Error(`Failed to write ${remotePath}: SSH command timed out after 120s`)
      }
      if (result.status !== 0) {
        throw new Error(`Failed to write ${remotePath}: ${result.stderr ?? ''}`)
      }
    },

    async listDir(remotePath: string) {
      const escapedPath = remotePath.replace(/'/g, "'\\''")
      const result = await this.exec(`ls -la -- '${escapedPath}'`)
      return result.stdout
    },

    async healthCheck() {
      const result = await this.exec('echo ok')
      return result.exitCode === 0
    },

    getSshUrl(path: string) {
      const portPart = config.port && config.port !== 22 ? `:${config.port}` : ''
      const userPart = config.user ? `${config.user}@` : ''
      return `ssh://${userPart}${config.host}${portPart}${path}`
    },

    getProjectDir(projectId: string) {
      return `${basePath}/${projectId}`
    },

    getWorktreeDir(worktreeName: string) {
      return `${basePath}/worktrees/${worktreeName}`
    },
  }
}
