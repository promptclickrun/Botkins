# A clean Debian with systemd as its first process, as a small server has: no X libraries, no
# Node.js, nothing of Botkins. test/terminal-e2e/run.sh installs the terminal host into it.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive container=docker
# What a minimal server image has, and GnuPG, which the installer asks for to check a release's signature.
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl gnupg procps \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl mask systemd-logind.service getty.target console-getty.service systemd-udevd.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
