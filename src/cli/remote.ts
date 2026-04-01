import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { resolveDefaultDbPath } from './utils'

function readRemoteState(dbPath: string, projectId: string): Record<string, unknown> | null {
  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const now = Date.now()
    const row = db.prepare('SELECT data FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?')
      .get(projectId, 'remote:state', now) as { data: string } | null
    if (!row) return null
    return JSON.parse(row.data)
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

function writeRemoteCommand(dbPath: string, projectId: string, action: 'enable' | 'disable'): boolean {
  if (!existsSync(dbPath)) {
    console.error('Database not found. Is the plugin running?')
    return false
  }

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    const now = Date.now()
    const ttl = 5 * 60 * 1000
    const expiresAt = now + ttl
    const data = JSON.stringify({ action })
    const key = 'remote:command'

    const existing = db.prepare('SELECT 1 FROM project_kv WHERE project_id = ? AND key = ?').get(projectId, key)
    if (existing) {
      db.prepare('UPDATE project_kv SET data = ?, expires_at = ?, updated_at = ? WHERE project_id = ? AND key = ?')
        .run(data, expiresAt, now, projectId, key)
    } else {
      db.prepare('INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, key, data, expiresAt, now, now)
    }
    return true
  } catch (err) {
    console.error('Failed to write command:', err)
    return false
  } finally {
    try { db?.close() } catch {}
  }
}

export async function cli(args: string[], globalOpts: { dbPath?: string; resolvedProjectId?: string }): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help()
    return
  }

  const subcommand = args[0]
  const projectId = globalOpts.resolvedProjectId

  if (!projectId) {
    console.error('Could not determine project. Run from a git repository or use --project flag.')
    process.exit(1)
  }

  const dbPath = globalOpts.dbPath || resolveDefaultDbPath()

  switch (subcommand) {
    case 'status': {
      const state = readRemoteState(dbPath, projectId)
      if (!state) {
        console.log('No remote state found. Is the plugin running with remote configured?')
        return
      }
      console.log(JSON.stringify(state, null, 2))
      break
    }
    case 'on': {
      const state = readRemoteState(dbPath, projectId)
      if (state?.enabled) {
        console.log('Remote is already enabled.')
        return
      }
      const ok = writeRemoteCommand(dbPath, projectId, 'enable')
      if (ok) {
        console.log('Remote enable command queued. It will take effect on the next session event.')
      }
      break
    }
    case 'off': {
      const state = readRemoteState(dbPath, projectId)
      if (state && !state.enabled) {
        console.log('Remote is already disabled.')
        return
      }
      const ok = writeRemoteCommand(dbPath, projectId, 'disable')
      if (ok) {
        console.log('Remote disable command queued. It will take effect on the next session event.')
      }
      break
    }
    default:
      console.error(`Unknown remote subcommand: ${subcommand}`)
      help()
      process.exit(1)
  }
}

export function help(): void {
  console.log(`
OpenCode Memory Remote Commands

Usage:
  ocm-mem remote <subcommand>

Subcommands:
  status    Show current remote connection state
  on        Enable remote container integration
  off       Disable remote container integration

Global Options:
  --project, -p <name>   Project name or SHA
  --dir, -d <path>       Git repo path for project detection
  --db-path <path>       Path to memory database
  --help, -h             Show this help
  `.trim())
}
