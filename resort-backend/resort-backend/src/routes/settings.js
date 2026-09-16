const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, requireAdminDepartment } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

router.get('/hotel', async (req, res) => {
  const r = await pool.query('SELECT * FROM hotel_settings WHERE admin_id = $1', [req.user.adminId]);
  res.json(r.rows[0] || null);
});
router.put('/hotel', requireAdmin, async (req, res) => {
  const { hotelName, address, phone, logoUrl } = req.body;
  const r = await pool.query(
    `UPDATE hotel_settings SET hotel_name=$1, address=$2, phone=$3, logo_url=$4, updated_at=now()
     WHERE admin_id=$5 RETURNING *`,
    [hotelName, address, phone, logoUrl, req.user.adminId]
  );
  res.json(r.rows[0]);
});

router.get('/restaurant', async (req, res) => {
  const r = await pool.query('SELECT * FROM restaurant_settings WHERE admin_id = $1', [req.user.adminId]);
  res.json(r.rows[0] || null);
});
router.put('/restaurant', requireAdminDepartment('restaurant'), async (req, res) => {
  const { tableCount, extra } = req.body;
  const r = await pool.query(
    `UPDATE restaurant_settings SET table_count=$1, extra=$2, updated_at=now() WHERE admin_id=$3 RETURNING *`,
    [tableCount, JSON.stringify(extra || {}), req.user.adminId]
  );
  res.json(r.rows[0]);
});

module.exports = router;