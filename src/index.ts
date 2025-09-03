#!/usr/bin/env node

// stdout is used to send messages to the client
// we redirect everything else to stderr to make sure it doesn't interfere with ACP
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

// Handle process signals gracefully
process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

import { runAcp as runAcp } from "./acp-agent.js";

try {
  console.error('Starting Claude Code ACP agent...');
  runAcp();
  console.error('ACP agent initialized successfully');
} catch (error) {
  console.error('Failed to start ACP agent:', error);
  process.exit(1);
}

// Keep process alive
process.stdin.resume();
