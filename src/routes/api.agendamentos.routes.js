const express = require("express");
const { db } = require("../db/connection");
const { validateInput } = require("../utils/validateInput");
const { requirePermission } = require("../middleware/requirePermission");
const { auditLog } = require("../services/audit");
const { resolveCityName } = require("../services/ixcSync");

const router = express.Router();

// Helpers
function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function detectPredialByAssunto(assunto) {
  const normalized = normalizeText(assunto);
  if (!normalized) return false;
  const hasPredial = normalized.includes('PREDIAL');
  const hasInstallation = normalized.includes('INSTALACAO');
  const hasMudanca = normalized.includes('MUDANCA');
  return hasPredial && (hasInstallation || hasMudanca);
}

function deriveTipoInstalacao({ assunto, tipo_instalacao, vagas_ocupadas }) {
  const explicitPredial = normalizeText(tipo_instalacao) === 'PREDIAL';
  const bySlots = Number(vagas_ocupadas || 0) > 1;
  const byAssunto = detectPredialByAssunto(assunto);
  return explicitPredial || bySlots || byAssunto ? 'PREDIAL' : 'RESIDENCIAL';
}

function deriveVagasOcupadas({ assunto, tipo_instalacao, vagas_ocupadas }) {
  if (normalizeText(tipo_instalacao) === 'PREDIAL') return 2;
  if (Number(vagas_ocupadas || 0) > 1) return 2;
  if (detectPredialByAssunto(assunto)) return 2;
  return 1;
}

function periodFromDateTime(dt) {
  const h = new Date(dt).getHours();
  return h < 12 ? 'MANHÃ' : 'TARDE';
}

function getCapacityByNames({ cidade, tipo_os, periodo, assunto, day = null }) {
  const sql = `
    SELECT COALESCE(vco.capacity, vt.capacity, 0) as capacity
    FROM vacancy_templates vt
    JOIN cities c ON c.id = vt.city_id
    JOIN os_types t ON t.id = vt.os_type_id
    JOIN periods p ON p.id = vt.period_id
    JOIN subjects s ON s.id = vt.subject_id
    LEFT JOIN vacancy_capacity_overrides vco
      ON vco.city_id = vt.city_id
     AND vco.os_type_id = vt.os_type_id
     AND vco.period_id = vt.period_id
     AND vco.subject_id = vt.subject_id
     AND vco.day = ?
    WHERE c.name = ? AND t.code = ? AND p.code = ? AND s.name = ?
    LIMIT 1
  `;
  return new Promise((resolve, reject) => {
    db.get(sql, [day, cidade, tipo_os, periodo, assunto], (err, row) => {
      if (err) return reject(err);
      resolve(Number(row?.capacity || 0));
    });
  });
}

function getClosedSlotIndexesByNames({ cidade, tipo_os, periodo, assunto, day }) {
  const sql = `
    SELECT vcs.slot_index as slot_index
    FROM vacancy_closed_slots vcs
    JOIN cities c ON c.id = vcs.city_id
    JOIN os_types t ON t.id = vcs.os_type_id
    JOIN periods p ON p.id = vcs.period_id
    JOIN subjects s ON s.id = vcs.subject_id
    WHERE c.name = ? AND t.code = ? AND p.code = ? AND s.name = ? AND vcs.day = ?
    ORDER BY vcs.slot_index ASC
  `;
  return new Promise((resolve, reject) => {
    db.all(sql, [cidade, tipo_os, periodo, assunto, day], (err, rows) => {
      if (err) return reject(err);
      resolve((rows || []).map(r => Number(r.slot_index)));
    });
  });
}

function getOccupiedSlotsExcludingAgendamento({ cidade, tipo_os, periodo, assunto, data_hora, excludeId }) {
  const sql = `
    SELECT COALESCE(SUM(CASE WHEN vagas_ocupadas IS NULL OR vagas_ocupadas < 1 THEN 1 ELSE vagas_ocupadas END), 0) as count
    FROM agendamentos
    WHERE cidade = ?
      AND tipo_os = ?
      AND DATE(data_hora) = DATE(?)
      AND assunto = ?
      AND status != 'Cancelada'
      AND status != 'Aberta'
      AND data_hora IS NOT NULL
      AND periodo = ?
      AND id != ?
  `;
  return new Promise((resolve, reject) => {
    db.get(sql, [cidade, tipo_os, data_hora, assunto, periodo, excludeId], (err, row) => {
      if (err) return reject(err);
      resolve(Number(row?.count || 0));
    });
  });
}

