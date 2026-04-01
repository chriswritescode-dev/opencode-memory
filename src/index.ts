import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
const z = tool.schema
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
import type { PluginConfig, CompactionConfig } from './types'
import { createTools, createToolExecuteBeforeHook, createToolExecuteAfterHook, autoValidateOnLoad, scopeEnum } from './tools'
import type { DimensionMismatchState, InitState, ToolContext } from './tools'
import type { VecService } from './storage/vec-types'
import { createSshClient, type SshClient } from './remote/ssh-client'
import { createMutagenSyncManager, type SyncManager, checkMutagenInstalled } from './remote/mutagen-sync'
import { createRemoteTools } from './remote/tools'
import { createRemoteSyncRegistry, type RemoteSyncRegistry } from './remote/sync-registry'
import { createRemoteStateManager, type RemoteStateManager } from './remote/state'


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

    let sshClient: SshClient | null = null
    let syncManager: SyncManager | null = null
    let remoteTools: Record<string, any> | null = null
    let syncRegistry: RemoteSyncRegistry | null = null
    let remoteStateManager: RemoteStateManager | null = null

    const remoteEnabled = config.remote?.enabled ?? false
    remoteStateManager = createRemoteStateManager(remoteEnabled, logger)

    if (remoteEnabled && config.remote) {
      try {
        sshClient = createSshClient(config.remote, logger)
        const healthy = await sshClient.healthCheck()
        if (!healthy) {
          logger.error('Remote container health check failed, continuing without remote')
          sshClient = null
        }
      } catch (err) {
        logger.error('Failed to initialize SSH client', err)
        sshClient = null
      }

      if (sshClient) {
        if (!checkMutagenInstalled()) {
          logger.error('Mutagen is not installed. Install with: brew install mutagen-io/mutagen/mutagen')
          sshClient = null
        } else {
          const mutagenSyncManager = createMutagenSyncManager(
            config.remote,
            directory,
            sshClient.getProjectDir(projectId),
            `opencode-${projectId}`,
            logger,
            sshClient,
          )
          try {
            await mutagenSyncManager.initializeAndSync()
            syncManager = mutagenSyncManager
            logger.log('Remote: initial sync complete')
          } catch (err) {
            logger.error('Remote mutagen sync initialization failed', err)
          }

          if (syncManager) {
            syncRegistry = createRemoteSyncRegistry(sshClient, syncManager, logger, config.remote)
            remoteStateManager.setConnectionInfo(config.remote.host, sshClient.getProjectDir(projectId))
            remoteStateManager.enable(sshClient, syncManager, syncRegistry)
          }
        }

        if (sshClient) {
          const allRemoteTools = createRemoteTools(
            sshClient,
            sshClient.getProjectDir(projectId),
            logger,
            (sessionId: string) => {
              const wtName = loopService.resolveWorktreeName(sessionId)
              if (!wtName) return undefined
              const state = loopService.getActiveState(wtName)
              if (!state?.worktree) return undefined
              return sshClient!.getWorktreeDir(wtName)
            },
            remoteStateManager
          )
          const excludeSet = new Set(config.remote.excludeTools ?? [])
          remoteTools = Object.fromEntries(
            Object.entries(allRemoteTools).filter(([name]) => !excludeSet.has(name))
          )
        }
      }
    }

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
    migrateRalphKeys(kvService, projectId, logger).catch(() => {})
    const reconciledCount = loopService.reconcileStale()
    if (reconciledCount > 0) {
      logger.log(`Reconciled ${reconciledCount} stale loop(s) from previous session`)
    }
    if (remoteStateManager) {
      kvService.set(projectId, 'remote:state', remoteStateManager.getState())
    }
    const loopHandler = createLoopEventHandler(loopService, client, v2, logger, () => config, syncRegistry)

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
            autoValidateOnLoad(projectId, memoryService, db, config, provider, dataDir, mismatchState, currentVec, logger, sshClient)
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
      
      loopHandler.terminateAll()
      logger.log('Memory loop: all active loops terminated')
      
      loopHandler.clearAllRetryTimeouts()
      
      if (syncManager) {
        try { await syncManager.terminate() } catch {}
      }
      
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
      sshClient,
      syncRegistry,
    }

    const tools = createTools(ctx)
    if (remoteTools && remoteStateManager) {
      // Wrap each remote tool to check state
      const wrappedRemoteTools: Record<string, any> = {}
      for (const [name, toolDef] of Object.entries(remoteTools)) {
        wrappedRemoteTools[name] = tool({
          ...(toolDef as any),
          execute: async (args: any, context: any) => {
            if (!remoteStateManager?.isEnabled()) {
              throw new Error(`Remote tool '${name}' is disabled. Use remote-toggle to enable.`)
            }
            return (toolDef.execute as any)(args, context)
          },
        })
      }
      Object.assign(tools, wrappedRemoteTools)
    }

    // Add toggle/status tools (always available)
    if (remoteStateManager) {
      tools['remote-toggle'] = tool({
        description: 'Toggle remote container integration on or off',
        args: {
          enabled: z.boolean().describe('Whether to enable or disable remote'),
        },
        execute: async (args) => {
          const newState = args.enabled
          const wasEnabled = remoteStateManager.isEnabled()
          
          if (newState === wasEnabled) {
            return `Remote is already ${newState ? 'enabled' : 'disabled'}`
          }
          
          await remoteStateManager.toggle()
          kvService.set(projectId, 'remote:state', remoteStateManager.getState())
          return `Remote ${newState ? 'enabled' : 'disabled'}`
        },
      })
      
      tools['remote-status'] = tool({
        description: 'Get current remote container status',
        args: {},
        execute: async () => {
          return JSON.stringify(remoteStateManager.getState(), null, 2)
        },
      })
    }

    const toolExecuteBeforeHook = createToolExecuteBeforeHook(ctx)
    const toolExecuteAfterHook = createToolExecuteAfterHook(ctx)

    return {
      getCleanup,
      tool: tools,
      config: createConfigHandler(
        config.auditorModel
          ? { ...agents, auditor: { ...agents.auditor, defaultModel: config.auditorModel } }
          : agents,
        config.agents,
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
        if (syncRegistry && eventInput.event?.type === 'session.idle') {
          const sessionId = (eventInput.event.properties as Record<string, unknown>)?.sessionID as string
          if (sessionId) {
            const sessionSyncManager = syncRegistry.resolveForSession(
              sessionId,
              (sid) => loopService.resolveWorktreeName(sid),
              (name) => loopService.getActiveState(name),
            )
            try {
              await sessionSyncManager.flush()
            } catch (err) {
              logger.error('Remote mutagen sync flush on idle failed', err)
            }
          }
        }
        await loopHandler.onEvent(eventInput)
        await sessionHooks.onEvent(eventInput)
      },
      'tool.execute.before': toolExecuteBeforeHook,
      'tool.execute.after': toolExecuteAfterHook,
      'permission.ask': async (input, output) => {
        const req = input as unknown as { sessionID: string; patterns: string[] }
        const worktreeName = loopService.resolveWorktreeName(req.sessionID)
        const state = worktreeName ? loopService.getActiveState(worktreeName) : null
        if (!state?.active) return

        if (req.patterns.some((p) => p.startsWith('git push'))) {
          logger.log(`Loop: denied git push for session ${req.sessionID}`)
          output.status = 'deny'
          return
        }
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
