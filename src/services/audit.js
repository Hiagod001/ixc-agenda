const { db } = require("../db/connection");

/**
 * Registra auditoria com antes/depois.
 * Nunca deve derrubar a requisição: se falhar, apenas loga no console.
 */
function auditLog(req, { action, entity_type, entity_id = null, old_value = null, new_value = null }) {
  try {
    const user = req?.session?.user || {};
    const user_id = user?.id || null;
    const username = user?.username || null;
    const ip_address = req.ip || req.connection?.remoteAddress || null;
    const user_agent = req.headers?.["user-agent"] || null;

    const sql = `INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.run(
      sql,
      [
        user_id,
        username,
        String(action || ""),
        String(entity_type || ""),
        entity_id != null ? String(entity_id) : null,
        old_value != null ? JSON.stringify(old_value) : null,
        new_value != null ? JSON.stringify(new_value) : null,
        ip_address,
        user_agent,
      ],
      (err) => {
        if (err) console.warn("[AUDIT] Falha ao inserir audit_logs:", err?.message || err);
      }
    );
  } catch (e) {
    console.warn("[AUDIT] Falha inesperada:", e?.message || e);
  }
}

module.exports = { auditLog };
