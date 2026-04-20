const express = require("express");
const axios = require("axios");
const { db } = require("../db/connection");
const { validateInput } = require("../utils/validateInput");
const { requirePermission } = require("../middleware/requirePermission");
const { ixcConfig, initializeIxcApi } = require("../services/ixc");

const router = express.Router();

/**
 * Monta a estrutura de vagas no mesmo formato legado do front:
 * ESTRUTURA_VAGAS[cidade][tipo][periodo][assunto] = capacidade
 */
function buildEstruturaVagas(callback) {
  const sql = `
    SELECT c.name as cidade, t.code as tipo, p.code as periodo, s.name as assunto, vt.capacity as capacidade
    FROM vacancy_templates vt
    JOIN cities c ON c.id = vt.city_id
    JOIN os_types t ON t.id = vt.os_type_id
    JOIN periods p ON p.id = vt.period_id
    JOIN subjects s ON s.id = vt.subject_id
    WHERE c.is_active = 1 AND t.is_active = 1 AND s.is_active = 1 AND COALESCE(s.show_in_board,0) = 1
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return callback(err);
    const estrutura = {};
    (rows || []).forEach(r => {
      estrutura[r.cidade] = estrutura[r.cidade] || {};
      estrutura[r.cidade][r.tipo] = estrutura[r.cidade][r.tipo] || {};
      estrutura[r.cidade][r.tipo][r.periodo] = estrutura[r.cidade][r.tipo][r.periodo] || {};
      estrutura[r.cidade][r.tipo][r.periodo][r.assunto] = Number(r.capacidade || 0);
    });
    callback(null, estrutura);
  });
}

router.get('/config', (req, res) => {
  try {
    // cidades, tecnicos, assuntos, etc, agora vêm do DB
    db.serialize(() => {
      db.all("SELECT name FROM cities WHERE is_active=1 ORDER BY name", [], (err, cityRows) => {
        if (err) return res.status(500).json({ error: "Erro ao buscar cidades" });

        db.all("SELECT name FROM technicians WHERE is_active=1 ORDER BY name", [], (err, techRows) => {
          if (err) return res.status(500).json({ error: "Erro ao buscar técnicos" });

          db.all("SELECT name, COALESCE(show_in_board,0) as show_in_board FROM subjects WHERE is_active=1 ORDER BY name", [], (err, subjRows) => {
            if (err) return res.status(500).json({ error: "Erro ao buscar assuntos" });

            db.all("SELECT code FROM os_types WHERE is_active=1 ORDER BY code", [], (err, typeRows) => {
              if (err) return res.status(500).json({ error: "Erro ao buscar tipos OS" });

              const statusPossiveis = ['Aberta', 'Agendada', 'Em andamento', 'Concluída', 'Cancelada']; // poderia virar tabela depois

              buildEstruturaVagas((err, estruturaVagas) => {
                if (err) return res.status(500).json({ error: "Erro ao montar estrutura de vagas" });

                res.json({
                  cidades: (cityRows || []).map(r => r.name),
                  tecnicos: (techRows || []).map(r => r.name),
                  assuntos: (subjRows || []).map(r => r.name),
                  assuntosComColuna: (subjRows || []).filter(r => Number(r.show_in_board) === 1).map(r => r.name),
                  tiposOS: (typeRows || []).map(r => r.code),
                  statusPossiveis,
                  estruturaVagas
                });
              });
            });
          });
        });
      });
    });
  } catch (error) {
    console.error('Erro ao retornar /api/config:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// =======================
// IXC CONFIG (já persiste no DB)
// =======================
router.get('/config/ixc', requirePermission('config.view'), (req, res) => {
  try {
    console.log(`[LOG] Usuário '${req.session.user.username}' consultou configurações da API IXC.`);

    db.all("SELECT key, value FROM config WHERE key IN ('ixc_api_url', 'ixc_api_token')", [], (err, rows) => {
      if (err) return res.status(500).json({ error: "Erro interno do servidor" });

      const cfg = {};
      (rows || []).forEach(row => {
        if (row.key === 'ixc_api_url') cfg.apiUrl = row.value;
        if (row.key === 'ixc_api_token') cfg.apiToken = row.value;
      });

      res.json(cfg);
    });
  } catch (error) {
    console.error('Erro ao buscar configurações da API IXC:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post('/config/ixc', requirePermission('config.edit'), (req, res) => {
  try {
    const { apiUrl, apiToken } = req.body || {};
    const errors = validateInput({ apiUrl, apiToken }, ['apiUrl', 'apiToken']);
    if (errors.length > 0) return res.status(400).json({ error: 'Dados inválidos', details: errors });

    console.log(`[LOG] Usuário '${req.session.user.username}' está atualizando configurações da API IXC.`);

    db.run("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      ['ixc_api_url', apiUrl], (err) => {
        if (err) return res.status(500).json({ error: "Erro ao salvar configurações" });

        db.run("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
          ['ixc_api_token', apiToken], (err) => {
            if (err) return res.status(500).json({ error: "Erro ao salvar configurações" });

            // Atualizar serviço em memória
            ixcConfig.apiUrl = apiUrl;
            ixcConfig.apiToken = apiToken;
            initializeIxcApi();

            const details = `Configurações da API IXC atualizadas`;
            const ip = req.ip || req.connection.remoteAddress;
            db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
              [req.session.user.username, 'CONFIG', details, ip]);

            res.json({ message: "Configurações salvas com sucesso" });
          });
      });
  } catch (error) {
    console.error('Erro ao salvar configurações da API IXC:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post('/config/ixc/test', requirePermission('config.view'), async (req, res) => {
  try {
    const { apiUrl, apiToken } = req.body || {};
    const errors = validateInput({ apiUrl, apiToken }, ['apiUrl', 'apiToken']);
    if (errors.length > 0) return res.status(400).json({ error: 'Dados inválidos', details: errors });

    console.log(`[LOG] Usuário '${req.session.user.username}' está testando conexão com a API IXC.`);

    const basicAuthToken = Buffer.from(apiToken).toString('base64');
    const testApi = axios.create({
      baseURL: apiUrl,
      headers: { 'Authorization': `Basic ${basicAuthToken}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    try {
      const response = await testApi.get('/cliente');

      const details = `Teste de conexão com a API IXC bem-sucedido`;
      const ip = req.ip || req.connection.remoteAddress;
      db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
        [req.session.user.username, 'TEST', details, ip]);

      res.json({
        message: "Conexão estabelecida com sucesso",
        result: { status: response.status, statusText: response.statusText }
      });
    } catch (error) {
      const details = `Teste de conexão com a API IXC falhou: ${error.message}`;
      const ip = req.ip || req.connection.remoteAddress;
      db.run(`INSERT INTO logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`,
        [req.session.user.username, 'TEST', details, ip]);

      res.status(400).json({ error: "Falha ao conectar com a API IXC", details: error.message });
    }
  } catch (error) {
    console.error('Erro ao testar API IXC:', error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

module.exports = router;
