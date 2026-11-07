'use strict';
const { completeText } = require('./managedInference');
const LUNA_MODEL = process.env.DARKLION_CODEX_MODEL || 'gpt-6-luna';

async function runLunaChat({ firmId, instructions, messages, tools = [], executeTool, isReadOnly }) {
  const prompt = JSON.stringify({ conversation: messages.slice(-20) });
  return completeText({ firmId, feature: 'staff_chat', prompt, providerOverride: 'codex', run: async () => {
    const origin = new URL(process.env.DARKLION_INFERENCE_URL || 'http://unconfigured.invalid');
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' &&
        (origin.hostname.endsWith('.railway.internal') || ['localhost', '127.0.0.1'].includes(origin.hostname))))
      throw Error('Private inference URL required');
    if (!process.env.DARKLION_INFERENCE_TOKEN) throw Error('Luna app-server is not configured');
    const headers = { Authorization: 'Bearer ' + process.env.DARKLION_INFERENCE_TOKEN, 'Content-Type': 'application/json' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 190000);
    try {
      const response = await fetch(new URL('/chat', origin), {
        method: 'POST', headers, redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ model: LUNA_MODEL, prompt, instructions,
          tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.input_schema })) }),
      });
      if (!response.ok) throw Error('Luna app-server is unavailable');
      let buffer = '', completed, pendingTool, count = 0;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 2000000) throw Error('Invalid app-server response');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (event.type === 'error') throw Error(event.error);
          if (event.type === 'completed') { completed = event; continue; }
          if (event.type !== 'tool') continue;
          if (!/^[a-f0-9-]{36}$/.test(event.id) || !tools.some(t => t.name === event.name) || ++count > 40)
            throw Error('Invalid app-server tool request');
          let result;
          if (!isReadOnly(event.name)) {
            pendingTool = { name: event.name, input: event.input };
            result = { pendingTool };
          } else {
            try { result = await executeTool(event.name, event.input); }
            catch (e) { result = { error: e.message }; }
          }
          const ack = await fetch(new URL('/chat/tool/' + event.id, origin), {
            method: 'POST', headers, redirect: 'error', signal: controller.signal, body: JSON.stringify(result),
          });
          if (!ack.ok) throw Error('Luna tool response failed');
        }
      }
      if (!completed || completed.model !== LUNA_MODEL || completed.provider !== 'codex-app-server' ||
          (!pendingTool && (typeof completed.text !== 'string' || !completed.text.trim())))
        throw Error('Invalid Luna completion');
      return { text: completed.text || '', pendingTool, usage: completed.usage, model: LUNA_MODEL, provider: 'codex-app-server' };
    } finally { clearTimeout(timer); controller.abort(); }
  } });
}
module.exports = { LUNA_MODEL, runLunaChat };
