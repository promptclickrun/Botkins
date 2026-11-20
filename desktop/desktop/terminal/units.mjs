// The files that keep the terminal host running across restarts: a systemd unit on Linux, a
// launchd job on macOS. `botkins service install` writes one of them (desktop/terminal/manager.mjs).
// This file only makes their text, so the tests read exactly what would be installed.
//
// The systemd unit for the whole computer runs the service as its own user, `botkins`, with
// nothing it doesn't need:
//
//   - It can write only its data folder (ProtectSystem=strict, ReadWritePaths=). The rest of the
//     disk is read-only to it, /home and /root are hidden (ProtectHome=), and /tmp is its own.
//   - It can never gain a privilege it didn't start with (NoNewPrivileges=, an empty capability
//     set, no set-user-ID files), and can't touch the kernel's settings, modules, logs or clock.
//   - The host key reaches it as a credential (LoadCredential=): systemd reads a root-only file
//     and hands the service a copy in memory, so the service's user can't read the file itself.
//
// Bots do real work on the host: they write files and run tools. With this unit they do so inside
// the data folder. A project folder elsewhere has to be named when the service is installed
// (`--allow-path`), which adds it to ReadWritePaths=.
//
// What is left out, on purpose: MemoryDenyWriteExecute= (Node's compiler needs writable code
// pages), RestrictNamespaces= and SystemCallFilter= (the model providers' own tools sandbox the
// commands they run, with namespaces and filters of their own).
export const UNIT = "botkins.service";
export const UPDATE_UNIT = "botkins-update.service";
export const UPDATE_PATH_UNIT = "botkins-update.path";
export const LABEL = "app.botkins.terminal";
export const DOCS = "https://github.com/promptclickrun/Botkins/blob/main/desktop/docs/terminal.md";

