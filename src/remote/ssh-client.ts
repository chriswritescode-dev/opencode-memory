import { spawnSync } from 'child_process'
import type { RemoteConfig, Logger } from '../types'

function isTransientSshError(stderr: string): boolean {
  const transientPatterns = [
    'Connection refused',
    'Connection timed out',
    'Connection reset',
    'No route to host',
    'Network is unreachable',
    'ssh_exchange_identification',
    'Connection closed by remote host',
  ]
  return transientPatterns.some(p => stderr.includes(p))
}

async function retrySpawnSync(
  args: string[],
  options: Parameters<typeof spawnSync>[2],
  logger: Logger,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<ReturnType<typeof spawnSync>> {
  let lastResult: ReturnType<typeof spawnSync>
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lastResult = spawnSync('ssh', args, options)
    const stderr = (lastResult as any).stderr ?? ''
    const timedOut = lastResult.status === null

    if (lastResult.status === 0) return lastResult
    if (!timedOut && !isTransientSshError(stderr as string)) return lastResult

    if (attempt < maxRetries - 1) {
      const delay = baseDelayMs * Math.pow(2, attempt)
      logger.debug(`SSH retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${stderr}`)
      await new Promise<void>(r => setTimeout(r, delay))
    }
  }
  return lastResult!
}

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
      
      const result = await retrySpawnSync([...baseArgs, hostTarget, finalCommand], {
        encoding: 'utf-8',
        timeout: 120000,
      }, logger)
      
      if (result.status === null) {
        logger.error('SSH command timed out after 120s')
        return { exitCode: 124, stdout: '', stderr: 'SSH command timed out after 120s' }
      }
      
      const exitCode = result.status ?? 1
      
      return {
        exitCode,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
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
      
      const result = await retrySpawnSync([...baseArgs, hostTarget, `cat > '${escapedPath}'`], {
        input: content,
        encoding: 'utf-8',
        timeout: 120000,
      }, logger)
      
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
      const result = await retrySpawnSync([...baseArgs, hostTarget, 'echo ok'], {
        encoding: 'utf-8',
        timeout: 120000,
      }, logger, 2)
      return result.status === 0
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
