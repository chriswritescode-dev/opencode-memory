import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createKvService } from '../src/services/kv'
import { createKvTools } from '../src/tools/kv'
import { createLoopService } from '../src/services/loop'
import type { Logger } from '../src/types'

const TEST_DIR = '/tmp/opencode-manager-kv-lines-test-' + Date.now()

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

interface ToolContext {
  kvService: ReturnType<typeof createKvService>
  projectId: string
  logger: Logger
  loopService: ReturnType<typeof createLoopService>
  sessionID: string
  directory: string
}

function createMockContext(db: Database): ToolContext {
  const kvService = createKvService(db)
  const logger = createMockLogger()
  const loopService = createLoopService(kvService, 'test-project', logger)
  return {
    kvService,
    projectId: 'test-project',
    logger,
    loopService,
    sessionID: 'test-session',
    directory: '/tmp',
  }
}

describe('memory-kv-get line-numbered output', () => {
  let db: Database
  let tools: Record<string, ReturnType<typeof tool>>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    const ctx = createMockContext(db)
    tools = createKvTools(ctx)
  })

  afterEach(() => {
    db.close()
  })

  test('string value returns line-numbered output with header', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'test', 'single line')
    
    const result = await tools['memory-kv-get'].execute(
      { key: 'test' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('(1 lines total)')
    expect(result).toContain('1: single line')
  })

  test('multiline string returns correct line numbers', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'multiline', 'line1\nline2\nline3')
    
    const result = await tools['memory-kv-get'].execute(
      { key: 'multiline' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('(3 lines total)')
    expect(result).toContain('1: line1')
    expect(result).toContain('2: line2')
    expect(result).toContain('3: line3')
  })

  test('JSON object returns pretty-printed line-numbered output', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'json', { foo: 'bar', count: 42 })
    
    const result = await tools['memory-kv-get'].execute(
      { key: 'json' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('(4 lines total)')
    expect(result).toContain('1: {')
    expect(result).toContain('2:   "foo": "bar",')
    expect(result).toContain('3:   "count": 42')
    expect(result).toContain('4: }')
  })

  test('with offset=3 limit=2 returns lines 3-4 with original line numbers', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'long', 'line1\nline2\nline3\nline4\nline5')
    
    const result = await tools['memory-kv-get'].execute(
      { key: 'long', offset: 3, limit: 2 },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('(5 lines total)')
    expect(result).toContain('3: line3')
    expect(result).toContain('4: line4')
    expect(result).not.toContain('line5')
  })

  test('offset beyond end returns header with no content lines', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'short', 'line1\nline2')
    
    const result = await tools['memory-kv-get'].execute(
      { key: 'short', offset: 10 },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('(2 lines total)')
    expect(result).not.toContain('10:')
  })

  test('non-existent key returns "No value found"', async () => {
    const result = await tools['memory-kv-get'].execute(
      { key: 'nonexistent' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('No value found')
  })
})

