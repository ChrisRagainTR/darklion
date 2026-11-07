# Private text inference

Build from repository root: `docker build -t darklion-inference inference/`.

On Railway use root directory `/inference`, Dockerfile path `Dockerfile`, and `RAILWAY_DOCKERFILE_PATH=Dockerfile`. Set start command `node server.cjs`, health check `/health` with a 120-second timeout, and watch path `/inference/**`. New Railway services do not accept legacy `railway.json` configuration. Do not create a public domain or TCP proxy. The application connects to the inference service's Railway private domain on port 8080.

Deploy on a private service with `CODEX_ACCESS_TOKEN`, `DARKLION_INFERENCE_TOKEN` (32+ characters), optional `DARKLION_CODEX_MODEL` (default `gpt-6-luna`), and the service port. `OPENAI_API_KEY` is supported as an alternative; a configured Codex access token takes precedence. This must be a dedicated service credential with model access. Do not mount a developer's Codex home or forward database, storage, firm integration or personal OAuth secrets.

Codex reads a workspace `CODEX_ACCESS_TOKEN` directly, without a persistent login or an API-key login call. If an OpenAI project (`sk-proj-`) or service-account (`sk-svcacct-`) API key is pasted into that setup placeholder, the runner recognizes its type and uses API-key login instead. Keep it separate from `DARKLION_INFERENCE_TOKEN`, which authenticates DarkLion's requests to this private service. The server listens on IPv6 and IPv4 for Railway private networking. See [Codex access-token authentication](https://learn.chatgpt.com/docs/enterprise/access-tokens).

The server exposes `/health` and authenticated `/complete`, with two concurrent jobs, bounded input, deadline/cleanup, separate ephemeral threads and no tool approval. The main application owns firm authorization, subscription/usage checks and persistence. This container receives only the approved prompt/model and returns text/usage. It never logs prompts or provider stderr.

CLI is pinned to 0.156.1. A real container protocol handshake and mocked completion/error/timeout/tool-denial tests pass; a successful handshake does not prove account model access or production generation. Follow the installed protocol and [official app-server documentation](https://learn.chatgpt.com/docs/app-server) when upgrading; run the transport and synthetic generation checks before changing the pin.

Staff chat uses authenticated `/chat` (NDJSON) and `/chat/tool/:id`. The app-server owns the tool loop; the application returns results for its registered tools using random per-call IDs. Firm/staff authorization and write confirmation remain in DarkLion. The inference container still receives no database or integration credentials. Calls have bounded input, concurrency, deadlines, and cleanup on disconnect. Summary `/complete` remains text-only. Chat history stays in DarkLion and is supplied to a fresh ephemeral app-server thread on each request.