// =======================
// BUSCA AVANÇADA (PAGINAÇÃO)
// =======================
router.get('/agendamentos/search', requirePermission('agenda.view'), (req, res) => {
  try {
    const {
      cidade, tecnico, status, cliente, assunto, tipo_os,
      data, data_inicio, data_fim, periodo,
      sort_by, sort_dir, page, page_size
    } = req.query;

    const pageNum = Math.max(parseInt(page || '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(page_size || '20', 10) || 20, 1), 200);
    const offset = (pageNum - 1) * pageSize;

    const allowedSort = new Set(['id','data_hora','created_at','updated_at','cliente','cidade','status','tecnico','assunto','tipo_os']);
    const sortBy = allowedSort.has(String(sort_by || 'data_hora')) ? String(sort_by || 'data_hora') : 'data_hora';
    const sortDir = String(sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let where = "WHERE 1=1";
    const params = [];

    if (cidade) { where += " AND cidade = ?"; params.push(cidade); }
    if (tecnico) { where += " AND tecnico = ?"; params.push(tecnico); }
    if (assunto) { where += " AND assunto = ?"; params.push(assunto); }
    if (tipo_os) { where += " AND tipo_os = ?"; params.push(tipo_os); }

    if (status) {
      const list = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (list.length === 1) { where += " AND status = ?"; params.push(list[0]); }
      else if (list.length > 1) { where += ` AND status IN (${list.map(() => '?').join(',')})`; params.push(...list); }
    }

    if (cliente) { where += " AND cliente LIKE ?"; params.push(`%${cliente}%`); }

    if (data) { where += " AND DATE(data_hora) = ?"; params.push(data); }
    else {
      if (data_inicio) { where += " AND DATE(data_hora) >= ?"; params.push(data_inicio); }
      if (data_fim) { where += " AND DATE(data_hora) <= ?"; params.push(data_fim); }
    }

    if (periodo) {
      const p = String(periodo).toUpperCase();
      if (p === 'MANHÃ' || p === 'MANHA') where += " AND data_hora IS NOT NULL AND strftime('%H', data_hora) < '12'";
      else if (p === 'TARDE') where += " AND data_hora IS NOT NULL AND strftime('%H', data_hora) >= '12'";
    }

    const countSql = `SELECT COUNT(*) as total FROM agendamentos ${where}`;
    const dataSql = `SELECT * FROM agendamentos ${where} ORDER BY ${sortBy} ${sortDir}, id ${sortDir} LIMIT ? OFFSET ?`;

    db.get(countSql, params, (err, countRow) => {
      if (err) return res.status(500).json({ error: 'Erro interno do servidor ao contar no DB' });

      const total = countRow?.total || 0;
      const totalPages = Math.max(Math.ceil(total / pageSize), 1);

      db.all(dataSql, [...params, pageSize, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Erro interno do servidor ao buscar no DB' });
        res.json({ rows, meta: { page: pageNum, page_size: pageSize, total, total_pages: totalPages, sort_by: sortBy, sort_dir: sortDir.toLowerCase() } });
      });
    });
  } catch (error) {
    console.error('Erro inesperado na rota /api/agendamentos/search:', error);
    res.status(500).json({ error: 'Erro interno inesperado no servidor.' });
  }
});

// =======================
// CRUD AGENDAMENTOS (LEGACY)
// =======================
router.get('/agendamentos', requirePermission('agenda.view'), (req, res) => {
  try {
    const { cidade, data, status, cliente } = req.query;
    let sql = "SELECT * FROM agendamentos WHERE 1=1";
    const params = [];

    if (cidade) { sql += " AND cidade = ?"; params.push(cidade); }
    if (data) { sql += " AND DATE(data_hora) = ?"; params.push(data); }
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (cliente) { sql += " AND cliente LIKE ?"; params.push(`%${cliente}%`); }

    sql += " ORDER BY data_hora DESC";

    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ error: "Erro interno do servidor ao buscar no DB" });
      res.json(rows);
    });
  } catch (error) {
    console.error('Erro inesperado na rota /api/agendamentos:', error);
    res.status(500).json({ error: "Erro interno inesperado no servidor." });
  }
});

