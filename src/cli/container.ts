import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

const DEFAULT_PORT = 2222
const DEFAULT_USER = 'devuser'
const DEFAULT_BASE_PATH = '/projects'
const KEY_DIR = join(homedir(), '.ssh')
const KEY_NAME = 'opencode-sandbox'

function getKeyPath(): string {
  return join(KEY_DIR, KEY_NAME)
}

function getPubKeyPath(): string {
  return join(KEY_DIR, `${KEY_NAME}.pub`)
}

function generateKeys(): { keyPath: string; pubKeyPath: string } {
  const keyPath = getKeyPath()
  const pubKeyPath = getPubKeyPath()

  if (existsSync(keyPath)) {
    console.log(`SSH key already exists: ${keyPath}`)
    return { keyPath, pubKeyPath }
  }

  if (!existsSync(KEY_DIR)) {
    mkdirSync(KEY_DIR, { mode: 0o700, recursive: true })
  }

  const result = spawnSync('ssh-keygen', [
    '-t', 'ed25519',
    '-f', keyPath,
    '-N', '',
    '-C', 'opencode-sandbox',
  ], { encoding: 'utf-8' })

  if (result.status !== 0) {
    throw new Error(`Failed to generate SSH key: ${result.stderr}`)
  }

  console.log(`SSH key generated: ${keyPath}`)
  return { keyPath, pubKeyPath }
}

function findComposeFile(): string | null {
  const candidates = [
    'container/docker-compose.yml',
    'docker-compose.yml',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export function containerSetup(args: string[]): void {
  const portArg = args.find(a => a.startsWith('--port='))
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : DEFAULT_PORT

  const hostArg = args.find(a => a.startsWith('--host='))
  const host = hostArg ? hostArg.split('=')[1] : 'localhost'

  const { keyPath, pubKeyPath } = generateKeys()

  const pubKey = readFileSync(pubKeyPath, 'utf-8').trim()

  const composeDir = resolve('container')
  if (!existsSync(composeDir)) {
    console.log(`\nNo container/ directory found.`)
    console.log(`If using the opencode-memory repo, run from the project root.`)
    console.log(`Otherwise, create a container manually or use the Docker image directly.\n`)
  }

  const authKeysDir = resolve('container')
  const authKeysPath = join(authKeysDir, 'authorized_keys')
  if (existsSync(composeDir)) {
    writeFileSync(authKeysPath, pubKey + '\n', { mode: 0o600 })
    console.log(`Wrote authorized_keys: ${authKeysPath}`)
  }

  console.log('\n--- Add this to your config.jsonc ---')
  console.log(JSON.stringify({
    remote: {
      enabled: true,
      host,
      port,
      user: DEFAULT_USER,
      keyPath,
      basePath: DEFAULT_BASE_PATH,
    },
  }, null, 2))
  console.log('-------------------------------------\n')
}

export function containerUp(args: string[]): void {
  const composeFile = findComposeFile()
  if (!composeFile) {
    console.error('No docker-compose.yml found. Run `ocm-mem container setup` first.')
    process.exit(1)
  }

  const portArg = args.find(a => a.startsWith('--port='))
  const env = portArg ? { ...process.env, SANDBOX_PORT: portArg.split('=')[1] } : process.env

  try {
    execSync(`docker compose -f ${composeFile} up -d --build`, {
      stdio: 'inherit',
      env: env as NodeJS.ProcessEnv,
    })
    console.log('\nSandbox container started.')
  } catch {
    process.exit(1)
  }
}

export function containerDown(args: string[]): void {
  const composeFile = findComposeFile()
  if (!composeFile) {
    console.error('No docker-compose.yml found.')
    process.exit(1)
  }

  try {
    execSync(`docker compose -f ${composeFile} down`, { stdio: 'inherit' })
    console.log('\nSandbox container stopped.')
  } catch {
    process.exit(1)
  }
}

export async function cli(args: string[], _globalOpts: { dbPath?: string; resolvedProjectId?: string }): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help()
    return
  }

  const subcommand = args[0]
  const subArgs = args.slice(1)

  switch (subcommand) {
    case 'setup':
      containerSetup(subArgs)
      break
    case 'up':
      containerUp(subArgs)
      break
    case 'down':
      containerDown(subArgs)
      break
    default:
      console.error(`Unknown container subcommand: ${subcommand}`)
      help()
      process.exit(1)
  }
}

export function help(): void {
  console.log(`
OpenCode Memory Container Commands

Usage:
  ocm-mem container <subcommand> [options]

Subcommands:
  setup     Generate SSH keys and create authorized_keys
  up        Start the sandbox container
  down      Stop the sandbox container

Options:
  --port=<number>   SSH port (default: 2222)
  --host=<host>     SSH host (default: localhost)
  --help, -h        Show this help
  `.trim())
}
