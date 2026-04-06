import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { createLoopService } from '../services/loop'
import type { createSandboxManager } from '../sandbox/manager'
import { toContainerPath, rewriteOutput } from '../sandbox/path'

interface SandboxToolHookDeps {
  loopService: ReturnType<typeof createLoopService>
  sandboxManager: ReturnType<typeof createSandboxManager> | null
  logger: Logger
}

const pendingResults = new Map<string, string>()

function getSandboxContext(deps: SandboxToolHookDeps, sessionId: string) {
  if (!deps.sandboxManager) return null

  const worktreeName = deps.loopService.resolveWorktreeName(sessionId)
  if (!worktreeName) return null

  const state = deps.loopService.getActiveState(worktreeName)
  if (!state?.active || !state.sandbox) return null

  const active = deps.sandboxManager.getActive(worktreeName)
  if (!active) return null

  return {
    docker: deps.sandboxManager.docker,
    containerName: active.containerName,
    hostDir: active.projectDir,
  }
}

const BASH_DEFAULT_TIMEOUT_MS = 120_000

export function createSandboxToolBeforeHook(deps: SandboxToolHookDeps): Hooks['tool.execute.before'] {
  return async (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => {
    if (input.tool !== 'bash') return

    const sandbox = getSandboxContext(deps, input.sessionID)
    if (!sandbox) return

    const { docker, containerName, hostDir } = sandbox
    const args = output.args

    output.args = { ...args, command: 'true' }

    const cmd = (args.command ?? '').trimStart()
    if (cmd === 'git push' || cmd.startsWith('git push ')) {
      pendingResults.set(input.callID, 'Git push is not available in sandbox mode. Pushes must be run on the host.')
      return
    }

    deps.logger.log(`[sandbox-hook] intercepting bash: ${args.command?.slice(0, 100)}`)

    const hookTimeout = (args.timeout ?? BASH_DEFAULT_TIMEOUT_MS) + 10_000
    const cwd = args.workdir ? toContainerPath(args.workdir, hostDir) : undefined

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`sandbox hook timeout after ${hookTimeout}ms`)), hookTimeout),
      )

      const execPromise = docker.exec(containerName, args.command, {
        timeout: args.timeout,
        cwd,
      })

      const result = await Promise.race([execPromise, timeoutPromise])

      let dockerOutput = rewriteOutput(result.stdout, hostDir)
      if (result.stderr && result.exitCode !== 0) {
        dockerOutput += rewriteOutput(result.stderr, hostDir)
      }
      if (result.exitCode === 124) {
        const timeoutMs = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS
        dockerOutput += `\n\n<bash_metadata>\nbash tool terminated command after exceeding timeout ${timeoutMs} ms\n</bash_metadata>`
      } else if (result.exitCode !== 0) {
        dockerOutput += `\n\n[Exit code: ${result.exitCode}]`
      }

      pendingResults.set(input.callID, dockerOutput.trim())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.logger.log(`[sandbox-hook] exec failed for callID ${input.callID}: ${message}`)
      pendingResults.set(input.callID, `Command failed: ${message}`)
    }
  }
}

export function createSandboxToolAfterHook(deps: SandboxToolHookDeps): Hooks['tool.execute.after'] {
  return async (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => {
    if (input.tool !== 'bash') return

    const dockerResult = pendingResults.get(input.callID)
    if (dockerResult === undefined) return

    pendingResults.delete(input.callID)
    deps.logger.log(`[sandbox-hook] replacing bash output for callID ${input.callID}`)
    output.output = dockerResult
  }
}
