"use strict";
const crypto = require("node:crypto");
const { z } = require("zod");
const { pool } = require("../db");
const rowSchema = z
  .object({
    relationship: z.string().trim().min(1).max(150),
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().max(100),
    email: z.email().max(254),
    phone: z.string().max(40).optional().default(""),
    company_name: z.string().trim().max(150).optional().default(""),
  })
  .strict();
function parseCsv(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 500000)
    throw Error("Upload a CSV smaller than 500 KB");
  const table = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || cell === "") quoted = !quoted;
      else throw Error("Malformed CSV quoting");
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) table.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("Unclosed CSV quote");
  row.push(cell);
  if (row.some((v) => v.trim())) table.push(row);
  if (table.length < 2 || table.length > 501)
    throw Error("CSV must contain between 1 and 500 contacts");
  const headers = table.shift().map((h) => h.trim().replace(/^\uFEFF/, ""));
  if (
    new Set(headers).size !== headers.length ||
    headers.some((h) => !Object.hasOwn(rowSchema.shape, h))
  )
    throw Error("Use the provided CSV column names");
  const seen = new Set(),
    errors = [],
    rows = [];
  for (let i = 0; i < table.length; i++) {
    const parsed =
      table[i].length === headers.length
        ? rowSchema.safeParse(
            Object.fromEntries(headers.map((h, j) => [h, table[i][j]])),
          )
        : { success: false };
    if (!parsed.success) {
      errors.push({
        row: i + 2,
        error: "Required fields are missing or invalid",
      });
      continue;
    }
    parsed.data.email = parsed.data.email.toLowerCase();
    if (seen.has(parsed.data.email)) {
      errors.push({ row: i + 2, error: "Duplicate email in this file" });
      continue;
    }
    seen.add(parsed.data.email);
    rows.push(parsed.data);
  }
  return { rows, errors, total: table.length };
}
async function importContacts({ firmId, csv, key, dryRun = false }, db = pool) {
  const parsed = parseCsv(csv);
  if (parsed.errors.length || dryRun)
    return {
      valid: !parsed.errors.length,
      total: parsed.total,
      errors: parsed.errors,
      preview: parsed.rows.slice(0, 10),
    };
  if (!/^[a-zA-Z0-9_-]{12,100}$/.test(key || ""))
    throw Error("An import idempotency key is required");
  const digest = crypto.createHash("sha256").update(csv).digest("hex"),
    client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM firms WHERE id=$1 FOR UPDATE", [firmId]);
    const prior = (
      await client.query(
        "SELECT content_hash,result FROM firm_imports WHERE firm_id=$1 AND idempotency_key=$2",
        [firmId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.content_hash !== digest)
        throw Error("Import key was already used for different content");
      await client.query("COMMIT");
      return { ...prior.result, replayed: true };
    }
    const result = { created: 0, skipped: 0, relationships: 0, companies: 0 };
    for (const row of parsed.rows) {
      const existing = await client.query(
        "SELECT id FROM people WHERE firm_id=$1 AND (LOWER(email)=$2 OR LOWER(spouse_email)=$2)",
        [firmId, row.email],
      );
      if (existing.rowCount) {
        result.skipped++;
        continue;
      }
      const rels = await client.query(
        "SELECT id FROM relationships WHERE firm_id=$1 AND name=$2",
        [firmId, row.relationship],
      );
      if (rels.rowCount > 1)
        throw Error(
          "More than one household has the same name; resolve the duplicate before importing",
        );
      let relationship = rels.rows[0];
      if (!relationship) {
        relationship = (
          await client.query(
            "INSERT INTO relationships(firm_id,name) VALUES($1,$2) RETURNING id",
            [firmId, row.relationship],
          )
        ).rows[0];
        result.relationships++;
      }
      const person = (
        await client.query(
          "INSERT INTO people(firm_id,relationship_id,first_name,last_name,email,phone) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            firmId,
            relationship.id,
            row.first_name,
            row.last_name,
            row.email,
            row.phone,
          ],
        )
      ).rows[0];
      if (row.company_name) {
        let company = (
          await client.query(
            "SELECT id FROM companies WHERE firm_id=$1 AND relationship_id=$2 AND company_name=$3",
            [firmId, relationship.id, row.company_name],
          )
        ).rows[0];
        if (!company) {
          company = (
            await client.query(
              "INSERT INTO companies(firm_id,relationship_id,company_name,realm_id,access_token,refresh_token,token_expires_at) VALUES($1,$2,$3,$4,'','',0) RETURNING id",
              [
                firmId,
                relationship.id,
                row.company_name,
                "pending-" + crypto.randomUUID(),
              ],
            )
          ).rows[0];
          result.companies++;
        }
        await client.query(
          "INSERT INTO person_company_access(person_id,company_id,access_level) VALUES($1,$2,'full') ON CONFLICT DO NOTHING",
          [person.id, company.id],
        );
      }
      result.created++;
    }
    await client.query(
      "INSERT INTO firm_imports(firm_id,idempotency_key,content_hash,result) VALUES($1,$2,$3,$4)",
      [firmId, key, digest, JSON.stringify(result)],
    );
    await client.query(
      "INSERT INTO audit_log(firm_id,action,detail) VALUES($1,$2,$3)",
      [firmId, "contacts_imported", JSON.stringify(result)],
    );
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
module.exports = { parseCsv, importContacts };
