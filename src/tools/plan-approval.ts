import type { ToolContext } from './types'
import type { Hooks } from '@opencode-ai/plugin'

const LOOP_BLOCKED_TOOLS: Record<string, string> = {
  question: 'The question tool is not available during a memory loop. Do not ask questions — continue working on the task autonomously.',
  'memory-plan-execute': 'The memory-plan-execute tool is not available during a memory loop. Focus on executing the current plan.',
  'memory-loop': 'The memory-loop tool is not available during a memory loop. Focus on executing the current plan.',
}

const PLAN_APPROVAL_LABELS = ['New session', 'Execute here', 'Loop (worktree)', 'Loop']

const PLAN_APPROVAL_DIRECTIVES: Record<string, string> = {
  'New session': `<system-reminder>
The user selected "New session". You MUST now call memory-plan-execute in this response with:
- plan: The FULL self-contained implementation plan (the code agent starts with zero context)
- title: A short descriptive title for the session
- inPlace: false (or omit)
Do NOT output text without also making this tool call.
</system-reminder>`,
  'Execute here': `<system-reminder>
The user selected "Execute here". You MUST now call memory-plan-execute in this response with:
- plan: "See plan above" (the code agent continues this session and already has context)
- title: A short descriptive title for the session
- inPlace: true
Do NOT output text without also making this tool call.
</system-reminder>`,
  'Loop (worktree)': `<system-reminder>
The user selected "Loop (worktree)". You MUST now call memory-loop in this response with:
- plan: The FULL self-contained implementation plan (runs in an isolated worktree with no prior context)
- title: A short descriptive title for the session
- worktree: true
Do NOT output text without also making this tool call.
</system-reminder>`,
  'Loop': `<system-reminder>
The user selected "Loop". You MUST now call memory-loop in this response with:
- plan: The FULL self-contained implementation plan (runs in the current directory with no prior context)
- title: A short descriptive title for the session
- worktree: false
Do NOT output text without also making this tool call.
</system-reminder>`,
}

export { LOOP_BLOCKED_TOOLS, PLAN_APPROVAL_LABELS, PLAN_APPROVAL_DIRECTIVES }

export function createToolExecuteBeforeHook(ctx: ToolContext): Hooks['tool.execute.before'] {
  const { loopService, logger, config, input } = ctx
  const sshClient = ctx.getSshClient?.() ?? null

  return async (
    hookInput: { tool: string; sessionID: string; callID: string },
    hookOutput: { args: any }
  ) => {
    const localDir = input.directory
    if (sshClient && config.remote?.enabled && localDir) {
      const remoteTools = ['bash', 'read', 'write', 'edit', 'multiedit', 'ls', 'glob', 'grep']
      const excludedTools = config.remote.excludeTools ?? []
      if (remoteTools.includes(hookInput.tool) && !excludedTools.includes(hookInput.tool)) {
        const normalizedLocal = localDir.endsWith('/') ? localDir : localDir + '/'

        const rewritePath = (p: string): string => {
          if (typeof p !== 'string') return p
          if (p.startsWith(normalizedLocal)) {
            return p.slice(normalizedLocal.length)
          }
          if (p === localDir) {
            return '.'
          }
          if (p.startsWith('..')) {
            logger.error(`Remote: path traversal detected: ${p}`)
            return p
          }
          return p
        }

        if (hookOutput.args.filePath) {
          hookOutput.args.filePath = rewritePath(hookOutput.args.filePath)
        }
        if (hookOutput.args.path) {
          hookOutput.args.path = rewritePath(hookOutput.args.path)
        }
        if (hookOutput.args.workdir) {
          hookOutput.args.workdir = rewritePath(hookOutput.args.workdir)
        }
      }
    }

    const worktreeName = loopService.resolveWorktreeName(hookInput.sessionID)
    const state = worktreeName ? loopService.getActiveState(worktreeName) : null
    if (!state?.active) return

    if (!(hookInput.tool in LOOP_BLOCKED_TOOLS)) return

    logger.log(`Loop: blocking ${hookInput.tool} tool before execution in ${state.phase} phase for session ${hookInput.sessionID}`)

    throw new Error(LOOP_BLOCKED_TOOLS[hookInput.tool]!)
  }
}

export function createToolExecuteAfterHook(ctx: ToolContext): Hooks['tool.execute.after'] {
  const { loopService, logger, config } = ctx
  const sshClient = ctx.getSshClient?.() ?? null

  return async (
    hookInput: { tool: string; sessionID: string; callID: string; args: unknown },
    hookOutput: { title: string; output: string; metadata: unknown }
  ) => {
    if (sshClient && config.remote?.enabled) {
      const remoteTools = ['bash', 'read', 'write', 'edit', 'multiedit', 'ls', 'glob', 'grep']
      const excludedTools = config.remote.excludeTools ?? []
      if (remoteTools.includes(hookInput.tool) && !excludedTools.includes(hookInput.tool)) {
        const projectDir = sshClient.getProjectDir(ctx.projectId)
        const normalizedDir = projectDir.endsWith('/') ? projectDir : projectDir + '/'
        if (typeof hookOutput.output === 'string' && hookOutput.output.includes(normalizedDir)) {
          hookOutput.output = hookOutput.output.replaceAll(normalizedDir, '')
        }
      }
    }

    if (hookInput.tool === 'question') {
      const args = hookInput.args as { questions?: Array<{ options?: Array<{ label: string }> }> } | undefined
      const options = args?.questions?.[0]?.options
      if (options) {
        const labels = options.map((o) => o.label)
        const isPlanApproval = PLAN_APPROVAL_LABELS.every((l) => labels.includes(l))
        if (isPlanApproval) {
          const metadata = hookOutput.metadata as { answers?: string[][] } | undefined
          const answer = metadata?.answers?.[0]?.[0]?.trim() ?? hookOutput.output.trim()
          const matchedLabel = PLAN_APPROVAL_LABELS.find((l) => answer === l || answer.startsWith(l))
          const directive = matchedLabel ? PLAN_APPROVAL_DIRECTIVES[matchedLabel] : '<system-reminder>\nThe user provided a custom response instead of selecting a predefined option. Review their answer and respond accordingly. If they want to proceed with execution, use the appropriate tool (memory-plan-execute or memory-loop) based on their intent. If they want to cancel or revise the plan, help them with that instead.\n</system-reminder>'
          hookOutput.output = `${hookOutput.output}\n\n${directive}`
          logger.log(`Plan approval: detected "${matchedLabel ?? 'cancel/custom'}" answer, injected directive`)
        }
      }
      return
    }

    const worktreeName = loopService.resolveWorktreeName(hookInput.sessionID)
    const state = worktreeName ? loopService.getActiveState(worktreeName) : null
    if (!state?.active) return

    if (!(hookInput.tool in LOOP_BLOCKED_TOOLS)) return

    logger.log(`Loop: blocked ${hookInput.tool} tool in ${state.phase} phase for session ${hookInput.sessionID}`)
    
    hookOutput.title = 'Tool blocked'
    hookOutput.output = LOOP_BLOCKED_TOOLS[hookInput.tool]!
  }
}
