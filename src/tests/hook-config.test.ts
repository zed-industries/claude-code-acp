import { describe, it, expect, vi } from "vitest";
import { transformHookConfigs, HookConfig } from "../hook-config.js";
import { HookEvent, PostToolUseHookInput, PreToolUseHookInput, SessionStartHookInput } from "@anthropic-ai/claude-agent-sdk";

describe("hook-config", () => {
  describe("transformHookConfigs", () => {
    it("should transform a single PreToolUse hook config", () => {
      const configs: HookConfig[] = [
        {
          event: "PreToolUse",
          command: "echo",
          args: ["test"],
        },
      ];

      const result = transformHookConfigs(configs);

      expect(result.PreToolUse).toBeDefined();
      expect(result.PreToolUse).toHaveLength(1);
      expect(result.PreToolUse![0].hooks).toHaveLength(1);
      expect(result.PreToolUse![0].matcher).toBeUndefined();
    });

    it("should transform a hook config with a matcher", () => {
      const configs: HookConfig[] = [
        {
          event: "PreToolUse",
          matcher: "Read",
          command: "echo",
          args: ["reading"],
        },
      ];

      const result = transformHookConfigs(configs);

      expect(result.PreToolUse).toBeDefined();
      expect(result.PreToolUse![0].matcher).toBe("Read");
    });

    it("should group multiple hooks by event type", () => {
      const configs: HookConfig[] = [
        {
          event: "PreToolUse",
          command: "echo",
          args: ["pre1"],
        },
        {
          event: "PreToolUse",
          command: "echo",
          args: ["pre2"],
        },
        {
          event: "PostToolUse",
          command: "echo",
          args: ["post1"],
        },
      ];

      const result = transformHookConfigs(configs);

      expect(result.PreToolUse).toHaveLength(2);
      expect(result.PostToolUse).toHaveLength(1);
    });

    it("should support all hook event types", () => {
      const events: HookEvent[] = [
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "Notification",
        "UserPromptSubmit",
        "SessionStart",
        "SessionEnd",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "PreCompact",
        "PermissionRequest",
      ];

      const configs: HookConfig[] = events.map((event) => ({
        event,
        command: "echo",
        args: [event],
      }));

      const result = transformHookConfigs(configs);

      // Verify all events are present in the result
      events.forEach((event) => {
        expect(result[event]).toBeDefined();
        expect(result[event]).toHaveLength(1);
      });
    });

    it("should pass custom env variables to the hook", () => {
      const configs: HookConfig[] = [
        {
          event: "SessionStart",
          command: "echo",
          env: {
            CUSTOM_VAR: "custom_value",
          },
        },
      ];

      const result = transformHookConfigs(configs);

      expect(result.SessionStart).toBeDefined();
      expect(result.SessionStart![0].hooks).toHaveLength(1);
    });

    it("should handle empty configs array", () => {
      const configs: HookConfig[] = [];
      const result = transformHookConfigs(configs);

      expect(result).toEqual({});
    });

    it("should execute hook callback with correct environment variables", async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };

      const configs: HookConfig[] = [
        {
          event: "PreToolUse",
          command: "echo",
          args: ["$CLAUDE_CODE_TOOL_NAME"],
          env: {
            CUSTOM_VAR: "test",
          },
        },
      ];

      const result = transformHookConfigs(configs, mockLogger);
      const callback = result.PreToolUse![0].hooks[0];

      const mockInput: PreToolUseHookInput = {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "/path/to/transcript",
        cwd: "/test/cwd",
        permission_mode: "default",
        tool_use_id: "tool-use-123",
        tool_name: "Read",
        tool_input: {
          file_path: "/test/file.txt",
        },
      };

      const hookResult = await callback(mockInput, "tool-use-123", { signal: new AbortController().signal });

      expect(hookResult).toEqual({ continue: true });
      expect(mockLogger.log).toHaveBeenCalled();
    });

    it("should handle tool response in PostToolUse hooks", async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };

      const configs: HookConfig[] = [
        {
          event: "PostToolUse",
          command: "echo",
          args: ["done"],
        },
      ];

      const result = transformHookConfigs(configs, mockLogger);
      const callback = result.PostToolUse![0].hooks[0];

      const mockInput: PostToolUseHookInput = {
        hook_event_name: "PostToolUse",
        session_id: "test-session",
        transcript_path: "/path/to/transcript",
        cwd: "/test/cwd",
        tool_name: "Read",
        tool_use_id: "tool-use-123",
        tool_input: {
          file_path: "/test/file.txt",
        },
        tool_response: {
          content: "file contents",
        },
      };

      const hookResult = await callback(mockInput, "tool-use-123", { signal: new AbortController().signal });

      expect(hookResult).toEqual({ continue: true });
    });

    it("should handle non-tool hooks like SessionStart", async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };

      const configs: HookConfig[] = [
        {
          event: "SessionStart",
          command: "echo",
          args: ["session starting"],
        },
      ];

      const result = transformHookConfigs(configs, mockLogger);
      const callback = result.SessionStart![0].hooks[0];

      const mockInput: SessionStartHookInput = {
        hook_event_name: "SessionStart",
        session_id: "test-session",
        transcript_path: "/path/to/transcript",
        cwd: "/test/cwd",
        source: "startup",
      };

      const hookResult = await callback(mockInput, undefined, { signal: new AbortController().signal });

      expect(hookResult).toEqual({ continue: true });
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining("SessionStart")
      );
    });

    it("should parse JSON output from hook command", async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };

      const configs: HookConfig[] = [
        {
          event: "PreToolUse",
          command: "node -e 'console.log(JSON.stringify({continue: false, suppressOutput: true}))'",
          args: [],
        },
      ];

      const result = transformHookConfigs(configs, mockLogger);
      const callback = result.PreToolUse![0].hooks[0];

      const mockInput: PreToolUseHookInput = {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "/path/to/transcript",
        cwd: "/test/cwd",
        permission_mode: "default",
        tool_use_id: "tool-use-123",
        tool_name: "Read",
        tool_input: {
          file_path: "/test/file.txt",
        },
      };

      const hookResult = await callback(mockInput, "tool-use-123", { signal: new AbortController().signal });

      expect(hookResult).toEqual({ continue: false, suppressOutput: true });
    });

    it("should default to {continue: true} on invalid JSON output", async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };

      const configs: HookConfig[] = [
        {
          event: "PreToolUse",
          command: "echo",
          args: ["invalid json {"],
        },
      ];

      const result = transformHookConfigs(configs, mockLogger);
      const callback = result.PreToolUse![0].hooks[0];

      const mockInput: PreToolUseHookInput = {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "/path/to/transcript",
        cwd: "/test/cwd",
        permission_mode: "default",
        tool_use_id: "tool-use-123",
        tool_name: "Read",
        tool_input: {
          file_path: "/test/file.txt",
        },
      };

      const hookResult = await callback(mockInput, "tool-use-123", { signal: new AbortController().signal });

      expect(hookResult).toEqual({ continue: true });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse hook output as JSON")
      );
    });

    it("should default to {continue: true} on empty output", async () => {
      const mockLogger = {
        log: vi.fn(),
        error: vi.fn(),
      };

      const configs: HookConfig[] = [
        {
          event: "PreToolUse",
          command: "echo",
          args: [""],
        },
      ];

      const result = transformHookConfigs(configs, mockLogger);
      const callback = result.PreToolUse![0].hooks[0];

      const mockInput: PreToolUseHookInput = {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "/path/to/transcript",
        cwd: "/test/cwd",
        permission_mode: "default",
        tool_use_id: "tool-use-123",
        tool_name: "Read",
        tool_input: {
          file_path: "/test/file.txt",
        },
      };

      const hookResult = await callback(mockInput, "tool-use-123", { signal: new AbortController().signal });

      expect(hookResult).toEqual({ continue: true });
    });
  });
});

