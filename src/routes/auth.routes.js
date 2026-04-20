const express = require("express");
const bcrypt = require("bcrypt");
const { db } = require("../db/connection");

const router = express.Router();

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
    }
    
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err) {
            console.error('Erro ao buscar usuário:', err);
            return res.status(500).json({ error: "Erro interno do servidor" });
        }
        
        if (!user) {
            return res.status(401).json({ error: "Usuário ou senha inválidos" });
        }
        
        bcrypt.compare(password, user.password, (err, result) => {
            if (err) {
                console.error('Erro ao comparar senhas:', err);
                return res.status(500).json({ error: "Erro interno do servidor" });
            }
            
            if (!result) {
                return res.status(401).json({ error: "Usuário ou senha inválidos" });
            }
            
            // Criar sessão
            req.session.user = {
                id: user.id,
                username: user.username,
                role: user.role
            };
            
            console.log(`[LOG] Usuário '${username}' fez LOGIN com sucesso.`);
            
            // Registrar log de login
            const ip = req.ip || req.connection.remoteAddress;
            db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`, 
                [username, 'LOGIN', 'Login bem-sucedido', ip]);
            
            res.json({ message: "Login bem-sucedido", user: req.session.user });
        });
    });
});

router.get('/logout', (req, res) => {
    if (req.session.user) {
        const username = req.session.user.username;
        console.log(`[LOG] Usuário '${username}' fez LOGOUT.`);
        
        // Registrar log de logout
        const ip = req.ip || req.connection.remoteAddress;
        db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`, 
            [username, 'LOGOUT', 'Logout bem-sucedido', ip]);
    }
    
    req.session.destroy();
    res.redirect('/login.html');
});

module.exports = router;
