const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdminDepartment, requireDepartment } = require('../middleware/rbac');
const { validateMenuRow, MAX_IMPORT_ROWS } = require('../utils/importRows');

const router = express.Router();
router.use(requireAuth);

// ---------- menu ----------
router.get('/menu', requireDepartment('restaurant'), async (req, res) => {
  const r = await pool.query('SELECT * FROM menu_items WHERE admin_id = $1 AND deleted_at IS NULL ORDER BY name', [req.user.adminId]);
  res.json(r.rows);
});
router.get('/menu/deleted', requireAdminDepartment('restaurant'), async (req, res) => {
  const r = await pool.query('SELECT * FROM menu_items WHERE admin_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/menu', requireAdminDepartment('restaurant'), async (req, res) => {
  const { name, category, price, isVeg } = req.body;
  const r = await pool.query(
    'INSERT INTO menu_items (admin_id, name, category, price, is_veg) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.user.adminId, name, category, price, isVeg !== false]
  );
  res.status(201).json(r.rows[0]);
});
router.put('/menu/:id', requireAdminDepartment('restaurant'), async (req, res) => {
  const { name, category, price, isVeg } = req.body;
  const r = await pool.query(
    'UPDATE menu_items SET name=$1, category=$2, price=$3, is_veg=$4 WHERE id=$5 AND admin_id=$6 RETURNING *',
    [name, category, price, isVeg !== false, req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Menu item not found.' });
  res.json(r.rows[0]);
});
router.delete('/menu/:id', requireAdminDepartment('restaurant'), async (req, res) => {
  // soft delete, so it can be restored later, matching the original deleted-menu-items list
  await pool.query('UPDATE menu_items SET deleted_at = now() WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});
router.post('/menu/:id/restore', requireAdminDepartment('restaurant'), async (req, res) => {
  const r = await pool.query('UPDATE menu_items SET deleted_at = NULL WHERE id = $1 AND admin_id = $2 RETURNING *', [req.params.id, req.user.adminId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Menu item not found.' });
  res.json(r.rows[0]);
});
// POST /api/restaurant/menu/import — body: { items: [{ rowNumber, name, category, price, veg }] }.
// Bulk-creates menu items from a spreadsheet. Same rules as adding by hand; an item whose
// name + category already exists on the active menu is skipped, never overwritten.
router.post('/menu/import', requireAdminDepartment('restaurant'), async (req, res) => {
  const rows = req.body && req.body.items;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'There are no menu items to import.' });
  if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: 'Please import at most ' + MAX_IMPORT_ROWS + ' items at a time.' });
  const adminId = req.user.adminId;
  const dryRun = req.body.dryRun === true; // preview only: do everything, report, roll back
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['import-menu:' + adminId]);
    const existing = new Set((await client.query('SELECT name, category FROM menu_items WHERE admin_id = $1 AND deleted_at IS NULL', [adminId]))
      .rows.map((m) => (m.name || '').trim().toLowerCase() + '|' + (m.category || '').trim().toLowerCase()));
    const errors = [], skipped = [], valid = [];
    const seen = new Set();
    rows.forEach((raw, i) => {
      const rowNumber = Number(raw && raw.rowNumber) || (i + 2);
      const v = validateMenuRow(raw || {});
      if (v.errors.length) { errors.push({ row: rowNumber, message: v.errors.join(' ') }); return; }
      const key = v.value.name.toLowerCase() + '|' + v.value.category.toLowerCase();
      if (seen.has(key)) { errors.push({ row: rowNumber, message: '"' + v.value.name + '" appears more than once in your file.' }); return; }
      seen.add(key);
      if (existing.has(key)) { skipped.push({ row: rowNumber, message: '"' + v.value.name + '" is already on your menu, so it was skipped.' }); return; }
      valid.push(v.value);
    });
    for (const m of valid) {
      await client.query('INSERT INTO menu_items (admin_id, name, category, price, is_veg) VALUES ($1,$2,$3,$4,$5)',
        [adminId, m.name, m.category, m.price, m.isVeg]);
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    const preview = valid.slice(0, 8).map((m) => ({ name: m.name, category: m.category, price: m.price, isVeg: m.isVeg }));
    res.status(dryRun ? 200 : 201).json({ dryRun, imported: valid.length, skipped, errors, warnings: [], createdCategories: [], createdFloors: [], preview });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong importing the menu. Nothing was saved.' });
  } finally {
    client.release();
  }
});
// PUT /api/restaurant/menu/:id/availability — a lighter-weight toggle than
// the full edit route above, deliberately open to restaurant STAFF too (not
// admin-only): "we ran out of paneer tikka" is a routine operational thing
// that shouldn't need an admin to log in and edit the menu item.
router.put('/menu/:id/availability', requireDepartment('restaurant'), async (req, res) => {
  const { available } = req.body;
  const r = await pool.query(
    'UPDATE menu_items SET available=$1 WHERE id=$2 AND admin_id=$3 AND deleted_at IS NULL RETURNING *',
    [available !== false, req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Menu item not found.' });
  res.json(r.rows[0]);
});

// ---------- tables (live order state) ----------
router.get('/tables', requireDepartment('restaurant'), async (req, res) => {
  const r = await pool.query('SELECT * FROM restaurant_tables WHERE admin_id = $1 ORDER BY table_no', [req.user.adminId]);
  res.json(r.rows);
});
// Upsert a single table's live state (called whenever staff edits the current bill).
router.put('/tables/:tableNo', requireDepartment('restaurant'), async (req, res) => {
  const { status, customerName, customerPhone, items, appliedPromo, paymentMethod } = req.body;
  const r = await pool.query(
    `INSERT INTO restaurant_tables (admin_id, table_no, status, customer_name, customer_phone, items, applied_promo, payment_method, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (admin_id, table_no) DO UPDATE SET
       status=$3, customer_name=$4, customer_phone=$5, items=$6, applied_promo=$7, payment_method=$8, updated_at=now()
     RETURNING *`,
    [req.user.adminId, req.params.tableNo, status || 'available', customerName || '', customerPhone || '',
     JSON.stringify(items || []), appliedPromo, paymentMethod || 'Cash']
  );
  res.json(r.rows[0]);
});

// ---------- promo codes ----------
router.get('/promo-codes', requireDepartment('restaurant'), async (req, res) => {
  const r = await pool.query('SELECT * FROM promo_codes WHERE admin_id = $1 ORDER BY created_at DESC', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/promo-codes', requireAdminDepartment('restaurant'), async (req, res) => {
  const { code, discountType, discountValue, expiryDate, maxUses } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO promo_codes (admin_id, code, discount_type, discount_value, expiry_date, max_uses)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.adminId, String(code).toUpperCase(), discountType, discountValue, expiryDate || null, maxUses || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That code already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong adding the promo code.' });
  }
});
router.delete('/promo-codes/:id', requireAdminDepartment('restaurant'), async (req, res) => {
  await pool.query('DELETE FROM promo_codes WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

module.exports = router;