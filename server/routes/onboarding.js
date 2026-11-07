"use strict";
const { Router } = require("express");
const { pool } = require("../db");
const { importContacts } = require("../services/contactImport");
const { getFirmPreferences } = require("../services/firmPreferences");
const router = Router();
router.use((req, res, next) =>
  ["owner", "admin"].includes(req.firm.role) && !req.firm.isApiToken
    ? next()
    : res.status(403).json({ error: "Firm administrator required" }),
);
router.get("/", async (req, res) => {
  try {
    const firmId = req.firm.id;
    const counts = (
      await pool.query(
        `SELECT
      (SELECT COUNT(*)::int FROM people WHERE firm_id=$1) AS contacts,
      (SELECT COUNT(*)::int FROM people WHERE firm_id=$1 AND portal_enabled=TRUE) AS clients,
      (SELECT COUNT(*)::int FROM firm_users WHERE firm_id=$1 AND archived_at IS NULL AND accepted_at IS NOT NULL) AS staff,
      (SELECT COUNT(*)::int FROM bookkeeping_connections WHERE firm_id=$1 AND provider='ledgerhq' AND status='connected') AS ledgerhq`,
        [firmId],
      )
    ).rows[0];
    res
      .set("Cache-Control", "no-store")
      .json({ preferences: await getFirmPreferences(firmId), counts });
  } catch (_) {
    res.status(503).json({ error: "Workspace setup unavailable" });
  }
});
router.post("/import", async (req, res) => {
  try {
    res.json(
      await importContacts({
        firmId: req.firm.id,
        csv: req.body.csv,
        key: req.body.key,
        dryRun: req.body.dryRun === true,
      }),
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.get("/import-template", (req, res) =>
  res
    .type("text/csv")
    .attachment("darklion-contacts.csv")
    .send(
      "relationship,first_name,last_name,email,phone,company_name\nExample Household,Example,Client,client@example.com,,Example Company\n",
    ),
);
router.get("/export", async (req, res) => {
  if (req.firm.role !== "owner")
    return res.status(403).json({ error: "Firm owner required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sections = {
      relationships:
        "SELECT id,name,service_tier,notes,created_at FROM relationships WHERE firm_id=$1 ORDER BY id LIMIT 50001",
      people:
        "SELECT id,relationship_id,first_name,last_name,email,phone,spouse_name,spouse_email,address_line1,address_line2,city,state,zip,created_at FROM people WHERE firm_id=$1 ORDER BY id LIMIT 50001",
      companies:
        "SELECT id,relationship_id,company_name,entity_type,notes,connected_at FROM companies WHERE firm_id=$1 ORDER BY id LIMIT 50001",
      documents:
        "SELECT id,owner_type,owner_id,year,doc_type,display_name,mime_type,size_bytes,folder_section,folder_category,created_at FROM documents WHERE firm_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 50001",
      messages:
        "SELECT m.id,m.thread_id,m.sender_type,m.sender_id,m.body,m.is_internal,m.created_at FROM messages m JOIN message_threads t ON t.id=m.thread_id WHERE t.firm_id=$1 AND m.removed_at IS NULL ORDER BY m.id LIMIT 50001",
      threads:
        "SELECT id,person_id,staff_user_id,subject,category FROM message_threads WHERE firm_id=$1 ORDER BY id LIMIT 50001",
      pipelines:
        "SELECT id,template_id,name,tax_year,status FROM pipeline_instances WHERE firm_id=$1 ORDER BY id LIMIT 50001",
      jobs: "SELECT j.id,j.instance_id,j.entity_type,j.entity_id,j.current_stage_id,j.assigned_to,j.notes,j.priority,j.due_date,j.job_status FROM pipeline_jobs j JOIN pipeline_instances i ON i.id=j.instance_id WHERE i.firm_id=$1 ORDER BY j.id LIMIT 50001",
    };
    const result = {
      version: 1,
      firmId: req.firm.id,
      exportedAt: new Date().toISOString(),
      scope:
        "Client directory, document metadata, client messages, and pipelines. Download files from client records; use Communications Archive for archived communications.",
    };
    for (const [name, query] of Object.entries(sections)) {
      result[name] = (await client.query(query, [req.firm.id])).rows;
      if (result[name].length > 50000)
        throw Error(
          "Large workspace: request an assisted export from Account security",
        );
    }
    await client.query("COMMIT");
    await pool.query(
      "INSERT INTO audit_log(firm_id,action,detail) VALUES($1,$2,$3)",
      [
        req.firm.id,
        "workspace_exported",
        JSON.stringify({ staffId: req.firm.userId }),
      ],
    );
    res
      .set("Cache-Control", "no-store")
      .attachment("darklion-workspace.json")
      .json(result);
  } catch (e) {
    await client.query("ROLLBACK");
    res
      .status(503)
      .json({
        error: e.message.startsWith("Large workspace:")
          ? e.message
          : "Workspace export unavailable",
      });
  } finally {
    client.release();
  }
});
module.exports = router;
