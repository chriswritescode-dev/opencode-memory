import { tool } from '@opencode-ai/plugin'
import type { ToolDefinition } from '@opencode-ai/plugin'
import type { SshClient } from './ssh-client'
import type { Logger } from '../types'

const z = tool.schema

function resolvePath(filePath: string, projectDir: string): string {
  if (filePath.startsWith('/')) return filePath
  return `${projectDir}/${filePath}`
}

export function createRemoteTools(
  sshClient: SshClient,
  projectId: string,
  logger: Logger,
): Record<string, ToolDefinition> {
  const projectDir = sshClient.getProjectDir(projectId)

  return {
    bash: tool({
      description: 'Execute a bash command on the remote container via SSH',
      args: {
        command: z.string().describe('The bash command to execute'),
        description: z.string().optional().describe('Description of what the command does'),
        timeout: z.number().optional().describe('Command timeout in milliseconds'),
        workdir: z.string().optional().describe('Working directory for the command (relative to project root)'),
      },
      execute: async (args) => {
        const cwd = args.workdir ? resolvePath(args.workdir, projectDir) : projectDir
        logger.debug(`Remote bash: ${args.command} (cwd: ${cwd})`)

        const result = await sshClient.exec(args.command, cwd)

        let output = `Exit code: ${result.exitCode}\n${result.stdout}`
        if (result.stderr) {
          output += `\nSTDERR: ${result.stderr}`
        }
        return output
      },
    }),

    read: tool({
      description: 'Read a file from the remote container via SSH',
      args: {
        filePath: z.string().describe('Path to the file to read'),
        offset: z.number().optional().describe('Line number to start from (1-indexed)'),
        limit: z.number().optional().describe('Maximum number of lines to read'),
      },
      execute: async (args) => {
        const resolvedPath = resolvePath(args.filePath, projectDir)
        logger.debug(`Remote read: ${resolvedPath}`)

        let content: string
        let startLine = 1
        if (args.offset !== undefined && args.limit !== undefined) {
          const sedCommand = `sed -n '${args.offset},${args.offset + args.limit - 1}p' "${resolvedPath}"`
          const result = await sshClient.exec(sedCommand)
          if (result.exitCode !== 0) {
            throw new Error(`Failed to read ${resolvedPath}: ${result.stderr}`)
          }
          content = result.stdout
          startLine = args.offset
        } else if (args.offset !== undefined) {
          const sedCommand = `sed -n '${args.offset},\$p' "${resolvedPath}"`
          const result = await sshClient.exec(sedCommand)
          if (result.exitCode !== 0) {
            throw new Error(`Failed to read ${resolvedPath}: ${result.stderr}`)
          }
          content = result.stdout
          startLine = args.offset
        } else {
          content = await sshClient.readFile(resolvedPath)
        }

        const lines = content.split('\n')
        const numbered = lines.map((line, i) => `${startLine + i}: ${line}`).join('\n')
        return numbered
      },
    }),

    write: tool({
      description: 'Write content to a file on the remote container via SSH',
      args: {
        filePath: z.string().describe('Path to the file to write'),
        content: z.string().describe('Content to write to the file'),
      },
      execute: async (args) => {
        const resolvedPath = resolvePath(args.filePath, projectDir)
        logger.debug(`Remote write: ${resolvedPath} (${args.content.length} bytes)`)

        await sshClient.writeFile(resolvedPath, args.content)
        return `Written ${args.content.length} bytes to ${args.filePath}`
      },
    }),

    edit: tool({
      description: 'Edit a file by replacing text on the remote container via SSH',
      args: {
        filePath: z.string().describe('Path to the file to edit'),
        oldText: z.string().describe('Text to find and replace'),
        newText: z.string().describe('Replacement text'),
      },
      execute: async (args) => {
        const resolvedPath = resolvePath(args.filePath, projectDir)
        logger.debug(`Remote edit: ${resolvedPath}`)

        const content = await sshClient.readFile(resolvedPath)
        if (!content.includes(args.oldText)) {
          throw new Error(`Text to replace not found in ${args.filePath}`)
        }

        const newContent = content.replace(args.oldText, args.newText)
        await sshClient.writeFile(resolvedPath, newContent)
        return `Edited ${args.filePath}`
      },
    }),

    multiedit: tool({
      description: 'Apply multiple edits to a file on the remote container via SSH',
      args: {
        filePath: z.string().describe('Path to the file to edit'),
        edits: z.array(z.object({
          oldText: z.string().describe('Text to find and replace'),
          newText: z.string().describe('Replacement text'),
        })).describe('Array of edits to apply'),
      },
      execute: async (args) => {
        const resolvedPath = resolvePath(args.filePath, projectDir)
        logger.debug(`Remote multiedit: ${resolvedPath} (${args.edits.length} edits)`)

        let content = await sshClient.readFile(resolvedPath)
        for (const edit of args.edits) {
          if (!content.includes(edit.oldText)) {
            throw new Error(`Text to replace not found in ${args.filePath}: ${edit.oldText.substring(0, 50)}...`)
          }
          content = content.replace(edit.oldText, edit.newText)
        }

        await sshClient.writeFile(resolvedPath, content)
        return `Applied ${args.edits.length} edits to ${args.filePath}`
      },
    }),

    ls: tool({
      description: 'List directory contents on the remote container via SSH',
      args: {
        path: z.string().optional().describe('Directory path to list (defaults to project root)'),
      },
      execute: async (args) => {
        const resolvedPath = args.path ? resolvePath(args.path, projectDir) : projectDir
        logger.debug(`Remote ls: ${resolvedPath}`)

        const result = await sshClient.exec(`ls -la "${resolvedPath}"`)
        return result.stdout
      },
    }),

    glob: tool({
      description: 'Find files matching a glob pattern on the remote container via SSH',
      args: {
        pattern: z.string().describe('Glob pattern to match'),
        path: z.string().optional().describe('Base path to search from (defaults to project root)'),
      },
      execute: async (args) => {
        const basePath = args.path ? resolvePath(args.path, projectDir) : projectDir
        logger.debug(`Remote glob: ${args.pattern} (basePath: ${basePath})`)

        const result = await sshClient.exec(`find "${basePath}" -path "${args.pattern}" -type f 2>/dev/null | head -200`)
        const files = result.stdout.split('\n').filter(line => line.trim() !== '')
        return files.join('\n')
      },
    }),

    grep: tool({
      description: 'Search for a pattern in files on the remote container via SSH',
      args: {
        pattern: z.string().describe('Regex pattern to search for'),
        path: z.string().optional().describe('Base path to search from (defaults to project root)'),
        include: z.string().optional().describe('File pattern to include (e.g., "*.ts")'),
      },
      execute: async (args) => {
        const basePath = args.path ? resolvePath(args.path, projectDir) : projectDir
        const includeFlag = args.include ? `--include="${args.include}"` : ''
        logger.debug(`Remote grep: ${args.pattern} (basePath: ${basePath}${args.include ? `, include: ${args.include}` : ''})`)

        const result = await sshClient.exec(`grep -rn ${includeFlag} "${args.pattern}" "${basePath}" 2>/dev/null | head -200`)
        return result.stdout
      },
    }),
  }
}
