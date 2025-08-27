import { runAcp as runAcp } from "./acp-agent.js";
runAcp();

// Keep process alive
process.stdin.resume();
