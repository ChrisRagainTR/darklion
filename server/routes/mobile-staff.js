'use strict';

const { Router } = require('express');
const { listStaffClients, staffPersonRecord, staffCompanyRecord } = require('../services/staffMobile');

const router = Router();

// GET /api/mobile/staff/clients: every person and company with this season's tax status.
router.get('/clients', async (req, res) => {
  try {
    res.json(await listStaffClients({ firmId: req.firm.id }));
  } catch (err) {
    console.error('[GET /api/mobile/staff/clients] error:', err);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

// GET /api/mobile/staff/person/:id and /company/:id: one client record with its tax returns.
router.get('/:type(person|company)/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const record = req.params.type === 'person'
      ? await staffPersonRecord({ firmId: req.firm.id, personId: id })
      : await staffCompanyRecord({ firmId: req.firm.id, companyId: id });
    if (!record) return res.status(404).json({ error: 'Client not found' });
    res.json(record);
  } catch (err) {
    console.error('[GET /api/mobile/staff/record] error:', err);
    res.status(500).json({ error: 'Failed to load client' });
  }
});

module.exports = router;

