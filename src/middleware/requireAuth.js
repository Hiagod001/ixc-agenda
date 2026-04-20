function requireAuth(req, res, next) {
if (!req.session.user) {
        console.log('[LOG] Acesso bloqueado para rota não autenticada:', req.method, req.path);
        return res.status(401).json({ error: "Não autenticado" });
    }
    next();
}

module.exports = { requireAuth };
