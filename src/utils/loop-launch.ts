/**
 * Fresh loop launch helper for TUI and tool-side execution.
 * 
 * This module provides functions to create fresh loop sessions
 * separate from the restartLoop() function which requires preexisting loop state.
 */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { slugify } from './logger'
import { DEFAULT_COMPLETION_SIGNAL } from '../services/loop'

interface FreshLoopOptions {
  planText: string
  title: string
  directory: string
  projectId: string
  isWorktree: boolean
  api: TuiPluginApi
}

/**
 * Launches a fresh loop session (either in-place or in a worktree).
 * This is separate from restartLoop() which requires preexisting loop state.
 * 
 * @returns The new session ID if successful, null otherwise
 */
export async function launchFreshLoop(options: FreshLoopOptions): Promise<string | null> {
  const { planText, title, directory, projectId, isWorktree, api } = options
  
  const worktreeName = slugify(title)
  
  // Create session based on worktree mode
  let sessionId: string
  let sessionDirectory: string
  let worktreeBranch: string | undefined
  
  if (isWorktree) {
    // Create worktree and session
    const worktreeResult = await api.client.worktree.create({
      worktreeCreateInput: { name: worktreeName },
    })
    
    if (worktreeResult.error || !worktreeResult.data) {
      return null
    }
    
    sessionDirectory = worktreeResult.data.directory
    worktreeBranch = worktreeResult.data.branch
    
    const createResult = await api.client.session.create({
      title: `Loop: ${title}`,
      directory: sessionDirectory,
      // Note: Cannot set permission ruleset from TUI - handled by loop service
    })
    
    if (createResult.error || !createResult.data) {
      return null
    }
    
    sessionId = createResult.data.id
  } else {
    // In-place loop
    const createResult = await api.client.session.create({
      title: `Loop: ${title}`,
      directory,
    })
    
    if (createResult.error || !createResult.data) {
      return null
    }
    
    sessionId = createResult.data.id
    sessionDirectory = directory
  }
  
  // Store plan and loop state in KV if database exists
  const dbPath = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share', 'opencode', 'memory', 'memory.db')
  const dbExists = existsSync(dbPath)
  
  if (dbExists) {
    let db: Database | null = null
    try {
      db = new Database(dbPath)
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      // Store plan with worktree name key
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, `plan:${worktreeName}`, JSON.stringify(planText), now + ttl, now, now)
      
      // Store loop state in KV
      const loopState = {
        active: true,
        sessionId,
        worktreeName,
        worktreeDir: sessionDirectory,
        worktreeBranch,
        iteration: 1,
        maxIterations: 0,
        completionSignal: DEFAULT_COMPLETION_SIGNAL,
        startedAt: new Date().toISOString(),
        prompt: planText,
        phase: 'coding' as const,
        audit: true,
        errorCount: 0,
        auditCount: 0,
        worktree: isWorktree,
      }
      
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(projectId, `loop:${worktreeName}`, JSON.stringify(loopState), now + ttl, now)
      
      // Store session mapping
      db.prepare(
        'INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(projectId, `loop-session:${sessionId}`, JSON.stringify(worktreeName), now + ttl, now)
    } catch {
      // Continue even if DB operations fail
    } finally {
      try { db?.close() } catch {}
    }
  }
  
  // Build prompt with completion signal
  let promptText = planText
  if (DEFAULT_COMPLETION_SIGNAL) {
    promptText += `\n\n---\n\n**IMPORTANT - Completion Signal:** When you have completed ALL phases of this plan successfully, you MUST output the following phrase exactly: ${DEFAULT_COMPLETION_SIGNAL}\n\nBefore outputting the completion signal, you MUST:\n1. Verify each phase's acceptance criteria are met\n2. Run all verification commands listed in the plan and confirm they pass\n3. If tests were required, confirm they exist AND pass\n\nDo NOT output this phrase until every phase is truly complete and all verification steps pass. The loop will continue until this signal is detected.`
  }
  
  // Send prompt to code agent
  try {
    await api.client.session.promptAsync({
      sessionID: sessionId,
      directory: sessionDirectory,
      parts: [{ type: 'text' as const, text: promptText }],
      agent: 'code',
    })
  } catch {
    return null
  }
  
  return sessionId
}
