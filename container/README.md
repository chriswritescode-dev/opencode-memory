# Remote Sandbox Container

Docker container for running OpenCode agent commands in an isolated environment via SSH.

## Included Tools

| Tool | Version | Source |
|------|---------|--------|
| Node.js | 24.x | Base image (node:24-slim) |
| npm | bundled with Node | Base image |
| pnpm | latest | npm install -g |
| Bun | latest | GitHub release binary |
| Python | 3.12 | uv managed |
| uv / uvx | latest | Multi-stage copy from distroless |
| git | distro | apt |
| gh (GitHub CLI) | latest | GitHub apt repo |
| ripgrep (rg) | distro | apt |
| jq, tree, less, file, lsof, make, gawk | distro | apt |

## Components

### Dockerfile

Multi-stage build using `node:24-slim` as base:
- `sshd` as PID 1
- `devuser` (uid 1001) without sudo access
- uv binary copied from distroless image (smallest approach)
- Bun installed from direct binary ZIP
- Python installed via uv as devuser
- arm64/amd64 support via `TARGETARCH`

### entrypoint.sh

On first boot:
1. Generates SSH host keys if missing
2. Creates `/home/devuser/.ssh` directory
3. Sets up `authorized_keys` from environment variable or auto-generates keys
4. Adds uv-managed Python to devuser PATH
5. Auto-generates SSH keypair if no authorized_keys is provided (key location logged, not printed)

### docker-compose.yml

Docker Compose template with:
- Port mapping (default 2222:22)
- Persistent volume for `/projects`
- Mount for `authorized_keys`

## Usage

```bash
docker build -t opencode-sandbox .
docker compose up -d
docker compose down
```

## Build Arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `PYTHON_VERSION` | `3.12` | Python version installed via uv |

## Environment Variables

| Var | Description |
|-----|-------------|
| `SANDBOX_PORT` | SSH port mapping (default: 2222) |
| `AUTHORIZED_KEYS` | Public key content (alternative to volume mount) |
