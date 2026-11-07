'use strict';

const { Router } = require('express');
const {
  createExport,
  listExports,
  getExport,
  getExportDownload,
} = require('../services/communicationArchive');

const router = Router();

function requireStaffUser(req, res, next) {
  if (!req.firm?.userId || req.firm?.isApiToken) {
    return res.status(403).json({ error: 'Communication exports require an authenticated staff user.' });
  }
  next();
}

router.use(requireStaffUser);

router.get('/', async (req, res) => {
  try {
    const exportsList = await listExports(req.firm.id, req.query.limit);
    res.json({ exports: exportsList });
  } catch (err) {
    console.error('[communication-exports] list error:', err);
    res.status(500).json({ error: 'Failed to list exports' });
  }
});

router.post('/', async (req, res) => {
  try {
    const startDate = req.body?.startDate || req.body?.start_date;
    const endDate = req.body?.endDate || req.body?.end_date;
    const timezone = req.body?.timezone || 'UTC';
    const channels = req.body?.channels || null;
    const includeAttachments = req.body?.includeAttachments !== false && req.body?.include_attachments !== false;
    const exp = await createExport({
      firmId: req.firm.id,
      staffUserId: req.firm.userId,
      startDate,
      endDate,
      timezone,
      channels,
      includeAttachments,
    });
    res.status(201).json({ export: exp });
  } catch (err) {
    console.error('[communication-exports] create error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create export' });
  }
});

router.get('/:exportId', async (req, res) => {
  try {
    const exp = await getExport(req.firm.id, req.params.exportId);
    if (!exp) return res.status(404).json({ error: 'Export not found' });
    res.json({ export: exp });
  } catch (err) {
    console.error('[communication-exports] get error:', err);
    res.status(500).json({ error: 'Failed to load export' });
  }
});

router.get('/:exportId/download', async (req, res) => {
  try {
    const fileName = req.query.file || 'export.zip';
    const result = await getExportDownload({
      firmId: req.firm.id,
      exportId: req.params.exportId,
      staffUserId: req.firm.userId,
      fileName,
    });
    res.json(result);
  } catch (err) {
    console.error('[communication-exports] download error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to download export' });
  }
});

module.exports = router;
