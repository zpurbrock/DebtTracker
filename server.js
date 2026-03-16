const express = require('express');
const path    = require('path');
const { Pool } = require('pg');
const multer  = require('multer');

const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB init ───────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lenders (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS debtors (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS debts (
      id         SERIAL PRIMARY KEY,
      debtor_id  INT  REFERENCES debtors(id) ON DELETE CASCADE,
      lender_id  INT  REFERENCES lenders(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      total      NUMERIC(15,2) DEFAULT 0,
      categories JSONB DEFAULT '[]',
      rubros     JSONB DEFAULT '[]',
      color      TEXT DEFAULT 'yellow'
    );
    CREATE TABLE IF NOT EXISTS installments (
      id          SERIAL PRIMARY KEY,
      debt_id     INT  REFERENCES debts(id) ON DELETE CASCADE,
      description TEXT,
      due_date    DATE,
      amount      NUMERIC(15,2) DEFAULT 0,
      rubro_idx   INT,
      paid        BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS payments (
      id              SERIAL PRIMARY KEY,
      debt_id         INT  REFERENCES debts(id)        ON DELETE CASCADE,
      debtor_id       INT  REFERENCES debtors(id)      ON DELETE SET NULL,
      installment_id  INT  REFERENCES installments(id) ON DELETE SET NULL,
      amount          NUMERIC(15,2) DEFAULT 0,
      date            DATE,
      type            TEXT DEFAULT 'transfer',
      other_desc      TEXT,
      rubro_idx       INT
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id         SERIAL PRIMARY KEY,
      payment_id INT  REFERENCES payments(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,
      size       INT  NOT NULL,
      data       BYTEA NOT NULL
    );
  `);
}

// ── Row mappers ───────────────────────────────────────────
const mapLender = r => ({ id: r.id, name: r.name });
const mapDebtor = r => ({ id: r.id, name: r.name });
const mapDebt   = r => ({
  id: r.id, debtorId: r.debtor_id, lenderId: r.lender_id,
  name: r.name, total: parseFloat(r.total),
  categories: r.categories || [], rubros: r.rubros || [], color: r.color,
});
const mapInst = r => ({
  id: r.id, debtId: r.debt_id, description: r.description,
  dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
  amount: parseFloat(r.amount), rubroIdx: r.rubro_idx, paid: r.paid,
});
const mapPay = (r, evidence = []) => ({
  id: r.id, debtId: r.debt_id, debtorId: r.debtor_id,
  installmentId: r.installment_id, amount: parseFloat(r.amount),
  date: r.date ? r.date.toISOString().slice(0, 10) : null,
  type: r.type, otherDesc: r.other_desc, rubroIdx: r.rubro_idx, evidence,
});

// ── Lenders ───────────────────────────────────────────────
app.get('/api/lenders', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM lenders ORDER BY name')).rows.map(mapLender)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/lenders', async (req, res) => {
  try {
    const r = await pool.query('INSERT INTO lenders(name) VALUES($1) RETURNING *', [req.body.name]);
    res.json(mapLender(r.rows[0]));
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.message }); }
});
app.delete('/api/lenders/:id', async (req, res) => {
  try { await pool.query('DELETE FROM lenders WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Debtors ───────────────────────────────────────────────
app.get('/api/debtors', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM debtors ORDER BY name')).rows.map(mapDebtor)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/debtors', async (req, res) => {
  try {
    const r = await pool.query('INSERT INTO debtors(name) VALUES($1) RETURNING *', [req.body.name]);
    res.json(mapDebtor(r.rows[0]));
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.message }); }
});
app.delete('/api/debtors/:id', async (req, res) => {
  try { await pool.query('DELETE FROM debtors WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Debts ─────────────────────────────────────────────────
app.get('/api/debts', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM debts ORDER BY id')).rows.map(mapDebt)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/debts', async (req, res) => {
  try {
    const { debtorId, lenderId, name, total, categories, rubros, color } = req.body;
    const r = await pool.query(
      'INSERT INTO debts(debtor_id,lender_id,name,total,categories,rubros,color) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [debtorId, lenderId || null, name, total || 0,
       JSON.stringify(categories || []), JSON.stringify(rubros || []), color || 'yellow']
    );
    res.json(mapDebt(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/debts/:id/plan', async (req, res) => {
  try { await pool.query('DELETE FROM installments WHERE debt_id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/debts/:id', async (req, res) => {
  try { await pool.query('DELETE FROM debts WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Installments ──────────────────────────────────────────
app.get('/api/installments', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM installments ORDER BY id')).rows.map(mapInst)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/installments', async (req, res) => {
  try {
    const { debtId, description, dueDate, amount, rubroIdx, paid } = req.body;
    const r = await pool.query(
      'INSERT INTO installments(debt_id,description,due_date,amount,rubro_idx,paid) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [debtId, description || null, dueDate, amount || 0, rubroIdx ?? null, paid || false]
    );
    res.json(mapInst(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/installments/:id', async (req, res) => {
  try {
    const r = await pool.query('UPDATE installments SET paid=$1 WHERE id=$2 RETURNING *', [req.body.paid, req.params.id]);
    res.json(mapInst(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/installments/:id', async (req, res) => {
  try { await pool.query('DELETE FROM installments WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payments ──────────────────────────────────────────────
app.get('/api/payments', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*,
        COALESCE(
          json_agg(json_build_object('id',e.id,'name',e.name,'type',e.type,'size',e.size))
          FILTER (WHERE e.id IS NOT NULL), '[]'
        ) AS evidence
      FROM payments p
      LEFT JOIN evidence e ON e.payment_id = p.id
      GROUP BY p.id ORDER BY p.id
    `);
    res.json(r.rows.map(r => mapPay(r, r.evidence)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/payments', async (req, res) => {
  try {
    const { debtId, debtorId, installmentId, amount, date, type, otherDesc, rubroIdx } = req.body;
    if (installmentId) await pool.query('UPDATE installments SET paid=true WHERE id=$1', [installmentId]);
    const r = await pool.query(
      'INSERT INTO payments(debt_id,debtor_id,installment_id,amount,date,type,other_desc,rubro_idx) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [debtId, debtorId || null, installmentId || null, amount || 0, date,
       type || 'transfer', otherDesc || null, rubroIdx ?? null]
    );
    res.json(mapPay(r.rows[0], []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/payments/:id', async (req, res) => {
  try {
    const p = await pool.query('SELECT installment_id FROM payments WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM payments WHERE id=$1', [req.params.id]);
    if (p.rows[0]?.installment_id)
      await pool.query('UPDATE installments SET paid=false WHERE id=$1', [p.rows[0].installment_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Evidence ──────────────────────────────────────────────
app.post('/api/evidence', upload.single('file'), async (req, res) => {
  try {
    const { paymentId } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const r = await pool.query(
      'INSERT INTO evidence(payment_id,name,type,size,data) VALUES($1,$2,$3,$4,$5) RETURNING id,name,type,size',
      [paymentId, name, file.mimetype, file.size, file.buffer]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/evidence/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT name,type,data FROM evidence WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).end();
    const { name, type, data } = r.rows[0];
    res.set('Content-Type', type);
    const disp = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/evidence/:id', async (req, res) => {
  try { await pool.query('DELETE FROM evidence WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB()
  .then(() => app.listen(PORT, () => console.log(`Debt Tracker en puerto ${PORT}`)))
  .catch(err => { console.error('DB init error:', err); process.exit(1); });
