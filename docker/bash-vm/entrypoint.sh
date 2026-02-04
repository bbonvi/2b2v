#!/bin/bash
set -e

# Volume contains bot's SSH keys - we only need authorized_keys (public key)
SSH_KEYS_VOL="/ssh-keys-vol"
SOURCE_AUTH_KEYS="$SSH_KEYS_VOL/authorized_keys"
TARGET_AUTH_KEYS="/run/authorized_keys"

# Wait for authorized_keys to exist (bot generates on first run)
echo "bash-vm: Waiting for authorized_keys..."
timeout=60
elapsed=0
while [ ! -f "$SOURCE_AUTH_KEYS" ]; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ $elapsed -ge $timeout ]; then
        echo "bash-vm: Timeout waiting for authorized_keys"
        exit 1
    fi
done

echo "bash-vm: authorized_keys found"

# Copy ONLY the public key to tmpfs - private keys stay hidden in volume
cp "$SOURCE_AUTH_KEYS" "$TARGET_AUTH_KEYS"
chmod 644 "$TARGET_AUTH_KEYS"
# Note: Private key in volume has mode 600 owned by root, unreadable by user (uid 1000)

# Apply egress filtering if CAP_NET_ADMIN is available
if command -v iptables &>/dev/null; then
    # Block private and link-local ranges (OUTPUT chain)
    # Allow loopback for local operations
    iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
    # Allow established connections (for DNS replies, etc)
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    # Allow DNS to container's configured resolver
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
    # Block private ranges
    iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT 2>/dev/null || true
    iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT 2>/dev/null || true
    iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT 2>/dev/null || true
    iptables -A OUTPUT -d 100.64.0.0/10 -j REJECT 2>/dev/null || true
    iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT 2>/dev/null || true
    iptables -A OUTPUT -d 127.0.0.0/8 -j REJECT 2>/dev/null || true
    # IPv6 private/link-local
    ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -d fc00::/7 -j REJECT 2>/dev/null || true
    ip6tables -A OUTPUT -d fe80::/10 -j REJECT 2>/dev/null || true
    ip6tables -A OUTPUT -d ::1/128 -j REJECT 2>/dev/null || true
    echo "bash-vm: Egress filtering applied"
fi

# Create sshd privilege separation directory (tmpfs /run is empty on start)
mkdir -p /run/sshd

echo "bash-vm: Starting sshd"
exec /usr/sbin/sshd -D -e
