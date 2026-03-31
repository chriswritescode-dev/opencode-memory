# Remote Sandbox Container

Docker container setup for running OpenCode Memory plugin commands in an isolated environment via SSH.

## Components

### Dockerfile

Builds an Ubuntu 22.04 minimal image with:
- `sshd` as PID 1
- `devuser` (uid 1000) with sudo access
- Git and essential tools (grep, find, sed)
- No Node.js or Bun (plugin runs on host)

### entrypoint.sh

On first boot:
1. Generates SSH host keys if missing
2. Creates `/home/devuser/.ssh` directory
3. Sets up `authorized_keys` from environment variable or auto-generates keys
4. Outputs the auto-generated private key to stdout for first-time setup

### docker-compose.yml

Docker Compose template with:
- Port mapping (default 2222:22)
- Persistent volume for `/projects`
- Mount for `authorized_keys`

## Usage

```bash
# Build the image
docker build -t opencode-sandbox .

# Start with docker-compose
docker compose up -d

# Stop
docker compose down
```

## Configuration

Environment variables:
- `SANDBOX_PORT` - SSH port (default: 2222)
- `AUTHORIZED_KEYS` - Public key content (alternative to volume mount)
