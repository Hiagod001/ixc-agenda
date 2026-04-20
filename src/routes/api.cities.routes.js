const express = require('express');
const { db } = require('../db/connection');
const { validateInput } = require('../utils/validateInput');
const { requirePermission } = require('../middleware/requirePermission');
const { auditLog } = require('../services/audit');

const router = express.Router();

// Listar cidades
router.get('/cities', requirePermission('cities.manage'), (req, res) => {
  db.all('SELECT id, name, is_active, created_at FROM cities ORDER BY is_active DESC, name', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao listar cidades' });
    res.json(rows || []);
  });
});

// Criar cidade
router.post('/cities', requirePermission('cities.manage'), (req, res) => {
  const { name } = req.body || {};
  const errors = validateInput({ name }, ['name']);
  if (errors.length) return res.status(400).json({ error: 'Dados inválidos', details: errors });

  const clean = String(name).trim();
  db.get('SELECT id, name, is_active FROM cities WHERE LOWER(name)=LOWER(?)', [clean], (err, existing) => {
    if (err) return res.status(500).json({ error: 'Erro ao validar cidade' });

    if (existing) {
      if (Number(existing.is_active) === 0) {
        const old_value = existing;
        db.run('UPDATE cities SET is_active=1 WHERE id=?', [existing.id], (err) => {
          if (err) return res.status(500).json({ error: 'Erro ao reativar cidade' });
          auditLog(req, {
            action: 'CITY_REACTIVATE',
            entity_type: 'city',
            entity_id: existing.id,
            old_value,
            new_value: { ...old_value, is_active: 1 },
          });
          res.json({ message: 'Cidade reativada com sucesso', id: existing.id });
        });
      } else {
        return res.status(409).json({ error: 'Já existe uma cidade com esse nome' });
      }
      return;
    }

    db.run('INSERT INTO cities (name, is_active) VALUES (?, 1)', [clean], function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao criar cidade' });
      auditLog(req, {
        action: 'CITY_CREATE',
        entity_type: 'city',
        entity_id: this.lastID,
        old_value: null,
        new_value: { id: this.lastID, name: clean, is_active: 1 },
      });
      res.json({ message: 'Cidade criada com sucesso', id: this.lastID });
    });
  });
});

// Remover (inativar) cidade
router.delete('/cities/:id', requirePermission('cities.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  db.get('SELECT id, name, is_active FROM cities WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar cidade' });
    if (!row) return res.status(404).json({ error: 'Cidade não encontrada' });

    const old_value = row;
    db.run('UPDATE cities SET is_active=0 WHERE id=?', [id], (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao remover cidade' });
      auditLog(req, {
        action: 'CITY_DEACTIVATE',
        entity_type: 'city',
        entity_id: id,
        old_value,
        new_value: { ...old_value, is_active: 0 },
      });
      res.json({ message: 'Cidade removida com sucesso' });
    });
  });
});

// Alternar status (ativar/desativar)
router.post('/cities/:id/toggle', requirePermission('cities.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  db.get('SELECT id, name, is_active FROM cities WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar cidade' });
    if (!row) return res.status(404).json({ error: 'Cidade não encontrada' });

    const old_value = row;
    const next = Number(row.is_active) === 1 ? 0 : 1;
    db.run('UPDATE cities SET is_active=? WHERE id=?', [next, id], (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar status da cidade' });
      auditLog(req, {
        action: next === 1 ? 'CITY_REACTIVATE' : 'CITY_DEACTIVATE',
        entity_type: 'city',
        entity_id: id,
        old_value,
        new_value: { ...old_value, is_active: next },
      });
      res.json({ message: next === 1 ? 'Cidade ativada com sucesso' : 'Cidade desativada com sucesso' });
    });
  });
});

module.exports = router;