describe('memory-kv-set line-based operations', () => {
  let db: Database
  let tools: Record<string, ReturnType<typeof tool>>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    const ctx = createMockContext(db)
    tools = createKvTools(ctx)
  })

  afterEach(() => {
    db.close()
  })

  test('full overwrite (no offset/append) stores value, retrievable with line numbers', async () => {
    const result = await tools['memory-kv-set'].execute(
      { key: 'test', value: 'overwrite content' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('Stored key "test"')
    
    const retrieved = await tools['memory-kv-get'].execute(
      { key: 'test' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(retrieved).toContain('(1 lines total)')
    expect(retrieved).toContain('1: overwrite content')
  })

  test('append: true appends content to existing multiline value', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'append-test', 'line1\nline2')
    
    await tools['memory-kv-set'].execute(
      { key: 'append-test', value: 'line3\nline4', append: true },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    const retrieved = await tools['memory-kv-get'].execute(
      { key: 'append-test' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(retrieved).toContain('(4 lines total)')
    expect(retrieved).toContain('1: line1')
    expect(retrieved).toContain('2: line2')
    expect(retrieved).toContain('3: line3')
    expect(retrieved).toContain('4: line4')
  })

  test('append: true on non-existent key creates new entry', async () => {
    const result = await tools['memory-kv-set'].execute(
      { key: 'new-append', value: 'first line', append: true },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('Appended to key "new-append"')
    
    const retrieved = await tools['memory-kv-get'].execute(
      { key: 'new-append' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(retrieved).toContain('(1 lines total)')
    expect(retrieved).toContain('1: first line')
  })

  test('offset=2, limit=1 replaces line 2', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'replace-test', 'line1\nline2\nline3')
    
    const result = await tools['memory-kv-set'].execute(
      { key: 'replace-test', value: 'REPLACED', offset: 2, limit: 1 },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('Updated key "replace-test"')
    expect(result).toContain('3 lines')
    
    const retrieved = await tools['memory-kv-get'].execute(
      { key: 'replace-test' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(retrieved).toContain('(3 lines total)')
    expect(retrieved).toContain('1: line1')
    expect(retrieved).toContain('2: REPLACED')
    expect(retrieved).toContain('3: line3')
  })

  test('offset=3, limit=0 inserts new lines at line 3 without removing', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'insert-test', 'line1\nline2\nline3')
    
    await tools['memory-kv-set'].execute(
      { key: 'insert-test', value: 'inserted1\ninserted2', offset: 3, limit: 0 },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    const retrieved = await tools['memory-kv-get'].execute(
      { key: 'insert-test' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(retrieved).toContain('(5 lines total)')
    expect(retrieved).toContain('1: line1')
    expect(retrieved).toContain('2: line2')
    expect(retrieved).toContain('3: inserted1')
    expect(retrieved).toContain('4: inserted2')
    expect(retrieved).toContain('5: line3')
  })

  test('offset on non-existent key returns error message', async () => {
    const result = await tools['memory-kv-set'].execute(
      { key: 'nonexistent', value: 'test', offset: 1 },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('not found')
    expect(result).toContain('Cannot edit lines')
  })

  test('multiline value replacement where new content has different line count', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'multiline-replace', 'line1\nline2\nline3\nline4')
    
    await tools['memory-kv-set'].execute(
      { key: 'multiline-replace', value: 'A\nB\nC', offset: 2, limit: 2 },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    const retrieved = await tools['memory-kv-get'].execute(
      { key: 'multiline-replace' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(retrieved).toContain('(5 lines total)')
    expect(retrieved).toContain('1: line1')
    expect(retrieved).toContain('2: A')
    expect(retrieved).toContain('3: B')
    expect(retrieved).toContain('4: C')
    expect(retrieved).toContain('5: line4')
  })

  test('offset at end+1 of content appends', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'end-append', 'line1\nline2')
    
    await tools['memory-kv-set'].execute(
      { key: 'end-append', value: 'line3', offset: 3, limit: 0 },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    const retrieved = await tools['memory-kv-get'].execute(
      { key: 'end-append' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(retrieved).toContain('(3 lines total)')
    expect(retrieved).toContain('1: line1')
    expect(retrieved).toContain('2: line2')
    expect(retrieved).toContain('3: line3')
  })

  test('all line numbers are 1-indexed throughout', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'index-test', 'a\nb\nc')
    
    const result = await tools['memory-kv-get'].execute(
      { key: 'index-test' },
      { sessionID: 'test', directory: '/tmp' }
    )
    
    expect(result).toContain('1: a')
    expect(result).toContain('2: b')
    expect(result).toContain('3: c')
    expect(result).not.toContain('0:')
  })
})

describe('memory-kv-search', () => {
  let db: Database
  let tools: ReturnType<typeof createKvTools>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    const ctx = createMockContext(db)
    tools = createKvTools(ctx)
  })

  afterEach(() => {
    db.close()
  })

  test('searches single key and returns matching lines with correct line numbers', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'plan:test', 'line one\nTODO: fix this\nline three\nTODO: also this\nline five')

    const result = await tools['memory-kv-search'].execute(
      { pattern: 'TODO', key: 'plan:test' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('Found 2 matches across 1 key')
    expect(result).toContain('key: plan:test')
    expect(result).toContain('Line 2: TODO: fix this')
    expect(result).toContain('Line 4: TODO: also this')
    expect(result).not.toContain('line one')
    expect(result).not.toContain('line three')
  })

  test('searches all keys when no key or prefix specified', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'plan:a', 'alpha\nTODO: first')
    kvService.set(projectId, 'plan:b', 'no match here\nnor here')
    kvService.set(projectId, 'plan:c', 'TODO: third\nbeta')

    const result = await tools['memory-kv-search'].execute(
      { pattern: 'TODO' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('Found 2 matches across 2 keys')
    expect(result).toContain('key: plan:a')
    expect(result).toContain('key: plan:c')
    expect(result).not.toContain('key: plan:b')
  })

  test('prefix filters keys before searching', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'plan:one', 'TODO: in plan')
    kvService.set(projectId, 'other:two', 'TODO: in other')

    const result = await tools['memory-kv-search'].execute(
      { pattern: 'TODO', prefix: 'plan:' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('key: plan:one')
    expect(result).not.toContain('key: other:two')
  })

  test('returns "No matches found" when pattern has no hits', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'test-key', 'nothing to find here')

    const result = await tools['memory-kv-search'].execute(
      { pattern: 'XYZNOTFOUND' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toBe('No matches found')
  })

  test('invalid regex returns error message', async () => {
    const result = await tools['memory-kv-search'].execute(
      { pattern: '[invalid' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('Invalid regex pattern:')
  })

  test('truncates results at 100 matches with notice', async () => {
    const kvService = createKvService(db)
    const lines = Array.from({ length: 150 }, (_, i) => `MATCH line ${i + 1}`)
    kvService.set(projectId, 'big-key', lines.join('\n'))

    const result = await tools['memory-kv-search'].execute(
      { pattern: 'MATCH', key: 'big-key' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('Found 100 matches')
    expect(result).toContain('Results truncated')
    expect(result).not.toContain('line 101')
  })

  test('key + pattern combination scopes search to specific key', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'target', 'find me here')
    kvService.set(projectId, 'other', 'find me here too')

    const result = await tools['memory-kv-search'].execute(
      { pattern: 'find me', key: 'target' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('key: target')
    expect(result).not.toContain('key: other')
    expect(result).toContain('Found 1 match across 1 key')
  })

  test('JSON object values are searched as pretty-printed text', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'json-key', { phase: 'implementation', status: 'pending' })

    const result = await tools['memory-kv-search'].execute(
      { pattern: '"phase"', key: 'json-key' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('key: json-key')
    expect(result).toContain('"phase": "implementation"')
  })

  test('returns error when key-scoped search finds no key', async () => {
    const result = await tools['memory-kv-search'].execute(
      { pattern: 'anything', key: 'does-not-exist' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('No value found for key "does-not-exist"')
  })

  test('regex special characters work correctly', async () => {
    const kvService = createKvService(db)
    kvService.set(projectId, 'md-key', 'intro\n## Phase 1\nbody\n## Phase 2\nend')

    const result = await tools['memory-kv-search'].execute(
      { pattern: '^## ', key: 'md-key' },
      { sessionID: 'test', directory: '/tmp' }
    )

    expect(result).toContain('Line 2: ## Phase 1')
    expect(result).toContain('Line 4: ## Phase 2')
    expect(result).not.toContain('intro')
    expect(result).not.toContain('body')
  })
})
