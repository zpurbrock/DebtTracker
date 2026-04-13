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
      color      TEXT DEFAULT 'yellow',
      start_date DATE,
      payment_frequency TEXT DEFAULT 'monthly',
      estimated_payments INT DEFAULT 0,
      payment_amount NUMERIC(15,2) DEFAULT 0,
      status TEXT DEFAULT 'active'
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
    CREATE TABLE IF NOT EXISTS debt_documents (
      id         SERIAL PRIMARY KEY,
      debt_id    INT REFERENCES debts(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,
      size       INT NOT NULL,
      note       TEXT,
      data       BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id         SERIAL PRIMARY KEY,
      debt_id    INT REFERENCES debts(id) ON DELETE CASCADE,
      entity     TEXT NOT NULL,
      entity_id  INT,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE debts ADD COLUMN IF NOT EXISTS start_date DATE;
    ALTER TABLE debts ADD COLUMN IF NOT EXISTS payment_frequency TEXT DEFAULT 'monthly';
    ALTER TABLE debts ADD COLUMN IF NOT EXISTS estimated_payments INT DEFAULT 0;
    ALTER TABLE debts ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE debts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
  `);
}

// ── Row mappers ───────────────────────────────────────────
const mapLender = r => ({ id: r.id, name: r.name });
const mapDebtor = r => ({ id: r.id, name: r.name });
const mapDebt   = r => ({
  id: r.id, debtorId: r.debtor_id, lenderId: r.lender_id,
  name: r.name, total: parseFloat(r.total),
  categories: r.categories || [], rubros: r.rubros || [], color: r.color,
  startDate: r.start_date ? r.start_date.toISOString().slice(0, 10) : null,
  paymentFrequency: r.payment_frequency || 'monthly',
  estimatedPayments: r.estimated_payments || 0,
  paymentAmount: parseFloat(r.payment_amount || 0),
  status: r.status || 'active',
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
const mapDebtDoc = r => ({
  id: r.id, debtId: r.debt_id, name: r.name, type: r.type, size: r.size,
  note: r.note || '', createdAt: r.created_at ? r.created_at.toISOString() : null,
});
const mapActivity = r => ({
  id: r.id, debtId: r.debt_id, entity: r.entity, entityId: r.entity_id,
  action: r.action, detail: r.detail || '', createdAt: r.created_at ? r.created_at.toISOString() : null,
});

async function logActivity(debtId, entity, entityId, action, detail) {
  if (!debtId) return;
  await pool.query(
    'INSERT INTO activity_log(debt_id,entity,entity_id,action,detail) VALUES($1,$2,$3,$4,$5)',
    [debtId, entity, entityId || null, action, detail || null]
  );
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, headers, rows) {
  const csv = [headers.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

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
app.patch('/api/lenders/:id', async (req, res) => {
  try {
    const r = await pool.query('UPDATE lenders SET name=$1 WHERE id=$2 RETURNING *', [req.body.name, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
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
app.patch('/api/debtors/:id', async (req, res) => {
  try {
    const r = await pool.query('UPDATE debtors SET name=$1 WHERE id=$2 RETURNING *', [req.body.name, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
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
    const { debtorId, lenderId, name, total, categories, rubros, color, startDate, paymentFrequency, estimatedPayments, paymentAmount, status } = req.body;
    const r = await pool.query(
      `INSERT INTO debts(debtor_id,lender_id,name,total,categories,rubros,color,start_date,payment_frequency,estimated_payments,payment_amount,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [debtorId, lenderId || null, name, total || 0,
       JSON.stringify(categories || []), JSON.stringify(rubros || []), color || 'yellow',
       startDate || null, paymentFrequency || 'monthly', estimatedPayments || 0, paymentAmount || 0, status || 'active']
    );
    await logActivity(r.rows[0].id, 'debt', r.rows[0].id, 'created', `Préstamo creado: ${name}`);
    res.json(mapDebt(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/debts/:id', async (req, res) => {
  try {
    const { debtorId, lenderId, name, total, categories, rubros, color, startDate, paymentFrequency, estimatedPayments, paymentAmount, status } = req.body;
    const r = await pool.query(
      `UPDATE debts
       SET debtor_id=$1, lender_id=$2, name=$3, total=$4, categories=$5, rubros=$6, color=$7,
           start_date=$8, payment_frequency=$9, estimated_payments=$10, payment_amount=$11, status=$12
       WHERE id=$13
       RETURNING *`,
      [debtorId, lenderId || null, name, total || 0,
       JSON.stringify(categories || []), JSON.stringify(rubros || []), color || 'yellow',
       startDate || null, paymentFrequency || 'monthly', estimatedPayments || 0, paymentAmount || 0, status || 'active',
       req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity(r.rows[0].id, 'debt', r.rows[0].id, 'updated', `Préstamo actualizado: ${name}`);
    res.json(mapDebt(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/debts/:id/plan', async (req, res) => {
  try {
    await pool.query('DELETE FROM installments WHERE debt_id=$1', [req.params.id]);
    await logActivity(req.params.id, 'installment', null, 'deleted', 'Se eliminó el plan de pagos completo');
    res.json({ ok: true });
  }
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
    await logActivity(debtId, 'installment', r.rows[0].id, 'created', `Cuota creada por ${amount || 0} con vencimiento ${dueDate}`);
    res.json(mapInst(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/installments/:id', async (req, res) => {
  try {
    const current = await pool.query('SELECT * FROM installments WHERE id=$1', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found' });
    const base = current.rows[0];
    const description = req.body.description !== undefined ? req.body.description : base.description;
    const dueDate = req.body.dueDate !== undefined ? req.body.dueDate : base.due_date;
    const amount = req.body.amount !== undefined ? req.body.amount : base.amount;
    const rubroIdx = req.body.rubroIdx !== undefined ? req.body.rubroIdx : base.rubro_idx;
    const paid = req.body.paid !== undefined ? req.body.paid : base.paid;
    const r = await pool.query(
      'UPDATE installments SET description=$1,due_date=$2,amount=$3,rubro_idx=$4,paid=$5 WHERE id=$6 RETURNING *',
      [description || null, dueDate, amount || 0, rubroIdx ?? null, paid, req.params.id]
    );
    await logActivity(base.debt_id, 'installment', r.rows[0].id, 'updated', `Cuota actualizada a ${amount || 0} con vencimiento ${dueDate}`);
    res.json(mapInst(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/installments/:id', async (req, res) => {
  try {
    const inst = await pool.query('SELECT debt_id FROM installments WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM installments WHERE id=$1', [req.params.id]);
    await logActivity(inst.rows[0]?.debt_id, 'installment', req.params.id, 'deleted', 'Cuota eliminada');
    res.json({ ok: true });
  }
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
    await logActivity(debtId, 'payment', r.rows[0].id, 'created', `Pago registrado por ${amount || 0} el ${date}`);
    res.json(mapPay(r.rows[0], []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/payments/:id', async (req, res) => {
  try {
    const current = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found' });
    const base = current.rows[0];
    const nextInstallmentId = req.body.installmentId !== undefined ? (req.body.installmentId || null) : base.installment_id;
    const prevInstallmentId = base.installment_id;

    if (prevInstallmentId && prevInstallmentId !== nextInstallmentId) {
      await pool.query('UPDATE installments SET paid=false WHERE id=$1', [prevInstallmentId]);
    }
    if (nextInstallmentId) {
      await pool.query('UPDATE installments SET paid=true WHERE id=$1', [nextInstallmentId]);
    }

    const r = await pool.query(
      `UPDATE payments
       SET debt_id=$1, debtor_id=$2, installment_id=$3, amount=$4, date=$5, type=$6, other_desc=$7, rubro_idx=$8
       WHERE id=$9
       RETURNING *`,
      [
        req.body.debtId !== undefined ? req.body.debtId : base.debt_id,
        req.body.debtorId !== undefined ? req.body.debtorId : base.debtor_id,
        nextInstallmentId,
        req.body.amount !== undefined ? req.body.amount : base.amount,
        req.body.date !== undefined ? req.body.date : base.date,
        req.body.type !== undefined ? req.body.type : base.type,
        req.body.otherDesc !== undefined ? (req.body.otherDesc || null) : base.other_desc,
        req.body.rubroIdx !== undefined ? req.body.rubroIdx : base.rubro_idx,
        req.params.id,
      ]
    );
    const ev = await pool.query(
      `SELECT id,name,type,size FROM evidence WHERE payment_id=$1 ORDER BY id`,
      [req.params.id]
    );
    await logActivity(r.rows[0].debt_id, 'payment', r.rows[0].id, 'updated', `Pago actualizado por ${r.rows[0].amount} en ${r.rows[0].date}`);
    res.json(mapPay(r.rows[0], ev.rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/payments/:id', async (req, res) => {
  try {
    const p = await pool.query('SELECT installment_id,debt_id FROM payments WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM payments WHERE id=$1', [req.params.id]);
    if (p.rows[0]?.installment_id)
      await pool.query('UPDATE installments SET paid=false WHERE id=$1', [p.rows[0].installment_id]);
    await logActivity(p.rows[0]?.debt_id, 'payment', req.params.id, 'deleted', 'Pago eliminado');
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
    const p = await pool.query('SELECT debt_id FROM payments WHERE id=$1', [paymentId]);
    await logActivity(p.rows[0]?.debt_id, 'evidence', r.rows[0].id, 'created', `Evidencia agregada: ${name}`);
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
  try {
    const e = await pool.query('SELECT payment_id,name FROM evidence WHERE id=$1', [req.params.id]);
    const p = e.rows[0] ? await pool.query('SELECT debt_id FROM payments WHERE id=$1', [e.rows[0].payment_id]) : { rows: [] };
    await pool.query('DELETE FROM evidence WHERE id=$1', [req.params.id]);
    await logActivity(p.rows[0]?.debt_id, 'evidence', req.params.id, 'deleted', `Evidencia eliminada: ${e.rows[0]?.name || ''}`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debts/:id/documents', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM debt_documents WHERE debt_id=$1 ORDER BY created_at DESC, id DESC', [req.params.id]);
    res.json(r.rows.map(mapDebtDoc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/debts/:id/documents', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const note = req.body.note || null;
    const r = await pool.query(
      'INSERT INTO debt_documents(debt_id,name,type,size,note,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, name, file.mimetype, file.size, note, file.buffer]
    );
    await logActivity(req.params.id, 'document', r.rows[0].id, 'created', `Documento agregado: ${name}`);
    res.json(mapDebtDoc(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/debt-documents/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT name,type,data FROM debt_documents WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).end();
    const { name, type, data } = r.rows[0];
    res.set('Content-Type', type);
    const disp = req.query.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/debt-documents/:id', async (req, res) => {
  try {
    const d = await pool.query('SELECT debt_id,name FROM debt_documents WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM debt_documents WHERE id=$1', [req.params.id]);
    await logActivity(d.rows[0]?.debt_id, 'document', req.params.id, 'deleted', `Documento eliminado: ${d.rows[0]?.name || ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/debts/:id/activity', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM activity_log WHERE debt_id=$1 ORDER BY created_at DESC, id DESC LIMIT 100', [req.params.id]);
    res.json(r.rows.map(mapActivity));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/summary', async (req, res) => {
  try {
    const [debtsR, installmentsR, paymentsR] = await Promise.all([
      pool.query('SELECT * FROM debts ORDER BY id'),
      pool.query('SELECT * FROM installments ORDER BY id'),
      pool.query('SELECT * FROM payments ORDER BY id'),
    ]);
    const debts = debtsR.rows.map(mapDebt);
    const installments = installmentsR.rows.map(mapInst);
    const payments = paymentsR.rows.map(r => ({ ...mapPay(r, []), evidence: [] }));
    const totalDebt = debts.reduce((s, d) => s + d.total, 0);
    const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
    const overdueInstallments = installments.filter(i => !i.paid && i.dueDate && i.dueDate < new Date().toISOString().slice(0, 10));
    const overdueAmount = overdueInstallments.reduce((s, i) => s + i.amount, 0);
    const activeLoans = debts.filter(d => d.status !== 'settled').length;
    res.json({
      totalDebt,
      totalPaid,
      balance: totalDebt - totalPaid,
      overdueInstallments: overdueInstallments.length,
      overdueAmount,
      activeLoans,
      recoveryPct: totalDebt ? Number(((totalPaid / totalDebt) * 100).toFixed(1)) : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/debts.csv', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT d.id,d.name,d.total,d.start_date,d.payment_frequency,d.estimated_payments,d.payment_amount,d.status,
             db.name AS debtor_name, l.name AS lender_name
      FROM debts d
      LEFT JOIN debtors db ON db.id = d.debtor_id
      LEFT JOIN lenders l ON l.id = d.lender_id
      ORDER BY d.id
    `);
    sendCsv(res, 'debts.csv',
      ['id','deudor','prestamista','prestamo','total','fecha_inicio','frecuencia','pagos_estimados','monto_pago','estado'],
      r.rows.map(row => [
        row.id, row.debtor_name, row.lender_name, row.name, row.total, row.start_date, row.payment_frequency,
        row.estimated_payments, row.payment_amount, row.status
      ])
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/installments.csv', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT i.id,i.description,i.due_date,i.amount,i.paid,d.name AS debt_name, db.name AS debtor_name
      FROM installments i
      JOIN debts d ON d.id = i.debt_id
      LEFT JOIN debtors db ON db.id = d.debtor_id
      ORDER BY i.id
    `);
    sendCsv(res, 'installments.csv',
      ['id','deudor','prestamo','descripcion','vencimiento','monto','pagada'],
      r.rows.map(row => [row.id, row.debtor_name, row.debt_name, row.description, row.due_date, row.amount, row.paid])
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/payments.csv', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id,p.date,p.amount,p.type,p.other_desc,d.name AS debt_name, db.name AS debtor_name
      FROM payments p
      JOIN debts d ON d.id = p.debt_id
      LEFT JOIN debtors db ON db.id = d.debtor_id
      ORDER BY p.id
    `);
    sendCsv(res, 'payments.csv',
      ['id','deudor','prestamo','fecha','monto','tipo','detalle'],
      r.rows.map(row => [row.id, row.debtor_name, row.debt_name, row.date, row.amount, row.type, row.other_desc])
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB()
  .then(() => app.listen(PORT, () => console.log(`Debt Tracker en puerto ${PORT}`)))
  .catch(err => { console.error('DB init error:', err); process.exit(1); });
