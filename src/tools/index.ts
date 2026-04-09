import { tool } from '@opencode-ai/plugin'
import { createMemoryTools } from './memory'
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createHealthTools } from './health'
import { createPlanExecuteTools } from './plan-execute'
import { createLoopTools } from './loop'
import { createSandboxFsTools } from './sandbox-fs'
import type { ToolContext } from './types'
import { isSandboxEnabled } from '../sandbox/context'

export { autoValidateOnLoad } from './health'
export { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './plan-approval'
export { scopeEnum } from './types'
export type { ToolContext, DimensionMismatchState, InitState } from './types'

export function createTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const sandboxEnabled = isSandboxEnabled(ctx.config, ctx.sandboxManager)
  return {
    ...createMemoryTools(ctx),
    ...createReviewTools(ctx),
    ...createPlanTools(ctx),
    ...createHealthTools(ctx),
    ...createPlanExecuteTools(ctx),
    ...createLoopTools(ctx),
    ...(sandboxEnabled ? createSandboxFsTools(ctx) : {}),
  }
}
