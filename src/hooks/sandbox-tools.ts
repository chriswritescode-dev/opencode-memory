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
    const cwd = args.workdir ? toContainerPath(args.workdir, hostDir) : undefined

    const cmd = (args.command ?? '').trimStart()
    if (cmd === 'git' || cmd.startsWith('git ')) {
      pendingResults.set(input.callID, 'Git is not available in sandbox mode. The worktree is managed by the loop system on the host.')
      output.args = { ...args, command: 'true' }
      return
    }

    deps.logger.log(`[sandbox-hook] intercepting bash: ${args.command?.slice(0, 100)}`)

    try {
      const result = await docker.exec(containerName, args.command, {
        timeout: args.timeout,
        cwd,
      })

      let dockerOutput = rewriteOutput(result.stdout, hostDir)
      if (result.stderr && result.exitCode !== 0) {
        dockerOutput += rewriteOutput(result.stderr, hostDir)
      }
      if (result.exitCode === 124) {
        const timeoutMs = args.timeout ?? 120000
        dockerOutput += `\n\n<bash_metadata>\nbash tool terminated command after exceeding timeout ${timeoutMs} ms\n</bash_metadata>`
      } else if (result.exitCode !== 0) {
        dockerOutput += `\n\n[Exit code: ${result.exitCode}]`
      }

      pendingResults.set(input.callID, dockerOutput.trim())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pendingResults.set(input.callID, `Command failed: ${message}`)
    }

    output.args = { ...args, command: 'true' }
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
