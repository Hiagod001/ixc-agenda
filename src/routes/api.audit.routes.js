const express = require("express");
const { db } = require("../db/connection");
const { requirePermission } = require("../middleware/requirePermission");

const router = express.Router();

// GET /api/audit?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id=&action=&entity_type=&page=&limit=
router.get("/audit", requirePermission("logs.view"), (req, res) => {
  const { from, to, user_id, action, entity_type, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(parseInt(page || "1", 10) || 1, 1);
  const lim = Math.min(Math.max(parseInt(limit || "50", 10) || 50, 1), 200);
  const offset = (pageNum - 1) * lim;

  let where = "WHERE 1=1";
  const params = [];

  if (from) {
    where += " AND DATE(created_at) >= ?";
    params.push(String(from));
  }
  if (to) {
    where += " AND DATE(created_at) <= ?";
    params.push(String(to));
  }
  if (user_id) {
    where += " AND user_id = ?";
    params.push(parseInt(user_id, 10));
  }
  if (action) {
    where += " AND action = ?";
    params.push(String(action));
  }
  if (entity_type) {
    where += " AND entity_type = ?";
    params.push(String(entity_type));
  }

  const countSql = `SELECT COUNT(*) as total FROM audit_logs ${where}`;
  const dataSql = `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;

  db.get(countSql, params, (err, row) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    const total = row?.total || 0;
    db.all(dataSql, [...params, lim, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: "Erro interno do servidor" });
      res.json({ rows: rows || [], meta: { page: pageNum, limit: lim, total } });
    });
  });
});

// Listas para filtros
router.get("/audit/meta", requirePermission("logs.view"), (req, res) => {
  const out = { actions: [], entity_types: [], users: [] };

  db.all("SELECT DISTINCT action FROM audit_logs ORDER BY action", [], (err, actions) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    out.actions = (actions || []).map((r) => r.action);

    db.all("SELECT DISTINCT entity_type FROM audit_logs ORDER BY entity_type", [], (err, et) => {
      if (err) return res.status(500).json({ error: "Erro interno do servidor" });
      out.entity_types = (et || []).map((r) => r.entity_type);

      db.all("SELECT id, username FROM users ORDER BY username", [], (err, users) => {
        if (err) return res.status(500).json({ error: "Erro interno do servidor" });
        out.users = users || [];
        res.json(out);
      });
    });
  });
});

module.exports = router;
