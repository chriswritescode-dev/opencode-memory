/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, onCleanup, Show, For } from 'solid-js'
import { readFileSync, existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { Database } from 'bun:sqlite'
import { VERSION } from './version'
import { compareVersions } from './utils/upgrade'
import { fetchSessionStats, type SessionStats } from './utils/session-stats'

type TuiOptions = {
  sidebar: boolean
  showLoops: boolean
  showVersion: boolean
}

type TuiConfig = {
  sidebar?: boolean
  showLoops?: boolean
  showVersion?: boolean
}

type LoopInfo = {
  name: string
  phase: string
  iteration: number
  maxIterations: number
  sessionId: string
  active: boolean
  startedAt?: string
  completedAt?: string
  terminationReason?: string
  worktreeBranch?: string
  worktree?: boolean
  worktreeDir?: string
}

function loadTuiConfig(): TuiConfig | undefined {
  try {
    const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.config')
    const configDir = process.env['XDG_CONFIG_HOME'] || defaultBase
    const raw = readFileSync(join(configDir, 'opencode', 'memory-config.jsonc'), 'utf-8')
    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const parsed = JSON.parse(stripped)
    return parsed?.tui
  } catch {
    return undefined
  }
}

function resolveProjectId(directory: string): string | null {
  const cachePath = join(directory, '.git', 'opencode')
  if (existsSync(cachePath)) {
    try {
      const id = readFileSync(cachePath, 'utf-8').trim()
      if (id) return id
    } catch {}
  }
  try {
    const output = execSync('git rev-list --max-parents=0 --all', { cwd: directory, encoding: 'utf-8' }).trim()
    const commits = output.split('\n').filter(Boolean).sort()
    if (commits[0]) return commits[0]
  } catch {}
  return null
}

function readLoopStates(projectId: string): LoopInfo[] {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  const dbPath = join(xdgDataHome, 'opencode', 'memory', 'memory.db')
  
  if (!existsSync(dbPath)) return []
  
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const now = Date.now()
    const stmt = db.prepare('SELECT key, data FROM project_kv WHERE project_id = ? AND key LIKE ? AND expires_at > ?')
    const rows = stmt.all(projectId, 'loop:%', now) as Array<{ key: string; data: string }>
    
    const loops: LoopInfo[] = []
    for (const row of rows) {
      try {
        const state = JSON.parse(row.data)
        if (!state.worktreeName || !state.sessionId) continue
        loops.push({
          name: state.worktreeName,
          phase: state.phase ?? 'coding',
          iteration: state.iteration ?? 0,
          maxIterations: state.maxIterations ?? 0,
          sessionId: state.sessionId,
          active: state.active ?? false,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          terminationReason: state.terminationReason,
          worktreeBranch: state.worktreeBranch,
          worktree: state.worktree ?? false,
          worktreeDir: state.worktreeDir,
        })
      } catch {}
    }
    return loops
  } catch {
    return []
  } finally {
    try { db?.close() } catch {}
  }
}

function cancelLoop(projectId: string, loopName: string): string | null {
  const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
  const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
  const dbPath = join(xdgDataHome, 'opencode', 'memory', 'memory.db')

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    const key = `loop:${loopName}`
    const now = Date.now()
    const row = db.prepare('SELECT data, project_id FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?').get(projectId, key, now) as { data: string; project_id: string } | null
    if (!row) return null

    const state = JSON.parse(row.data)
    if (!state.active) return null

    const updatedState = {
      ...state,
      active: false,
      completedAt: new Date().toISOString(),
      terminationReason: 'cancelled',
    }
    db.prepare('UPDATE project_kv SET data = ?, updated_at = ? WHERE project_id = ? AND key = ?').run(
      JSON.stringify(updatedState),
      now,
      projectId,
      key,
    )
    return state.sessionId ?? null
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60))
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((ms % (1000 * 60)) / 1000)
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + '...'
}

