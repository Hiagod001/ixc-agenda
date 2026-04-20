const { db } = require("../db/connection");

/**
 * Carrega permissões efetivas do usuário.
 * Regra (para permitir "desmarcar" permissões do papel):
 * - Se existir pelo menos 1 permissão em user_permissions para esse usuário,
 *   ENTÃO usamos APENAS a lista do usuário (modo "override total").
 * - Caso contrário, usamos as permissões do role.
 */
function getEffectivePermissions(user) {
  return new Promise((resolve, reject) => {
    if (!user?.id) return resolve([]);
    const role = user.role || 'user';

    db.all("SELECT permission FROM user_permissions WHERE user_id = ?", [user.id], (err, userRows) => {
      if (err) return reject(err);

      const list = (userRows || []).map(r => r.permission).filter(Boolean);
      if (list.length > 0) return resolve(list);

      db.all("SELECT permission FROM role_permissions WHERE role = ?", [role], (err2, roleRows) => {
        if (err2) return reject(err2);
        resolve((roleRows || []).map(r => r.permission).filter(Boolean));
      });
    });
  });
}

function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const user = req.session?.user;
      if (!user) return res.status(401).json({ error: "Não autenticado" });

      // IMPORTANTe: não cachear permissões de forma "eterna" na sessão.
      // Quando o admin muda permissões no banco, a sessão do usuário pode continuar com permissões antigas.
      // Para garantir que "entrou em vigor" imediatamente, sempre recalculamos do banco.
      const perms = await getEffectivePermissions(user);

      // mantém no objeto da sessão apenas para o front (menu/visibilidade), mas sem confiar nisso pra segurança.
      req.session.user.permissions = perms;

      // Admin NÃO é bypass automático; admin tem permissões via role_permissions (ou override em user_permissions).
      if (perms.includes(permission)) return next();

      return res.status(403).json({ error: "Acesso negado", permission });
    } catch (err) {
      console.error("Erro no requirePermission:", err);
      return res.status(500).json({ error: "Erro interno do servidor" });
    }
  };
}

module.exports = { requirePermission, getEffectivePermissions };
