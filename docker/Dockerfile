FROM cgr.dev/chainguard/node:latest-dev@sha256:8cef8e2f7f6f7e96c224a4a4d6123cd55e43d8688ee8676b1bf70bb5e3232f8c

# openssh-client: ssh binary for git-over-SSH (PI_SSH_AGENT=1) and ssh-add.
USER root
RUN apk add --no-cache \
        curl \
        ca-certificates \
        git \
        openssh-client \
        tmux

# Install pi globally
RUN npm install -g "@earendil-works/pi-coding-agent@0.80.2"

# Install yaml where jiti's module resolution can reach it.
# /home/piuser/.pi/node_modules/ sits in the ancestor-walk chain of every
# extension file (/home/piuser/.pi/agent/extensions/*.ts) but is NOT covered
# by the host directory mounted over /home/piuser/.pi/agent, so the package
# survives at runtime without being shadowed.
RUN npm install --prefix /home/piuser/.pi yaml

# Prepend the runtime npm-global bin dir so packages installed via `pi install`
# are on PATH. The .npmrc prefix routes installs into the host directory at
# /home/piuser/.pi/agent, so they survive container restarts.
# Security: binaries here can shadow any system command; --cap-drop=ALL and
# --no-new-privileges are expected at run time to prevent privilege escalation.
ENV PATH="/home/piuser/.pi/agent/npm-global/bin:${PATH}"

# /home/piuser: world-writable (1777) so any runtime UID can write here.
# /home/piuser/.ssh: root-owned 755; SSH accepts it and the runtime user can
#   read mounts inside it (700 would block a non-matching UID).
# /etc/passwd: world-writable so the entrypoint can add the runtime UID.
#   SSH calls getpwuid(3) and hard-fails without a passwd entry. Safe here
#   because --cap-drop=ALL and --no-new-privileges block privilege escalation.
# .npmrc sets prefix=/home/piuser/.pi/agent/npm-global so runtime installs land
# in the host directory and persist across container restarts.
# Written as a literal file because ENV HOME is not yet set to /home/piuser.
RUN mkdir -p /home/piuser /home/piuser/.ssh \
    && chmod 1777 /home/piuser \
    && chmod 755 /home/piuser/.ssh \
    && chmod a+w /etc/passwd \
    && touch /home/piuser/.ssh/known_hosts \
    && chmod 644 /home/piuser/.ssh/known_hosts \
    && echo "prefix=/home/piuser/.pi/agent/npm-global" > /home/piuser/.npmrc

ENV HOME=/home/piuser

# Register the runtime UID in /etc/passwd before starting pi.
# SSH calls getpwuid(3) and hard-fails without an entry; nss_wrapper is
# unavailable in Wolfi so we append directly.
RUN <<'EOF'
cat > /usr/local/bin/entrypoint.sh << 'ENTRYPOINT'
#!/bin/sh
set -e

if ! grep -q "^[^:]*:[^:]*:$(id -u):" /etc/passwd; then
    printf 'piuser:x:%d:%d:piuser:%s:/bin/sh\n' \
        "$(id -u)" "$(id -g)" "${HOME}" >> /etc/passwd
fi

exec pi --offline "$@"
ENTRYPOINT
chmod +x /usr/local/bin/entrypoint.sh
EOF

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

