# Changelog

## 0.10.6

- Disable experimental terminal auth support for now, as it was causing issues on Windows. Will revisit with a fix later.
- Update to @anthropic-ai/claude-agent-sdk@v0.1.46

## 0.10.5

- Better error messages at end of turn if there were any
- Add experimental support for disabling built-in tools via \_meta flag
- Update to @anthropic-ai/claude-agent-sdk@v0.1.44

## 0.10.4

- Fix tool call titles not appearing during approval in some cases
- Update to @anthropic-ai/claude-agent-sdk@v0.1.42

## 0.10.3

- Fix for experimental terminal auth support

## 0.10.2

- Fix incorrect stop reason for tool call refusals

## 0.10.1

- Add additional structured metadata to tool calls
- Update to @anthropic-ai/claude-agent-sdk@v0.1.37

## 0.10.0

- Update to @anthropic-ai/claude-agent-sdk@v0.1.30
- Use `canUseTool` callback instead of launching an HTTP MCP server for permission checks.

## 0.9.0

- Support slash commands coming from MCP servers (Prompts)

## 0.8.0

- Revert changes to filename for cli entrypoint
- Provide library entrypoint via lib.ts

## 0.7.0

- Allow importing from this package as a library in addition to running it as a CLI. Allows for easier integration into existing node applications.
- Update to @anthropic-ai/claude-agent-sdk@v0.1.27

## 0.6.10

- Provide `agentInfo` on initialization response.
- Update to @agentclientprotocol/sdk@0.5.1
- Fix crash when receiving a hook_response event
- Fix for invalid locations when read call has no path

## 0.6.9

- Update to @anthropic-ai/claude-agent-sdk@v0.1.26
- Update to @agentclientprotocol/sdk@0.5.0

## 0.6.8

- Fix for duplicate tokens appearing in thread with streaming enabled
- Update to @anthropic-ai/claude-agent-sdk@v0.1.23
- Update to @agentclientprotocol/sdk@0.4.9

## 0.6.7

- Fix for invalid plan input from the model introduced in latest agent-sdk

## 0.6.6

- Do not enable bypassPermissions mode if in root/sudo mode, because Claude Code will not start

## 0.6.5

- Fix for duplicated text content after streaming

## 0.6.4

- Support streaming partial messages!
- Update to @anthropic-ai/claude-agent-sdk@v0.1.21

## 0.6.3

- Fix issue where slash commands were loaded before initialization was complete.

## 0.6.2

- Fix bug where mode selection would sometimes fire before initialization was complete.
- Update to @anthropic-ai/claude-agent-sdk@v0.1.19

## 0.6.1

- Fix to allow bypassPermissions mode to be selected (it wasn't permitted previously)

## 0.6.0

- Provide a model selector. We use the "default" model by default, and the user can change it via the client.
- Make sure writes require permissions when necessary: https://github.com/zed-industries/claude-code-acp/pull/92
- Add support for appending or overriding the system prompt: https://github.com/zed-industries/claude-code-acp/pull/91
- Update to @anthropic-ai/claude-agent-sdk@v0.1.15
- Update to @agentclientprotocol/sdk@0.4.8

## 0.5.5

- Migrate to @agentclientprotocol/sdk@0.4.5
- Update to @anthropic-ai/claude-agent-sdk@v0.1.13

## 0.5.4

- Update to @anthropic-ai/claude-agent-sdk@v0.1.11
- Enable setting CLAUDE_CODE_EXECUTABLE to override the executable used by the SDK https://github.com/zed-industries/claude-code-acp/pull/86

## 0.5.3

- Update to @anthropic-ai/claude-agent-sdk@v0.1.8
- Update to @zed-industries/agent-client-protocol@v0.4.5

## 0.5.2

- Add back @anthropic-ai/claude-code@2.0.1 as runtime dependency

## 0.5.1

- Update to @anthropic-ai/claude-agent-sdk@v0.1.1
- Make improvements to ACP tools provided to the model

## 0.5.0

- Migrate to @anthropic-ai/claude-agent-sdk@v0.1.0

## v0.4.7

- More efficient file reads from the client.

## v0.4.6

- Update to @anthropic-ai/claude-code@v1.0.128

## v0.4.5

- Update to @anthropic-ai/claude-code@v1.0.124
- Update to @zed-industries/agent-client-protocol@v0.4.3

## v0.4.4

- Update to @anthropic-ai/claude-code@v1.0.123
- Update to @zed-industries/agent-client-protocol@v0.4.2

## v0.4.3

- Move ACP tools over MCP from an "http" MCP server to an "sdk" one so more tool calls can stay in-memory.
- Update to @anthropic-ai/claude-code@v1.0.119
- Update to @zed-industries/agent-client-protocol@v0.4.0

## v0.4.2

- Fix missing package.json metadata

## v0.4.1

- Add support for /compact command [ecfd36a](https://github.com/zed-industries/claude-code-acp/commit/ecfd36afa6c4e31f12e1daf9b8a2bdc12dda1794)
- Add default limits to read tool [7bd1638](https://github.com/zed-industries/claude-code-acp/commit/7bd163818bb959b11fd2c933eff73ad83c57abb8)
- Better rendering of Tool errors [491efe3](https://github.com/zed-industries/claude-code-acp/commit/491efe32e8547075842e448d873fc01b2ffabf3a)
- Load managed-settings.json [f691024](https://github.com/zed-industries/claude-code-acp/commit/f691024350362858e00b97248ac68e356d2331c2)
- Update to @anthropic-ai/claude-code@v1.0.113
- Update to @zed-industries/agent-client-protocol@v0.3.1
