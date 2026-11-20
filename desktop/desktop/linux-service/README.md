# Enable in-app updates on a Linux system service

Use this setup once for a Botkins x64 or ARM64 tarball launched by a systemd **system** service. The helper needs Node.js 20 or later at `/usr/bin/node`, GnuPG, tar and polkit. Versions through 0.15.7 need one manual upgrade to 0.15.8 or later.

1. From the GitHub release, download the tarball for your architecture, `SHA256SUMS`, `SHA256SUMS.asc` and `botkins-release.asc`. Verify the key fingerprint is `366DD24D230E9F6BAE3EDE0AEB0AB1B21A7BAA7E`, the detached signature verifies, and the archive matches its checksum. Work from a directory writable only by the administrator. Extract the verified archive as root with `tar --no-same-owner -xzf ARCHIVE` under a root-owned install directory such as `/opt/botkins`. For an existing service-user-owned installation, use a fresh root-owned directory for the verified release. Keep the existing workspace and data paths in the service.
2. Point `/opt/botkins/current` to the extracted version directory. The service should use `ExecStart=/opt/botkins/current/botkins-desktop` and its usual unprivileged `User=`. Run `chown root:root /opt/botkins/current/chrome-sandbox` and `chmod 4755 /opt/botkins/current/chrome-sandbox` for this first manual installation. Restart the service and check its workspace.
3. In the following commands, start in `/opt/botkins/current/resources/app/desktop/linux-service` from the verified archive. Run as root. Before installing the polkit rule, replace `botkins` in `subject.user` with the actual service user. If your paths or app service name differ, adjust the installed JSON file to match.

```sh
install -d -m 0755 /usr/local/libexec /etc/botkins
install -m 0600 update.json.example /etc/botkins/update.json
gpg --batch --yes --dearmor --output /etc/botkins/release.gpg botkins-release.asc
install -m 0644 botkins-update-helper.mjs /usr/local/libexec/botkins-update-helper.mjs
install -m 0644 botkins-update.service /etc/systemd/system/botkins-update.service
install -m 0644 49-botkins-update.rules.example /etc/polkit-1/rules.d/49-botkins-update.rules
systemctl daemon-reload
```

Use **Settings → About → Check for updates** and choose **Install update**, or ask a bot to update the app. The service account can start only the fixed updater unit. The helper fetches the stable public release, verifies the signed checksum, installs the sandbox and atomically replaces the current symlink. The previous version stays on disk. If the new service fails or restarts during the first minute, the helper restores the previous symlink and restarts the old service. Check `journalctl -u botkins-update.service` for the outcome.
