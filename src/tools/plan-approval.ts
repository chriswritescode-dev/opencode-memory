import type { ToolContext } from './types'
import type { Hooks } from '@opencode-ai/plugin'
import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'

const LOOP_BLOCKED_TOOLS: Record<string, string> = {
  question: 'The question tool is not available during a memory loop. Do not ask questions — continue working on the task autonomously.',
  'memory-plan-execute': 'The memory-plan-execute tool is not available during a memory loop. Focus on executing the current plan.',
  'memory-loop': 'The memory-loop tool is not available during a memory loop. Focus on executing the current plan.',
}

const PLAN_APPROVAL_LABELS = ['New session', 'Execute here', 'Loop (worktree)', 'Loop']

interface PendingExecution {
  directory: string
  executionModel?: { providerID: string; modelID: string }
}

const pendingExecutions = new Map<string, PendingExecution>()

const PLAN_APPROVAL_DIRECTIVES: Record<string, string> = {
  'New session': `<system-reminder>
The user selected "New session". You MUST now call memory-plan-execute in this response with:
- plan: The FULL self-contained implementation plan (the code agent starts with zero context)
- title: A short descriptive title for the session
- worktree: true (or omit)
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
  const { loopService, logger } = ctx

  return async (
    input: { tool: string; sessionID: string; callID: string },
    _output: { args: unknown }
  ) => {
    const worktreeName = loopService.resolveWorktreeName(input.sessionID)
    const state = worktreeName ? loopService.getActiveState(worktreeName) : null
    if (!state?.active) return

    if (!(input.tool in LOOP_BLOCKED_TOOLS)) return

    logger.log(`Loop: blocking ${input.tool} tool before execution in ${state.phase} phase for session ${input.sessionID}`)

    throw new Error(LOOP_BLOCKED_TOOLS[input.tool]!)
  }
}

export function createToolExecuteAfterHook(ctx: ToolContext): Hooks['tool.execute.after'] {
  const { loopService, logger } = ctx

  return async (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ) => {
    if (input.tool === 'question') {
      const args = input.args as { questions?: Array<{ options?: Array<{ label: string }> }> } | undefined
      const options = args?.questions?.[0]?.options
      if (options) {
        const labels = options.map((o) => o.label.toLowerCase())
        const hasExecuteHere = labels.some((l) => l === 'execute here' || l.startsWith('execute here'))
        const isPlanApproval = hasExecuteHere || PLAN_APPROVAL_LABELS.every((l) => labels.includes(l))
        if (isPlanApproval) {
          const metadata = output.metadata as { answers?: string[][] } | undefined
          const answer = metadata?.answers?.[0]?.[0]?.trim() ?? output.output.trim()
          const answerLower = answer.toLowerCase()
          const matchedLabel = PLAN_APPROVAL_LABELS.find((l) => answerLower === l.toLowerCase() || answerLower.startsWith(l.toLowerCase()))
          
          if (matchedLabel?.toLowerCase() === 'execute here') {
            pendingExecutions.set(input.sessionID, {
              directory: ctx.directory,
              executionModel: parseModelString(ctx.config.executionModel),
            })
            
            ctx.v2.session.abort({ sessionID: input.sessionID }).catch((err) => {
              logger.error('Plan approval: failed to abort architect session', err)
            })
            
            output.output = `${output.output}\n\nSwitching to code agent for execution...`
            logger.log('Plan approval: "Execute here" — aborting architect, pending code agent switch')
            return
          }
          
          const directive = matchedLabel ? PLAN_APPROVAL_DIRECTIVES[matchedLabel] : '<system-reminder>\nThe user provided a custom response instead of selecting a predefined option. Review their answer and respond accordingly. If they want to proceed with execution, use the appropriate tool (memory-plan-execute or memory-loop) based on their intent. If they want to cancel or revise the plan, help them with that instead.\n</system-reminder>'
          output.output = `${output.output}\n\n${directive}`
          logger.log(`Plan approval: detected "${matchedLabel ?? 'cancel/custom'}" answer, injected directive`)
        }
      }
      return
    }

    const worktreeName = loopService.resolveWorktreeName(input.sessionID)
    const state = worktreeName ? loopService.getActiveState(worktreeName) : null
    if (!state?.active) return

    if (!(input.tool in LOOP_BLOCKED_TOOLS)) return

    logger.log(`Loop: blocked ${input.tool} tool in ${state.phase} phase for session ${input.sessionID}`)
    
    output.title = 'Tool blocked'
    output.output = LOOP_BLOCKED_TOOLS[input.tool]!
  }
}

export function createPlanApprovalEventHook(ctx: ToolContext) {
  const { v2, logger } = ctx
  
  return async (eventInput: { event: { type: string; properties?: Record<string, unknown> } }) => {
    if (eventInput.event?.type !== 'session.idle') return
    
    const sessionID = eventInput.event.properties?.sessionID as string
    if (!sessionID) return
    
    const pending = pendingExecutions.get(sessionID)
    if (!pending) return
    
    pendingExecutions.delete(sessionID)
    
    const inPlacePrompt = 'The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: Execute the implementation plan from this conversation. Review all phases above and implement each one.'
    
    const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
      () => v2.session.promptAsync({
        sessionID,
        directory: pending.directory,
        agent: 'code',
        parts: [{ type: 'text' as const, text: inPlacePrompt }],
        ...(pending.executionModel ? { model: pending.executionModel } : {}),
      }),
      () => v2.session.promptAsync({
        sessionID,
        directory: pending.directory,
        agent: 'code',
        parts: [{ type: 'text' as const, text: inPlacePrompt }],
      }),
      pending.executionModel,
      logger,
    )
    
    if (promptResult.error) {
      logger.error('Plan approval: failed to switch to code agent', promptResult.error)
    } else {
      const modelInfo = actualModel ? `${actualModel.providerID}/${actualModel.modelID}` : 'default'
      logger.log(`Plan approval: switched to code agent (model: ${modelInfo})`)
    }
  }
}
