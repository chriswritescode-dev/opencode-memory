#!/bin/bash
set -e

if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
    ssh-keygen -A
fi

if [ ! -d /home/devuser/.ssh ]; then
    mkdir -p /home/devuser/.ssh
    chmod 700 /home/devuser/.ssh
    chown devuser:devuser /home/devuser/.ssh
fi

if [ -n "$AUTHORIZED_KEYS" ]; then
    echo "$AUTHORIZED_KEYS" > /home/devuser/.ssh/authorized_keys
    chmod 600 /home/devuser/.ssh/authorized_keys
    chown devuser:devuser /home/devuser/.ssh/authorized_keys
fi

if [ ! -f /home/devuser/.ssh/authorized_keys ] || [ ! -s /home/devuser/.ssh/authorized_keys ]; then
    if [ ! -f /home/devuser/.ssh/id_ed25519 ]; then
        ssh-keygen -t ed25519 -f /home/devuser/.ssh/id_ed25519 -N "" -C "opencode-sandbox"
        cat /home/devuser/.ssh/id_ed25519.pub > /home/devuser/.ssh/authorized_keys
        chmod 600 /home/devuser/.ssh/authorized_keys
        chmod 600 /home/devuser/.ssh/id_ed25519
        chown -R devuser:devuser /home/devuser/.ssh
    fi
    echo "=========================================="
    echo "Auto-generated SSH private key:"
    echo "=========================================="
    cat /home/devuser/.ssh/id_ed25519
    echo "=========================================="
    echo "Save this key to connect to the container."
    echo "=========================================="
fi

exec /usr/sbin/sshd -D
