#!/usr/bin/env node

// Load managed settings and apply environment variables
import { loadManagedSettings, applyEnvironmentSettings } from "./utils.js";

const managedSettings = loadManagedSettings();
if (managedSettings) {
  applyEnvironmentSettings(managedSettings);
}

// stdout is used to send messages to the client
// we redirect everything else to stderr to make sure it doesn't interfere with ACP
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

import { runAcp } from "./acp-agent.js";
runAcp();

// Keep process alive
process.stdin.resume();
