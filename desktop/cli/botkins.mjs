#!/usr/bin/env node
// The `botkins` command: installs, runs and operates Botkins on a computer from a terminal.
// `botkins help` lists what it does; desktop/docs/terminal.md is the guide.
import { main } from "./main.mjs";

process.exitCode = await main(process.argv.slice(2));
