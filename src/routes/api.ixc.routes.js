const express = require("express");
const { db } = require("../db/connection");
const { getIxcApi } = require("../services/ixc");
const { syncIxcServicosOs, getLastSyncSummary, IXC_SERVICOS_SETOR_ID, resolveCityName } = require("../services/ixcSync");
const { requirePermission } = require("../middleware/requirePermission");

const router = express.Router();

/**
 * Busca cliente no IXC por ID e guarda cache no banco para multiusuário.
 * GET /api/ixc/cliente/:id -> { razao, cidade }
 */
router.get("/ixc/cliente/:id", requirePermission('agenda.view'), async (req, res) => {
  const { id } = req.params;

  // 1) tenta cache
  db.get("SELECT razao, cidade, updated_at FROM ixc_clients WHERE ixc_id = ?", [String(id)], async (err, row) => {
    if (err) return res.status(500).json({ error: "Erro interno do servidor" });
    if (row) {
      const cidadeInfo = await resolveCityName(row.cidade);
      const cidade = cidadeInfo?.name || row.cidade || null;
      if (cidade !== row.cidade && cidade) {
        db.run(
          `UPDATE ixc_clients SET cidade = ?, updated_at = CURRENT_TIMESTAMP WHERE ixc_id = ?`,
          [cidade, String(id)],
          () => {}
        );
      }
      return res.json({ razao: row.razao, cidade, cached: true, updated_at: row.updated_at });
    }

    // 2) se não tem cache, chama IXC
    if (!getIxcApi()) return res.status(500).json({ error: "API IXC não configurada." });

    try {
      const requestData = {
        qtype: "cliente.id",
        query: id,
        oper: "=",
        page: "1",
        rp: "1",
        sortname: "cliente.id",
        sortorder: "desc"
      };

      const response = await getIxcApi().get(`/cliente`, { data: requestData });

      if (response.data?.registros?.length > 0) {
        const cliente = response.data.registros[0];
        const razao = cliente.razao || null;
        const cidadeRaw = cliente.cidade || cliente.cidade_cliente || null;
        const cidadeInfo = await resolveCityName(cidadeRaw);
        const cidade = cidadeInfo?.name || cidadeRaw || null;

        db.run(
          `INSERT OR REPLACE INTO ixc_clients (ixc_id, razao, cidade, raw_json, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [String(id), razao, cidade, JSON.stringify(cliente)],
          () => {}
        );

        return res.json({ razao, cidade, cached: false });
      }

      return res.status(404).json({ error: "Cliente não encontrado no IXC." });
    } catch (error) {
      console.error("Erro ao buscar cliente no IXC:", error.response ? error.response.data : error.message);
      res.status(500).json({ error: "Erro ao buscar cliente no IXC." });
    }
  });
});


router.post('/ixc/sync', requirePermission('ixc.sync'), async (req, res) => {
  try {
    const summary = await syncIxcServicosOs({ triggeredBy: req.session?.user?.username || 'usuario', mode: req.query.mode === 'light' ? 'light' : 'full' });
    return res.json({ message: 'Sincronização do IXC concluída', summary });
  } catch (error) {
    console.error('Erro ao sincronizar OS do IXC:', error?.response?.data || error.message);
    return res.status(500).json({ error: 'Erro ao sincronizar OS do IXC.', details: error.message });
  }
});

router.get('/ixc/sync-status', requirePermission('agenda.view'), async (req, res) => {
  try {
    const summary = await getLastSyncSummary();
    return res.json({ setor_servicos_id: IXC_SERVICOS_SETOR_ID, summary });
  } catch (error) {
    console.error('Erro ao consultar status da sincronização do IXC:', error.message);
    return res.status(500).json({ error: 'Erro ao consultar status da sincronização do IXC.' });
  }
});

module.exports = router;
