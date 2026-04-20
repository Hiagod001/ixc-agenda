const express = require('express');
const { db } = require('../db/connection');
const { validateInput } = require('../utils/validateInput');
const { requirePermission } = require('../middleware/requirePermission');
const { auditLog } = require('../services/audit');

const router = express.Router();

router.get('/vacancy-templates', requirePermission('vagas.manage'), (req, res) => {
  const { city, tipo_os, periodo } = req.query || {};
  const errors = validateInput({ city, tipo_os, periodo }, ['city', 'tipo_os', 'periodo']);
  if (errors.length > 0) return res.status(400).json({ error: 'Parametros invalidos', details: errors });

  const sql = `
    SELECT s.name as assunto, vt.capacity as capacity
    FROM vacancy_templates vt
    JOIN cities c ON c.id = vt.city_id
    JOIN os_types t ON t.id = vt.os_type_id
    JOIN periods p ON p.id = vt.period_id
    JOIN subjects s ON s.id = vt.subject_id
    WHERE c.name = ? AND t.code = ? AND p.code = ? AND c.is_active=1 AND t.is_active=1 AND COALESCE(s.show_in_board,0)=1
    ORDER BY s.name
  `;

  db.all(sql, [city, tipo_os, periodo], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar estrutura de vagas' });
    res.json(rows || []);
  });
});

router.put('/vacancy-templates', requirePermission('vagas.manage'), (req, res) => {
  const { city, tipo_os, periodo, capacities } = req.body || {};
  const errors = validateInput({ city, tipo_os, periodo, capacities }, ['city', 'tipo_os', 'periodo', 'capacities']);
  if (errors.length > 0) return res.status(400).json({ error: 'Dados invalidos', details: errors });

  const caps = capacities && typeof capacities === 'object' ? capacities : null;
  if (!caps) return res.status(400).json({ error: 'capacities deve ser um objeto {assunto: capacidade}' });

  db.serialize(() => {
    db.get('SELECT id FROM cities WHERE name = ? AND is_active=1', [city], (err, cRow) => {
      if (err) return res.status(500).json({ error: 'Erro ao buscar cidade' });
      if (!cRow) return res.status(404).json({ error: 'Cidade nao encontrada' });

      db.get('SELECT id FROM os_types WHERE code = ? AND is_active=1', [tipo_os], (err2, tRow) => {
        if (err2) return res.status(500).json({ error: 'Erro ao buscar tipo OS' });
        if (!tRow) return res.status(404).json({ error: 'Tipo OS nao encontrado' });

        db.get('SELECT id FROM periods WHERE code = ?', [periodo], (err3, pRow) => {
          if (err3) return res.status(500).json({ error: 'Erro ao buscar periodo' });
          if (!pRow) return res.status(404).json({ error: 'Periodo nao encontrado' });

          const cityId = cRow.id;
          const typeId = tRow.id;
          const periodId = pRow.id;

          const oldSql = `
            SELECT s.name as assunto, vt.capacity as capacity
            FROM vacancy_templates vt
            JOIN subjects s ON s.id = vt.subject_id
            WHERE vt.city_id = ? AND vt.os_type_id = ? AND vt.period_id = ? AND COALESCE(s.show_in_board,0)=1
          `;

          db.all(oldSql, [cityId, typeId, periodId], (eOld, oldRows) => {
            if (eOld) return res.status(500).json({ error: 'Erro ao buscar capacidades atuais' });

            const oldMap = {};
            (oldRows || []).forEach((r) => { oldMap[r.assunto] = Number(r.capacity || 0); });

            const entries = Object.entries(caps);
            if (entries.length === 0) return res.json({ ok: true, changes: 0 });

            let pending = entries.length;
            let changes = 0;
            let failed = false;

            entries.forEach(([assunto, cap]) => {
              const capacity = Math.max(0, parseInt(cap, 10) || 0);
              db.get('SELECT id FROM subjects WHERE name = ? AND is_active=1 AND COALESCE(show_in_board,0)=1', [assunto], (errS, sRow) => {
                if (failed) return;
                if (errS) {
                  failed = true;
                  return res.status(500).json({ error: 'Erro ao buscar assunto' });
                }

                if (!sRow) {
                  pending -= 1;
                  if (pending === 0) {
                    auditLog(req, {
                      action: 'UPDATE_VACANCY_TEMPLATES',
                      entity_type: 'vacancy_templates',
                      entity_id: `${city}|${tipo_os}|${periodo}`,
                      old_value: { city, tipo_os, periodo, capacities: oldMap },
                      new_value: { city, tipo_os, periodo, capacities: caps }
                    });
                    return res.json({ ok: true, changes });
                  }
                  return;
                }

                const subjId = sRow.id;
                const upsert = `
                  INSERT INTO vacancy_templates (city_id, os_type_id, period_id, subject_id, capacity)
                  VALUES (?,?,?,?,?)
                  ON CONFLICT(city_id, os_type_id, period_id, subject_id) DO UPDATE SET
                    capacity = excluded.capacity,
                    updated_at = CURRENT_TIMESTAMP
                `;

                db.run(upsert, [cityId, typeId, periodId, subjId, capacity], function (errU) {
                  if (failed) return;
                  if (errU) {
                    failed = true;
                    return res.status(500).json({ error: 'Erro ao salvar estrutura de vagas' });
                  }

                  changes += 1;
                  pending -= 1;
                  if (pending === 0) {
                    auditLog(req, {
                      action: 'UPDATE_VACANCY_TEMPLATES',
                      entity_type: 'vacancy_templates',
                      entity_id: `${city}|${tipo_os}|${periodo}`,
                      old_value: { city, tipo_os, periodo, capacities: oldMap },
                      new_value: { city, tipo_os, periodo, capacities: caps }
                    });
                    return res.json({ ok: true, changes });
                  }
                });
              });
            });
          });
        });
      });
    });
  });
});

