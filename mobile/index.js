import "expo-router/entry";
import { listenForShortcuts } from "./src/features/shortcuts/bridge";

// App Intents can start the JS runtime without mounting a scene.
listenForShortcuts(false);
