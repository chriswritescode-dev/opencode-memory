import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import { agents } from './agents'
import { createConfigHandler } from './config'
import { createSessionHooks, createMemoryInjectionHook, createLoopEventHandler } from './hooks'
import { initializeDatabase, resolveDataDir, closeDatabase } from './storage'
import { createVecService, createNoopVecService } from './storage/vec'
import { createEmbeddingProvider, killEmbeddingServer } from './embedding'
import { createMemoryService } from './services/memory'
import { createEmbeddingSyncService } from './services/embedding-sync'
import { createKvService } from './services/kv'
import { createLoopService, migrateRalphKeys } from './services/loop'
import { loadPluginConfig } from './setup'
import { resolveLogPath } from './storage'
import { createLogger } from './utils/logger'
import { createDockerService } from './sandbox/docker'
import { createSandboxManager } from './sandbox/manager'
import type { PluginConfig, CompactionConfig } from './types'
import { createTools, createToolExecuteBeforeHook, createToolExecuteAfterHook, autoValidateOnLoad, createPlanApprovalEventHook } from './tools'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from './hooks/sandbox-tools'
import type { DimensionMismatchState, ToolContext } from './tools'
import type { VecService } from './storage/vec-types'


export function createMemoryPlugin(config: PluginConfig): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const { directory, project, client } = input
    const projectId = project.id

    const serverUrl = input.serverUrl
    const serverPassword = serverUrl.password || process.env['OPENCODE_SERVER_PASSWORD']
    const cleanUrl = new URL(serverUrl.toString())
    cleanUrl.username = ''
    cleanUrl.password = ''
    const v2ClientConfig: Parameters<typeof createV2Client>[0] = { baseUrl: cleanUrl.toString(), directory }
    if (serverPassword) {
      v2ClientConfig.headers = {
        Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`,
      }
    }
    const v2 = createV2Client(v2ClientConfig)

    const loggingConfig = config.logging
    const logger = createLogger({
      enabled: loggingConfig?.enabled ?? false,
      file: loggingConfig?.file ?? resolveLogPath(),
      debug: loggingConfig?.debug ?? false,
    })
    logger.log(`Initializing plugin for directory: ${directory}, projectId: ${projectId}`)

    const provider = createEmbeddingProvider(config.embedding)
    provider.warmup()

    const dataDir = config.dataDir ?? resolveDataDir()
    
    if (config.embedding.provider !== 'local') {
      killEmbeddingServer(dataDir).catch(() => {})
    }
    
    const db = initializeDatabase(dataDir)
    const dimensions = config.embedding.dimensions ?? provider.dimensions

    const noopVec = createNoopVecService()
    const memoryService = await createMemoryService({
      db,
      provider,
      vec: noopVec,
      logger,
    })

    if (config.dedupThreshold) {
      memoryService.setDedupThreshold(config.dedupThreshold)
    }

    const kvService = createKvService(db, logger, config.defaultKvTtlMs)

    const loopService = createLoopService(kvService, projectId, logger, config.loop)
    try {
      migrateRalphKeys(kvService, projectId, logger)
    } catch (err) {
      logger.error('Failed to migrate ralph: KV entries', err)
    }

    const activeSandboxLoops = loopService.listActive().filter(s => s.sandbox && s.worktreeName)

    const reconciledCount = loopService.reconcileStale()
    if (reconciledCount > 0) {
      logger.log(`Reconciled ${reconciledCount} stale loop(s) from previous session`)
    }

    let sandboxManager: ReturnType<typeof createSandboxManager> | null = null
    if (config.sandbox?.mode === 'docker') {
      const dockerService = createDockerService(logger)
      try {
        sandboxManager = createSandboxManager(dockerService, {
          image: config.sandbox?.image || 'ocm-sandbox:latest',
        }, logger)
        logger.log('Docker sandbox manager initialized')
      } catch (err) {
        logger.error('Failed to initialize Docker sandbox manager', err)
      }
    }

    if (sandboxManager) {
      const preserveWorktrees = activeSandboxLoops.map(s => s.worktreeName)
      sandboxManager.cleanupOrphans(preserveWorktrees).then(async (count) => {
        if (count > 0) logger.log(`Cleaned up ${count} orphaned sandbox container(s)`)
        for (const loop of activeSandboxLoops) {
          try {
            await sandboxManager!.restore(loop.worktreeName, loop.worktreeDir, loop.startedAt)
            loopService.setState(loop.worktreeName, { ...loop, active: true })
            logger.log(`Restored sandbox and reactivated loop for ${loop.worktreeName}`)
          } catch (err) {
            logger.error(`Failed to restore sandbox for ${loop.worktreeName}`, err)
          }
        }
      }).catch((err) => logger.error('Failed to cleanup orphaned containers', err))
    }

    const loopHandler = createLoopEventHandler(loopService, client, v2, logger, () => config, sandboxManager || undefined)

    const mismatchState: DimensionMismatchState = {
      detected: false,
      expected: null,
      actual: null,
    }

    const initState = {
      vecReady: false,
      syncRunning: false,
      syncComplete: false,
    }

    let currentVec: VecService = noopVec

    createVecService(db, dataDir, dimensions, logger)
      .then(async (vec) => {
        currentVec = vec
        memoryService.setVecService(vec)

        if (!vec.available) {
          logger.log('Vec service unavailable, skipping embedding sync')
          return
        }

        logger.log('Vec service initialized')
        initState.vecReady = true

        const tableInfo = await vec.getDimensions()
        if (tableInfo.exists && tableInfo.dimensions !== null && tableInfo.dimensions !== dimensions) {
          logger.log(`Dimension mismatch detected: config=${dimensions}, table=${tableInfo.dimensions}, auto-recreating`)
          await vec.recreateTable(dimensions)
        }

        const embeddingSync = createEmbeddingSyncService(memoryService, logger)
        initState.syncRunning = true
        embeddingSync.start().then(
          () => {
            initState.syncRunning = false
            initState.syncComplete = true
            autoValidateOnLoad(projectId, memoryService, db, config, provider, dataDir, mismatchState, currentVec, logger)
              .catch((err: unknown) => {
                logger.error('Auto-validate failed', err)
              })
          },
          (err: unknown) => {
            initState.syncRunning = false
            logger.error('Embedding sync failed', err)
          }
        )
      })
      .catch((err: unknown) => {
        logger.error('Vec service initialization failed', err)
      })

    const compactionConfig: CompactionConfig | undefined = config.compaction
    const memoryInjectionConfig = config.memoryInjection
    const messagesTransformConfig = config.messagesTransform
    const sessionHooks = createSessionHooks(projectId, memoryService, logger, input, compactionConfig)
    const memoryInjection = createMemoryInjectionHook({
      projectId,
      memoryService,
      logger,
      config: memoryInjectionConfig,
    })
    const injectedMessageIds = new Set<string>()

    let cleaned = false
    const cleanup = async () => {
      if (cleaned) return
      cleaned = true
      logger.log('Cleaning up plugin resources...')
      
      if (sandboxManager) {
        const activeLoops = loopService.listActive()
        for (const state of activeLoops) {
          if (state.sandbox && sandboxManager) {
            try {
              await sandboxManager.stop(state.worktreeName)
              logger.log(`Cleanup: stopped sandbox for ${state.worktreeName}`)
            } catch (err) {
              logger.error(`Cleanup: failed to stop sandbox for ${state.worktreeName}`, err)
            }
          }
        }
      }

      loopHandler.terminateAll()
      logger.log('Memory loop: all active loops terminated')
      
      loopHandler.clearAllRetryTimeouts()
      
      memoryInjection.destroy()
      await memoryService.destroy()
      closeDatabase(db)
      logger.log('Plugin cleanup complete')
    }

    process.once('exit', cleanup)
    process.once('SIGINT', cleanup)
    process.once('SIGTERM', cleanup)

    const getCleanup = cleanup

    const ctx: ToolContext = {
      projectId,
      directory,
      config,
      logger,
      db,
      provider,
      dataDir,
      memoryService,
      kvService,
      loopService,
      loopHandler,
      memoryInjection,
      v2,
      mismatchState,
      initState,
      getCurrentVec: () => currentVec,
      cleanup,
      input,
      sandboxManager,
    }

    const tools = createTools(ctx)
    const toolExecuteBeforeHook = createToolExecuteBeforeHook(ctx)
    const toolExecuteAfterHook = createToolExecuteAfterHook(ctx)
    const planApprovalEventHook = createPlanApprovalEventHook(ctx)
    const sandboxBeforeHook = createSandboxToolBeforeHook({
      loopService,
      sandboxManager,
      logger,
    })
    const sandboxAfterHook = createSandboxToolAfterHook({
      loopService,
      sandboxManager,
      logger,
    })

    return {
      getCleanup,
      tool: tools,
      config: createConfigHandler(
        config.auditorModel
          ? { ...agents, auditor: { ...agents.auditor, defaultModel: config.auditorModel } }
          : agents,
        config.agents
      ),
      'chat.message': async (input, output) => {
        await sessionHooks.onMessage(input, output)
      },
      event: async (input) => {
        const eventInput = input as { event: { type: string; properties?: Record<string, unknown> } }
        if (eventInput.event?.type === 'server.instance.disposed') {
          cleanup()
          return
        }
        await loopHandler.onEvent(eventInput)
        await sessionHooks.onEvent(eventInput)
        await planApprovalEventHook(eventInput)
      },
      'tool.execute.before': async (input, output) => {
        const worktree = loopService.resolveWorktreeName(input.sessionID)
        if (worktree) {
          logger.log(`[tool-before] ${input.tool} callID=${input.callID} session=${input.sessionID} worktree=${worktree}`)
        }
        await toolExecuteBeforeHook!(input, output)
        await sandboxBeforeHook!(input, output)
      },
      'tool.execute.after': async (input, output) => {
        const worktree = loopService.resolveWorktreeName(input.sessionID)
        if (worktree) {
          logger.log(`[tool-after] ${input.tool} callID=${input.callID} output=${output.output?.slice(0, 200)}`)
        }
        await sandboxAfterHook!(input, output)
        await toolExecuteAfterHook!(input, output)
      },
      'permission.ask': async (input, output) => {
        const worktreeName = loopService.resolveWorktreeName(input.sessionID)
        const state = worktreeName ? loopService.getActiveState(worktreeName) : null
        if (!state?.active) return

        const patterns = Array.isArray(input.pattern) ? input.pattern : (input.pattern ? [input.pattern] : [])

        if (patterns.some((p) => p.startsWith('git push'))) {
          logger.log(`Loop: denied git push for session ${input.sessionID}`)
          output.status = 'deny'
          return
        }

        logger.log(`Loop: auto-allowing ${input.type} [${patterns.join(', ')}] for session ${input.sessionID}`)
        output.status = 'allow'
      },
      'experimental.session.compacting': async (input, output) => {
        logger.log(`Compacting triggered`)
        await sessionHooks.onCompacting(
          input as { sessionID: string },
          output as { context: string[]; prompt?: string }
        )
      },
      'experimental.chat.messages.transform': async (
        _input: Record<string, never>,
        output: { messages: Array<{ info: { role: string; agent?: string; id?: string }; parts: Array<Record<string, unknown>> }> }
      ) => {
        const messages = output.messages
        let userMessage: typeof messages[number] | undefined
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].info.role === 'user') {
            userMessage = messages[i]
            break
          }
        }

        if (!userMessage) return

        const messageId = userMessage.info.id
        const alreadyInjected = messageId ? injectedMessageIds.has(messageId) : false

        if (!alreadyInjected) {
          const textParts = userMessage.parts
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text as string)
          const userText = textParts.join('\n').trim()

          if (userText.length > 0) {
            const memoryInjectionEnabled = config.memoryInjection?.enabled ?? true
            if (memoryInjectionEnabled) {
              const injected = await memoryInjection.handler(userText)
              if (injected) {
                userMessage.parts.push({
                  type: 'text',
                  text: injected,
                  synthetic: true,
                })
              }
            }
          }

          if (messageId) {
            injectedMessageIds.add(messageId)
            if (injectedMessageIds.size > 100) {
              const first = injectedMessageIds.values().next().value
              if (first) injectedMessageIds.delete(first)
            }
          }
        }

        const messagesTransformEnabled = messagesTransformConfig?.enabled ?? true
        if (!messagesTransformEnabled) return

        const isArchitect = userMessage.info.agent === agents.architect.displayName
        if (!isArchitect) return

        userMessage.parts.push({
          type: 'text',
          text: `<system-reminder>
Plan mode is active. You MUST NOT make any file edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

You may ONLY: observe, analyze, plan, and use memory tools (memory-read, memory-write, memory-edit, memory-delete, memory-kv-set, memory-kv-get, memory-kv-list, memory-kv-delete), the question tool, memory-plan-execute, and memory-loop.

You MUST always present your plan to the user for explicit approval before proceeding. Never execute a plan without approval. Use the question tool to collect approval — never ask for approval via plain text output.
</system-reminder>`,
          synthetic: true,
        })
      },
    } as Hooks & { getCleanup: () => Promise<void> }
  }
}

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const config = loadPluginConfig()
  const factory = createMemoryPlugin(config)
  return factory(input)
}

const pluginModule = {
  id: '@opencode-manager/memory',
  server: plugin,
}

export default pluginModule
export type { PluginConfig, CompactionConfig } from './types'
export { VERSION } from './version'
