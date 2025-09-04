# ACP for Claude Code CLI

Use Claude Code directly with your Claude Pro/Max subscription from ACP-compatible clients such as Zed.

This tool implements an ACP agent that connects directly to Claude Code via the CLI, supporting:

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

## Setup

### Prerequisites

- Node.js installed on your system
- Claude Pro or Max subscription (no API key needed)
- Claude Code CLI installed and authenticated

### Installation

1. Clone this repository:
```bash
git clone https://github.com/your-username/claude-code-cli
cd claude-code-cli
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

### Usage with Zed

Add the following configuration to your Zed settings under `agent_servers`:

```json
"agent_servers": {
  "Claude Code via CLI": {
    "command": "node",
    "args": ["/path/to/claude-code-cli/dist/index.js"],
    "env": {}
  }
}
```

Replace `/path/to/claude-code-cli` with the actual path to your cloned repository.

### Other ACP-compatible clients

This adapter works with any ACP-compatible client. Configure it to run:

```bash
node /path/to/claude-code-cli/dist/index.js
```

## License

Apache-2.0
