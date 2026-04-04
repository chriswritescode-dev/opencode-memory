import type { DockerService } from './docker'
import type { Logger } from '../types'
import { resolve } from 'path'

export interface SandboxManagerConfig {
  image: string
}

export interface ActiveSandbox {
  containerName: string
  projectDir: string
  startedAt: string
}

interface SandboxManager {
  docker: DockerService
  start(worktreeName: string, projectDir: string): Promise<{ containerName: string }>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
  isActive(worktreeName: string): boolean
  cleanupOrphans(): Promise<number>
}

const activeSandboxes = new Map<string, ActiveSandbox>()

export function createSandboxManager(
  docker: DockerService,
  config: SandboxManagerConfig,
  logger: Logger,
): SandboxManager {
  async function start(worktreeName: string, projectDir: string): Promise<{ containerName: string }> {
    const dockerAvailable = await docker.checkDocker()
    if (!dockerAvailable) {
      throw new Error('Docker is not available. Please ensure Docker is running.')
    }

    const imageExists = await docker.imageExists(config.image)
    if (!imageExists) {
      throw new Error(
        `Docker image "${config.image}" not found. Build it first:\n` +
        `  docker build -t ${config.image} container/`
      )
    }

    const containerName = docker.containerName(worktreeName)

    const running = await docker.isRunning(containerName)
    if (running) {
      logger.log(`Sandbox container ${containerName} already running`)
      return { containerName }
    }

    const absoluteProjectDir = resolve(projectDir)
    logger.log(`Creating sandbox container ${containerName} for ${absoluteProjectDir}`)
    await docker.createContainer(containerName, absoluteProjectDir, config.image)

    const active: ActiveSandbox = {
      containerName,
      projectDir: absoluteProjectDir,
      startedAt: new Date().toISOString(),
    }

    activeSandboxes.set(worktreeName, active)
    logger.log(`Sandbox container ${containerName} started`)

    return { containerName }
  }

  async function stop(worktreeName: string): Promise<void> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName || docker.containerName(worktreeName)

    try {
      await docker.removeContainer(containerName)
      logger.log(`Sandbox container ${containerName} removed`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.log(`Sandbox container ${containerName} removal: ${errMsg}`)
    } finally {
      activeSandboxes.delete(worktreeName)
    }
  }

  function getActive(worktreeName: string): ActiveSandbox | null {
    return activeSandboxes.get(worktreeName) || null
  }

  function isActive(worktreeName: string): boolean {
    return activeSandboxes.has(worktreeName)
  }

  async function cleanupOrphans(): Promise<number> {
    const containers = await docker.listContainersByPrefix('ocm-sandbox-')
    let removed = 0
    for (const name of containers) {
      try {
        await docker.removeContainer(name)
        removed++
      } catch {}
    }
    activeSandboxes.clear()
    return removed
  }

  return {
    docker,
    start,
    stop,
    getActive,
    isActive,
    cleanupOrphans,
  }
}
