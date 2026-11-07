"use strict";
const { pool } = require("../db");
const { getFirmPreferences } = require("./firmPreferences");
const { AI_MODEL } = require("./aiModel");
async function completeText(
  { firmId, feature, prompt, maxTokens = 4096, providerOverride, run },
  db = pool,
) {
  if (!Number.isSafeInteger(Number(firmId)) || Number(firmId) < 1)
    throw Error("An owning firm is required for inference");
  const prefs = await getFirmPreferences(firmId, db);
  if (!prefs.aiEnabled) throw Error("AI is disabled for this firm");
  if (prefs.edition === "public") {
    const subscription = (
      await db.query(
        "SELECT status FROM darklion_subscriptions WHERE firm_id=$1",
        [firmId],
      )
    ).rows[0];
    if (!["active", "trialing"].includes(subscription?.status))
      throw Error("Activate your subscription to use AI");
  }
  if (typeof prompt !== "string" || prompt.length > 200000)
    throw Error("AI input exceeds the request limit");
  const provider =
    providerOverride || (prefs.edition === "public"
      ? "codex"
      : process.env.DARKLION_AI_PROVIDER || "anthropic");
  const model =
    provider === "codex"
      ? process.env.DARKLION_CODEX_MODEL || "gpt-6-luna"
      : AI_MODEL;
  const client = await db.connect();
  let usageId;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM firms WHERE id=$1 FOR UPDATE", [firmId]);
    const used = Number(
      (
        await client.query(
          "SELECT COUNT(*)::int AS n FROM ai_usage WHERE firm_id=$1 AND created_at>=CURRENT_DATE",
          [firmId],
        )
      ).rows[0].n,
    );
    if (used >= prefs.aiDailyRequests)
      throw Error("Daily AI allowance reached; try again tomorrow");
    usageId = (
      await client.query(
        "INSERT INTO ai_usage(firm_id,feature,provider,model,status) VALUES($1,$2,$3,$4,'running') RETURNING id",
        [firmId, feature, provider, model],
      )
    ).rows[0].id;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  try {
    let result;
    if (run) {
      result = await run();
    } else if (provider === "codex") {
      const origin = new URL(
        process.env.DARKLION_INFERENCE_URL || "http://unconfigured.invalid",
      );
      if (
        origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          (origin.hostname.endsWith(".railway.internal") ||
            ["localhost", "127.0.0.1"].includes(origin.hostname))
        )
      )
        throw Error("Private inference URL required");
      if (!process.env.DARKLION_INFERENCE_TOKEN)
        throw Error("Inference service unavailable");
      const response = await fetch(new URL("/complete", origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(130000),
        headers: {
          Authorization: "Bearer " + process.env.DARKLION_INFERENCE_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, prompt }),
      });
      if (!response.ok) throw Error("Inference service unavailable");
      result = await response.json();
      if (
        result.model !== model ||
        typeof result.text !== "string" ||
        result.text.length > 100000
      )
        throw Error("Invalid inference response");
    } else if (provider === "anthropic") {
      const response =
        await new (require("@anthropic-ai/sdk"))().messages.create({
          model: AI_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        });
      result = {
        text: response.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } else throw Error("Unknown AI provider");
    const tokens = (value) =>
      Number.isSafeInteger(Number(value)) && Number(value) >= 0
        ? Number(value)
        : 0;
    await db.query(
      "UPDATE ai_usage SET input_tokens=$2,output_tokens=$3,status='completed' WHERE id=$1",
      [
        usageId,
        tokens(result.usage?.inputTokens),
        tokens(result.usage?.outputTokens),
      ],
    );
    return run ? result : result.text;
  } catch (e) {
    await db.query("UPDATE ai_usage SET status='failed' WHERE id=$1", [
      usageId,
    ]);
    throw e;
  }
}
module.exports = { completeText };
