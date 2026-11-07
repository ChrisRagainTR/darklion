'use strict';

const { Router } = require('express');
const { buildAdvisorToday } = require('../services/advisorToday');

const router = Router();

// GET /api/today — firm-wide tax season counts and work lists for the advisor Today page.
router.get('/', async (req, res) => {
  try {
    res.json(await buildAdvisorToday({ firmId: req.firm.id }));
  } catch (err) {
    console.error('[GET /api/today] error:', err);
    res.status(500).json({ error: 'Failed to load today' });
  }
});

module.exports = router;