function LoopDetailsDialog(props: { api: TuiPluginApi; loop: LoopInfo }) {
  const theme = () => props.api.theme.current
  const loop = props.loop
  const [stats, setStats] = createSignal<SessionStats | null>(null)
  const [loading, setLoading] = createSignal(true)

  const directory = props.api.state.path.directory

  createEffect(() => {
    if (loop.sessionId && directory) {
      setLoading(true)
      fetchSessionStats(props.api, loop.sessionId, directory).then((result) => {
        setStats(result)
        setLoading(false)
      }).catch(() => {
        setStats(null)
        setLoading(false)
      })
    } else {
      setLoading(false)
    }
  })

  const options = () => {
    const opts: Array<{ title: string; value: string; description?: string; onSelect?: () => void }> = []

    if (loop.worktreeBranch) {
      opts.push({
        title: 'View branch',
        value: 'branch',
        description: `${loop.worktreeBranch}`,
      })
    }

    if (loop.active) {
      opts.push({
        title: 'Cancel loop',
        value: 'cancel',
        description: `Cancel ${loop.name}`,
        onSelect: () => {
          props.api.ui.dialog.clear()
          const directory = props.api.state.path.directory
          const pid = resolveProjectId(directory)
          if (!pid) return
          const sessionId = cancelLoop(pid, loop.name)
          if (sessionId) {
            props.api.client.session.abort({ sessionID: sessionId }).catch(() => {})
          }
          props.api.ui.toast({
            message: sessionId ? `Cancelled loop: ${loop.name}` : `Loop ${loop.name} is not active`,
            variant: sessionId ? 'success' : 'info',
            duration: 3000,
          })
        },
      })
    } else if (loop.terminationReason === 'completed') {
      opts.push({
        title: `Completed: ${loop.iteration} iteration${loop.iteration !== 1 ? 's' : ''}`,
        value: 'completed',
      })
    } else {
      opts.push({
        title: `Ended: ${loop.terminationReason?.replace(/_/g, ' ') ?? 'unknown'}`,
        value: 'ended',
      })
    }

    opts.push({
      title: 'Close',
      value: 'close',
    })

    return opts
  }

  

  return (
    <box flexDirection="column">
      <box paddingBottom={1}>
        <text fg={theme().text}>
          <b>{loop.name}</b>
        </text>
      </box>
      
      <Show when={loading()}>
        <box paddingBottom={1}>
          <text fg={theme().textMuted}>Loading stats...</text>
        </box>
      </Show>
      
      <Show when={!loading()}>
        <box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          <Show when={stats()} fallback={
            <box>
              <text fg={theme().textMuted}>Session stats unavailable</text>
            </box>
          }>
            <box flexDirection="column" gap={1}>
              <box>
                <text fg={theme().text}>
                  <b>Session:</b> {loop.sessionId.slice(0, 8)}...
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <b>Phase:</b> {loop.phase}
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <b>Iteration:</b> {loop.iteration}/{loop.maxIterations}
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <b>Tokens:</b> {formatTokens(stats()!.tokens.input)} in / {formatTokens(stats()!.tokens.output)} out / {formatTokens(stats()!.tokens.reasoning)} reasoning
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <b>Cost:</b> ${stats()!.cost.toFixed(4)}
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <b>Messages:</b> {stats()!.messages.total} total ({stats()!.messages.assistant} assistant)
                </text>
              </box>
              <Show when={stats()!.fileChanges}>
                <box>
                  <text fg={theme().text}>
                    <b>Files:</b> {stats()!.fileChanges!.files} changed (+{stats()!.fileChanges!.additions}/-{stats()!.fileChanges!.deletions})
                  </text>
                </box>
              </Show>
              <Show when={stats()!.timing}>
                <box>
                  <text fg={theme().text}>
                    <b>Duration:</b> {formatDuration(stats()!.timing!.durationMs)}
                  </text>
                </box>
              </Show>
              <Show when={stats()?.lastAssistantMessage?.text}>
                <box flexDirection="column" gap={1} paddingTop={1}>
                  <box>
                    <text fg={theme().text}><b>Last assistant message:</b></text>
                  </box>
                  <box borderStyle="rounded" borderColor={theme().border}>
                    <text fg={theme().textMuted} wrapMode="word" paddingX={1} paddingY={1}>
                      {stats()!.lastAssistantMessage!.text}
                    </text>
                  </box>
                </box>
              </Show>
            </box>
          </Show>
        </box>
      </Show>
      
      <box>
        <props.api.ui.DialogSelect
          title="Actions"
          options={options()}
          onSelect={(opt) => {
            if (opt.onSelect) {
              opt.onSelect()
              return
            }
            props.api.ui.dialog.clear()
          }}
        />
      </box>
    </box>
  )
}

