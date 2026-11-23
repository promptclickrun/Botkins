# Botkins on a server.
#
# The default image (the last stage, `terminal`) is the terminal host: the whole workspace and
# the phone link in one small Node service, with no Electron and no display. It is what
# `docker compose up` runs. See docs/terminal.md.
#
# The stages before it are the earlier headless setup, kept for a phone that should see and
# control a screen: a `host` that owns the paired-phone identity and the screen grant, and a
# `workspace` that runs Electron on a virtual display and exposes only a Unix socket through the
# shared runtime volume. `docker compose --profile display up host workspace` runs those two.
FROM node:24-bookworm-slim AS botkins

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
    chromium \
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
# A gadget's Botkin is drawn from the design kit beside the link (desktop/link/botkin-svg.mjs).
COPY design/botkins-kit/customize.js ./design/botkins-kit/customize.js
COPY design/botkins-kit/motion ./design/botkins-kit/motion
COPY design/botkins-kit/avatars ./design/botkins-kit/avatars
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

# The terminal host: plain Node, nothing of a desktop. This is the default image.
FROM node:24-bookworm-slim AS terminal

ENV DEBIAN_FRONTEND=noninteractive

# Certificates for the providers and the relay, git for bots that work in a project folder, and
# tini so the service is stopped properly and the tools it starts are reaped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/botkins

COPY package.json package-lock.json ./
# The same dependencies as the desktop app's own process, without Electron and the build tools.
# The copies of Claude Code the SDK brings are left out, as in the desktop package: a host uses
# the one that is installed on it.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-* node_modules/electron-updater node_modules/@microsoft/copilot-sdk-linuxmusl-* \
  && npm cache clean --force
COPY cli ./cli
COPY desktop ./desktop
COPY design/botkins-kit/customize.js ./design/botkins-kit/customize.js
COPY design/botkins-kit/motion ./design/botkins-kit/motion
COPY design/botkins-kit/avatars ./design/botkins-kit/avatars
COPY install/botkins ./bin/botkins

RUN groupadd --system --gid 10001 botkins \
  && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /var/lib/botkins/home --shell /usr/sbin/nologin botkins \
  && install -d -o botkins -g botkins -m 0700 /var/lib/botkins /var/lib/botkins/home \
  && chmod 0755 bin/botkins \
  && ln -s /opt/botkins/bin/botkins /usr/local/bin/botkins

# BOTKINS_IMAGE names the image this is, so `botkins update` can say what to pull: a container is
# replaced by a new image, never updated from inside.
ENV NODE_ENV=production \
    BOTKINS_DATA_DIR=/var/lib/botkins \
    BOTKINS_IMAGE=ghcr.io/promptclickrun/botkins \
    HOME=/var/lib/botkins/home

USER botkins
VOLUME ["/var/lib/botkins"]
# The phone link. The control socket stays inside the container: `docker compose exec botkins botkins pair`.
EXPOSE 47610
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["botkins", "status", "--json"]
ENTRYPOINT ["/usr/bin/tini", "--", "botkins"]
CMD ["serve"]
