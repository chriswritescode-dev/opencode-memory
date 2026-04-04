import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

export interface SessionStats {
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  messages: {
    total: number
    assistant: number
  }
  fileChanges: {
    additions: number
    deletions: number
    files: number
  } | null
  timing: {
    created: string
    updated: string
    durationMs: number
  } | null
  lastAssistantMessage: {
    text: string
    parts: Array<{ type: string; text?: string }>
  } | null
}

export async function fetchSessionStats(
  api: TuiPluginApi,
  sessionId: string,
  directory: string,
): Promise<SessionStats | null> {
  if (!directory || !sessionId) {
    return null
  }

  try {
    const messagesResult = await api.client.session.messages({
      sessionID: sessionId,
      directory,
    })

    const messages = (messagesResult.data ?? []) as Array<{
      info: {
        role: string
        cost?: number
        tokens?: {
          input: number
          output: number
          reasoning: number
          cache: { read: number; write: number }
        }
      }
      parts: Array<{ type: string; text?: string }>
    }>

    const assistantMessages = messages.filter((m) => m.info.role === 'assistant')
    const lastAssistantMessage =
      assistantMessages.length > 0
        ? {
            text: assistantMessages[assistantMessages.length - 1].parts
              .filter((p) => p.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text as string)
              .join('\n'),
            parts: assistantMessages[assistantMessages.length - 1].parts,
          }
        : null

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalReasoningTokens = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0
    let totalCost = 0

    for (const msg of messages) {
      totalCost += msg.info.cost ?? 0
      const tokens = msg.info.tokens
      if (tokens) {
        totalInputTokens += tokens.input ?? 0
        totalOutputTokens += tokens.output ?? 0
        totalReasoningTokens += tokens.reasoning ?? 0
        totalCacheRead += tokens.cache?.read ?? 0
        totalCacheWrite += tokens.cache?.write ?? 0
      }
    }

    const sessionResult = await api.client.session.get({
      sessionID: sessionId,
      directory,
    })
    const session = sessionResult.data as
      | {
          summary?: { additions: number; deletions: number; files: number }
          time?: { created: string; updated: string }
        }
      | undefined

    const fileChanges = session?.summary
      ? {
          additions: session.summary.additions,
          deletions: session.summary.deletions,
          files: session.summary.files,
        }
      : null

    const timing = session?.time?.created && session?.time?.updated
      ? {
          created: session.time.created,
          updated: session.time.updated,
          durationMs:
            new Date(session.time.updated).getTime() -
            new Date(session.time.created).getTime(),
        }
      : null

    return {
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        reasoning: totalReasoningTokens,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total:
          totalInputTokens +
          totalOutputTokens +
          totalReasoningTokens +
          totalCacheRead +
          totalCacheWrite,
      },
      cost: totalCost,
      messages: {
        total: messages.length,
        assistant: assistantMessages.length,
      },
      fileChanges,
      timing,
      lastAssistantMessage,
    }
  } catch {
    return null
  }
}
