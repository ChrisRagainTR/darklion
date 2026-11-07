'use strict';

const { z } = require('zod');
const { registerDarkLionTools } = require('../mcp/tools');

// Use the exact same handlers and input validation as external MCP agents.
// Identity comes only from the authenticated staff session, never model input.
function createChatAgentTools(firmId, staffUserId) {
  if (!Number.isSafeInteger(Number(firmId)) || Number(firmId) <= 0 ||
      !Number.isSafeInteger(Number(staffUserId)) || Number(staffUserId) <= 0) {
    throw new Error('An authenticated staff identity is required');
  }
  const tools = new Map();
  registerDarkLionTools({
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
  }, {
    firmId: Number(firmId), staffUserId: Number(staffUserId),
    clientId: 'darklion-staff-chat',
    scopes: ['darklion:read', 'darklion:write', 'darklion:communicate'],
  });
  return {
    definitions: [...tools].map(([name, { config }]) => ({
      name, description: config.description,
      input_schema: z.toJSONSchema(config.inputSchema, { target: 'draft-7', io: 'input' }),
    })),
    isReadOnly(name) { return tools.get(name)?.config.annotations?.readOnlyHint === true; },
    async execute(name, input) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown agent tool: ${name}`);
      const result = await tool.handler(tool.config.inputSchema.parse(input));
      const payload = result.structuredContent;
      if (result.isError) throw new Error(payload?.error || 'Agent tool failed');
      if (['darklion_list_relationships', 'darklion_list_people'].includes(name) && Array.isArray(payload)) {
        return { total_count: payload.length, records: payload };
      }
      if (name === 'darklion_list_companies' && Array.isArray(payload?.companies)) {
        return { ...payload, total_count: payload.companies.length };
      }
      return payload;
    },
  };
}

module.exports = { createChatAgentTools };
