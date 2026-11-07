# AI setup

AI is optional. With no key configured, DarkLion runs normally and the AI buttons (Emma drafts, summaries, document classification, categorization) are unavailable or fall back to manual work.

## Turning it on

1. Create an API key at https://console.anthropic.com and set a monthly spend limit there.
2. Set `ANTHROPIC_API_KEY` in your host's environment and redeploy.
3. In DarkLion Settings, confirm AI features are enabled for the firm.

## Cost

You pay Anthropic directly for usage. A small firm drafting replies and summarizing documents typically spends a few dollars to a few tens of dollars a month. The spend limit in the Anthropic console is your safety net.

## Privacy

When AI is on, the text of the messages and documents being processed is sent to the AI provider. Review the provider's data-retention terms and your engagement letters, and tell clients if your obligations require it. To keep everything in house, run the service in `inference/` on your own hardware and set `DARKLION_INFERENCE_URL` and `DARKLION_INFERENCE_TOKEN`.

## Using your own AI agent with DarkLion

Settings → API Keys gives you an MCP URL (`/mcp`) that Claude, ChatGPT, or other MCP clients can connect to through OAuth, so an assistant can read and act on your firm's data with the permissions you grant. See [mcp.md](mcp.md).