function Sidebar(props: { api: TuiPluginApi; opts: TuiOptions }) {
  const [open, setOpen] = createSignal(true)
  const [loops, setLoops] = createSignal<LoopInfo[]>([])
  const theme = () => props.api.theme.current
  const directory = props.api.state.path.directory
  const pid = resolveProjectId(directory)

  const title = createMemo(() => {
    return props.opts.showVersion ? `Memory v${VERSION}` : 'Memory'
  })

  const dot = (loop: LoopInfo) => {
    if (!loop.active) {
      if (loop.terminationReason === 'completed') return theme().success
      if (loop.terminationReason === 'cancelled' || loop.terminationReason === 'user_aborted') return theme().textMuted
      return theme().error
    }
    if (loop.phase === 'auditing') return theme().warning
    return theme().success
  }

  const statusText = (loop: LoopInfo) => {
    const max = loop.maxIterations > 0 ? `/${loop.maxIterations}` : ''
    if (loop.active) return `${loop.phase} · iter ${loop.iteration}${max}`
    if (loop.terminationReason === 'completed') return `completed · ${loop.iteration} iter${loop.iteration !== 1 ? 's' : ''}`
    return loop.terminationReason?.replace(/_/g, ' ') ?? 'ended'
  }

  function refreshLoops() {
    if (!pid) return
    
    const states = readLoopStates(pid)
    const cutoff = Date.now() - 5 * 60 * 1000
    const visible = states.filter(l => 
      l.active || (l.completedAt && new Date(l.completedAt).getTime() > cutoff)
    )
    visible.sort((a, b) => {
      if (a.active && !b.active) return -1
      if (!a.active && b.active) return 1
      const aTime = a.completedAt ?? a.startedAt ?? ''
      const bTime = b.completedAt ?? b.startedAt ?? ''
      return bTime.localeCompare(aTime)
    })
    setLoops(visible)
  }
  
  const unsub = props.api.event.on('session.status', () => {
    refreshLoops()
  })

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      refreshLoops()
    }, 5000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  refreshLoops()

  createEffect(() => {
    const hasActiveWorktreeLoops = loops().filter(l => l.active && l.worktree).length > 0
    if (hasActiveWorktreeLoops) {
      startPolling()
    } else {
      stopPolling()
    }
  })

  onCleanup(() => {
    unsub()
    stopPolling()
  })

  const hasContent = createMemo(() => {
    if (props.opts.showLoops && loops().length > 0) return true
    return false
  })
  
  const activeCount = createMemo(() => {
    return loops().filter(l => l.active).length
  })

  return (
    <Show when={props.opts.sidebar}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => hasContent() && setOpen((x) => !x)}>
          <Show when={hasContent()}>
            <text fg={theme().text}>{open() ? '▼' : '▶'}</text>
          </Show>
          <text fg={theme().text}>
            <b>{title()}</b>
            <Show when={!open() && activeCount() > 0}>
              <span style={{ fg: theme().textMuted }}>
                {' '}({activeCount()} active)
              </span>
            </Show>
          </text>
        </box>
        <Show when={open() && props.opts.showLoops && loops().length > 0}>
          <For each={loops()}>
            {(loop) => (
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={() => {
                  if (loop.worktree) {
                    props.api.ui.dialog.replace(() => (
                      <LoopDetailsDialog api={props.api} loop={loop} />
                    ))
                  } else {
                    props.api.route.navigate('session', { sessionID: loop.sessionId })
                  }
                }}
              >
                <text flexShrink={0} style={{ fg: dot(loop) }}>•</text>
                <text fg={theme().text} wrapMode="word">
                  {loop.name}{' '}
                  <span style={{ fg: theme().textMuted }}>{statusText(loop)}</span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const id = '@opencode-manager/memory'
const MIN_OPENCODE_VERSION = '1.3.5'

const tui: TuiPlugin = async (api) => {
  const v = api.app.version
  if (v !== 'local' && compareVersions(v, MIN_OPENCODE_VERSION) < 0) return

  const tuiConfig = loadTuiConfig()
  const opts: TuiOptions = {
    sidebar: tuiConfig?.sidebar ?? true,
    showLoops: tuiConfig?.showLoops ?? true,
    showVersion: tuiConfig?.showVersion ?? true,
  }

  if (!opts.sidebar) return

  api.command.register(() => {
    const directory = api.state.path.directory
    const pid = resolveProjectId(directory)
    if (!pid) return []

    const states = readLoopStates(pid)
    if (states.length === 0) return []

    return [
      {
        title: 'Memory: Show loops',
        value: 'memory.loops.show',
        description: `${states.length} loop${states.length !== 1 ? 's' : ''}`,
        category: 'Memory',
        onSelect: () => {
          const loopOptions = states.map(l => {
            const active = l.active
            const max = l.maxIterations > 0 ? `/${l.maxIterations}` : ''
            const status = active
              ? `${l.phase} · iter ${l.iteration}${max}`
              : l.terminationReason === 'completed'
                ? `completed · ${l.iteration} iter${l.iteration !== 1 ? 's' : ''}`
                : l.terminationReason?.replace(/_/g, ' ') ?? 'ended'

            return {
              title: l.name,
              value: l.name,
              description: `${status}${l.worktreeBranch ? ` · ${l.worktreeBranch}` : ''}`,
              onSelect: () => {
                api.ui.dialog.clear()
                if (l.worktree) {
                  api.ui.dialog.replace(() => (
                    <LoopDetailsDialog api={api} loop={l} />
                  ))
                } else {
                  api.route.navigate('session', { sessionID: l.sessionId })
                }
              },
            }
          })

          api.ui.dialog.replace(() => (
            <api.ui.DialogSelect
              title="Loops"
              options={loopOptions}
              onSelect={(opt) => {
                if (opt.onSelect) {
                  opt.onSelect()
                  return
                }
                api.ui.dialog.clear()
              }}
            />
          ))
        },
      },
    ]
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return <Sidebar api={api} opts={opts} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
