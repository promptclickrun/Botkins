# Botkins headless host and its isolated virtual-display workspace.
#
# The host and workspace are separate Compose services. The host owns the paired-phone
# identity and screen grant. The workspace owns the Electron display and exposes only a
# Unix socket through the shared runtime volume.
FROM node:24-bookworm-slim AS botkins

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
    xvfb \
    openbox \
    xdotool \
    x11-utils \
    xauth \
    dbus-x11 \
    fonts-dejavu \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    libxkbcommon0 \
    libxkbcommon-x11-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev
# npm 11 may leave Electron's platform binary to its first invocation. Install the
# Linux binary while building so the read-only runtime never downloads or mutates
# node_modules.
RUN node node_modules/electron/install.js \
  && chmod 4755 node_modules/electron/dist/chrome-sandbox
COPY . .
RUN npm run build

RUN groupadd --system --gid 10001 botkins \
  && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/botkins --shell /usr/sbin/nologin botkins \
  && install -d -o botkins -g botkins -m 0700 \
       /var/lib/botkins-link \
       /var/lib/botkins-link/uploads \
       /var/lib/botkins-workspace \
       /run/botkins-owner \
       /run/botkins-workspace

COPY docker/host-entrypoint.sh /usr/local/bin/botkins-headless-host
COPY docker/workspace-entrypoint.sh /usr/local/bin/botkins-display-workspace
RUN chmod 0755 /usr/local/bin/botkins-headless-host /usr/local/bin/botkins-display-workspace

ENV NODE_ENV=production \
    BOTKINS_HEADLESS=1 \
    BOTKINS_HOST_PORT=59851 \
    BOTKINS_DATA_DIR=/var/lib/botkins-link \
    BOTKINS_OWNER_PAIRING_FILE=/run/botkins-owner/pairing.json \
    BOTKINS_WORKSPACE_SOCKET=/run/botkins-workspace/backend.sock

USER botkins
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM node:24-bookworm-slim AS headless-host

ENV DEBIAN_FRONTEND=noninteractive

# The authority has no Electron, renderer, provider or build-tool dependency. Keep
# it a small Node image and copy only the link/headless runtime it can execute.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY desktop/link ./desktop/link
COPY desktop/headless ./desktop/headless
COPY docker/host-entrypoint.sh /usr/local/bin/botkins-headless-host

RUN groupadd --system --gid 10001 botkins \
  && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/botkins --shell /usr/sbin/nologin botkins \
  && install -d -o botkins -g botkins -m 0700 \
       /var/lib/botkins-link \
       /var/lib/botkins-link/uploads \
       /run/botkins-owner \
       /run/botkins-workspace \
  && chmod 0755 /usr/local/bin/botkins-headless-host

ENV NODE_ENV=production \
    BOTKINS_HEADLESS=1 \
    BOTKINS_LINK_PORT=59851 \
    BOTKINS_HOST_PORT=59851 \
    BOTKINS_DATA_DIR=/var/lib/botkins-link \
    BOTKINS_OWNER_PAIRING_FILE=/run/botkins-owner/pairing.json \
    BOTKINS_WORKSPACE_SOCKET=/run/botkins-workspace/backend.sock

USER botkins
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM headless-host AS host
CMD ["/usr/local/bin/botkins-headless-host"]

FROM botkins AS workspace
CMD ["/usr/local/bin/botkins-display-workspace"]
