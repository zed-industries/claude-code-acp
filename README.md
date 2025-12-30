# ACP adapter for Claude Code

[![npm](https://img.shields.io/npm/v/%40zed-industries%2Fclaude-code-acp)](https://www.npmjs.com/package/@zed-industries/claude-code-acp)

Use [Claude Code](https://www.anthropic.com/claude-code) from [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## How to use

### Zed

The latest version of Zed can already use this adapter out of the box.

To use Claude Code, open the Agent Panel and click "New Claude Code Thread" from the `+` button menu in the top-right:

https://github.com/user-attachments/assets/ddce66c7-79ac-47a3-ad59-4a6a3ca74903

Read the docs on [External Agent](https://zed.dev/docs/ai/external-agents) support.

### Other clients

Or try it with any of the other [ACP compatible clients](https://agentclientprotocol.com/overview/clients)!

#### Installation

Install the adapter from `npm`:

```bash
npm install -g @zed-industries/claude-code-acp
```

You can then use `claude-code-acp` as a regular ACP agent:

```
ANTHROPIC_API_KEY=sk-... claude-code-acp
```

## License

Apache-2.0
