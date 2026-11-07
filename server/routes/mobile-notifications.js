'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { getStaffBadgeCount } = require('../services/mobilePush');

const router = Router();

function requireStaffUser(req, res, next) {
  if (!req.firm?.userId || req.firm?.isApiToken) {
    return res.status(400).json({ error: 'Staff mobile notifications require staff user authentication.' });
  }
  next();
}

router.use(requireStaffUser);

router.post('/devices', async (req, res) => {
  const firmId = req.firm.id;
  const staffUserId = req.firm.userId;
  const pushToken = (req.body.pushToken || req.body.push_token || req.body.token || '').trim();
  const platform = (req.body.platform || '').trim().toLowerCase();

  if (!pushToken) return res.status(400).json({ error: 'pushToken is required' });
  if (platform && !['ios', 'android', 'web', 'unknown'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be ios, android, web, or unknown' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO staff_mobile_devices
         (firm_id, staff_user_id, push_token, platform, device_id, app_version, device_model, os_version, metadata, last_seen_at, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
       ON CONFLICT (firm_id, staff_user_id, push_token)
       DO UPDATE SET
         platform = EXCLUDED.platform,
         device_id = EXCLUDED.device_id,
         app_version = EXCLUDED.app_version,
         device_model = EXCLUDED.device_model,
         os_version = EXCLUDED.os_version,
         metadata = EXCLUDED.metadata,
         session_id = EXCLUDED.session_id,
         disabled_at = NULL,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id, firm_id, staff_user_id, platform, device_id, app_version, device_model, os_version,
                 disabled_at, last_seen_at, created_at, updated_at`,
      [
        firmId,
        staffUserId,
        pushToken,
        platform || 'unknown',
        req.body.deviceId || req.body.device_id || '',
        req.body.appVersion || req.body.app_version || '',
        req.body.deviceModel || req.body.device_model || '',
        req.body.osVersion || req.body.os_version || '',
        req.body.metadata || {},
        req.firm.sessionId || null,
      ]
    );
    res.status(201).json({ device: rows[0] });
  } catch (err) {
    console.error('[staff-mobile] POST /devices error:', err);
    res.status(500).json({ error: 'Failed to register staff device' });
  }
});

router.post('/logout', async (req, res) => {
  const pushToken = (req.body.pushToken || req.body.push_token || req.body.token || '').trim();
  const deviceId = req.body.deviceId || req.body.device_id || '';
  const id = req.body.id ? parseInt(req.body.id, 10) : null;

  try {
    let rowCount = 0;
    if (Number.isInteger(id)) {
      const result = await pool.query(
        `UPDATE staff_mobile_devices SET disabled_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND staff_user_id = $2 AND firm_id = $3`,
        [id, req.firm.userId, req.firm.id]
      );
      rowCount += result.rowCount;
    }
    if (pushToken) {
      const result = await pool.query(
        `UPDATE staff_mobile_devices SET disabled_at = NOW(), updated_at = NOW()
         WHERE push_token = $1 AND staff_user_id = $2 AND firm_id = $3`,
        [pushToken, req.firm.userId, req.firm.id]
      );
      rowCount += result.rowCount;
    } else if (deviceId) {
      const result = await pool.query(
        `UPDATE staff_mobile_devices SET disabled_at = NOW(), updated_at = NOW()
         WHERE device_id = $1 AND staff_user_id = $2 AND firm_id = $3`,
        [deviceId, req.firm.userId, req.firm.id]
      );
      rowCount += result.rowCount;
    }
    res.json({ ok: true, removed: rowCount > 0 });
  } catch (err) {
    console.error('[staff-mobile] POST /logout error:', err);
    res.status(500).json({ error: 'Failed to clean up staff device' });
  }
});

router.get('/notification-preferences', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO staff_mobile_notification_preferences (firm_id, staff_user_id)
       VALUES ($1, $2)
       ON CONFLICT (firm_id, staff_user_id) DO UPDATE SET updated_at = staff_mobile_notification_preferences.updated_at
       RETURNING client_messages_enabled, team_chat_enabled, tasks_enabled,
                 marketing_enabled, quiet_hours, timezone, updated_at`,
      [req.firm.id, req.firm.userId]
    );
    res.json({ preferences: rows[0], badge: await getStaffBadgeCount({ firmId: req.firm.id, staffUserId: req.firm.userId }) });
  } catch (err) {
    console.error('[staff-mobile] GET /notification-preferences error:', err);
    res.status(500).json({ error: 'Failed to load staff notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  const allowed = ['client_messages_enabled', 'team_chat_enabled', 'tasks_enabled', 'marketing_enabled', 'quiet_hours', 'timezone'];
  const updates = [];
  const values = [req.firm.id, req.firm.userId];

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      values.push(field === 'quiet_hours' ? JSON.stringify(req.body[field] || {}) : req.body[field]);
      updates.push(`${field} = $${values.length}`);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No notification preference fields supplied.' });

  try {
    await pool.query(
      `INSERT INTO staff_mobile_notification_preferences (firm_id, staff_user_id)
       VALUES ($1, $2)
       ON CONFLICT (firm_id, staff_user_id) DO NOTHING`,
      [req.firm.id, req.firm.userId]
    );
    const { rows } = await pool.query(
      `UPDATE staff_mobile_notification_preferences
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE firm_id = $1 AND staff_user_id = $2
       RETURNING client_messages_enabled, team_chat_enabled, tasks_enabled,
                 marketing_enabled, quiet_hours, timezone, updated_at`,
      values
    );
    res.json({ preferences: rows[0] });
  } catch (err) {
    console.error('[staff-mobile] PUT /notification-preferences error:', err);
    res.status(500).json({ error: 'Failed to save staff notification preferences' });
  }
});

router.get('/badge-count', async (req, res) => {
  try {
    const badge = await getStaffBadgeCount({ firmId: req.firm.id, staffUserId: req.firm.userId });
    res.json({ badge });
  } catch (err) {
    console.error('[staff-mobile] GET /badge-count error:', err);
    res.status(500).json({ error: 'Failed to load staff badge count' });
  }
});

module.exports = router;
