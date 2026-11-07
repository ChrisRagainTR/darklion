'use strict';
const crypto = require('node:crypto');
const pending = new Map();
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 2000000) throw Error('Input too large');
  }
  return JSON.parse(body);
}
async function toolResult(req, res) {
  const id = req.url.slice('/chat/tool/'.length);
  const job = pending.get(id);
  if (!job) { res.writeHead(404); return res.end(); }
  try {
    const result = await readBody(req);
    pending.delete(id); job.resolve(result);
    res.writeHead(200); res.end('{}');
  } catch { res.writeHead(400); res.end('{}'); }
}
async function chat(req, res, model, runCodex) {
  const data = await readBody(req);
  if (data.model !== model || typeof data.prompt !== 'string' || data.prompt.length > 200000 ||
      typeof data.instructions !== 'string' || data.instructions.length > 100000 ||
      !Array.isArray(data.tools) || data.tools.length > 150 ||
      data.tools.some(t => t.type !== 'function' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) || typeof t.description !== 'string' || !t.inputSchema)) {
    res.writeHead(400); return res.end('{}');
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const controller = new AbortController(), ids = new Set();
  res.on('close', () => controller.abort());
  const emit = value => { if (!res.destroyed) res.write(JSON.stringify(value) + '\n'); };
  const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15000);
  try {
    const result = await runCodex({ prompt: data.prompt, instructions: data.instructions, tools: data.tools, model, signal: controller.signal, timeoutMs: 180000,
      onTool: (name, input) => new Promise((resolve, reject) => {
        const id = crypto.randomUUID(); ids.add(id);
        pending.set(id, { resolve, reject });
        emit({ type: 'tool', id, name, input });
      }),
    });
    emit({ type: 'completed', ...result, model, provider: 'codex-app-server' });
  } catch { emit({ type: 'error', error: 'Luna app-server request failed' }); }
  finally {
    clearInterval(heartbeat);
    for (const id of ids) { pending.get(id)?.reject(Error('Chat ended')); pending.delete(id); }
    res.end();
  }
}
module.exports = { chat, toolResult };
