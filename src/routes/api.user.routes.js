const express = require("express");
const bcrypt = require("bcrypt");
const { db } = require("../db/connection");
const { getEffectivePermissions } = require("../middleware/requirePermission");

const router = express.Router();

/**
 * Sessão atual + permissões efetivas (para o front montar menu/visibilidade).
 */
router.get('/user', async (req, res) => {
  try {
    console.log(`[LOG] Usuário '${req.session.user.username}' verificou a sessão.`);

    const user = req.session.user;

    // garante permissões carregadas
    const perms = await getEffectivePermissions(user);
    req.session.user.permissions = perms;

    res.json({ ...user, permissions: perms });
  } catch (err) {
    console.error('Erro ao retornar /api/user:', err);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

/**
 * Preferências do usuário (ex.: tema).
 * - GET /api/me/preferences  -> { theme: 'dark'|'light'|null }
 * - PUT /api/me/preferences  -> { key, value }  (ou { theme: 'dark' })
 */
router.get('/me/preferences', (req, res) => {
  const userId = req.session.user.id;
  db.all("SELECT key, value FROM user_preferences WHERE user_id = ?", [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    const prefs = {};
    (rows || []).forEach(r => { prefs[r.key] = r.value; });
    res.json(prefs);
  });
});

router.put('/me/preferences', (req, res) => {
  const userId = req.session.user.id;
  const body = req.body || {};
  // aceita formato { key, value } ou objeto direto (ex: { theme: 'dark' })
  const entries = body.key ? [[body.key, body.value]] : Object.entries(body);

  if (!entries.length) return res.status(400).json({ error: "Nada para salvar" });

  const stmt = db.prepare("INSERT OR REPLACE INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)");
  entries.forEach(([k, v]) => stmt.run([userId, String(k), v == null ? null : String(v)]));
  stmt.finalize((err) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    res.json({ ok: true });
  });
});

router.put('/me/password', (req, res) => {
  const userId = req.session.user.id;
  const {
    current_password: currentPassword,
    new_password: newPassword,
    confirm_password: confirmPassword
  } = req.body || {};

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: "Preencha a senha atual, a nova senha e a confirmação." });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "A confirmação da nova senha não confere." });
  }

  if (String(newPassword).length < 4) {
    return res.status(400).json({ error: "A nova senha precisa ter pelo menos 4 caracteres." });
  }

  db.get("SELECT id, username, password FROM users WHERE id = ?", [userId], async (err, user) => {
    if (err) {
      console.error('Erro ao buscar usuário para troca de senha:', err);
      return res.status(500).json({ error: "Erro interno do servidor" });
    }

    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    try {
      const passwordOk = await bcrypt.compare(currentPassword, user.password);
      if (!passwordOk) {
        return res.status(400).json({ error: "A senha atual está incorreta." });
      }

      const hash = await bcrypt.hash(newPassword, 10);
      db.run("UPDATE users SET password = ? WHERE id = ?", [hash, userId], function(updateErr) {
        if (updateErr) {
          console.error('Erro ao atualizar senha do usuário:', updateErr);
          return res.status(500).json({ error: "Erro interno do servidor" });
        }

        res.json({ ok: true, message: "Senha alterada com sucesso." });
      });
    } catch (hashErr) {
      console.error('Erro ao processar troca de senha:', hashErr);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  });
});

module.exports = router;