router.get('/agendamentos/:id', requirePermission('agenda.view'), (req, res) => {
  db.get("SELECT * FROM agendamentos WHERE id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    if (!row) return res.status(404).json({ error: "Agendamento não encontrado" });
    res.json(row);
  });
});

router.post('/agendamentos', requirePermission('agenda.create'), (req, res) => {
  try {
    const { cliente, cidade, assunto, observacao, tipo_os, tipo_instalacao } = req.body || {};
    const errors = validateInput({ cliente, cidade, assunto, tipo_os }, ['cliente', 'cidade', 'assunto', 'tipo_os']);
    if (errors.length > 0) return res.status(400).json({ error: 'Dados inválidos', details: errors });

    const tipoInstalacao = deriveTipoInstalacao({ assunto, tipo_instalacao });
    const vagasOcupadas = deriveVagasOcupadas({ assunto, tipo_instalacao: tipoInstalacao });

    const sql = `INSERT INTO agendamentos (cliente, cidade, assunto, observacoes, status, tipo_os, tipo_instalacao, vagas_ocupadas)
                 VALUES (?, ?, ?, ?, 'Aberta', ?, ?, ?)`;

    db.run(sql, [cliente, cidade, assunto, observacao, tipo_os, tipoInstalacao, vagasOcupadas], function (err) {
      if (err) return res.status(500).json({ error: "Erro ao criar agendamento" });

      // Auditoria
      auditLog(req, {
        action: 'CREATE_AGENDAMENTO',
        entity_type: 'agendamento',
        entity_id: this.lastID,
        old_value: null,
        new_value: { id: this.lastID, cliente, cidade, assunto, observacoes: observacao || null, status: 'Aberta', tipo_os, tipo_instalacao: tipoInstalacao, vagas_ocupadas: vagasOcupadas }
      });

      const details = `Agendamento criado para ${cliente} (${cidade})`;
      const ip = req.ip || req.connection.remoteAddress;
      db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
        [req.session.user.username, 'CREATE', details, ip]);

      res.status(201).json({ id: this.lastID, message: "Agendamento criado com sucesso" });
    });
  } catch (error) {
    console.error('Erro ao criar agendamento:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.put('/agendamentos/:id', requirePermission('agenda.edit'), (req, res) => {
  try {
    const id = req.params.id;
    const fieldsToUpdate = req.body || {};
    if (!id || id === 'undefined' || isNaN(parseInt(id))) return res.status(400).json({ error: "ID do agendamento é inválido." });
    if (Object.keys(fieldsToUpdate).length === 0) return res.status(400).json({ error: "Nenhum campo para atualizar foi fornecido." });

    const fieldEntries = Object.entries(fieldsToUpdate);
    const setClause = fieldEntries.map(([key]) => `${key} = ?`).join(', ');
    const values = fieldEntries.map(([, value]) => value);
    values.push(id);

    const sql = `UPDATE agendamentos SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

    db.get('SELECT * FROM agendamentos WHERE id = ?', [id], (e1, oldRow) => {
      if (e1) return res.status(500).json({ error: "Erro interno do servidor" });
      if (!oldRow) return res.status(404).json({ error: "Nenhum agendamento encontrado com este ID para atualizar." });

      const assuntoAtualizado = fieldsToUpdate.assunto ?? oldRow.assunto;
      const tipoInstalacaoDerivado = deriveTipoInstalacao({
        assunto: assuntoAtualizado,
        tipo_instalacao: fieldsToUpdate.tipo_instalacao ?? oldRow.tipo_instalacao,
        vagas_ocupadas: fieldsToUpdate.vagas_ocupadas ?? oldRow.vagas_ocupadas,
      });
      const vagasDerivadas = deriveVagasOcupadas({
        assunto: assuntoAtualizado,
        tipo_instalacao: tipoInstalacaoDerivado,
        vagas_ocupadas: fieldsToUpdate.vagas_ocupadas ?? oldRow.vagas_ocupadas,
      });
      fieldsToUpdate.tipo_instalacao = tipoInstalacaoDerivado;
      fieldsToUpdate.vagas_ocupadas = vagasDerivadas;

      (async () => {
        if (oldRow.data_hora && oldRow.periodo && oldRow.assunto && oldRow.tipo_os) {
          const cidadeInfo = await resolveCityName(fieldsToUpdate.cidade || oldRow.cidade);
          const cidade = String(cidadeInfo?.name || fieldsToUpdate.cidade || oldRow.cidade || '').trim();
          const tipo_os = fieldsToUpdate.tipo_os || oldRow.tipo_os;
          const periodo = fieldsToUpdate.periodo || oldRow.periodo;
          const assunto = fieldsToUpdate.assunto || oldRow.assunto;
          const data_hora = fieldsToUpdate.data_hora || oldRow.data_hora;
          const vagasNecessarias = Math.max(Number(fieldsToUpdate.vagas_ocupadas || oldRow.vagas_ocupadas || 1), 1);

          const capacidade = await getCapacityByNames({
            cidade,
            tipo_os,
            periodo,
            assunto,
            day: String(oldRow.data_hora || '').slice(0, 10)
          });
          const vagasJaOcupadas = await getOccupiedSlotsExcludingAgendamento({
            cidade,
            tipo_os,
            periodo,
            assunto,
            data_hora,
            excludeId: id
          });

          if ((vagasJaOcupadas + vagasNecessarias) > capacidade) {
            return res.status(400).json({
              error: `Nao ha vagas suficientes para salvar como ${vagasNecessarias} vaga(s) em ${assunto} (${periodo}).`
            });
          }

          if (cidade && cidade !== oldRow.cidade) {
            const cityIndex = fieldEntries.findIndex(([key]) => key === 'cidade');
            if (cityIndex >= 0) values[cityIndex] = cidade;
          }
        }

        db.run(sql, values, function (err) {
          if (err) return res.status(500).json({ error: "Erro ao atualizar agendamento no DB" });
          if (this.changes === 0) return res.status(404).json({ error: "Nenhum agendamento encontrado com este ID para atualizar." });

          db.get('SELECT * FROM agendamentos WHERE id = ?', [id], (e2, newRow) => {
            if (!e2) {
              auditLog(req, {
                action: 'UPDATE_AGENDAMENTO',
                entity_type: 'agendamento',
                entity_id: id,
                old_value: oldRow,
                new_value: newRow || fieldsToUpdate
              });
            }
            res.json({ message: "Agendamento atualizado com sucesso", changes: this.changes });
          });
        });
      })().catch((err) => {
        console.error('Erro ao validar atualização de vagas:', err);
        res.status(500).json({ error: "Erro interno do servidor" });
      });
    });
  } catch (error) {
    console.error('Erro na rota PUT:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.delete('/agendamentos/:id', requirePermission('agenda.delete'), (req, res) => {
  try {
    const id = req.params.id;
    db.get('SELECT * FROM agendamentos WHERE id = ?', [id], (e1, oldRow) => {
      if (e1) return res.status(500).json({ error: "Erro interno do servidor" });
      if (!oldRow) return res.status(404).json({ error: "Agendamento não encontrado" });

      db.run("DELETE FROM agendamentos WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: "Erro ao excluir agendamento" });
        if (this.changes === 0) return res.status(404).json({ error: "Agendamento não encontrado" });

      const details = `Agendamento ID ${id} excluído`;
      const ip = req.ip || req.connection.remoteAddress;
      db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
        [req.session.user.username, 'DELETE', details, ip]);

        // Auditoria
        auditLog(req, {
          action: 'DELETE_AGENDAMENTO',
          entity_type: 'agendamento',
          entity_id: id,
          old_value: oldRow,
          new_value: null
        });

        res.json({ message: "Agendamento excluído com sucesso", changes: this.changes });
      });
    });
  } catch (error) {
    console.error('Erro ao excluir agendamento:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.get('/agendamentos/nao-alocados', requirePermission('agenda.view'), (req, res) => {
  const sql = `SELECT * FROM agendamentos WHERE status = 'Aberta' ORDER BY created_at DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    res.json(rows);
  });
});

