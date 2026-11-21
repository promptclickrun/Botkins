// Where the app starts. Almost always this loads the app (desktop/main.mjs). Once, after the
// rename, the app starts itself a second time as a helper that opens the keys the
// earlier keychain entry guards (desktop/keychain.mjs); that process must take the earlier name
// before Electron sets up, so it is decided here, before anything else runs.
import { app, safeStorage } from "electron";
import { isKeyHelper, runKeyHelper } from "./keychain.mjs";

if (isKeyHelper()) runKeyHelper({ app, safeStorage });
else await import("./main.mjs");
