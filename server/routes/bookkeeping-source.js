'use strict';
const { Router } = require('express');
const { pool } = require('../db');
const router = Router();

router.put('/:companyId([0-9]+)/bookkeeping-source', async (req, res) => {
  const provider = req.body?.provider;
  if (!['ledgerhq', 'qbo'].includes(provider)) return res.status(400).json({ error: 'Choose LedgerHQ or QuickBooks.' });
  try {
    const { rows } = await pool.query(
      `UPDATE companies SET bookkeeping_provider = $3
       WHERE id = $1 AND firm_id = $2
       RETURNING bookkeeping_provider`, [req.params.companyId, req.firm.id, provider]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json({ provider: rows[0].bookkeeping_provider });
  } catch (error) {
    res.status(500).json({ error: 'Could not save the bookkeeping source. Please retry.' });
  }
});

module.exports = router;