// =======================
// ALOCAR (drag and drop)
// =======================
router.put('/agendamentos/:id/alocar', requirePermission('agenda.allocate'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data_hora, periodo, vaga_assunto } = req.body || {};

    const errors = validateInput({ data_hora, periodo, vaga_assunto }, ['data_hora', 'periodo', 'vaga_assunto']);
    if (errors.length > 0) return res.status(400).json({ error: 'Dados inválidos', details: errors });

    // pega agendamento (old)
    db.get('SELECT * FROM agendamentos WHERE id = ?', [id], async (err, ag) => {
      if (err) return res.status(500).json({ error: "Erro interno do servidor" });
      if (!ag) return res.status(404).json({ error: "Agendamento não encontrado" });

      const cidadeInfo = await resolveCityName(ag.cidade);
      const cidade = String(cidadeInfo?.name || ag.cidade || '').trim();
      const tipo_os = ag.tipo_os;
      const tipoInstalacaoDestino = deriveTipoInstalacao({
        assunto: vaga_assunto,
        tipo_instalacao: ag.tipo_instalacao,
        vagas_ocupadas: ag.vagas_ocupadas,
      });
      const vagasNecessarias = deriveVagasOcupadas({
        assunto: vaga_assunto,
        tipo_instalacao: tipoInstalacaoDestino,
        vagas_ocupadas: ag.vagas_ocupadas,
      });

      const capacidade = await getCapacityByNames({ cidade, tipo_os, periodo, assunto: vaga_assunto, day: String(data_hora || '').slice(0, 10) });

      // Ocupadas (mesmo dia/cidade/tipo/assunto/periodo) - ignora cancelada
      const checkSql = `
        SELECT COALESCE(SUM(CASE WHEN vagas_ocupadas IS NULL OR vagas_ocupadas < 1 THEN 1 ELSE vagas_ocupadas END), 0) as count FROM agendamentos
        WHERE cidade = ?
          AND tipo_os = ?
          AND data_hora IS NOT NULL
          AND periodo IS NOT NULL
          AND DATE(data_hora) = DATE(?)
          AND assunto = ?
          AND status != 'Cancelada'
          AND status != 'Aberta'
          AND data_hora IS NOT NULL
          AND periodo = ?
      `;

      db.get(checkSql, [cidade, tipo_os, data_hora, vaga_assunto, periodo], async (err, result) => {
        if (err) return res.status(500).json({ error: "Erro interno do servidor" });

        const vagasJaOcupadas = Number(result?.count || 0);

        if ((vagasJaOcupadas + vagasNecessarias) > capacidade) {
          return res.status(400).json({ error: `Vaga indisponível. Limite de ${capacidade} para ${vaga_assunto} (${periodo}).` });
        }

        // Ao alocar via drag-and-drop, o agendamento passa a ocupar uma vaga de um ASSUNTO específico.
        // Então precisamos gravar também o assunto selecionado na vaga.
        db.get('SELECT * FROM agendamentos WHERE id = ?', [id], (eOld, oldRow) => {
          const updateSql = `UPDATE agendamentos
            SET data_hora = ?,
                cidade = ?,
                periodo = ?,
                assunto = ?,
                tipo_instalacao = ?,
                vagas_ocupadas = ?,
                status = 'Agendada',
                alocado_por = ?,
                alocado_em = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`;
          const alocadoPor = (req.session?.user?.username) || (req.session?.user?.name) || 'sistema';
          db.run(updateSql, [data_hora, cidade, periodo, vaga_assunto, tipoInstalacaoDestino, vagasNecessarias, alocadoPor, id], function (err) {
          if (err) return res.status(500).json({ error: "Erro ao alocar agendamento" });
          if (this.changes === 0) return res.status(404).json({ error: "Agendamento não encontrado" });

          db.get('SELECT * FROM agendamentos WHERE id = ?', [id], (eNew, newRow) => {
            if (!eOld && !eNew) {
              auditLog(req, {
                action: 'ALLOCATE_AGENDAMENTO',
                entity_type: 'agendamento',
                entity_id: id,
                old_value: oldRow,
                new_value: newRow
              });
            }
          });

          const details = `OS ID ${id} alocada para ${data_hora} (${periodo}) ocupando ${vagasNecessarias} vaga(s)`;
          const ip = req.ip || req.connection.remoteAddress;
          db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
            [req.session.user.username, 'ALLOCATE', details, ip]);

          res.json({ message: "Agendamento alocado com sucesso", changes: this.changes });
        });
        });
      });
    });

  } catch (error) {
    console.error('Erro ao alocar agendamento:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.put('/agendamentos/:id/desalocar', requirePermission('agenda.allocate'), (req, res) => {
  try {
    const { id } = req.params;
    db.get('SELECT * FROM agendamentos WHERE id = ?', [id], (e1, oldRow) => {
      if (e1) return res.status(500).json({ error: "Erro interno do servidor" });
      if (!oldRow) return res.status(404).json({ error: "Agendamento não encontrado" });

      const nextStatus = String(oldRow.origem || '').toLowerCase() === 'ixc'
        ? (oldRow.ixc_status || oldRow.status || 'A')
        : 'Aberta';

      db.run(
        `UPDATE agendamentos
           SET data_hora = NULL,
               periodo = NULL,
               status = ?,
               alocado_por = NULL,
               alocado_em = NULL,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [nextStatus, id],
        function (err) {
          if (err) return res.status(500).json({ error: "Erro ao retirar agendamento da vaga" });
          if (this.changes === 0) return res.status(404).json({ error: "Agendamento não encontrado" });

          db.get('SELECT * FROM agendamentos WHERE id = ?', [id], (e2, newRow) => {
            if (!e2) {
              auditLog(req, {
                action: 'UNALLOCATE_AGENDAMENTO',
                entity_type: 'agendamento',
                entity_id: id,
                old_value: oldRow,
                new_value: newRow
              });
            }
            res.json({ message: "Agendamento retirado da vaga com sucesso", changes: this.changes });
          });
        }
      );
    });
  } catch (error) {
    console.error('Erro ao desalocar agendamento:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// =======================
// CONSULTA DE VAGAS (LEGADO - usado pelo dashboard principal)
// =======================
// GET /api/vagas/:cidade/:data -> { template, ocupadas }
router.get('/vagas/:cidade/:data', requirePermission('vagas.view'), (req, res) => {
  const { cidade, data } = req.params;

  const sql = `
    SELECT id, cliente, assunto, data_hora, tecnico, observacoes, status, tipo_os, tipo_instalacao, vagas_ocupadas
    FROM agendamentos
    WHERE cidade = ? AND DATE(data_hora) = ? AND status = 'Agendada'
    ORDER BY data_hora ASC
  `;

  db.all(sql, [cidade, data], async (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });

    // template completo do dia vem do DB (mesmo formato antigo)
    const tplSql = `
      SELECT t.code as tipo, p.code as periodo, s.name as assunto, vt.capacity as capacidade
      FROM vacancy_templates vt
      JOIN cities c ON c.id = vt.city_id
      JOIN os_types t ON t.id = vt.os_type_id
      JOIN periods p ON p.id = vt.period_id
      JOIN subjects s ON s.id = vt.subject_id
      WHERE c.name = ?
        AND COALESCE(s.is_active, 1) = 1
    `;
    db.all(tplSql, [cidade], (err, trows) => {
      if (err) return res.status(500).json({ error: "Erro ao montar template" });

      const template = {};
      (trows || []).forEach(r => {
        template[r.tipo] = template[r.tipo] || {};
        template[r.tipo][r.periodo] = template[r.tipo][r.periodo] || {};
        template[r.tipo][r.periodo][r.assunto] = Number(r.capacidade || 0);
      });

      const ocupadas = (rows || []).map(a => ({
        id: a.id,
        cliente: a.cliente,
        assunto: a.assunto,
        data_hora: a.data_hora,
        tecnico: a.tecnico,
        observacoes: a.observacoes,
        status: a.status,
        tipo_os: a.tipo_os,
        tipo_instalacao: a.tipo_instalacao || 'RESIDENCIAL',
        vagas_ocupadas: Math.max(Number(a.vagas_ocupadas || 1), 1)
      }));

      res.json({ template, ocupadas });
    });
  });
});

// =======================
// VAGAS DETALHADAS (agenda-dashboard)
// =======================
router.get('/vagas-detalhadas/:cidade/:tipo/:data', requirePermission('vagas.view'), async (req, res) => {
  try {
    const { cidade: cidadeParam, tipo, data } = req.params;
    const cidadeInfo = await resolveCityName(cidadeParam);
    const cidade = String(cidadeInfo?.name || cidadeParam || '').trim();

    const tplSql = `
      SELECT p.code as periodo, s.name as assunto, COALESCE(vco.capacity, vt.capacity, 0) as capacidade
      FROM vacancy_templates vt
      JOIN cities c ON c.id = vt.city_id
      JOIN os_types t ON t.id = vt.os_type_id
      JOIN periods p ON p.id = vt.period_id
      JOIN subjects s ON s.id = vt.subject_id
      LEFT JOIN vacancy_capacity_overrides vco
        ON vco.city_id = vt.city_id
       AND vco.os_type_id = vt.os_type_id
       AND vco.period_id = vt.period_id
       AND vco.subject_id = vt.subject_id
       AND vco.day = ?
      WHERE c.name = ? AND t.code = ?
        AND COALESCE(s.is_active, 1) = 1
        AND COALESCE(s.show_in_board, 0) = 1
    `;
    db.all(tplSql, [data, cidade, tipo], (err, trows) => {
      if (err) return res.status(500).json({ error: "Erro ao montar template" });
      if (!trows || trows.length === 0) return res.status(400).json({ error: "Cidade ou tipo de OS não encontrado" });

      const template = { 'MANHÃ': {}, 'TARDE': {} };
      (trows || []).forEach(r => {
        template[r.periodo] = template[r.periodo] || {};
        template[r.periodo][r.assunto] = Number(r.capacidade || 0);
      });

      const agSql = `
        SELECT id, cliente, assunto, data_hora, periodo, tecnico, observacoes, status, tipo_os, alocado_por, tipo_instalacao, vagas_ocupadas, origem, ixc_status
        FROM agendamentos
        WHERE cidade = ?
          AND DATE(data_hora) = ?
          AND tipo_os = ?
        ORDER BY data_hora ASC
      `;
      db.all(agSql, [cidade, data, tipo], async (err, rows) => {
        if (err) return res.status(500).json({ error: "Erro interno do servidor" });

        const agendamentosOrganizados = { 'MANHÃ': {}, 'TARDE': {} };
        Object.keys(template).forEach(periodo => {
          agendamentosOrganizados[periodo] = {};
          Object.keys(template[periodo] || {}).forEach(assunto => agendamentosOrganizados[periodo][assunto] = []);
        });

        (rows || []).forEach(a => {
          const periodo = a.periodo || (a.data_hora ? periodFromDateTime(a.data_hora) : 'MANHÃ');
          const assunto = a.assunto;
          if (agendamentosOrganizados[periodo] && agendamentosOrganizados[periodo][assunto]) {
            agendamentosOrganizados[periodo][assunto].push({
              id: a.id,
              cliente: a.cliente,
              assunto: a.assunto,
              data_hora: a.data_hora,
              periodo: a.periodo || periodo,
              tecnico: a.tecnico,
              status: a.status,
              origem: a.origem,
              ixc_status: a.ixc_status,
              observacoes: a.observacoes,
              tipo_os: a.tipo_os,
              alocado_por: a.alocado_por,
              tipo_instalacao: a.tipo_instalacao || 'RESIDENCIAL',
              vagas_ocupadas: Math.max(Number(a.vagas_ocupadas || 1), 1)
            });
          }
        });

        // carrega slots fechados para o dia/tipo/cidade (por assunto/período)
        const fechadas = { 'MANHÃ': {}, 'TARDE': {} };
        const tasks = [];
        for (const periodo of Object.keys(template)) {
          for (const assunto of Object.keys(template[periodo] || {})) {
            tasks.push(
              getClosedSlotIndexesByNames({ cidade, tipo_os: tipo, periodo, assunto, day: data })
                .then(indexes => { fechadas[periodo][assunto] = indexes; })
            );
          }
        }

        await Promise.all(tasks);

        res.json({ template, agendamentos: agendamentosOrganizados, vagasFechadas: fechadas, cidade, data, tipo });
      });
    });
  } catch (error) {
    console.error('Erro ao processar vagas detalhadas:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// =======================
// VAGAS FECHADAS (sem localStorage)
// =======================
// GET /api/vagas-fechadas?cidade=&data=&tipo=
router.get('/vagas-fechadas', requirePermission('vagas.view'), (req, res) => {
  const { cidade, data, tipo } = req.query;
  if (!cidade || !data || !tipo) return res.status(400).json({ error: "Informe cidade, data e tipo" });

  const sql = `
    SELECT p.code as periodo, s.name as assunto, vcs.slot_index as slot_index
    FROM vacancy_closed_slots vcs
    JOIN cities c ON c.id = vcs.city_id
    JOIN os_types t ON t.id = vcs.os_type_id
    JOIN periods p ON p.id = vcs.period_id
    JOIN subjects s ON s.id = vcs.subject_id
    WHERE c.name = ? AND t.code = ? AND vcs.day = ?
    ORDER BY p.code, s.name, vcs.slot_index
  `;
  db.all(sql, [cidade, tipo, data], (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });

    const out = { 'MANHÃ': {}, 'TARDE': {} };
    (rows || []).forEach(r => {
      out[r.periodo] = out[r.periodo] || {};
      out[r.periodo][r.assunto] = out[r.periodo][r.assunto] || [];
      out[r.periodo][r.assunto].push(Number(r.slot_index));
    });

    res.json(out);
  });
});

// PUT /api/vagas-fechadas { cidade, data, tipo, periodo, assunto, index, closed }
router.put('/vagas-fechadas', requirePermission('vagas.manage'), (req, res) => {
  const { cidade, data, tipo, periodo, assunto, index, closed } = req.body || {};
  const errors = validateInput({ cidade, data, tipo, periodo, assunto, index }, ['cidade','data','tipo','periodo','assunto','index']);
  if (errors.length > 0) return res.status(400).json({ error: "Dados inválidos", details: errors });

  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: "index inválido" });

  const idsSql = `
    SELECT c.id as city_id, t.id as os_type_id, p.id as period_id, s.id as subject_id
    FROM cities c, os_types t, periods p, subjects s
    WHERE c.name=? AND t.code=? AND p.code=? AND s.name=?
  `;
  db.get(idsSql, [cidade, tipo, periodo, assunto], (err, ids) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    if (!ids) return res.status(400).json({ error: "Cidade/tipo/período/assunto inválidos" });

    if (closed === false || closed === 0 || closed === 'false') {
      auditLog(req, {
        action: 'OPEN_SLOT',
        entity_type: 'vacancy_closed_slot',
        entity_id: `${cidade}|${tipo}|${periodo}|${assunto}|${data}|${idx}`,
        old_value: { closed: true },
        new_value: { closed: false, cidade, tipo, periodo, assunto, data, index: idx }
      });
      db.run(
        `DELETE FROM vacancy_closed_slots
         WHERE city_id=? AND os_type_id=? AND period_id=? AND subject_id=? AND day=? AND slot_index=?`,
        [ids.city_id, ids.os_type_id, ids.period_id, ids.subject_id, data, idx],
        function (err) {
          if (err) return res.status(500).json({ error: "Erro ao reabrir vaga" });

          return res.json({ ok: true, action: "open", changes: this.changes });
        }
      );
    } else {
      auditLog(req, {
        action: 'CLOSE_SLOT',
        entity_type: 'vacancy_closed_slot',
        entity_id: `${cidade}|${tipo}|${periodo}|${assunto}|${data}|${idx}`,
        old_value: { closed: false },
        new_value: { closed: true, cidade, tipo, periodo, assunto, data, index: idx }
      });
      db.run(
        `INSERT OR IGNORE INTO vacancy_closed_slots (city_id, os_type_id, period_id, subject_id, day, slot_index, closed_by_user_id)
         VALUES (?,?,?,?,?,?,?)`,
        [ids.city_id, ids.os_type_id, ids.period_id, ids.subject_id, data, idx, req.session.user.id],
        function (err) {
          if (err) return res.status(500).json({ error: "Erro ao fechar vaga" });

          return res.json({ ok: true, action: "close" });
        }
      );
    }
  });
});

module.exports = router;
