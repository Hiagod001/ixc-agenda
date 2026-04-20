const express = require("express");
const { db } = require("../db/connection");
const { requirePermission } = require("../middleware/requirePermission");

const router = express.Router();

function buildWhere(q, params) {
  let where = "WHERE 1=1";

  if (q.data_inicio) { where += " AND DATE(data_hora) >= ?"; params.push(String(q.data_inicio)); }
  if (q.data_fim) { where += " AND DATE(data_hora) <= ?"; params.push(String(q.data_fim)); }
  if (q.cidade) { where += " AND cidade = ?"; params.push(String(q.cidade)); }
  if (q.tecnico) { where += " AND tecnico = ?"; params.push(String(q.tecnico)); }
  if (q.assunto) { where += " AND assunto = ?"; params.push(String(q.assunto)); }
  if (q.tipo_os) { where += " AND tipo_os = ?"; params.push(String(q.tipo_os)); }
  if (q.status) {
    const list = String(q.status).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 1) { where += " AND status = ?"; params.push(list[0]); }
    else if (list.length > 1) { where += ` AND status IN (${list.map(() => '?').join(',')})`; params.push(...list); }
  }
  return where;
}

// Produção/Resumo
router.get("/reports/summary", requirePermission("reports.view"), (req, res) => {
  const params = [];
  const where = buildWhere(req.query || {}, params);

  const sql = `
    SELECT
      cidade,
      COALESCE(tecnico, '-') as tecnico,
      COALESCE(assunto, '-') as assunto,
      COALESCE(tipo_os, '-') as tipo_os,
      status,
      COUNT(*) as total
    FROM agendamentos
    ${where}
    GROUP BY cidade, tecnico, assunto, tipo_os, status
    ORDER BY cidade ASC, tecnico ASC, assunto ASC, tipo_os ASC, status ASC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    res.json({ rows: rows || [] });
  });
});

// Export CSV
router.get("/reports/export", requirePermission("reports.export"), (req, res) => {
  const params = [];
  const where = buildWhere(req.query || {}, params);

  const sql = `
    SELECT
      id,
      cliente,
      cidade,
      assunto,
      tipo_os,
      tecnico,
      status,
      data_hora,
      created_at,
      updated_at
    FROM agendamentos
    ${where}
    ORDER BY COALESCE(data_hora, created_at) DESC, id DESC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });

    const header = [
      "id",
      "cliente",
      "cidade",
      "assunto",
      "tipo_os",
      "tecnico",
      "status",
      "data_hora",
      "created_at",
      "updated_at",
    ];

    const escape = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/\r?\n/g, " ");
      if (s.includes('"') || s.includes(',') || s.includes(';')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [header.join(",")];
    (rows || []).forEach((r) => {
      lines.push(header.map((k) => escape(r[k])).join(","));
    });

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=relatorio_agendamentos_${Date.now()}.csv`);
    res.send(csv);
  });
});

module.exports = router;
