const express = require("express");
const bcrypt = require("bcrypt");
const { db } = require("../db/connection");
const { validateInput } = require("../utils/validateInput");
const { requirePermission } = require("../middleware/requirePermission");
const { auditLog } = require("../services/audit");

const router = express.Router();

// =======================
// LISTAR USUÁRIOS
// =======================
router.get('/users', requirePermission('users.view'), (req, res) => {
  try {
    console.log(`[LOG] Usuário '${req.session.user.username}' consultou lista de usuários.`);

    const sql = `
      SELECT u.id, u.username, u.role, u.is_active, u.created_at,
             GROUP_CONCAT(up.permission) as permissions
      FROM users u
      LEFT JOIN user_permissions up ON u.id = up.user_id
      GROUP BY u.id, u.username, u.role, u.is_active, u.created_at
      ORDER BY u.created_at DESC
    `;

    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error('Erro ao buscar usuários:', err);
        return res.status(500).json({ error: "Erro interno do servidor" });
      }

      const users = (rows || []).map(u => ({
        ...u,
        permissions: u.permissions ? String(u.permissions).split(',').filter(Boolean) : []
      }));

      res.json(users);
    });
  } catch (error) {
    console.error('Erro ao buscar usuários:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// =======================
// CRIAR USUÁRIO
// =======================
router.post('/users', requirePermission('users.manage'), (req, res) => {
  try {
    const { username, password, role } = req.body || {};

    const errors = validateInput({ username, password, role }, ['username', 'password', 'role']);
    if (errors.length > 0) return res.status(400).json({ error: 'Dados inválidos', details: errors });

    if (!['admin', 'supervisor', 'agendamento', 'suporte'].includes(role)) {
      return res.status(400).json({ error: 'Função inválida' });
    }

    console.log(`[LOG] Usuário '${req.session.user.username}' está criando novo usuário: ${username}.`);

    db.get("SELECT id FROM users WHERE username = ?", [username], (err, row) => {
      if (err) return res.status(500).json({ error: "Erro interno do servidor" });
      if (row) return res.status(400).json({ error: "Nome de usuário já existe" });

      bcrypt.hash(password, 10, (err, hash) => {
        if (err) return res.status(500).json({ error: "Erro interno do servidor" });

        db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, hash, role], function (err) {
          if (err) return res.status(500).json({ error: "Erro ao criar usuário" });

          auditLog(req, {
            action: 'CREATE_USER',
            entity_type: 'user',
            entity_id: this.lastID,
            old_value: null,
            new_value: { id: this.lastID, username, role, is_active: 1 }
          });

          const details = `Usuário '${username}' criado com função '${role}'`;
          const ip = req.ip || req.connection.remoteAddress;
          db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
            [req.session.user.username, 'CREATE_USER', details, ip]);

          res.json({ message: "Usuário criado com sucesso", user: { id: this.lastID, username, role } });
        });
      });
    });
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// =======================
// ATUALIZAR USUÁRIO
// =======================
router.put('/users/:id', requirePermission('users.manage'), (req, res) => {
  try {
    const userId = req.params.id;
    const { username, password, role, is_active } = req.body || {};

    const errors = validateInput({ username, role }, ['username', 'role']);
    if (errors.length > 0) return res.status(400).json({ error: 'Dados inválidos', details: errors });

    if (!['admin', 'supervisor', 'agendamento', 'suporte'].includes(role)) {
      return res.status(400).json({ error: 'Função inválida' });
    }

    console.log(`[LOG] Usuário '${req.session.user.username}' está editando usuário ID: ${userId}.`);

    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
      if (err) return res.status(500).json({ error: "Erro interno do servidor" });
      if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

      db.get("SELECT id FROM users WHERE username = ? AND id != ?", [username, userId], (err, row) => {
        if (err) return res.status(500).json({ error: "Erro interno do servidor" });
        if (row) return res.status(400).json({ error: "Nome de usuário já existe" });

        const updateUser = (hashedPassword = null) => {
          let sql, params;
          if (hashedPassword) {
            sql = "UPDATE users SET username = ?, password = ?, role = ?, is_active = ? WHERE id = ?";
            params = [username, hashedPassword, role, is_active == null ? 1 : Number(is_active), userId];
          } else {
            sql = "UPDATE users SET username = ?, role = ?, is_active = ? WHERE id = ?";
            params = [username, role, is_active == null ? 1 : Number(is_active), userId];
          }

          db.run(sql, params, function (err) {
            if (err) return res.status(500).json({ error: "Erro ao atualizar usuário" });

            auditLog(req, {
              action: 'UPDATE_USER',
              entity_type: 'user',
              entity_id: userId,
              old_value: { id: user.id, username: user.username, role: user.role, is_active: user.is_active },
              new_value: { id: Number(userId), username, role, is_active: is_active == null ? 1 : Number(is_active) }
            });

            const details = `Usuário '${username}' (ID: ${userId}) atualizado`;
            const ip = req.ip || req.connection.remoteAddress;
            db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
              [req.session.user.username, 'UPDATE_USER', details, ip]);

            res.json({ message: "Usuário atualizado com sucesso" });
          });
        };

        if (password && String(password).trim() !== '') {
          bcrypt.hash(password, 10, (err, hash) => {
            if (err) return res.status(500).json({ error: "Erro interno do servidor" });
            updateUser(hash);
          });
        } else {
          updateUser();
        }
      });
    });
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// =======================
// EXCLUIR USUÁRIO
// =======================
router.delete('/users/:id', requirePermission('users.manage'), (req, res) => {
  try {
    const userId = req.params.id;

    if (parseInt(userId) === req.session.user.id) {
      return res.status(400).json({ error: "Você não pode excluir sua própria conta" });
    }

    console.log(`[LOG] Usuário '${req.session.user.username}' está excluindo usuário ID: ${userId}.`);

    db.get("SELECT id, username, role, is_active FROM users WHERE id = ?", [userId], (eOld, oldUser) => {
      if (eOld) return res.status(500).json({ error: "Erro interno do servidor" });
      if (!oldUser) return res.status(404).json({ error: "Usuário não encontrado" });

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        db.run("UPDATE audit_logs SET user_id = NULL WHERE user_id = ?", [userId], function (err) {
          if (err) {
            db.run("ROLLBACK");
            console.error('Erro ao desvincular audit_logs do usuário:', err);
            return res.status(500).json({ error: "Erro ao preparar exclusão do usuário" });
          }

          db.run("UPDATE vacancy_closed_slots SET closed_by_user_id = NULL WHERE closed_by_user_id = ?", [userId], function (err2) {
            if (err2) {
              db.run("ROLLBACK");
              console.error('Erro ao desvincular vacancy_closed_slots do usuário:', err2);
              return res.status(500).json({ error: "Erro ao preparar exclusão do usuário" });
            }

            db.run("UPDATE vacancy_capacity_overrides SET updated_by_user_id = NULL WHERE updated_by_user_id = ?", [userId], function (err3) {
              if (err3) {
                db.run("ROLLBACK");
                console.error('Erro ao desvincular vacancy_capacity_overrides do usuário:', err3);
                return res.status(500).json({ error: "Erro ao preparar exclusão do usuário" });
              }

              db.run("DELETE FROM users WHERE id = ?", [userId], function (err4) {
                if (err4) {
                  db.run("ROLLBACK");
                  console.error('Erro ao excluir usuário:', err4);
                  return res.status(500).json({ error: "Erro ao excluir usuário" });
                }
                if (this.changes === 0) {
                  db.run("ROLLBACK");
                  return res.status(404).json({ error: "Usuário não encontrado" });
                }

                auditLog(req, {
                  action: 'DELETE_USER',
                  entity_type: 'user',
                  entity_id: userId,
                  old_value: oldUser,
                  new_value: null
                });

                const details = `Usuário ID ${userId} excluído`;
                const ip = req.ip || req.connection.remoteAddress;
                db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
                  [req.session.user.username, 'DELETE_USER', details, ip]);

                db.run("COMMIT", (commitErr) => {
                  if (commitErr) {
                    db.run("ROLLBACK");
                    console.error('Erro ao confirmar exclusão do usuário:', commitErr);
                    return res.status(500).json({ error: "Erro ao concluir exclusão do usuário" });
                  }

                  res.json({ message: "Usuário excluído com sucesso" });
                });
              });
            });
          });
        });
      });
    });
  } catch (error) {
    console.error('Erro ao excluir usuário:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// =======================
// PERMISSÕES POR USUÁRIO (override)
// =======================
// GET /api/users/:id/permissions -> lista efetiva (override do usuário se existir, senão role)
router.get('/users/:id/permissions', requirePermission('users.manage'), (req, res) => {
  const userId = req.params.id;

  db.get("SELECT id, role FROM users WHERE id = ?", [userId], (err, userRow) => {
    if (err) return res.status(500).json({ error: "Erro ao carregar usuário" });
    if (!userRow) return res.status(404).json({ error: "Usuário não encontrado" });

    // Se houver permissões do usuário, elas sobrescrevem o papel.
    db.all("SELECT permission FROM user_permissions WHERE user_id = ?", [userId], (err2, userPermRows) => {
      if (err2) return res.status(500).json({ error: "Erro ao carregar permissões" });

      const userPerms = (userPermRows || []).map(r => r.permission).filter(Boolean);
      if (userPerms.length > 0) return res.json(userPerms);

      db.all("SELECT permission FROM role_permissions WHERE role = ?", [userRow.role], (err3, rolePermRows) => {
        if (err3) return res.status(500).json({ error: "Erro ao carregar permissões" });
        const rolePerms = (rolePermRows || []).map(r => r.permission).filter(Boolean);
        return res.json(rolePerms);
      });
    });
  });
});

// PUT /api/users/:id/permissions { permissions: ['agenda.view', ...] }
router.put('/users/:id/permissions', requirePermission('users.manage'), (req, res) => {
  const userId = req.params.id;
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];

  // normaliza
  const normalized = [...new Set(permissions.map(p => String(p).trim()).filter(Boolean))];

  db.serialize(() => {
    db.all("SELECT permission FROM user_permissions WHERE user_id = ?", [userId], (eOld, oldRows) => {
      if (eOld) return res.status(500).json({ error: "Erro ao carregar permissões atuais" });
      const oldPerms = (oldRows || []).map(r => r.permission).filter(Boolean);

      db.run("DELETE FROM user_permissions WHERE user_id = ?", [userId], (err) => {
        if (err) return res.status(500).json({ error: "Erro ao limpar permissões" });

        if (normalized.length === 0) {
          if (req.session.user.id === Number(userId)) req.session.user.permissions = undefined;

          auditLog(req, {
            action: 'UPDATE_PERMISSIONS',
            entity_type: 'user_permissions',
            entity_id: userId,
            old_value: { user_id: Number(userId), permissions: oldPerms },
            new_value: { user_id: Number(userId), permissions: [] }
          });

          return res.json({ message: "Permissões atualizadas (nenhuma override)" });
        }

        const stmt = db.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission) VALUES (?, ?)");
        normalized.forEach(p => stmt.run([userId, p]));
        stmt.finalize((err) => {
          if (err) return res.status(500).json({ error: "Erro ao salvar permissões" });

          if (req.session.user.id === Number(userId)) req.session.user.permissions = undefined;

          auditLog(req, {
            action: 'UPDATE_PERMISSIONS',
            entity_type: 'user_permissions',
            entity_id: userId,
            old_value: { user_id: Number(userId), permissions: oldPerms },
            new_value: { user_id: Number(userId), permissions: normalized }
          });

          const details = `Permissões do usuário ID ${userId} atualizadas (${normalized.length})`;
          const ip = req.ip || req.connection.remoteAddress;
          db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
            [req.session.user.username, 'UPDATE_PERMISSIONS', details, ip]);

          res.json({ message: "Permissões atualizadas com sucesso", permissions: normalized });
        });
      });
    });
  });
});

module.exports = router;
