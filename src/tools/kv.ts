import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { execSync } from 'child_process'

const z = tool.schema

export function createKvTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { kvService, projectId, logger, loopService } = ctx

  const PLAN_CURRENT_KEY = 'plan:current'

  function resolvePlanKey(key: string, sessionID: string): string {
    return key === PLAN_CURRENT_KEY ? `plan:${sessionID}` : key
  }

  function injectBranchField(value: unknown, directory: string): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    const active = loopService.listActive()
    const loop = active.find((s) => s.worktreeDir === directory)
    if (loop?.worktreeBranch) {
      ;(value as Record<string, unknown>).branch = loop.worktreeBranch
    } else {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: directory, encoding: 'utf-8' }).trim()
        if (branch) {
          ;(value as Record<string, unknown>).branch = branch
        }
      } catch {
        // git not available or not a repo
      }
    }
  }

  return {
    'memory-kv-set': tool({
      description: 'Store a key-value pair for the current project. Values expire after 7 days by default. Keys prefixed with "review-finding:" get an automatic "branch" field injected. Supports line-based editing via offset/limit parameters.',
      args: {
        key: z.string().describe('The key to store the value under'),
        value: z.string().describe('The value to store (JSON string)'),
        ttlMs: z.number().optional().describe('Time-to-live in milliseconds (default: 7 days)'),
        offset: z.number().optional().describe('Line number to start editing at (1-indexed). Requires existing key.'),
        limit: z.number().optional().default(0).describe('Number of lines to replace starting at offset (0 = insert without removing)'),
        append: z.boolean().optional().describe('Append value to existing content instead of overwriting'),
      },
      execute: async (args, context) => {
        logger.log(`memory-kv-set: key="${args.key}"`)
        const resolvedKey = resolvePlanKey(args.key, context.sessionID)

        // Line editing mode - stores raw string, not compatible with branch injection
        if (args.offset !== undefined) {
          if (args.key.startsWith('review-finding:')) {
            return `Line editing (offset parameter) is not supported for "review-finding:" keys. Use full overwrite mode to ensure branch field is properly injected.`
          }
          const existing = kvService.get<string>(projectId, resolvedKey)
          if (existing === null) {
            return `Key "${args.key}" not found. Cannot edit lines of a non-existent key.`
          }
          const existingStr = typeof existing === 'string' ? existing : JSON.stringify(existing, null, 2)
          const lines = existingStr.split('\n')
          let idx = args.offset - 1
          if (idx < 0) idx = 0
          if (idx > lines.length) idx = lines.length
          const newLines = args.value.split('\n')
          const limit = args.limit ?? 0
          if (limit < 0) return `Invalid limit: ${limit}. Limit must be non-negative.`
          lines.splice(idx, limit, ...newLines)
          const result = lines.join('\n')
          kvService.set(projectId, resolvedKey, result, args.ttlMs)
          const expiresAt = new Date(Date.now() + (args.ttlMs ?? 7 * 24 * 60 * 60 * 1000))
          logger.log(`memory-kv-set: updated key="${args.key}" (${lines.length} lines), expires=${expiresAt.toISOString()}`)
          return `Updated key "${args.key}" (${lines.length} lines, expires ${expiresAt.toISOString()})`
        }

        // Append mode - stores raw string, not compatible with branch injection
        if (args.append === true) {
          if (args.key.startsWith('review-finding:')) {
            return `Append mode is not supported for "review-finding:" keys. Use full overwrite mode to ensure branch field is properly injected.`
          }
          const existing = kvService.get<string>(projectId, resolvedKey)
          let result: string
          if (existing === null) {
            result = args.value
          } else {
            const existingStr = typeof existing === 'string' ? existing : JSON.stringify(existing, null, 2)
            result = `${existingStr}\n${args.value}`
          }
          kvService.set(projectId, resolvedKey, result, args.ttlMs)
          const lineCount = result.split('\n').length
          const expiresAt = new Date(Date.now() + (args.ttlMs ?? 7 * 24 * 60 * 60 * 1000))
          logger.log(`memory-kv-set: appended to key="${args.key}" (${lineCount} lines), expires=${expiresAt.toISOString()}`)
          return `Appended to key "${args.key}" (${lineCount} lines, expires ${expiresAt.toISOString()})`
        }

        // Full overwrite mode (backward compat) - supports branch injection
        let parsed: unknown
        try {
          parsed = JSON.parse(args.value)
        } catch {
          parsed = args.value
        }

        if (args.key.startsWith('review-finding:') && typeof parsed === 'object' && parsed !== null) {
          injectBranchField(parsed, context.directory)
        }

        kvService.set(projectId, resolvedKey, parsed, args.ttlMs)
        const expiresAt = new Date(Date.now() + (args.ttlMs ?? 7 * 24 * 60 * 60 * 1000))
        logger.log(`memory-kv-set: stored key="${args.key}", expires=${expiresAt.toISOString()}`)
        return `Stored key "${args.key}" (expires ${expiresAt.toISOString()})`
      },
    }),

    'memory-kv-get': tool({
      description: 'Retrieve a value by key for the current project. Returns line-numbered output. Supports offset/limit for pagination.',
      args: {
        key: z.string().describe('The key to retrieve'),
        offset: z.number().optional().describe('Line number to start from (1-indexed)'),
        limit: z.number().optional().describe('Maximum number of lines to return'),
      },
      execute: async (args, context) => {
        logger.log(`memory-kv-get: key="${args.key}"`)
        const resolvedKey = resolvePlanKey(args.key, context.sessionID)
        const value = kvService.get(projectId, resolvedKey)
        if (value === null) {
          logger.log(`memory-kv-get: key="${args.key}" not found`)
          return `No value found for key "${args.key}"`
        }
        logger.log(`memory-kv-get: key="${args.key}" found`)
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        const lines = valueStr.split('\n')
        const totalLines = lines.length

        let resultLines = lines
        if (args.offset !== undefined) {
          const startIdx = args.offset - 1
          resultLines = resultLines.slice(Math.max(0, startIdx))
        }
        if (args.limit !== undefined) {
          resultLines = resultLines.slice(0, args.limit)
        }

        const numberedLines = resultLines.map((line, i) => {
          const originalLineNum = args.offset !== undefined ? args.offset + i : i + 1
          return `${originalLineNum}: ${line}`
        })

        const header = `(${totalLines} lines total)`
        return `${header}\n${numberedLines.join('\n')}`
      },
    }),

    'memory-kv-list': tool({
      description: 'Lists all active key-value pairs when called with no arguments. Optionally filter by key prefix.',
      args: {
        prefix: z.string().optional().describe('Filter entries by key prefix (e.g. "review-finding:")'),
      },
      execute: async (args) => {
        logger.log(`memory-kv-list: prefix="${args.prefix ?? 'none'}"`)
        const entries = args.prefix
          ? kvService.listByPrefix(projectId, args.prefix)
          : kvService.list(projectId)
        if (entries.length === 0) {
          logger.log('memory-kv-list: no entries')
          return 'No active KV entries for this project.'
        }
        const formatted = entries.map((e) => {
          const expiresIn = Math.round((e.expiresAt - Date.now()) / 60000)
          const dataStr = typeof e.data === 'string' ? e.data : JSON.stringify(e.data)
          const preview = dataStr.substring(0, 50).replace(/\n/g, ' ')
          return `- **${e.key}** (expires in ${expiresIn}m): ${preview}${dataStr.length > 50 ? '...' : ''}`
        })
        logger.log(`memory-kv-list: ${entries.length} entries`)
        return `${entries.length} active KV entries:\n\n${formatted.join('\n')}`
      },
    }),

    'memory-kv-delete': tool({
      description: 'Delete a key-value pair for the current project.',
      args: {
        key: z.string().describe('The key to delete'),
      },
      execute: async (args, context) => {
        logger.log(`memory-kv-delete: key="${args.key}"`)
        const resolvedKey = resolvePlanKey(args.key, context.sessionID)
        kvService.delete(projectId, resolvedKey)
        return `Deleted key "${args.key}"`
      },
    }),

    'memory-kv-search': tool({
      description: 'Search KV values by regex pattern. Returns matching lines with line numbers, grouped by key — like grep across files. Optionally scope to a single key or a key prefix.',
      args: {
        pattern: z.string().describe('Regex pattern to search for in KV values'),
        key: z.string().optional().describe('Search only this specific key. If omitted, searches all keys.'),
        prefix: z.string().optional().describe('Filter keys by prefix before searching (e.g. "plan:", "review-finding:")'),
      },
      execute: async (args, context) => {
        logger.log(`memory-kv-search: pattern="${args.pattern}" key="${args.key ?? ''}" prefix="${args.prefix ?? ''}"`)

        let regex: RegExp
        try {
          regex = new RegExp(args.pattern)
        } catch (e) {
          return `Invalid regex pattern: ${(e as Error).message}`
        }

        let entries: Array<{ key: string; data: unknown }>
        if (args.key !== undefined) {
          const resolvedKey = resolvePlanKey(args.key, context.sessionID)
          const value = kvService.get(projectId, resolvedKey)
          if (value === null) return `No value found for key "${args.key}"`
          entries = [{ key: args.key, data: value }]
        } else if (args.prefix !== undefined) {
          entries = kvService.listByPrefix(projectId, args.prefix)
        } else {
          entries = kvService.list(projectId)
        }

        const MAX_MATCHES = 100
        const grouped = new Map<string, Array<{ lineNum: number; text: string }>>()
        let totalMatches = 0
        let truncated = false

        outer: for (const entry of entries) {
          const valueStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)
          const lines = valueStr.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const text = lines[i]
            if (!regex.test(text)) continue
            if (totalMatches >= MAX_MATCHES) {
              truncated = true
              break outer
            }
            const truncatedText = text.length > 2000 ? `${text.slice(0, 1997)}...` : text
            if (!grouped.has(entry.key)) grouped.set(entry.key, [])
            grouped.get(entry.key)!.push({ lineNum: i + 1, text: truncatedText })
            totalMatches++
          }
        }

        if (totalMatches === 0) return 'No matches found'

        const keyCount = grouped.size
        const outputParts: string[] = [`Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} across ${keyCount} key${keyCount === 1 ? '' : 's'}`]

        for (const [key, matches] of grouped) {
          outputParts.push('')
          outputParts.push(`key: ${key}`)
          for (const m of matches) {
            outputParts.push(`  Line ${m.lineNum}: ${m.text}`)
          }
        }

        if (truncated) {
          outputParts.push('')
          outputParts.push('(Results truncated: showing first 100 matches. Use a more specific pattern or scope to a key/prefix.)')
        }

        logger.log(`memory-kv-search: found ${totalMatches} matches across ${keyCount} keys`)
        return outputParts.join('\n')
      },
    }),
  }
}
