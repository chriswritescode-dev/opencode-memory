FROM ghcr.io/astral-sh/uv:latest AS uv-bin

FROM node:24-slim

ARG PYTHON_VERSION=3.12
ARG TARGETARCH

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    git \
    ca-certificates \
    curl \
    unzip \
    ripgrep \
    jq \
    less \
    tree \
    file \
    lsof \
    procps \
    make \
    gawk \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/sshd

COPY --from=uv-bin /uv /uvx /usr/local/bin/

RUN npm install -g pnpm && npm cache clean --force

RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x64") && \
    curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-${ARCH}.zip" \
    -o /tmp/bun.zip && \
    unzip -q /tmp/bun.zip -d /tmp && \
    mv /tmp/bun-linux-${ARCH}/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun && \
    rm -rf /tmp/bun*

RUN useradd -m -s /bin/bash -u 1001 devuser

RUN mkdir -p /projects && chown devuser:devuser /projects

USER devuser
RUN uv python install ${PYTHON_VERSION} && \
    chown -R devuser:devuser /projects
USER root

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ssh -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=no devuser@localhost -p 22 echo ok || exit 1

ENTRYPOINT ["/entrypoint.sh"]
