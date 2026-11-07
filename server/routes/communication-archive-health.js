'use strict';

const { Router } = require('express');
const { healthStatus } = require('../services/communicationArchive');

const router = Router();

router.get('/', async (req, res) => {
  try {
    const status = await healthStatus();
    res.json(status);
  } catch (err) {
    console.error('[communication-archive-health] error:', err);
    res.status(500).json({ error: 'Failed to load archive health' });
  }
});

module.exports = router;
