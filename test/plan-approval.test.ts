import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createKvService } from '../src/services/kv'
import { createLoopService } from '../src/services/loop'
import type { Logger } from '../src/types'
import { createToolExecuteAfterHook, createPlanApprovalEventHook } from '../src/tools/plan-approval'
import type { ToolContext } from '../src/tools/types'
import type { PluginConfig } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-plan-approval-test-' + Date.now()

function createTestDb(): Database {
  const db = new Database(`${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)
  return db
}

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('Plan Approval Tool Interception', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'
  const sessionID = 'test-session-123'

  const PLAN_APPROVAL_LABELS = ['New session', 'Execute here', 'Loop (worktree)', 'Loop']

  beforeEach(() => {
    db = createTestDb()
    const kvService = createKvService(db)
    loopService = createLoopService(kvService, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
  })

  function simulateToolExecuteAfter(
    tool: string,
    args: unknown,
    output: { title: string; output: string; metadata: unknown },
    sessionActive = false
  ) {
    if (sessionActive) {
      const state = {
        active: true,
        sessionId: sessionID,
        worktreeName: 'test-worktree',
        worktreeDir: '/test/worktree',
        worktreeBranch: 'opencode/loop-test',
        iteration: 1,
        maxIterations: 5,
        completionSignal: 'ALL_PHASES_COMPLETE',
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,
        audit: false,
        errorCount: 0,
        auditCount: 0,
        worktree: true,
      }
      loopService.setState(sessionID, state)
    }

    if (tool === 'question') {
      const questionArgs = args as { questions?: Array<{ options?: Array<{ label: string }> }> } | undefined
      const options = questionArgs?.questions?.[0]?.options
      if (options) {
        const labels = options.map((o) => o.label)
        const isPlanApproval = PLAN_APPROVAL_LABELS.every((l) => labels.includes(l))
        if (isPlanApproval) {
          const metadata = output.metadata as { answers?: string[][] } | undefined
          const answer = metadata?.answers?.[0]?.[0]?.trim() ?? output.output.trim()
          const matchedLabel = PLAN_APPROVAL_LABELS.find((l) => answer === l || answer.startsWith(l))
          
          if (matchedLabel?.toLowerCase() === 'execute here') {
            output.output = `${output.output}\n\nSwitching to code agent for execution...`
          } else if (matchedLabel) {
            // Programmatic dispatch - no directive injection
            output.output = `${output.output}\n\n[Programmatic dispatch - no directive]`
          } else {
            // Custom answer fallback
            output.output = `${output.output}\n\n<system-reminder>\nThe user provided a custom response instead of selecting a predefined option. Review their answer and respond accordingly. If they want to proceed with execution, use the appropriate tool (memory-plan-execute or memory-loop) based on their intent. If they want to cancel or revise the plan, help them with that instead.\n</system-reminder>`
          }
        }
      }
      return
    }

    if (!sessionActive) return

    const LOOP_BLOCKED_TOOLS: Record<string, string> = {
      question: 'The question tool is not available during a memory loop. Do not ask questions — continue working on the task autonomously.',
      'memory-plan-execute': 'The memory-plan-execute tool is not available during a memory loop. Focus on executing the current plan.',
      'memory-loop': 'The memory-loop tool is not available during a memory loop. Focus on executing the current plan.',
    }

    if (!(tool in LOOP_BLOCKED_TOOLS)) return

    output.title = 'Tool blocked'
    output.output = LOOP_BLOCKED_TOOLS[tool]!
  }

  test('Detects plan approval question and handles "New session" programmatically', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'New session', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('New session')
    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).not.toContain('memory-plan-execute')
  })

  test('Detects plan approval question and handles "Execute here" with abort', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Execute here', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Execute here')
    expect(output.output).toContain('Switching to code agent')
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Detects plan approval question and handles "Loop (worktree)" programmatically', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Loop (worktree)', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Loop (worktree)')
    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).not.toContain('memory-loop')
  })

  test('Detects plan approval question and handles "Loop" programmatically', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Loop', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Loop')
    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).not.toContain('memory-loop')
  })

  test('Injects directive for unknown answer', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'Custom answer', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('Custom answer')
    expect(output.output).toContain('<system-reminder>')
    expect(output.output).toContain('custom response')
    expect(output.output).toContain('respond accordingly')
  })

  test('Matches partial answer that starts with label', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'New session (with custom config)', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('New session (with custom config)')
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Does not match partial label in middle of text', () => {
    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = { title: '', output: 'I want to create a session', metadata: {} }

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toContain('I want to create a session')
    expect(output.output).toContain('<system-reminder>')
    expect(output.output).toContain('custom response')
  })

  test('Does not modify non-approval questions', () => {
    const args = {
      questions: [{
        question: 'What is your preference?',
        options: [
          { label: 'Option A', description: 'First option' },
          { label: 'Option B', description: 'Second option' },
        ],
      }],
    }
    const output = { title: '', output: 'Option A', metadata: {} }
    const originalOutput = output.output

    simulateToolExecuteAfter('question', args, output)

    expect(output.output).toBe(originalOutput)
    expect(output.output).not.toContain('<system-reminder>')
  })

  test('Does not modify non-question tools', () => {
    const output = { title: '', output: 'Some result', metadata: {} }
    const originalOutput = output.output

    simulateToolExecuteAfter('memory-read', {}, output)

    expect(output.output).toBe(originalOutput)
  })

  test('Loop blocking still works for question tool when loop is active', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('question', {}, output, true)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })

  test('Loop blocking works for memory-plan-execute tool', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('memory-plan-execute', {}, output, true)

    expect(output.title).toBe('Tool blocked')
    expect(output.output).toContain('memory-plan-execute tool is not available')
  })

  test('Loop blocking works for memory-loop tool', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('memory-loop', {}, output, true)

    expect(output.title).toBe('Tool blocked')
    expect(output.output).toContain('memory-loop tool is not available')
  })

  test('Loop blocking does not affect non-blocked tools', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('memory-read', {}, output, true)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })

  test('Loop blocking only applies when loop is active', () => {
    const output = { title: '', output: 'test', metadata: {} }

    simulateToolExecuteAfter('memory-plan-execute', {}, output, false)

    expect(output.title).toBe('')
    expect(output.output).toBe('test')
  })
})

describe('Execute here bypass', () => {
  const projectId = 'test-project'
  const sessionID = 'test-session-456'
  const testDir = '/test/dir'
  const openDbs: Database[] = []

  afterEach(() => {
    for (const db of openDbs) db.close()
    openDbs.length = 0
  })

  function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
    const mockV2 = {
      session: {
        abort: async () => ({ data: {} }),
        promptAsync: async () => ({ data: {} }),
        create: async () => ({ data: { id: 'new-session-id' } }),
      },
      tui: {
        selectSession: async () => ({ data: {} }),
      },
    } as unknown as ToolContext['v2']

    const mockConfig = {
      executionModel: 'test-provider/test-model',
    } as PluginConfig

    const mockLogger = createMockLogger()

    const db = createTestDb()
    openDbs.push(db)
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, projectId, mockLogger)

    return {
      projectId,
      directory: testDir,
      config: mockConfig,
      logger: mockLogger,
      db,
      loopService,
      kvService,
      v2: mockV2,
      ...overrides,
    } as ToolContext
  }

  test('Execute here bypasses directive injection and triggers abort', async () => {
    const abortSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: async () => ({ data: {} }),
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    })

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await hook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).not.toContain('<system-reminder>')
    expect(output.output).toContain('Switching to code agent')
    expect(abortSpy).toHaveBeenCalledWith({ sessionID })
  })

  test('session.idle event triggers promptAsync for pending execution', async () => {
    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: async () => ({ data: {} }),
          promptAsync: promptSpy,
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
      config: { executionModel: 'test-provider/test-model' } as PluginConfig,
    })

    const afterHook = createToolExecuteAfterHook(ctx)
    const eventHook = createPlanApprovalEventHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'Execute here',
      metadata: { answers: [['Execute here']] },
    }

    await afterHook(
      { tool: 'question', sessionID, callID: 'test-call', args },
      output
    )

    await eventHook({
      event: {
        type: 'session.idle',
        properties: { sessionID },
      },
    })

    expect(promptSpy).toHaveBeenCalled()
    const callArgs = promptSpy.mock.calls[0][0]
    expect(callArgs.sessionID).toBe(sessionID)
    expect(callArgs.agent).toBe('code')
    expect(callArgs.parts[0].text).toContain('The architect agent has created an implementation plan')

    await eventHook({
      event: {
        type: 'session.idle',
        properties: { sessionID },
      },
    })

    expect(promptSpy).toHaveBeenCalledTimes(1)
  })

  test('Other approval labels do not inject directives (programmatic dispatch)', async () => {
    const abortSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: async () => ({ data: {} }),
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    })

    const hook = createToolExecuteAfterHook(ctx)

    for (const label of ['New session', 'Loop (worktree)', 'Loop']) {
      const args = {
        questions: [{
          question: 'How would you like to proceed?',
          options: [
            { label: 'New session', description: 'Create new session' },
            { label: 'Execute here', description: 'Execute here' },
            { label: 'Loop (worktree)', description: 'Loop worktree' },
            { label: 'Loop', description: 'Loop in place' },
          ],
        }],
      }
      const output = {
        title: 'Asked 1 question',
        output: label,
        metadata: { answers: [[label]] },
      }

      await hook(
        { tool: 'question', sessionID, callID: 'test-call', args },
        output
      )

      expect(output.output).not.toContain('<system-reminder>')
      expect(abortSpy).not.toHaveBeenCalled()
      abortSpy.mockClear()
    }
  })

  test('session.idle for non-pending session is a no-op', async () => {
    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const ctx = createMockContext({
      v2: {
        session: {
          abort: async () => ({ data: {} }),
          promptAsync: promptSpy,
          create: async () => ({ data: { id: 'new-session-id' } }),
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    })

    const eventHook = createPlanApprovalEventHook(ctx)

    await eventHook({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'non-pending-session' },
      },
    })

    expect(promptSpy).not.toHaveBeenCalled()
  })

  test('New session path reads plan from session-scoped KV and deletes after dispatch', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const kvService = createKvService(db)
    const testSessionID = 'test-session-abc'
    
    // Store a plan in session-scoped KV
    kvService.set(projectId, `plan:${testSessionID}`, '# Test Plan\n\nThis is a test plan.')
    
    const createSpy = mock(() => Promise.resolve({ data: { id: 'new-session-123' } }))
    const promptSpy = mock(() => Promise.resolve({ data: {} }))
    const abortSpy = mock(() => Promise.resolve({ data: {} }))
    
    const ctx = {
      projectId,
      directory: testDir,
      config: { executionModel: 'test-provider/test-model' } as PluginConfig,
      logger: createMockLogger(),
      kvService,
      loopService: createLoopService(kvService, projectId, createMockLogger()),
      v2: {
        session: {
          abort: abortSpy,
          promptAsync: promptSpy,
          create: createSpy,
        },
        tui: {
          selectSession: async () => ({ data: {} }),
        },
      } as unknown as ToolContext['v2'],
    } as ToolContext

    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      questions: [{
        question: 'How would you like to proceed?',
        options: [
          { label: 'New session', description: 'Create new session' },
          { label: 'Execute here', description: 'Execute here' },
          { label: 'Loop (worktree)', description: 'Loop worktree' },
          { label: 'Loop', description: 'Loop in place' },
        ],
      }],
    }
    const output = {
      title: 'Asked 1 question',
      output: 'New session',
      metadata: { answers: [['New session']] },
    }

    await hook(
      { tool: 'question', sessionID: testSessionID, callID: 'test-call', args },
      output
    )

    // Give async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify plan was deleted from session-scoped key
    const planAfter = kvService.get(projectId, `plan:${testSessionID}`)
    expect(planAfter).toBeNull()
  })

  test('Two different sessions can store plans independently without collision', async () => {
    const db = createTestDb()
    openDbs.push(db)
    const kvService = createKvService(db)
    
    const session1 = 'session-1'
    const session2 = 'session-2'
    const plan1 = '# Plan for Session 1'
    const plan2 = '# Plan for Session 2'
    
    // Store different plans for different sessions
    kvService.set(projectId, `plan:${session1}`, plan1)
    kvService.set(projectId, `plan:${session2}`, plan2)
    
    // Verify each session can read its own plan
    const retrieved1 = kvService.get(projectId, `plan:${session1}`)
    const retrieved2 = kvService.get(projectId, `plan:${session2}`)
    
    expect(retrieved1).toBe(plan1)
    expect(retrieved2).toBe(plan2)
    expect(retrieved1).not.toBe(plan2)
    expect(retrieved2).not.toBe(plan1)
  })
})

describe('memory-kv-set plan:current surfacing', () => {
  const projectId = 'test-project'
  const sessionID = 'test-session-789'
  const testDir = '/test/dir'
  const openDbs: Database[] = []

  afterEach(() => {
    for (const db of openDbs) db.close()
    openDbs.length = 0
  })

  function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
    const mockV2 = {
      session: {
        abort: async () => ({ data: {} }),
        promptAsync: async () => ({ data: {} }),
        create: async () => ({ data: { id: 'new-session-id' } }),
      },
      tui: {
        selectSession: async () => ({ data: {} }),
      },
    } as unknown as ToolContext['v2']

    const mockConfig = {
      executionModel: 'test-provider/test-model',
    } as PluginConfig

    const mockLogger = createMockLogger()

    const db = createTestDb()
    openDbs.push(db)
    const kvService = createKvService(db)
    const loopService = createLoopService(kvService, projectId, mockLogger)

    return {
      projectId,
      directory: testDir,
      config: mockConfig,
      logger: mockLogger,
      db,
      loopService,
      kvService,
      v2: mockV2,
      ...overrides,
    } as ToolContext
  }

  test('memory-kv-set with plan:current key surfaces plan from session-scoped key', async () => {
    const ctx = createMockContext()
    const hook = createToolExecuteAfterHook(ctx)

    const planContent = '# Implementation Plan\n\n## Phase 1: Setup\n- Configure environment\n- Install dependencies\n\n## Phase 2: Implementation\n- Write code\n- Add tests'

    // Simulate the tool execution by writing to session-scoped KV
    ctx.kvService.set(projectId, `plan:${sessionID}`, planContent)

    const args = {
      key: 'plan:current',
      value: planContent,
      ttlMs: 604800000,
    }
    const output = {
      title: 'Stored key "plan:current"',
      output: 'Stored key "plan:current" (expires in 7 days)',
      metadata: {},
    }

    await hook(
      { tool: 'memory-kv-set', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).toContain('Stored key "plan:current" (expires in 7 days)')
    expect(output.output).toContain('# Implementation Plan')
    expect(output.output).toContain('## Phase 1: Setup')
    expect(output.output).toContain('## Phase 2: Implementation')
  })

  test('memory-kv-set with different key does NOT surface content', async () => {
    const ctx = createMockContext()
    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      key: 'other:key',
      value: 'Some other value',
      ttlMs: 604800000,
    }
    const output = {
      title: 'Stored key "other:key"',
      output: 'Stored key "other:key" (expires in 7 days)',
      metadata: {},
    }

    await hook(
      { tool: 'memory-kv-set', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).toBe('Stored key "other:key" (expires in 7 days)')
    expect(output.output).not.toContain('Some other value')
  })

  test('memory-kv-set with plan:current and append: true surfaces full plan from session-scoped key', async () => {
    const ctx = createMockContext()
    const hook = createToolExecuteAfterHook(ctx)

    // First, set initial content in session-scoped key
    ctx.kvService.set(projectId, `plan:${sessionID}`, '# Initial Plan\n\n- Step 1')

    // Simulate the append operation that the tool would perform
    const existing = ctx.kvService.get<string>(projectId, `plan:${sessionID}`)
    const existingStr = typeof existing === 'string' ? existing : JSON.stringify(existing, null, 2)
    const appendedValue = `${existingStr}\n\n- Step 2`
    ctx.kvService.set(projectId, `plan:${sessionID}`, appendedValue)

    const args = {
      key: 'plan:current',
      value: '\n\n- Step 2',
      append: true,
    }
    const output = {
      title: 'Appended to key "plan:current"',
      output: 'Appended to key "plan:current" (expires in 7 days)',
      metadata: {},
    }

    await hook(
      { tool: 'memory-kv-set', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).toContain('Appended to key "plan:current" (expires in 7 days)')
    expect(output.output).toContain('# Initial Plan')
    expect(output.output).toContain('- Step 1')
    expect(output.output).toContain('- Step 2')
  })

  test('memory-kv-set with plan:current and offset surfaces full plan from session-scoped key', async () => {
    const ctx = createMockContext()
    const hook = createToolExecuteAfterHook(ctx)

    // First, set initial content with multiple lines in session-scoped key
    const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4'
    ctx.kvService.set(projectId, `plan:${sessionID}`, initialContent)

    // Simulate the offset editing that the tool would perform
    const existing = ctx.kvService.get<string>(projectId, `plan:${sessionID}`)
    const existingStr = typeof existing === 'string' ? existing : JSON.stringify(existing, null, 2)
    const lines = existingStr.split('\n')
    const newLines = 'Line 2 Updated'.split('\n')
    let idx = 1 - 1 // offset is 1-indexed, so offset=1 means idx=0
    if (idx < 0) idx = 0
    if (idx > lines.length) idx = lines.length
    const limit = 1
    lines.splice(idx, limit, ...newLines)
    const result = lines.join('\n')
    ctx.kvService.set(projectId, `plan:${sessionID}`, result)

    const args = {
      key: 'plan:current',
      value: 'Line 2 Updated',
      offset: 1,
      limit: 1,
    }
    const output = {
      title: 'Updated key "plan:current"',
      output: 'Updated key "plan:current" (expires in 7 days)',
      metadata: {},
    }

    await hook(
      { tool: 'memory-kv-set', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).toContain('Updated key "plan:current" (expires in 7 days)')
    expect(output.output).toContain('Line 2 Updated')
    expect(output.output).toContain('Line 2')
    expect(output.output).toContain('Line 3')
    expect(output.output).toContain('Line 4')
  })

  test('memory-kv-set with empty value does not surface content', async () => {
    const ctx = createMockContext()
    const hook = createToolExecuteAfterHook(ctx)

    const args = {
      key: 'plan:current',
      value: '',
      ttlMs: 604800000,
    }
    const output = {
      title: 'Stored key "plan:current"',
      output: 'Stored key "plan:current" (expires in 7 days)',
      metadata: {},
    }

    await hook(
      { tool: 'memory-kv-set', sessionID, callID: 'test-call', args },
      output
    )

    expect(output.output).toBe('Stored key "plan:current" (expires in 7 days)')
  })
})