/** A value in a unit file: quoted when it holds a space, with what systemd would expand escaped. */
const unitValue = (value) => {
  const text = String(value).replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /[\s"'\\]/.test(text) ? '"' + text.replace(/(["\\])/g, "\\$1") + '"' : text;
};
const environment = (env) => Object.entries(env).map(([name, value]) => "Environment=" + unitValue(name + "=" + value));
const safePath = (path) => {
  if (typeof path !== "string" || !path.startsWith("/") || /[\n\r\0]/.test(path) || path.split("/").includes("..")) throw new Error("A path in a service file is whole, from the top of the disk: " + path);
  return path;
};

/**
 * The unit for the whole computer.
 * @param options.command    How `botkins` is started: its program and any words before the command, each whole.
 * @param options.dataDir    The data folder.
 * @param options.user       The user the service runs as.
 * @param options.home       That user's home, where the providers' tools keep their sign-ins. Inside the data folder.
 * @param options.key        { file } a root-only key file handed over with LoadCredential=,
 *                           { encrypted } one encrypted with systemd-creds, handed over with
 *                           LoadCredentialEncrypted=, or { groupFile } a key file the service's
 *                           group reads itself, where systemd can't hand a credential over.
 * @param options.allowPaths More folders bots may write to (project folders).
 * @param options.env        More environment for the service.
 */
export function systemUnit({ command, dataDir, user = "botkins", group = user, home = dataDir + "/home", key, allowPaths = [], env = {} }) {
  for (const path of [...command, dataDir, home, ...allowPaths, key?.file, key?.encrypted, key?.groupFile].filter(Boolean)) safePath(path);
  // The unit says where the key comes from, so a start without it fails with one sentence
  // instead of quietly making another key somewhere else (desktop/host/keystore.mjs).
  const keyEnv = key?.groupFile ? { BOTKINS_KEY_SOURCE: "file", BOTKINS_KEY_FILE: key.groupFile } : key ? { BOTKINS_KEY_SOURCE: "systemd" } : {};
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(group)) throw new Error("That isn't a user's name: " + user);
  return [
    "# Written by `botkins service install`. Change it with `systemctl edit " + UNIT + "`, which survives the next install.",
    "[Unit]",
    "Description=Botkins terminal host",
    "Documentation=" + DOCS,
    "Wants=network-online.target",
    "After=network-online.target",
    // Five failed starts in a minute is a problem to look at, not one to keep hitting.
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "User=" + user,
    "Group=" + group,
    "WorkingDirectory=" + unitValue(dataDir),
    ...environment({ BOTKINS_DATA_DIR: dataDir, HOME: home, NODE_ENV: "production", ...keyEnv, ...env }),
    ...(key?.encrypted ? ["LoadCredentialEncrypted=botkins-key:" + key.encrypted] : key?.file ? ["LoadCredential=botkins-key:" + key.file] : []),
    "ExecStart=" + command.map(unitValue).join(" ") + " serve",
    "Restart=on-failure",
    "RestartSec=3",
    // The service saves its work and closes its providers before it goes.
    "TimeoutStopSec=20",
    "KillMode=mixed",
    "UMask=0077",
    "",
    "# What the service may touch.",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ReadWritePaths=" + [dataDir, ...allowPaths].map(unitValue).join(" "),
    "ProtectHome=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectKernelLogs=true",
    "ProtectControlGroups=true",
    "ProtectClock=true",
    "ProtectHostname=true",
    "RestrictSUIDSGID=true",
    "RestrictRealtime=true",
    "LockPersonality=true",
    "SystemCallArchitectures=native",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * The unit for one person (`systemctl --user`), with lingering so it runs when they are signed
 * out. It runs as that person, so it protects less than the system unit: there is no other user
 * to run as and no root to hand it a key, and its key file is the person's own.
 */
export function userUnit({ command, dataDir, keyFile, env = {} }) {
  for (const path of [...command, dataDir, keyFile].filter(Boolean)) safePath(path);
  return [
    "# Written by `botkins service install --user`. Change it with `systemctl --user edit " + UNIT + "`.",
    "[Unit]",
    "Description=Botkins terminal host",
    "Documentation=" + DOCS,
    "Wants=network-online.target",
    "After=network-online.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    ...environment({ BOTKINS_DATA_DIR: dataDir, ...(keyFile && { BOTKINS_KEY_FILE: keyFile }), NODE_ENV: "production", ...env }),
    "ExecStart=" + command.map(unitValue).join(" ") + " serve",
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=20",
    "KillMode=mixed",
    "UMask=0077",
    "NoNewPrivileges=true",
    "LockPersonality=true",
    "RestrictRealtime=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * The root job that installs a signed release, and the watch that starts it. The service runs
 * without privileges, so it can't replace its own program: it can only ask, by making an empty
 * file in its data folder. The watch sees the file and starts the job as root. The job takes
 * nothing from the file but that it is there: what it installs is the latest signed release from
 * the project's own address (desktop/terminal/update-install.mjs).
 */
export function updateUnits({ command, dataDir }) {
  for (const path of [...command, dataDir]) safePath(path);
  return {
    [UPDATE_UNIT]: [
      "# Written by `botkins service install`.",
      "[Unit]",
      "Description=Install the latest signed Botkins terminal host release",
      "Documentation=" + DOCS,
      "Wants=network-online.target",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=oneshot",
      "Environment=" + unitValue("BOTKINS_DATA_DIR=" + dataDir),
      "ExecStart=" + command.map(unitValue).join(" ") + " update --apply",
      "UMask=0022",
      "PrivateTmp=true",
      "",
    ].join("\n"),
    [UPDATE_PATH_UNIT]: [
      "# Written by `botkins service install`.",
      "[Unit]",
      "Description=Watch for the Botkins terminal host asking to be updated",
      "",
      "[Path]",
      "PathExists=" + unitValue(dataDir + "/run/update-requested"),
      "Unit=" + UPDATE_UNIT,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n"),
  };
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The launchd job. For one person it is a LaunchAgent in their own session, where their login
 * keychain holds the host key; with `user` it is a LaunchDaemon that runs as that user from the
 * moment the Mac starts, and keeps its key in a file (a daemon has no keychain session to ask).
 * It is started again when it ends badly, and left alone when it was stopped on purpose.
 */
export function launchdJob({ command, dataDir, logFile, user, env = {} }) {
  for (const path of [...command, dataDir, logFile]) safePath(path);
  // The service keeps its own log; launchd's file is for what Node itself says when it can't start.
  const vars = { BOTKINS_DATA_DIR: dataDir, BOTKINS_QUIET: "1", NODE_ENV: "production", ...env };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>" + LABEL + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[...command, "serve"].map((word) => "    <string>" + xml(word) + "</string>"),
    "  </array>",
    ...(user ? ["  <key>UserName</key>", "  <string>" + xml(user) + "</string>"] : []),
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(vars).flatMap(([name, value]) => ["    <key>" + xml(name) + "</key>", "    <string>" + xml(value) + "</string>"]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    "  <string>" + xml(dataDir) + "</string>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>ExitTimeOut</key>",
    "  <integer>20</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "  <key>StandardOutPath</key>",
    "  <string>" + xml(logFile) + "</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>" + xml(logFile) + "</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
