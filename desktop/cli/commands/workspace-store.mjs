// `botkins workspace` commands: offline/maintenance operations on the workspace store.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, table, usage } from "../output.mjs";
import {
  countDbRecords,
  exportWorkspaceToJson,
  formatBytes,
  migrateWorkspaceFile,
  openWorkspaceDb,
  WORKSPACE_DB_FILENAME,
} from "../../desktop/workspace-sqlite.mjs";

function resolveWorkspaceDir(context) {
  // Prefer `<root>/data` (the standard terminal/desktop layout), or `<root>` directly if the user
  // pointed `--data-dir` straight at a folder holding `workspace.json` or `workspace.db`.
  const dataDir = context.paths.dataDir;
  if (
    existsSync(join(dataDir, WORKSPACE_DB_FILENAME)) ||
    existsSync(join(dataDir, "workspace.json"))
  ) {
    return dataDir;
  }
  if (
    existsSync(join(context.paths.root, WORKSPACE_DB_FILENAME)) ||
    existsSync(join(context.paths.root, "workspace.json"))
  ) {
    return context.paths.root;
  }
  return dataDir;
}

function formatCounts(counts) {
  return table(
    ["TABLE", "ROWS"],
    [
      ["bots", String(counts.bots)],
      ["chats", String(counts.chats)],
      ["messages", String(counts.messages)],
      ["routines", String(counts.routines)],
      ["runs", String(counts.runs)],
      ["run_steps", String(counts.runSteps)],
      ["tasks", String(counts.tasks)],
      ["projects", String(counts.projects)],
      ["spaces", String(counts.spaces)],
      ["panels", String(counts.panels)],
      ["workflows", String(counts.workflows)],
      ["workflow_runs", String(counts.workflowRuns)],
      ["kv", String(counts.kvKeys)],
    ],
  );
}

export const workspaceStoreCommands = {
  workspace: {
    summary: "Inspect or migrate the workspace store (SQLite)",
    commands: {
      migrate: {
        summary: "Migrate workspace.json to SQLite (workspace.db)",
        usage: "botkins workspace migrate [--dry-run]",
        options: {
          "dry-run": {
            type: "boolean",
            about: "Validate import and verify row counts in memory without modifying files on disk",
          },
        },
        details:
          "Imports workspace.json (and any pending turn checkpoints) into workspace.db in one transaction, verifies all row counts, and renames workspace.json to workspace.json.migrated-<timestamp>. Idempotent when workspace.db already exists. Pass --dry-run to check timing and counts without changing disk.",
        async run(context) {
          if (context.args.length) throw usage("`botkins workspace migrate` takes no positional arguments.");
          const dryRun = context.options["dry-run"] === true;
          const dir = resolveWorkspaceDir(context);
          let result;
          try {
            result = migrateWorkspaceFile(dir, { dryRun });
          } catch (error) {
            throw new CliError("Workspace migration failed: " + error.message);
          }
          context.print(result, (r) => {
            if (r.status === "already-migrated") {
              return [
                `Workspace is already on SQLite (${r.dbPath}, ${formatBytes(r.dbBytes)}).`,
                "",
                formatCounts(r.counts),
              ].join("\n");
            }
            if (r.status === "empty") {
              return `No workspace.json or workspace.db found in ${r.dir}.`;
            }
            if (r.status === "dry-run") {
              return [
                `Dry run succeeded for ${r.jsonPath} (${formatBytes(r.jsonBytes)}). No files were changed.`,
                `Read: ${r.readMs} ms  Import + verify: ${r.importMs} ms  Total: ${r.totalMs} ms`,
                "",
                formatCounts(r.counts),
              ].join("\n");
            }
            return [
              `Migrated ${r.jsonPath} (${formatBytes(r.jsonBytes)}) -> ${r.dbPath} (${formatBytes(r.dbBytes)}).`,
              `Backup: ${r.backupPath}`,
              `Read: ${r.readMs} ms  Import + verify: ${r.importMs} ms  Total: ${r.totalMs} ms`,
              "",
              formatCounts(r.counts),
            ].join("\n");
          });
        },
      },
      status: {
        summary: "Show the workspace store backend, size and row counts",
        usage: "botkins workspace status",
        async run(context) {
          if (context.args.length) throw usage("`botkins workspace status` takes no positional arguments.");
          const dir = resolveWorkspaceDir(context);
          const dbPath = join(dir, WORKSPACE_DB_FILENAME);
          const jsonPath = join(dir, "workspace.json");
          if (existsSync(dbPath)) {
            const db = openWorkspaceDb(dbPath);
            try {
              const counts = countDbRecords(db);
              const bytes = statSync(dbPath).size;
              const walBytes = existsSync(dbPath + "-wal") ? statSync(dbPath + "-wal").size : 0;
              const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "unknown";
              const info = { backend: "sqlite", dir, path: dbPath, bytes, walBytes, journalMode, counts };
              context.print(info, (i) => [
                `Backend: sqlite (${i.journalMode} mode)`,
                `Path:    ${i.path} (${formatBytes(i.bytes)}${i.walBytes ? `, WAL ${formatBytes(i.walBytes)}` : ""})`,
                "",
                formatCounts(i.counts),
              ].join("\n"));
              return;
            } finally {
              db.close();
            }
          }
          if (existsSync(jsonPath)) {
            const bytes = statSync(jsonPath).size;
            const info = { backend: "json", dir, path: jsonPath, bytes };
            context.print(info, (i) => `Backend: json\nPath:    ${i.path} (${formatBytes(i.bytes)})\nRun \`botkins workspace migrate --dry-run\` to check SQLite migration.`);
            return;
          }
          context.print({ backend: "none", dir }, () => `No workspace store found in ${dir}.`);
        },
      },
      export: {
        summary: "Export workspace.db back to workspace.json (backup or downgrade)",
        usage: "botkins workspace export [--out <path>]",
        options: {
          out: {
            type: "string",
            takes: "path",
            about: "Destination JSON path (defaults to <data>/workspace.json)",
          },
        },
        details:
          "Reads the full workspace state from workspace.db (including all run-step payloads) and writes it atomically as JSON (mode 0600). Stop Botkins first before downgrading to an older release that reads workspace.json.",
        async run(context) {
          if (context.args.length) throw usage("`botkins workspace export` takes no positional arguments.");
          const dir = resolveWorkspaceDir(context);
          const outArg = context.options.out;
          const outPath = typeof outArg === "string" && outArg.trim() ? resolve(outArg) : join(dir, "workspace.json");
          let result;
          try {
            result = exportWorkspaceToJson(dir, outPath);
          } catch (error) {
            throw new CliError("Workspace export failed: " + error.message);
          }
          context.print(result, (r) => [
            `Exported ${r.dbPath} -> ${r.outPath} (${formatBytes(r.bytes)}) in ${r.elapsedMs} ms.`,
            "",
            formatCounts(r.counts),
          ].join("\n"));
        },
      },
    },
  },
};
