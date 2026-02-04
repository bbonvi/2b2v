FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install extended package set per spec
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    bash \
    coreutils \
    curl \
    wget \
    git \
    python3 \
    python3-pip \
    jq \
    tmux \
    ripgrep \
    zip \
    unzip \
    ca-certificates \
    nodejs \
    npm \
    build-essential \
    make \
    dnsutils \
    iputils-ping \
    netcat-openbsd \
    socat \
    less \
    nano \
    vim \
    iptables \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for SSH
RUN useradd -m -s /bin/bash user

# SSH configuration (authorized_keys is in /ssh-keys volume, not user home)
RUN mkdir -p /run/sshd

# sshd config: key auth only, no password, no root login
# AuthorizedKeysFile points to /run (tmpfs) where entrypoint copies only the public key
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config && \
    echo "AuthorizedKeysFile /run/authorized_keys" >> /etc/ssh/sshd_config

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
