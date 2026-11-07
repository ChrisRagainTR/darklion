"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const { chat, toolResult } = require("./chat-transport.cjs");
const { runCodex } = require("./codex-runner.cjs");
const secret = process.env.DARKLION_INFERENCE_TOKEN || "";
if (
  secret.length < 32 ||
  (!(process.env.CODEX_ACCESS_TOKEN || "").trim() &&
    !(process.env.OPENAI_API_KEY || "").trim())
)
  throw Error("Dedicated inference credentials are required");
const model = process.env.DARKLION_CODEX_MODEL || "gpt-6-luna";
let active = 0;
http
  .createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health" && req.method === "GET")
      return send(200, { status: "ok" });
    const supplied = String(req.headers.authorization || "").replace(
      /^Bearer /,
      "",
    );
    const suppliedBytes = Buffer.from(supplied),
      secretBytes = Buffer.from(secret);
    if (
      suppliedBytes.length !== secretBytes.length ||
      !crypto.timingSafeEqual(suppliedBytes, secretBytes)
    )
      return send(401, { error: "Unauthorized" });
    if (req.method === 'POST' && req.url.startsWith('/chat/tool/')) return toolResult(req, res);
    if (!["/complete", "/chat"].includes(req.url) || req.method !== "POST")
      return send(404, { error: "Not found" });
    if (active >= 2) return send(429, { error: "Inference busy" });
    active++;
    try {
      if (req.url === "/chat") return await chat(req, res, model, runCodex);
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 800000)
          return send(413, { error: "Input too large" });
      }
      const data = JSON.parse(body);
      if (
        typeof data.prompt !== "string" ||
        !data.prompt.trim() ||
        data.prompt.length > 200000 ||
        data.model !== model
      )
        return send(400, { error: "Invalid inference request" });
      const result = await runCodex({ prompt: data.prompt, model });
      send(200, { ...result, model });
    } catch (_) {
      send(503, { error: "Inference unavailable" });
    } finally {
      active--;
    }
  })
  .listen(Number(process.env.PORT || 8080), "::");