router.post('/vacancy-templates/adjust', requirePermission('vagas.adjust'), (req, res) => {
  const { city, tipo_os, periodo, assunto, delta, day } = req.body || {};
  const errors = validateInput({ city, tipo_os, periodo, assunto, delta, day }, ['city', 'tipo_os', 'periodo', 'assunto', 'delta', 'day']);
  if (errors.length > 0) return res.status(400).json({ error: 'Dados invalidos', details: errors });

  const d = parseInt(delta, 10);
  if (![1, -1].includes(d)) return res.status(400).json({ error: 'delta deve ser 1 ou -1' });

  db.serialize(() => {
    db.get('SELECT id FROM cities WHERE name=?', [city], (e1, cRow) => {
      if (e1) return res.status(500).json({ error: 'Erro ao buscar cidade' });
      if (!cRow) return res.status(404).json({ error: 'Cidade nao encontrada' });

      db.get('SELECT id FROM os_types WHERE code=? AND is_active=1', [tipo_os], (e2, tRow) => {
        if (e2) return res.status(500).json({ error: 'Erro ao buscar tipo OS' });
        if (!tRow) return res.status(404).json({ error: 'Tipo OS nao encontrado' });

        db.get('SELECT id FROM periods WHERE code=?', [periodo], (e3, pRow) => {
          if (e3) return res.status(500).json({ error: 'Erro ao buscar periodo' });
          if (!pRow) return res.status(404).json({ error: 'Periodo nao encontrado' });

          db.get('SELECT id FROM subjects WHERE name=? AND COALESCE(show_in_board,0)=1', [assunto], (e4, sRow) => {
            if (e4) return res.status(500).json({ error: 'Erro ao buscar assunto' });
            if (!sRow) return res.status(404).json({ error: 'Assunto nao encontrado' });

            const cityId = cRow.id;
            const typeId = tRow.id;
            const periodId = pRow.id;
            const subjectId = sRow.id;

            db.get(
              `SELECT
                 vt.capacity as base_capacity,
                 vco.capacity as override_capacity
               FROM vacancy_templates vt
               LEFT JOIN vacancy_capacity_overrides vco
                 ON vco.city_id = vt.city_id
                AND vco.os_type_id = vt.os_type_id
                AND vco.period_id = vt.period_id
                AND vco.subject_id = vt.subject_id
                AND vco.day = ?
               WHERE vt.city_id=? AND vt.os_type_id=? AND vt.period_id=? AND vt.subject_id=?`,
              [day, cityId, typeId, periodId, subjectId],
              (eOld, oldRow) => {
                if (eOld) return res.status(500).json({ error: 'Erro ao buscar capacidade atual' });

                const baseCap = Number(oldRow?.base_capacity || 0);
                const oldCap = Number(oldRow?.override_capacity ?? oldRow?.base_capacity ?? 0);
                let newCap = oldCap + d;
                if (newCap < 0) newCap = 0;

                db.run(
                  `INSERT INTO vacancy_capacity_overrides (city_id, os_type_id, period_id, subject_id, day, capacity, updated_by_user_id, updated_at)
                   VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                   ON CONFLICT(city_id, os_type_id, period_id, subject_id, day) DO UPDATE SET
                     capacity = excluded.capacity,
                     updated_by_user_id = excluded.updated_by_user_id,
                     updated_at = CURRENT_TIMESTAMP`,
                  [cityId, typeId, periodId, subjectId, day, newCap, req.session?.user?.id || null],
                  function (eUp) {
                    if (eUp) return res.status(500).json({ error: 'Erro ao ajustar capacidade' });

                    auditLog(req, {
                      action: 'VACANCY_CAPACITY_DAY_ADJUST',
                      entity_type: 'vacancy_capacity_override',
                      entity_id: `${city}|${tipo_os}|${periodo}|${assunto}|${day}`,
                      old_value: { capacity: oldCap, base_capacity: baseCap, day },
                      new_value: { capacity: newCap, base_capacity: baseCap, day }
                    });

                    return res.json({ ok: true, capacity: newCap });
                  }
                );
              }
            );
          });
        });
      });
    });
  });
});

module.exports = router;
