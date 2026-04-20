const express = require('express');
const { db } = require('../db/connection');
const { validateInput } = require('../utils/validateInput');
const { requirePermission } = require('../middleware/requirePermission');
const { auditLog } = require('../services/audit');

const router = express.Router();

// Lista assuntos (ativos por padrão)
router.get('/subjects', requirePermission('config.view'), (req, res) => {
  const onlyActive = String(req.query.active ?? '1') !== '0';
  const sql = onlyActive
    ? 'SELECT id, name, is_active, COALESCE(show_in_board,0) as show_in_board FROM subjects WHERE is_active=1 ORDER BY name'
    : 'SELECT id, name, is_active, COALESCE(show_in_board,0) as show_in_board FROM subjects ORDER BY name';
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar assuntos' });
    res.json(rows || []);
  });
});

// Cria um novo assunto
router.post('/subjects', requirePermission('subjects.manage'), (req, res) => {
  const { name, show_in_board } = req.body || {};
  const errors = validateInput({ name }, ['name']);
  if (errors.length > 0) return res.status(400).json({ error: 'Dados inválidos', details: errors });

  const clean = String(name).trim();
  if (!clean) return res.status(400).json({ error: 'Nome do assunto é obrigatório' });

  db.run('INSERT OR IGNORE INTO subjects (name, is_active, show_in_board) VALUES (?, 1, ?)', [clean, Number(show_in_board) ? 1 : 0], function (err) {
    if (err) return res.status(500).json({ error: 'Erro ao criar assunto' });

    // Se já existia, reativa
    db.get('SELECT * FROM subjects WHERE name = ?', [clean], (eOld, oldRow) => {
      db.run('UPDATE subjects SET is_active=1, show_in_board = COALESCE(show_in_board, ?) WHERE name = ?', [Number(show_in_board) ? 1 : 0, clean], (err2) => {
      if (err2) return res.status(500).json({ error: 'Erro ao reativar assunto' });
      db.get('SELECT * FROM subjects WHERE name = ?', [clean], (eNew, newRow) => {
        if (!eNew) {
          auditLog(req, {
            action: 'UPSERT_SUBJECT',
            entity_type: 'subject',
            entity_id: newRow?.id || oldRow?.id || null,
            old_value: oldRow || null,
            new_value: newRow || { name: clean, is_active: 1 }
          });
        }
      });
      res.status(201).json({ ok: true, name: clean });
      });
    });
  });
});

// Renomear assunto
router.put('/subjects/:id', requirePermission('subjects.manage'), (req, res) => {
  const id = Number(req.params.id);
  const { name, show_in_board } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const clean = String(name || '').trim();
  if (!clean) return res.status(400).json({ error: 'Nome do assunto é obrigatório' });

  db.get('SELECT * FROM subjects WHERE id = ?', [id], (eOld, oldRow) => {
    if (eOld) return res.status(500).json({ error: 'Erro ao atualizar assunto' });
    if (!oldRow) return res.status(404).json({ error: 'Assunto não encontrado' });
    db.run('UPDATE subjects SET name = ?, show_in_board = CASE WHEN ? IS NULL THEN show_in_board ELSE ? END, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [(clean), (show_in_board === undefined ? null : Number(show_in_board) ? 1 : 0), (show_in_board === undefined ? null : Number(show_in_board) ? 1 : 0), id], function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar assunto' });
      if (this.changes === 0) return res.status(404).json({ error: 'Assunto não encontrado' });
      db.get('SELECT * FROM subjects WHERE id = ?', [id], (eNew, newRow) => {
        if (!eNew) {
          auditLog(req, { action: 'RENAME_SUBJECT', entity_type: 'subject', entity_id: id, old_value: oldRow, new_value: newRow || { ...oldRow, name: clean } });
        }
      });
      res.json({ ok: true });
    });
  });
});

// Exibir/ocultar assunto no quadro de vagas
router.post('/subjects/:id/board-column', requirePermission('subjects.manage'), (req, res) => {
  const id = Number(req.params.id);
  const { show_in_board } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const visible = Number(show_in_board) ? 1 : 0;

  db.get('SELECT * FROM subjects WHERE id = ?', [id], (eOld, oldRow) => {
    if (eOld) return res.status(500).json({ error: 'Erro ao atualizar visibilidade do assunto' });
    if (!oldRow) return res.status(404).json({ error: 'Assunto não encontrado' });

    db.run('UPDATE subjects SET show_in_board = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [visible, id], function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar visibilidade do assunto' });
      db.get('SELECT * FROM subjects WHERE id = ?', [id], (eNew, newRow) => {
        if (!eNew) {
          auditLog(req, {
            action: visible ? 'SHOW_SUBJECT_IN_BOARD' : 'HIDE_SUBJECT_IN_BOARD',
            entity_type: 'subject',
            entity_id: id,
            old_value: oldRow,
            new_value: newRow || { ...oldRow, show_in_board: visible }
          });
        }
      });
      res.json({ ok: true, show_in_board: visible });
    });
  });
});

// Ativar/desativar assunto
router.post('/subjects/:id/toggle', requirePermission('subjects.manage'), (req, res) => {
  const id = Number(req.params.id);
  const { is_active } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const active = Number(is_active ? 1 : 0);
  db.get('SELECT * FROM subjects WHERE id = ?', [id], (eOld, oldRow) => {
    if (eOld) return res.status(500).json({ error: 'Erro ao atualizar status do assunto' });
    if (!oldRow) return res.status(404).json({ error: 'Assunto não encontrado' });
    db.run('UPDATE subjects SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [active, id], function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar status do assunto' });
      if (this.changes === 0) return res.status(404).json({ error: 'Assunto não encontrado' });
      db.get('SELECT * FROM subjects WHERE id = ?', [id], (eNew, newRow) => {
        if (!eNew) {
          auditLog(req, { action: active ? 'ACTIVATE_SUBJECT' : 'DEACTIVATE_SUBJECT', entity_type: 'subject', entity_id: id, old_value: oldRow, new_value: newRow || { ...oldRow, is_active: active } });
        }
      });
      res.json({ ok: true });
    });
  });
});

module.exports = router;
