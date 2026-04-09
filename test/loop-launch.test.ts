import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { launchFreshLoop } from '../src/utils/loop-launch'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

const TEST_DIR = '/tmp/opencode-manager-loop-launch-test-' + Date.now()

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

function createMockApi(overrides?: Partial<TuiPluginApi>): TuiPluginApi {
  return {
    client: {
      session: {
        create: mock(async (params) => {
          return {
            data: { id: 'mock-session-' + Date.now(), title: params.title },
            error: null,
          }
        }),
        promptAsync: mock(async () => ({ data: {} })),
        abort: mock(async () => ({ data: {} })),
      },
      worktree: {
        create: mock(async (params) => {
          return {
            data: {
              name: params.worktreeCreateInput.name,
              directory: `/tmp/worktree-${params.worktreeCreateInput.name}`,
              branch: `opencode/loop-${params.worktreeCreateInput.name}`,
            },
            error: null,
          }
        }),
      },
    },
    state: {
      path: {
        directory: TEST_DIR,
      },
    },
    ui: {
      toast: mock(() => {}),
      dialog: {
        clear: mock(() => {}),
        replace: mock(() => {}),
        setSize: mock(() => {}),
      },
    },
    theme: {
      current: {
        text: 'white',
        textMuted: 'gray',
        border: 'blue',
        info: 'cyan',
        success: 'green',
        warning: 'yellow',
        error: 'red',
        markdownText: 'white',
      },
    },
    route: {
      navigate: mock(() => {}),
      current: { name: 'session', params: {} },
    },
    event: {
      on: mock(() => () => {}),
    },
    app: {
      version: 'local',
    },
    ...overrides,
  } as TuiPluginApi
}

describe('Fresh Loop Launch', () => {
  let db: Database
  const projectId = 'test-project'
  const planText = '# Test Plan\n\nThis is a test plan for loop execution.'
  const title = 'Test Loop'

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  test('Creates fresh in-place loop session', async () => {
    const mockApi = createMockApi()
    
    const sessionId = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
    })

    expect(sessionId).toBeDefined()
    expect(mockApi.client.session.create).toHaveBeenCalledWith({
      title: `Loop: ${title}`,
      directory: TEST_DIR,
    })
    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
  })

  test('Creates fresh worktree loop session', async () => {
    const mockApi = createMockApi()
    
    const sessionId = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      api: mockApi,
    })

    expect(sessionId).toBeDefined()
    expect(mockApi.client.worktree.create).toHaveBeenCalledWith({
      worktreeCreateInput: { name: expect.stringContaining('test-loop') },
    })
    expect(mockApi.client.session.create).toHaveBeenCalled()
  })

  test('Persists loop state to KV for in-place loop', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
    })

    // Verify loop state was written to KV
    const loopStateRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'loop:%') as { data: string } | null

    expect(loopStateRow).toBeDefined()
    if (loopStateRow) {
      const state = JSON.parse(loopStateRow.data)
      expect(state.active).toBe(true)
      expect(state.worktree).toBe(false)
      expect(state.phase).toBe('coding')
      expect(state.prompt).toBe(planText)
    }
  })

  test('Persists loop state to KV for worktree loop', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: true,
      api: mockApi,
    })

    const loopStateRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'loop:%') as { data: string } | null

    expect(loopStateRow).toBeDefined()
    if (loopStateRow) {
      const state = JSON.parse(loopStateRow.data)
      expect(state.active).toBe(true)
      expect(state.worktree).toBe(true)
      expect(state.worktreeDir).toBeDefined()
    }
  })

  test('Persists session mapping to KV', async () => {
    const mockApi = createMockApi()
    
    const sessionId = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
    })

    const sessionRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key = ?'
    ).get(projectId, `loop-session:${sessionId}`) as { data: string } | null

    expect(sessionRow).toBeDefined()
    if (sessionRow) {
      const worktreeName = JSON.parse(sessionRow.data)
      expect(worktreeName).toContain('test-loop')
    }
  })

  test('Stores plan with worktree name key', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
    })

    const planRow = db.prepare(
      'SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ?'
    ).get(projectId, 'plan:%') as { data: string } | null

    expect(planRow).toBeDefined()
    if (planRow) {
      const storedPlan = JSON.parse(planRow.data)
      expect(storedPlan).toBe(planText)
    }
  })

  test('Returns null when session creation fails', async () => {
    const mockApi = createMockApi({
      client: {
        session: {
          create: mock(async () => ({ data: null, error: 'Failed' })),
          promptAsync: mock(async () => ({ data: {} })),
          abort: mock(async () => ({ data: {} })),
        },
        worktree: {
          create: mock(async () => ({ data: null, error: 'Failed' })),
        },
      },
    } as Partial<TuiPluginApi> as TuiPluginApi)

    const sessionId = await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
    })

    expect(sessionId).toBeNull()
  })

  test('Sends prompt with completion signal instructions', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
    })

    expect(mockApi.client.session.promptAsync).toHaveBeenCalled()
    const callArgs = (mockApi.client.session.promptAsync as any).mock.calls[0][0]
    expect(callArgs.parts[0].text).toContain('ALL_PHASES_COMPLETE')
    expect(callArgs.parts[0].text).toContain(planText)
  })

  test('Uses code agent for prompt', async () => {
    const mockApi = createMockApi()
    
    await launchFreshLoop({
      planText,
      title,
      directory: TEST_DIR,
      projectId,
      isWorktree: false,
      api: mockApi,
    })

    const callArgs = (mockApi.client.session.promptAsync as any).mock.calls[0][0]
    expect(callArgs.agent).toBe('code')
  })
})
