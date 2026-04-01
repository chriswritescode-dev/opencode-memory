#!/bin/bash
set -e

if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
    ssh-keygen -A
fi

if [ ! -d /home/devuser/.ssh ]; then
    mkdir -p /home/devuser/.ssh
    chmod 700 /home/devuser/.ssh
    chown devuser:devuser /home/devuser/.ssh
else
    chown devuser:devuser /home/devuser/.ssh
    chmod 700 /home/devuser/.ssh
fi

if [ -n "$AUTHORIZED_KEYS" ]; then
    echo "$AUTHORIZED_KEYS" > /home/devuser/.ssh/authorized_keys
    chmod 600 /home/devuser/.ssh/authorized_keys
    chown devuser:devuser /home/devuser/.ssh/authorized_keys || true
fi

if [ -f /home/devuser/.ssh/authorized_keys ]; then
    chmod 600 /home/devuser/.ssh/authorized_keys 2>/dev/null || true
    chown devuser:devuser /home/devuser/.ssh/authorized_keys 2>/dev/null || true
fi

if [ ! -f /home/devuser/.ssh/authorized_keys ] || [ ! -s /home/devuser/.ssh/authorized_keys ]; then
    if [ ! -f /home/devuser/.ssh/id_ed25519 ]; then
        ssh-keygen -t ed25519 -f /home/devuser/.ssh/id_ed25519 -N "" -C "opencode-sandbox"
        cat /home/devuser/.ssh/id_ed25519.pub > /home/devuser/.ssh/authorized_keys
        chmod 600 /home/devuser/.ssh/authorized_keys
        chmod 600 /home/devuser/.ssh/id_ed25519
        chown -R devuser:devuser /home/devuser/.ssh
    fi
    echo "SSH key auto-generated. Mount authorized_keys or set AUTHORIZED_KEYS env var."
    echo "Key location: /home/devuser/.ssh/id_ed25519"
fi

UV_PYTHON_DIR=$(find /home/devuser/.local/share/uv/python -maxdepth 1 -type d -name 'cpython-*' 2>/dev/null | head -1)
if [ -n "$UV_PYTHON_DIR" ]; then
    PROFILE="/home/devuser/.bashrc"
    if ! grep -q 'uv/python' "$PROFILE" 2>/dev/null; then
        echo "export PATH=\"${UV_PYTHON_DIR}/bin:\$PATH\"" >> "$PROFILE"
        chown devuser:devuser "$PROFILE"
    fi
fi

exec /usr/sbin/sshd -D
