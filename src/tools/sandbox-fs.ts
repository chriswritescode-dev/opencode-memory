import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { toContainerPath, rewriteOutput } from '../sandbox/path'
import { getSandboxForSession } from '../sandbox/context'

const z = tool.schema

export function createSandboxFsTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  return {
    glob: tool({
      description: [
        '- Fast file pattern matching tool that works with any codebase size',
        '- Supports glob patterns like "**/*.js" or "src/**/*.ts"',
        '- Returns matching file paths sorted by modification time',
        '- Use this tool when you need to find files by name patterns',
        '- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead',
        '- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.',
      ].join('\n'),
      args: {
        pattern: z.string().describe('The glob pattern to match files against'),
        path: z.string().optional().describe(
          'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.'
        ),
      },
      execute: async (args, context) => {
        const sandbox = getSandboxForSession(ctx, context.sessionID)
        if (!sandbox) return 'Glob tool requires sandbox context.'

        const { docker, containerName, hostDir } = sandbox
        const searchPath = args.path
          ? toContainerPath(args.path, hostDir)
          : '/workspace'

        const safePattern = args.pattern.replace(/'/g, "'\\''")
        const cmd = `rg --files --glob '${safePattern}' '${searchPath}' 2>/dev/null | head -100`

        try {
          const result = await docker.exec(containerName, cmd, { timeout: 30000 })

          if (!result.stdout.trim()) return 'No files found'

          const lines = result.stdout.trim().split('\n').filter(Boolean)
          const rewritten = lines.map(l => rewriteOutput(l, hostDir))

          let output = rewritten.join('\n')
          if (lines.length >= 100) {
            output += '\n\n(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)'
          }
          return output
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return `Glob failed: ${message}`
        }
      },
    }),

    grep: tool({
      description: [
        '- Fast content search tool that works with any codebase size',
        '- Searches file contents using regular expressions',
        '- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)',
        '- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")',
        '- Returns file paths and line numbers with at least one match sorted by modification time',
        '- Use this tool when you need to find files containing specific patterns',
        '- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.',
        '- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead',
      ].join('\n'),
      args: {
        pattern: z.string().describe('The regex pattern to search for in file contents'),
        path: z.string().optional().describe('The directory to search in. Defaults to the current working directory.'),
        include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      },
      execute: async (args, context) => {
        const sandbox = getSandboxForSession(ctx, context.sessionID)
        if (!sandbox) return 'Grep tool requires sandbox context.'

        const { docker, containerName, hostDir } = sandbox
        const searchPath = args.path
          ? toContainerPath(args.path, hostDir)
          : '/workspace'

        const safePattern = args.pattern.replace(/'/g, "'\\''")
        let cmd = `rg -nH --hidden --no-messages --field-match-separator='|' --regexp '${safePattern}'`
        if (args.include) {
          const safeInclude = args.include.replace(/'/g, "'\\''")
          cmd += ` --glob '${safeInclude}'`
        }
        cmd += ` '${searchPath}' 2>/dev/null | head -100`

        try {
          const result = await docker.exec(containerName, cmd, { timeout: 30000 })

          if (!result.stdout.trim()) return 'No files found'

          const lines = result.stdout.trim().split('\n').filter(Boolean)
          const grouped = new Map<string, Array<{ line: number; text: string }>>()

          for (const line of lines) {
            const parts = line.split('|')
            if (parts.length < 3) continue
            const filePath = rewriteOutput(parts[0], hostDir)
            const lineNum = parseInt(parts[1], 10)
            const text = parts.slice(2).join('|')
            const truncatedText = text.length > 2000 ? text.slice(0, 1997) + '...' : text
            if (!grouped.has(filePath)) grouped.set(filePath, [])
            grouped.get(filePath)!.push({ line: lineNum, text: truncatedText })
          }

          let totalMatches = 0
          const outputParts: string[] = []
          outputParts.push(`Found ${lines.length} matches`)

          for (const [filePath, matches] of grouped) {
            outputParts.push(`${filePath}:`)
            for (const m of matches) {
              outputParts.push(`  Line ${m.line}: ${m.text}`)
              totalMatches++
            }
            outputParts.push('')
          }

          if (lines.length >= 100) {
            outputParts.push('(Results truncated: showing 100 of possibly more matches. Consider using a more specific path or pattern.)')
          }

          return outputParts.join('\n')
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return `Grep failed: ${message}`
        }
      },
    }),
  }
}
