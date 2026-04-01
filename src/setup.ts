import { readFileSync, existsSync, mkdirSync, copyFileSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { resolveDataDir, resolveLogPath } from './storage'
import type { PluginConfig, EmbeddingConfig, RemoteConfig } from './types'
import * as jsoncParser from 'jsonc-parser'
const parseJsoncLib = (jsoncParser as any).default?.parse ?? (jsoncParser as any).parse

function debugLog(msg: string): void {
  try {
    appendFileSync('/tmp/memory-config-debug.log', `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

interface ParseError {
  offset: number
  length: number
  error: number
}

function resolveBundledConfigPath(): string {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  return join(pluginDir, '..', 'config.jsonc')
}

function resolveConfigDir(): string {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.config')
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'] || defaultBase
  return join(xdgConfigHome, 'opencode')
}

export function resolveConfigPath(): string {
  return join(resolveConfigDir(), 'memory-config.jsonc')
}

function resolveOldConfigPath(): string {
  const dataDir = resolveDataDir()
  return join(dataDir, 'config.json')
}

function ensureGlobalConfig(): void {
  const configDir = resolveConfigDir()
  const newConfigPath = resolveConfigPath()

  if (existsSync(newConfigPath)) {
    return
  }

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  const oldConfigPath = resolveOldConfigPath()
  if (existsSync(oldConfigPath)) {
    copyFileSync(oldConfigPath, newConfigPath)
    return
  }

  const bundledConfigPath = resolveBundledConfigPath()
  if (existsSync(bundledConfigPath)) {
    copyFileSync(bundledConfigPath, newConfigPath)
  }
}

function getDefaultEmbeddingConfig(): EmbeddingConfig {
  return {
    provider: 'local',
    model: 'all-MiniLM-L6-v2',
    dimensions: 384,
  }
}

function getDefaultConfig(): PluginConfig {
  return {
    embedding: getDefaultEmbeddingConfig(),
    logging: {
      enabled: false,
      file: resolveLogPath(),
    },
  }
}

function isValidPluginConfig(config: unknown): config is PluginConfig {
  if (!config || typeof config !== 'object') return false

  const obj = config as Record<string, unknown>

  if (!obj.embedding || typeof obj.embedding !== 'object') return false

  const embedding = obj.embedding as Record<string, unknown>
  if (
    typeof embedding.provider !== 'string' ||
    !['openai', 'voyage', 'local'].includes(embedding.provider)
  ) {
    return false
  }

  if (typeof embedding.model !== 'string') return false

  const remote = obj.remote as Record<string, unknown> | undefined
  if (remote?.enabled === true && !remote.host) {
    return false
  }

  return true
}

function stripJsoncComments(text: string): string {
  let result = ''
  let i = 0
  let inString = false
  let escape = false

  while (i < text.length) {
    const ch = text[i]!

    if (escape) {
      result += ch
      escape = false
      i++
      continue
    }

    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      result += ch
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      result += ch
      i++
      continue
    }

    if (ch === '/' && i + 1 < text.length) {
      if (text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
        continue
      }
      if (text[i + 1] === '*') {
        i += 2
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
        i += 2
        continue
      }
    }

    result += ch
    i++
  }

  return result
}

function parseJsoncFallback<T = unknown>(content: string): T {
  const stripped = stripJsoncComments(content)
  const noTrailingCommas = stripped.replace(/,\s*([}\]])/g, '$1')
  return JSON.parse(noTrailingCommas) as T
}

function parseJsonc<T = unknown>(content: string): T {
  if (typeof parseJsoncLib === 'function') {
    const errors: ParseError[] = []
    const result = parseJsoncLib(content, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    })
    if (errors.length > 0) {
      throw new SyntaxError(`Invalid JSONC at offset ${errors[0]!.offset}`)
    }
    return result as T
  }
  debugLog('parseJsoncLib not available, using fallback parser')
  return parseJsoncFallback<T>(content)
}

export function loadPluginConfig(): PluginConfig {
  debugLog(`loadPluginConfig called, parseJsoncLib type=${typeof parseJsoncLib}`)
  ensureGlobalConfig()

  const configPath = resolveConfigPath()
  debugLog(`configPath=${configPath}, exists=${existsSync(configPath)}`)

  if (!existsSync(configPath)) {
    debugLog('Config file not found, returning defaults')
    return getDefaultConfig()
  }

  try {
    const content = readFileSync(configPath, 'utf-8')
    debugLog(`Config file read, length=${content.length}`)
    const parsed = parseJsonc(content)
    debugLog(`Config parsed successfully, remote.enabled=${(parsed as any)?.remote?.enabled}`)

    if (!isValidPluginConfig(parsed)) {
      debugLog('isValidPluginConfig returned false')
      console.warn(`[memory] Invalid config at ${configPath}, using defaults`)
      return getDefaultConfig()
    }

    debugLog('Config valid, returning normalized config')
    return normalizeConfig(parsed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    debugLog(`Error loading config: ${message}\nStack: ${err instanceof Error ? err.stack : 'N/A'}`)
    console.warn(`[memory] Failed to load config at ${configPath}: ${message}, using defaults`)
    return getDefaultConfig()
  }
}

function normalizeRemoteConfig(remote: RemoteConfig | undefined): RemoteConfig | undefined {
  if (!remote) return undefined
  
  return {
    ...remote,
    port: remote.port ?? 22,
    user: remote.user ?? 'root',
    basePath: remote.basePath ?? '/projects',
    disableLsp: remote.disableLsp ?? true,
  }
}

function normalizeConfig(config: PluginConfig): PluginConfig {
  const normalized: PluginConfig = {
    dataDir: config.dataDir,
    defaultKvTtlMs: config.defaultKvTtlMs,
    embedding: config.embedding,
    dedupThreshold: config.dedupThreshold,
    logging: config.logging,
    compaction: config.compaction,
    memoryInjection: config.memoryInjection,
    messagesTransform: config.messagesTransform,
    executionModel: config.executionModel,
    auditorModel: config.auditorModel,
    loop: config.loop ?? config.ralph,
    tui: config.tui,
    agents: config.agents,
    remote: normalizeRemoteConfig(config.remote),
  }
  
  if (config.ralph && !config.loop) {
    console.warn('[memory] Config key "ralph" is deprecated, use "loop" instead')
  }
  
  if (normalized.embedding) {
    const embedding = { ...normalized.embedding }
    
    if (embedding.baseUrl === '') {
      delete embedding.baseUrl
    }
    
    if (embedding.apiKey === '') {
      delete embedding.apiKey
    }
    
    normalized.embedding = embedding
  }
  
  return normalized
}
