const express = require("express");
const { db } = require("../db/connection");
const { requirePermission } = require("../middleware/requirePermission");

const router = express.Router();

router.get('/logs', requirePermission('logs.view'), (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const sql = "SELECT * FROM logs ORDER BY timestamp DESC LIMIT ? OFFSET ?";

  db.all(sql, [parseInt(limit), parseInt(offset)], (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    res.json(rows);
  });
});

module.exports = router;
