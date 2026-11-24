import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as pause } from "node:timers/promises";
import { Failure, runTool, ToolError } from "./tools.mjs";

export const PASS_OUTPUT = 8 * 1024 * 1024;

export function protonPage(output) {
  for (const match of output.matchAll(/https?:\/\/[^\s<>"'`\x1b]+/gi)) {
    const candidate = match[0];
    const authority = /^https:\/\/([^/?#]+)/i.exec(candidate)?.[1];
    if (!authority || !/^(?:[a-z0-9-]+\.)*account\.proton\.me$/i.test(authority) || candidate.includes("\\")) continue;
    try {
      const url = new URL(candidate);
      if (url.href.length <= 4096 && !url.username && !url.password && !url.port) return url.href;
    } catch {
      // Not an absolute Proton account URL.
    }
  }
}

// Windows' default named-pipe ACL is not private. Create a write-only pipe with an ACL for
// this user's SID; stdin carries the password, not a file or a command-line argument.
const WINDOWS_PIPE = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [IO.Pipes.PipeSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$rule = [IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$pipe = [IO.Pipes.NamedPipeServerStream]::new($env:BOTKINS_PASS_PIPE, 'Out', 1, 'Byte', 'None', 0, 0, $acl)
try {
  [Console]::WriteLine('ready')
  while ($true) {
    $pipe.WaitForConnection()
    try {
      [Console]::WriteLine('ask')
      $response = [Console]::ReadLine()
      if ($null -eq $response) { break }
      $bytes = [Convert]::FromBase64String($response)
      try {
        $pipe.Write($bytes, 0, $bytes.Length)
        $pipe.Flush()
        $pipe.WaitForPipeDrain()
      } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
    } finally { $pipe.Disconnect() }
  }
} finally { $pipe.Dispose() }
`;

async function windowsPipe(signal, receive) {
  const name = "botkins-pass-" + randomBytes(24).toString("hex");
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const exe = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(exe, ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", WINDOWS_PIPE], {
    env: { SystemRoot: root, BOTKINS_PASS_PIPE: name }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const local = new AbortController();
  const waiting = AbortSignal.any([signal, local.signal]);
  const error = () => new Failure("Botkins couldn't open the Proton Pass extra password pipe.");
  const exited = new Promise((resolve) => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout });
  const ready = Promise.withResolvers();
  child.once("error", () => ready.reject(error()));
  child.stdin.on("error", () => child.kill());
  const worker = (async () => {
    for await (const line of lines) {
      if (line === "ready") ready.resolve();
      else if (line === "ask") {
        const password = await receive(waiting);
        waiting.throwIfAborted();
        child.stdin.write(Buffer.from(password, "utf8").toString("base64") + "\n");
      }
    }
    if (!waiting.aborted) throw error();
  })();
  void worker.catch(ready.reject);
  const close = async () => {
    local.abort();
    child.kill();
    lines.close();
    await exited;
  };
  const abort = () => child.kill();
  waiting.addEventListener("abort", abort, { once: true });
  try {
    waiting.throwIfAborted();
    await Promise.race([ready.promise, exited.then(() => { throw error(); })]);
  } catch (reason) {
    await close();
    throw signal.reason ?? reason;
  }
  return { path: "\\\\.\\pipe\\" + name, worker, close };
}

async function passwordPipe(dir, signal, receive) {
  if (process.platform === "win32") return windowsPipe(signal, receive);
  const path = join(dir, "extra-password");
  const mkfifo = await stat("/usr/bin/mkfifo").then(() => "/usr/bin/mkfifo", () => "/bin/mkfifo");
  await runTool("Proton Pass password pipe", mkfifo, ["-m", "600", path]);
  const watch = new AbortController();
  const waiting = AbortSignal.any([signal, watch.signal]);
  const worker = (async () => {
    while (!waiting.aborted) {
      let fd;
      try {
        fd = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        if (error.code !== "ENXIO") throw error;
      }
      if (fd) {
        try {
          const password = await receive(waiting);
          waiting.throwIfAborted();
          await fd.writeFile(password);
        } finally {
          await fd.close();
        }
        // Give the CLI time to consume EOF before probing for another reader.
        await pause(250, undefined, { signal: waiting });
      } else await pause(40, undefined, { signal: waiting });
    }
  })();
  return { path, worker, close: async () => {
    watch.abort();
    await worker.catch((error) => { if (!waiting.aborted) throw error; });
  } };
}

export async function browserLogin({ cli, env, dir, signal, onOpen, receive }) {
  const pipe = await passwordPipe(dir, signal, receive);
  const local = new AbortController();
  const stop = AbortSignal.any([signal, local.signal]);
  try {
    stop.throwIfAborted();
    await new Promise((resolve, reject) => {
      const child = spawn(cli, ["login"], {
        env: { ...env, PROTON_PASS_EXTRA_PASSWORD_FILE: pipe.path }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let size = 0, detail = "", opened = false, failure;
      const kill = (error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () => kill(stop.reason);
      stop.addEventListener("abort", abort, { once: true });
      void pipe.worker?.catch((error) => {
        if (!stop.aborted) kill(error instanceof Failure ? error : new Failure("Botkins couldn't open the Proton Pass extra password pipe."));
      });
      child.once("error", () => { failure ??= new ToolError("Proton Pass", "missing"); });
      for (const stream of [child.stdout, child.stderr]) {
        let pending = "";
        const decoder = new StringDecoder();
        const scan = (line) => {
          if (!opened) {
            const url = protonPage(line);
            if (url) {
              opened = true;
              onOpen(url);
            }
          }
        };
        stream.on("data", (bytes) => {
          size += bytes.length;
          if (size > PASS_OUTPUT) return kill(new ToolError("Proton Pass", "output"));
          const text = decoder.write(bytes);
          detail = (detail + text).slice(-4000);
          const lines = (pending + text).split(/[\r\n]+/);
          pending = (lines.pop() ?? "").slice(-8192);
          for (const line of lines) scan(line);
        });
        stream.on("end", () => scan(pending + decoder.end()));
      }
      child.once("close", (code) => {
        stop.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new ToolError("Proton Pass", "exit", detail));
      });
      if (stop.aborted) abort();
    });
  } finally {
    await pipe.close();
  }
}
