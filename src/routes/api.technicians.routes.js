const express = require('express');
const { db } = require('../db/connection');
const { validateInput } = require('../utils/validateInput');
const { requirePermission } = require('../middleware/requirePermission');
const { auditLog } = require('../services/audit');

const router = express.Router();

// Listar técnicos
router.get('/technicians', requirePermission('technicians.manage'), (req, res) => {
  db.all('SELECT id, name, is_active, created_at FROM technicians ORDER BY is_active DESC, name', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao listar técnicos' });
    res.json(rows || []);
  });
});

// Criar técnico
router.post('/technicians', requirePermission('technicians.manage'), (req, res) => {
  const { name } = req.body || {};
  const errors = validateInput({ name }, ['name']);
  if (errors.length) return res.status(400).json({ error: 'Dados inválidos', details: errors });

  const clean = String(name).trim();
  db.get('SELECT id, name, is_active FROM technicians WHERE LOWER(name)=LOWER(?)', [clean], (err, existing) => {
    if (err) return res.status(500).json({ error: 'Erro ao validar técnico' });

    if (existing) {
      // Se existe e estava inativo, reativa
      if (Number(existing.is_active) === 0) {
        const old_value = existing;
        db.run('UPDATE technicians SET is_active=1 WHERE id=?', [existing.id], (err) => {
          if (err) return res.status(500).json({ error: 'Erro ao reativar técnico' });
          auditLog(req, {
            action: 'TECHNICIAN_REACTIVATE',
            entity_type: 'technician',
            entity_id: existing.id,
            old_value,
            new_value: { ...old_value, is_active: 1 },
          });
          res.json({ message: 'Técnico reativado com sucesso', id: existing.id });
        });
      } else {
        return res.status(409).json({ error: 'Já existe um técnico com esse nome' });
      }
      return;
    }

    db.run('INSERT INTO technicians (name, is_active) VALUES (?, 1)', [clean], function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao criar técnico' });
      auditLog(req, {
        action: 'TECHNICIAN_CREATE',
        entity_type: 'technician',
        entity_id: this.lastID,
        old_value: null,
        new_value: { id: this.lastID, name: clean, is_active: 1 },
      });
      res.json({ message: 'Técnico criado com sucesso', id: this.lastID });
    });
  });
});

// Remover (inativar) técnico
router.delete('/technicians/:id', requirePermission('technicians.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  db.get('SELECT id, name, is_active FROM technicians WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar técnico' });
    if (!row) return res.status(404).json({ error: 'Técnico não encontrado' });

    const old_value = row;
    db.run('UPDATE technicians SET is_active=0 WHERE id=?', [id], (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao remover técnico' });
      auditLog(req, {
        action: 'TECHNICIAN_DEACTIVATE',
        entity_type: 'technician',
        entity_id: id,
        old_value,
        new_value: { ...old_value, is_active: 0 },
      });
      res.json({ message: 'Técnico removido com sucesso' });
    });
  });
});

// Alternar status (ativar/desativar)
router.post('/technicians/:id/toggle', requirePermission('technicians.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  db.get('SELECT id, name, is_active FROM technicians WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar técnico' });
    if (!row) return res.status(404).json({ error: 'Técnico não encontrado' });

    const old_value = row;
    const next = Number(row.is_active) === 1 ? 0 : 1;
    db.run('UPDATE technicians SET is_active=? WHERE id=?', [next, id], (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar status do técnico' });
      auditLog(req, {
        action: next === 1 ? 'TECHNICIAN_REACTIVATE' : 'TECHNICIAN_DEACTIVATE',
        entity_type: 'technician',
        entity_id: id,
        old_value,
        new_value: { ...old_value, is_active: next },
      });
      res.json({ message: next === 1 ? 'Técnico ativado com sucesso' : 'Técnico desativado com sucesso' });
    });
  });
});

module.exports = router;
