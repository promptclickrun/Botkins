#!/usr/bin/env node
// The `botkins` command: installs, runs and operates Botkins on a computer from a terminal.
// `botkins help` lists what it does; desktop/docs/terminal.md is the guide.
import { main } from "./main.mjs";

// A bot's shell in the desktop app runs this as Node by that flag; a program this command starts is no Node.
delete process.env.ELECTRON_RUN_AS_NODE;
process.exitCode = await main(process.argv.slice(2));
