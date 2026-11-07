'use strict';

const express = require('express');
const { buildRevenueForecast } = require('../services/revenueForecast');

const router = express.Router();

// GET /api/forecast?year=2026
router.get('/', async (req, res) => {
  try {
    const forecast = await buildRevenueForecast({
      firmId: req.firm.id,
      year: req.query.year,
    });
    res.json(forecast);
  } catch (err) {
    console.error('[GET /forecast] error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
