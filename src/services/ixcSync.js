const { db } = require('../db/connection');
const { getIxcApi } = require('./ixc');

const IXC_SERVICOS_SETOR_ID = '6';
const SYNC_PAGE_SIZE = 100;
const MAX_PAGES = 10;
const ASSUNTOS_IGNORAR = new Set(['498']);
const ASSUNTOS_IGNORAR_NOMES = new Set([
  'AJUDA TECNICA',
  'DESLOCAMENTO TECNICO',
  'ORGANIZACAO DE CTO',
  'PONTUACAO EXTRA',
  'RETORNO PARA CORRECAO',
]);
const DATA_ABERTURA_CORTE = '2026-04-05 23:59:59';
let currentSyncPromise = null;
const MANUAL_CITY_ALIASES = {
  'CARMO DO PARANAIBA': 'Carmo do Paranaíba',
  'GUIMARANIA': 'Guimarânia',
  'PATROCINIO': 'Patrocínio',
  'VARJAO DE MINAS': 'Varjão de Minas',
  'SAO GONCALO': 'São Gonçalo do Abaeté',
  'SANTANA': 'Santana de Patos',
};

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

function isNumericIdentifier(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function normalizeCityKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizeSubjectKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function isPredialSubject(value) {
  const normalized = normalizeSubjectKey(value);
  if (!normalized) return false;
  return normalized.includes('PREDIAL') && (
    normalized.includes('INSTALACAO') ||
    normalized.includes('MUDANCA')
  );
}

function parseIxcDateTime(value) {
  const str = String(value || '').trim();
  if (!str || str === '0000-00-00' || str === '0000-00-00 00:00:00') return null;
  const normalized = str.replace(' ', 'T');
  const dt = new Date(normalized);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isAfterCutoff(value) {
  const dt = parseIxcDateTime(value);
  const cutoff = parseIxcDateTime(DATA_ABERTURA_CORTE);
  if (!dt || !cutoff) return false;
  return dt > cutoff;
}

function mapIxcSubject(os, cachedSubject) {
  const assuntoId = String(os?.id_assunto || '').trim();
  const known = {
    '13': 'Sem conexão',
    '578': 'Instalação',
    '446': 'Manutenção programada',
  };
  const resolved = String(cachedSubject?.name || '').trim();
  return resolved || known[assuntoId] || `Assunto IXC #${assuntoId || 'não identificado'}`;
}

function getRadusuarioLookupId(os) {
  const candidates = [os?.login, os?.id_login, os?.id_radusuario];
  for (const candidate of candidates) {
    const cleaned = String(candidate || '').trim();
    if (cleaned) return cleaned;
  }
  return '';
}

function mapTipoOsFromConexaoMapa(tipoConexaoMapa, fallback = 'FIBRA') {
  const mapa = String(tipoConexaoMapa || '').trim().toUpperCase();
  if (mapa === 'F') return 'FIBRA';
  if (mapa === '58' || mapa === '24') return 'RADIO';
  return fallback;
}

function buildClienteLabel(os, cachedClient) {
  if (cachedClient?.razao) return cachedClient.razao;
  if (os?.id_cliente) return `Cliente IXC #${os.id_cliente}`;
  return `OS IXC #${os?.id || ''}`.trim();
}

function buildObservacoes(os) {
  const partes = [];
  if (os?.protocolo) partes.push(`Protocolo: ${os.protocolo}`);
  if (os?.endereco) partes.push(`Endereço: ${os.endereco}`);
  if (os?.complemento) partes.push(`Complemento: ${os.complemento}`);
  if (os?.referencia) partes.push(`Referência: ${os.referencia}`);
  if (os?.data_agenda) partes.push(`Agendamento IXC: ${os.data_agenda}`);
  if (os?.data_agenda_final) partes.push(`Fim agenda IXC: ${os.data_agenda_final}`);
  return partes.join(' | ');
}

async function fetchClientCache(ixcClientId) {
  if (!ixcClientId) return null;
  return await dbGet('SELECT razao, cidade FROM ixc_clients WHERE ixc_id = ?', [String(ixcClientId)]);
}

async function fetchAndCacheClient(ixcClientId) {
  if (!ixcClientId || !getIxcApi()) return null;
  const existing = await fetchClientCache(ixcClientId);
  if (existing?.razao) return existing;

  try {
    const requestData = {
      qtype: 'cliente.id',
      query: String(ixcClientId),
      oper: '=',
      page: '1',
      rp: '1',
      sortname: 'cliente.id',
      sortorder: 'desc'
    };

    const response = await getIxcApi().request({
      method: 'GET',
      url: '/cliente',
      data: requestData,
      headers: { ixcsoft: 'listar' }
    });

    const cliente = response?.data?.registros?.[0];
    if (!cliente) return existing || null;

    const razao = cliente.razao || cliente.nome || null;
    const cidadeRaw = cliente.cidade || cliente.cidade_cliente || null;
    const cidadeInfo = await resolveCityName(cidadeRaw);
    const cidade = cidadeInfo?.name || (!isNumericIdentifier(cidadeRaw) ? cidadeRaw : null);

    await dbRun(
      `INSERT OR REPLACE INTO ixc_clients (ixc_id, razao, cidade, raw_json, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [String(ixcClientId), razao, cidade, JSON.stringify(cliente)]
    );

    return { razao, cidade };
  } catch (error) {
    console.error('[IXC_SYNC] Falha ao buscar cliente no IXC:', error?.response?.data || error.message);
    return existing || null;
  }
}


async function fetchSubjectCache(ixcSubjectId) {
  if (!ixcSubjectId) return null;
  return await dbGet('SELECT name FROM ixc_subjects WHERE ixc_id = ?', [String(ixcSubjectId)]);
}

async function ensureSubjectExistsLocal(subjectName) {
  const cleaned = String(subjectName || '').trim();
  if (!cleaned) return null;

  let existing = await dbGet('SELECT id, COALESCE(show_in_board,0) as show_in_board FROM subjects WHERE lower(name) = lower(?) LIMIT 1', [cleaned]);
  if (existing?.id) {
    await dbRun('UPDATE subjects SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [existing.id]);
  } else {
    const result = await dbRun(
      `INSERT INTO subjects (name, is_active, show_in_board, created_at, updated_at)
       VALUES (?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [cleaned]
    );
    existing = { id: result.lastID };
  }

  if (Number(existing.show_in_board || 0) === 1) {
    await ensureVacancyTemplatesForSubject(cleaned, 1);
  }
  return existing;
}

async function requestIxcList(url, body) {
  const api = getIxcApi();
  if (!api) throw new Error('API IXC não configurada');
  return api.request({
    method: 'GET',
    url,
    data: body,
    headers: { ixcsoft: 'listar' }
  });
}

async function fetchAndCacheSubject(ixcSubjectId, workflowParamId = null) {
  if (!ixcSubjectId || !getIxcApi()) return null;

  const existing = await fetchSubjectCache(ixcSubjectId);
  if (existing?.name) {
    await ensureSubjectExistsLocal(existing.name);
    return existing;
  }

  const workflowId = String(workflowParamId || '').trim();
  const candidates = [
    { url: '/su_oss_assunto', qtype: 'su_oss_assunto.id', query: String(ixcSubjectId) },
    { url: '/su_assunto', qtype: 'su_assunto.id', query: String(ixcSubjectId) },
    ...(workflowId ? [
      { url: '/wfl_param_os', qtype: 'wfl_param_os.id', query: String(workflowId) },
      { url: '/wf_param_os', qtype: 'wf_param_os.id', query: String(workflowId) },
    ] : []),
  ];

  for (const candidate of candidates) {
    try {
      const requestData = {
        qtype: candidate.qtype,
        query: candidate.query,
        oper: '=',
        page: '1',
        rp: '1',
        sortname: candidate.qtype,
        sortorder: 'desc'
      };

      const response = await requestIxcList(candidate.url, requestData);
      const assunto = response?.data?.registros?.[0];
      if (!assunto) continue;

      const name = String(
        assunto.assunto ||
        assunto.descricao ||
        assunto.nome ||
        assunto.name ||
        assunto.titulo ||
        assunto.parametro ||
        ''
      ).trim();

      if (!name) continue;

      await dbRun(
        `INSERT INTO ixc_subjects (ixc_id, name, raw_json, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(ixc_id) DO UPDATE SET
           name = excluded.name,
           raw_json = excluded.raw_json,
           updated_at = CURRENT_TIMESTAMP`,
        [String(ixcSubjectId), name, JSON.stringify(assunto)]
      );

      await ensureSubjectExistsLocal(name);
      return { name };
    } catch (error) {
      continue;
    }
  }

  return null;
}

async function fetchOsPageBySetor(page = 1) {
  if (!getIxcApi()) {
    throw new Error('API IXC não configurada');
  }

  const body = {
    qtype: 'su_oss_chamado.setor',
    query: String(IXC_SERVICOS_SETOR_ID),
    oper: '=',
    page: String(page),
    rp: String(SYNC_PAGE_SIZE),
    sortname: 'su_oss_chamado.id',
    sortorder: 'desc'
  };

  const response = await getIxcApi().request({
    method: 'GET',
    url: '/su_oss_chamado',
    data: body,
    headers: { ixcsoft: 'listar' }
  });

  return response?.data || {};
}

async function fetchRecentServicosOs(maxPages = MAX_PAGES) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const payload = await fetchOsPageBySetor(page);
    const registros = Array.isArray(payload?.registros) ? payload.registros : [];
    all.push(...registros);
    if (registros.length < SYNC_PAGE_SIZE) break;
  }
  return all;
}

async function fetchServicoOsById(osId) {
  if (!osId || !getIxcApi()) return null;

  const body = {
    qtype: 'su_oss_chamado.id',
    query: String(osId),
    oper: '=',
    page: '1',
    rp: '1',
    sortname: 'su_oss_chamado.id',
    sortorder: 'desc'
  };

  const response = await getIxcApi().request({
    method: 'GET',
    url: '/su_oss_chamado',
    data: body,
    headers: { ixcsoft: 'listar' }
  });

  return response?.data?.registros?.[0] || null;
}

async function ensureSyncColumns() {
  const cols = await dbAll('PRAGMA table_info(agendamentos)');
  const names = new Set(cols.map(c => c.name));
  const adds = [];
  if (!names.has('origem')) adds.push("ALTER TABLE agendamentos ADD COLUMN origem TEXT DEFAULT 'manual'");
  if (!names.has('ixc_os_id')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_os_id TEXT');
  if (!names.has('ixc_status')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_status TEXT');
  if (!names.has('ixc_setor_id')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_setor_id TEXT');
  if (!names.has('ixc_assunto_id')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_assunto_id TEXT');
  if (!names.has('ixc_tecnico_id')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_tecnico_id TEXT');
  if (!names.has('ixc_cliente_id')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_cliente_id TEXT');
  if (!names.has('ixc_login_id')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_login_id TEXT');
  if (!names.has('ixc_data_abertura')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_data_abertura TEXT');
  if (!names.has('ixc_data_agenda')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_data_agenda TEXT');
  if (!names.has('ixc_data_agenda_final')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_data_agenda_final TEXT');
  if (!names.has('ixc_data_fechamento')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_data_fechamento TEXT');
  if (!names.has('sync_updated_at')) adds.push('ALTER TABLE agendamentos ADD COLUMN sync_updated_at TIMESTAMP');
  if (!names.has('ixc_raw_json')) adds.push('ALTER TABLE agendamentos ADD COLUMN ixc_raw_json TEXT');

  for (const sql of adds) {
    await dbRun(sql);
  }
}


async function ensureAuxTables() {
  await dbRun(`CREATE TABLE IF NOT EXISTS ixc_cities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ixc_id TEXT UNIQUE NOT NULL,
    name TEXT,
    raw_json TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS ixc_radusuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ixc_id TEXT UNIQUE NOT NULL,
    tipo_conexao_mapa TEXT,
    raw_json TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function ensureCityExistsLocal(cityName) {
  const cleaned = String(cityName || '').trim();
  if (!cleaned) return null;

  let city = await dbGet('SELECT id, name, is_active FROM cities WHERE lower(name) = lower(?) LIMIT 1', [cleaned]);
  if (!city) {
    const result = await dbRun('INSERT INTO cities (name, is_active) VALUES (?, 1)', [cleaned]);
    city = { id: result.lastID, name: cleaned, is_active: 1 };
  } else {
    // Respeita desativações manuais: o sync do IXC não deve religar cidades já inativadas localmente.
    await dbRun('UPDATE cities SET name = ? WHERE id = ?', [cleaned, city.id]);
    city.name = cleaned;
  }
  return city;
}

async function findCanonicalCityName(cleanedName) {
  const normalizedInput = normalizeCityKey(cleanedName);
  if (!normalizedInput) return null;

  const alias = MANUAL_CITY_ALIASES[normalizedInput];
  if (alias) return alias;

  const ixcCities = await dbAll('SELECT name FROM ixc_cities WHERE name IS NOT NULL AND TRIM(name) <> ""');
  const matchIxc = ixcCities.find((row) => normalizeCityKey(row.name) === normalizedInput);
  if (matchIxc?.name) return String(matchIxc.name).trim();

  const localCities = await dbAll('SELECT name FROM cities WHERE name IS NOT NULL AND TRIM(name) <> ""');
  const matchLocal = localCities.find((row) => normalizeCityKey(row.name) === normalizedInput);
  return matchLocal?.name ? String(matchLocal.name).trim() : null;
}

async function ensureVacancyTemplatesForSubject(subjectName, defaultCapacity = 1) {
  const cleaned = String(subjectName || '').trim();
  if (!cleaned) return;

  const subject = await dbGet('SELECT id, COALESCE(show_in_board,0) as show_in_board FROM subjects WHERE lower(name) = lower(?) LIMIT 1', [cleaned]);
  if (!subject?.id || Number(subject.show_in_board || 0) !== 1) return;

  const cities = await dbAll('SELECT id FROM cities WHERE is_active = 1');
  const osTypes = await dbAll('SELECT id FROM os_types WHERE is_active = 1');
  const periods = await dbAll('SELECT id FROM periods');

  for (const city of cities) {
    for (const osType of osTypes) {
      for (const period of periods) {
        await dbRun(
          `INSERT INTO vacancy_templates (city_id, os_type_id, period_id, subject_id, capacity)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(city_id, os_type_id, period_id, subject_id) DO NOTHING`,
          [city.id, osType.id, period.id, subject.id, defaultCapacity]
        );
      }
    }
  }
}

async function ensureVacancyTemplatesForCity(cityName, defaultCapacity = 1) {
  const city = await ensureCityExistsLocal(cityName);
  if (!city?.id) return;
  if (Number(city.is_active || 0) !== 1) return;

  const subjects = await dbAll('SELECT id FROM subjects WHERE is_active = 1 AND COALESCE(show_in_board,0) = 1');
  const osTypes = await dbAll('SELECT id FROM os_types WHERE is_active = 1');
  const periods = await dbAll('SELECT id FROM periods');

  for (const subject of subjects) {
    for (const osType of osTypes) {
      for (const period of periods) {
        await dbRun(
          `INSERT INTO vacancy_templates (city_id, os_type_id, period_id, subject_id, capacity)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(city_id, os_type_id, period_id, subject_id) DO NOTHING`,
          [city.id, osType.id, period.id, subject.id, defaultCapacity]
        );
      }
    }
  }
}

async function fetchCityCache(ixcCityId) {
  if (!ixcCityId) return null;
  return await dbGet('SELECT name FROM ixc_cities WHERE ixc_id = ?', [String(ixcCityId)]);
}

async function fetchAndCacheCity(ixcCityId) {
  if (!ixcCityId || !getIxcApi()) return null;

  const existing = await fetchCityCache(ixcCityId);
  if (existing?.name) {
    await ensureCityExistsLocal(existing.name);
    await ensureVacancyTemplatesForCity(existing.name);
    return existing;
  }

  const candidates = [
    { url: '/cidade', qtype: 'cidade.id' },
    { url: '/cidade', qtype: 'cidade.id_cidade' },
    { url: '/cidade_cliente', qtype: 'cidade_cliente.id' },
  ];

  for (const candidate of candidates) {
    try {
      const requestData = {
        qtype: candidate.qtype,
        query: String(ixcCityId),
        oper: '=',
        page: '1',
        rp: '1',
        sortname: candidate.qtype,
        sortorder: 'desc'
      };
      const response = await requestIxcList(candidate.url, requestData);
      const cidade = response?.registros?.[0] || response?.data?.registros?.[0];
      if (!cidade) continue;

      const name = String(cidade.nome || cidade.name || cidade.cidade || cidade.descricao || '').trim();
      if (!name) continue;

      await dbRun(
        `INSERT INTO ixc_cities (ixc_id, name, raw_json, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(ixc_id) DO UPDATE SET
           name = excluded.name,
           raw_json = excluded.raw_json,
           updated_at = CURRENT_TIMESTAMP`,
        [String(ixcCityId), name, JSON.stringify(cidade)]
      );
      await ensureCityExistsLocal(name);
      await ensureVacancyTemplatesForCity(name);
      return { name };
    } catch (error) {
      continue;
    }
  }

  return existing || null;
}

async function resolveCityName(rawValue) {
  const cleaned = String(rawValue || '').trim();
  if (!cleaned) return null;

  if (isNumericIdentifier(cleaned)) {
    return await fetchAndCacheCity(cleaned);
  }

  const canonicalName = await findCanonicalCityName(cleaned) || cleaned;
  const ensured = await ensureCityExistsLocal(canonicalName);
  const resolvedName = String(ensured?.name || canonicalName).trim();
  await ensureVacancyTemplatesForCity(resolvedName);
  return { name: resolvedName };
}

async function fetchRadusuarioCache(ixcLoginId) {
  if (!ixcLoginId) return null;
  return await dbGet(
    'SELECT tipo_conexao_mapa, raw_json FROM ixc_radusuarios WHERE ixc_id = ?',
    [String(ixcLoginId)]
  );
}

async function fetchAndCacheRadusuario(ixcLoginId) {
  if (!ixcLoginId || !getIxcApi()) return null;

  const existing = await fetchRadusuarioCache(ixcLoginId);
  if (String(existing?.tipo_conexao_mapa || '').trim()) {
    return existing;
  }

  try {
    const requestData = {
      qtype: 'radusuarios.id',
      query: String(ixcLoginId),
      oper: '=',
      page: '1',
      rp: '1',
      sortname: 'radusuarios.id',
      sortorder: 'desc'
    };

    const response = await requestIxcList('/radusuarios', requestData);
    const radusuario = response?.registros?.[0] || response?.data?.registros?.[0];
    if (!radusuario) return existing || null;

    const tipoConexaoMapa = String(radusuario?.tipo_conexao_mapa || '').trim().toUpperCase();

    await dbRun(
      `INSERT INTO ixc_radusuarios (ixc_id, tipo_conexao_mapa, raw_json, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(ixc_id) DO UPDATE SET
         tipo_conexao_mapa = excluded.tipo_conexao_mapa,
         raw_json = excluded.raw_json,
         updated_at = CURRENT_TIMESTAMP`,
      [String(ixcLoginId), tipoConexaoMapa || null, JSON.stringify(radusuario)]
    );

    return { tipo_conexao_mapa: tipoConexaoMapa, raw_json: JSON.stringify(radusuario) };
  } catch (error) {
    console.error('[IXC_SYNC] Falha ao buscar radusuario no IXC:', error?.response?.data || error.message);
    return existing || null;
  }
}

async function repairNumericCityReferences() {
  const rows = await dbAll(`
    SELECT DISTINCT cidade as raw_city
    FROM (
      SELECT cidade FROM ixc_clients WHERE cidade IS NOT NULL AND TRIM(cidade) <> '' AND TRIM(cidade) GLOB '[0-9]*'
      UNION
      SELECT cidade FROM agendamentos WHERE origem = 'ixc' AND cidade IS NOT NULL AND TRIM(cidade) <> '' AND TRIM(cidade) GLOB '[0-9]*'
    )
  `);

  for (const row of rows) {
    const rawCity = String(row?.raw_city || '').trim();
    if (!rawCity) continue;

    const resolved = await fetchAndCacheCity(rawCity);
    const cityName = String(resolved?.name || '').trim();
    if (!cityName) continue;

    await dbRun('UPDATE ixc_clients SET cidade = ?, updated_at = CURRENT_TIMESTAMP WHERE cidade = ?', [cityName, rawCity]);
    await dbRun(
      `UPDATE agendamentos
         SET cidade = ?, updated_at = CURRENT_TIMESTAMP
       WHERE origem = 'ixc' AND cidade = ?`,
      [cityName, rawCity]
    );
  }
}

async function harmonizeExistingCityNames() {
  const cityRows = await dbAll('SELECT id, name FROM cities');
  for (const row of cityRows) {
    const currentName = String(row?.name || '').trim();
    if (!currentName) continue;
    const resolved = await resolveCityName(currentName);
    const canonicalName = String(resolved?.name || '').trim();
    if (!canonicalName || canonicalName === currentName) continue;

    const targetCity = await ensureCityExistsLocal(canonicalName);
    if (targetCity?.id && targetCity.id !== row.id) {
      const templates = await dbAll(
        `SELECT os_type_id, period_id, subject_id, capacity
         FROM vacancy_templates
         WHERE city_id = ?`,
        [row.id]
      );

      for (const tpl of templates) {
        await dbRun(
          `INSERT INTO vacancy_templates (city_id, os_type_id, period_id, subject_id, capacity, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(city_id, os_type_id, period_id, subject_id)
           DO UPDATE SET capacity = MAX(vacancy_templates.capacity, excluded.capacity), updated_at = CURRENT_TIMESTAMP`,
          [targetCity.id, tpl.os_type_id, tpl.period_id, tpl.subject_id, tpl.capacity]
        );
      }

      await dbRun('DELETE FROM vacancy_templates WHERE city_id = ?', [row.id]);
      await dbRun('UPDATE cities SET is_active = 0 WHERE id = ?', [row.id]);
    }

    await dbRun('UPDATE agendamentos SET cidade = ?, updated_at = CURRENT_TIMESTAMP WHERE cidade = ?', [canonicalName, currentName]);
    await dbRun('UPDATE ixc_clients SET cidade = ?, updated_at = CURRENT_TIMESTAMP WHERE cidade = ?', [canonicalName, currentName]);
  }

  const localCities = await dbAll('SELECT id, name FROM cities');
  const ixcNames = new Set(
    (await dbAll('SELECT name FROM ixc_cities WHERE name IS NOT NULL AND TRIM(name) <> ""'))
      .map((row) => normalizeCityKey(row.name))
  );

  for (const city of localCities) {
    const normalized = normalizeCityKey(city.name);
    const keepByAlias = Object.prototype.hasOwnProperty.call(MANUAL_CITY_ALIASES, normalized);
    const shouldStayActive = ixcNames.has(normalized) || keepByAlias;
    if (!shouldStayActive) {
      await dbRun('UPDATE cities SET is_active = 0 WHERE id = ?', [city.id]);
    }
  }
}
async function syncIxcServicosOs({ triggeredBy = 'system', mode = 'full' } = {}) {
  if (currentSyncPromise) return currentSyncPromise;

  currentSyncPromise = (async () => {
  await ensureSyncColumns();
  await ensureAuxTables();
  await repairNumericCityReferences();
  await harmonizeExistingCityNames();

  const remoteOsList = await fetchRecentServicosOs(mode === 'light' ? 1 : MAX_PAGES);
  if (mode === 'full') {
    const pendingRows = await dbAll(`
      SELECT DISTINCT ixc_os_id
      FROM agendamentos
      WHERE origem = 'ixc'
        AND ixc_os_id IS NOT NULL
        AND TRIM(ixc_os_id) <> ''
        AND COALESCE(ixc_status, '') NOT IN ('F', 'C', 'CAN')
    `);

    const remoteById = new Map(
      remoteOsList
        .map((os) => [String(os?.id || '').trim(), os])
        .filter(([id]) => id)
    );

    for (const row of pendingRows) {
      const osId = String(row?.ixc_os_id || '').trim();
      if (!osId || remoteById.has(osId)) continue;
      try {
        const os = await fetchServicoOsById(osId);
        if (os?.id) remoteById.set(String(os.id).trim(), os);
      } catch (error) {
        console.error('[IXC_SYNC] Falha ao buscar OS pendente por ID:', osId, error?.response?.data || error.message);
      }
    }

    remoteOsList.length = 0;
    remoteOsList.push(...remoteById.values());
  }

  const summary = {
    setor: IXC_SERVICOS_SETOR_ID,
    triggeredBy,
    fetched: remoteOsList.length,
    ignored: 0,
    removedIgnored: 0,
    cutoffDate: DATA_ABERTURA_CORTE,
    created: 0,
    updated: 0,
    finalized: 0,
    unchanged: 0,
    errors: 0,
    resolvedSubjects: 0,
    syncedAt: new Date().toISOString(),
  };

  const clientCache = new Map();
  const subjectCache = new Map();
  const cityCache = new Map();
  const radusuarioCache = new Map();

  for (const os of remoteOsList) {
    try {
      const ixcOsId = String(os?.id || '').trim();
      if (!ixcOsId) continue;

      const assuntoId = String(os?.id_assunto || '').trim();
      if (ASSUNTOS_IGNORAR.has(assuntoId)) {
        const deleted = await dbRun(
          "DELETE FROM agendamentos WHERE origem = 'ixc' AND (ixc_os_id = ? OR ixc_assunto_id = ?)",
          [ixcOsId, assuntoId]
        );
        summary.ignored += 1;
        summary.removedIgnored += deleted?.changes || 0;
        continue;
      }

      const dataAbertura = String(os?.data_abertura || '').trim();
      if (!isAfterCutoff(dataAbertura)) {
        const deleted = await dbRun(
          "DELETE FROM agendamentos WHERE origem = 'ixc' AND ixc_os_id = ?",
          [ixcOsId]
        );
        summary.ignored += 1;
        summary.removedIgnored += deleted?.changes || 0;
        continue;
      }

      const existing = await dbGet('SELECT * FROM agendamentos WHERE ixc_os_id = ? LIMIT 1', [ixcOsId]);

      let cachedClient = null;
      const ixcClientId = String(os?.id_cliente || '').trim();
      if (ixcClientId) {
        if (clientCache.has(ixcClientId)) cachedClient = clientCache.get(ixcClientId);
        else {
          cachedClient = await fetchAndCacheClient(ixcClientId);
          clientCache.set(ixcClientId, cachedClient);
        }
      }

      let cachedSubject = null;
      const ixcSubjectId = String(os?.id_assunto || '').trim();
      const workflowParamId = String(os?.id_wfl_param_os || '').trim();
      if (ixcSubjectId) {
        const subjectKey = `${ixcSubjectId}|${workflowParamId}`;
        if (subjectCache.has(subjectKey)) cachedSubject = subjectCache.get(subjectKey);
        else {
          cachedSubject = await fetchAndCacheSubject(ixcSubjectId, workflowParamId);
          subjectCache.set(subjectKey, cachedSubject);
        }
        if (cachedSubject?.name) summary.resolvedSubjects += 1;
      }

      const subjectNameForIgnore = String(
        cachedSubject?.name || mapIxcSubject(os, cachedSubject)
      ).trim();
      const normalizedSubjectName = normalizeSubjectKey(subjectNameForIgnore);
      if (ASSUNTOS_IGNORAR_NOMES.has(normalizedSubjectName)) {
        const deleted = await dbRun(
          "DELETE FROM agendamentos WHERE origem = 'ixc' AND (ixc_os_id = ? OR lower(trim(assunto)) = lower(trim(?)))",
          [ixcOsId, subjectNameForIgnore]
        );
        summary.ignored += 1;
        summary.removedIgnored += deleted?.changes || 0;
        continue;
      }

      let cachedCity = null;
      const ixcCityId = String(os?.id_cidade || '').trim();
      if (ixcCityId) {
        if (cityCache.has(ixcCityId)) cachedCity = cityCache.get(ixcCityId);
        else {
          cachedCity = await fetchAndCacheCity(ixcCityId);
          cityCache.set(ixcCityId, cachedCity);
        }
      }

      let cachedRadusuario = null;
      const ixcLoginId = getRadusuarioLookupId(os);
      if (ixcLoginId) {
        if (radusuarioCache.has(ixcLoginId)) cachedRadusuario = radusuarioCache.get(ixcLoginId);
        else {
          cachedRadusuario = await fetchAndCacheRadusuario(ixcLoginId);
          radusuarioCache.set(ixcLoginId, cachedRadusuario);
        }
      }

      const remoteStatus = normalizeStatus(os?.status);
      const isFinalizada = remoteStatus === 'F' || Boolean(os?.data_fechamento);
      const assunto = String(
        existing?.periodo
          ? (existing?.assunto || cachedSubject?.name || mapIxcSubject(os, cachedSubject))
          : (cachedSubject?.name || existing?.assunto || mapIxcSubject(os, cachedSubject))
      ).trim();
      const clientCityInfo = await resolveCityName(cachedClient?.cidade);
      const existingCityInfo = await resolveCityName(existing?.cidade);
      const cidade = String(
        cachedCity?.name ||
        clientCityInfo?.name ||
        existingCityInfo?.name ||
        'Patos de Minas'
      ).trim();
      const cliente = String(cachedClient?.razao || existing?.cliente || buildClienteLabel(os, cachedClient)).trim();
      const observacoes = buildObservacoes(os, cachedClient);
      const tipoOs = mapTipoOsFromConexaoMapa(cachedRadusuario?.tipo_conexao_mapa, existing?.tipo_os || 'FIBRA');
      const tipoInstalacao = isPredialSubject(assunto) ? 'PREDIAL' : (existing?.tipo_instalacao || 'RESIDENCIAL');
      const vagasOcupadas = tipoInstalacao === 'PREDIAL' ? 2 : 1;
      const statusLocal = isFinalizada
        ? 'Concluída'
        : (existing?.status === 'Agendada' || existing?.status === 'Em andamento' ? existing.status : 'Aberta');

      if (!existing && isFinalizada) {
        summary.unchanged += 1;
        continue;
      }

      if (!existing) {
        await dbRun(
          `INSERT INTO agendamentos (
             cliente, cidade, assunto, data_hora, tecnico, status, observacoes, tipo_os,
             periodo, alocado_por, alocado_em, tipo_instalacao, vagas_ocupadas,
             origem, ixc_os_id, ixc_status, ixc_setor_id, ixc_assunto_id, ixc_tecnico_id,
             ixc_cliente_id, ixc_login_id, ixc_data_abertura, ixc_data_agenda, ixc_data_agenda_final,
             ixc_data_fechamento, sync_updated_at, ixc_raw_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
          [
            cliente,
            cidade,
            assunto,
            os?.data_agenda || null,
            existing?.tecnico || null,
            statusLocal,
            observacoes,
            tipoOs,
            null,
            null,
            null,
            tipoInstalacao,
            vagasOcupadas,
            'ixc',
            ixcOsId,
            remoteStatus,
            String(os?.setor || ''),
            String(os?.id_assunto || ''),
            String(os?.id_tecnico || ''),
            ixcClientId,
            ixcLoginId,
            dataAbertura || null,
            os?.data_agenda || null,
            os?.data_agenda_final || null,
            os?.data_fechamento || null,
            os?.ultima_atualizacao || new Date().toISOString(),
            JSON.stringify(os)
          ]
        );
        summary.created += 1;
        continue;
      }

      const relevantChanged = [
        existing.ixc_status !== remoteStatus,
        (existing.ixc_data_abertura || '') !== dataAbertura,
        (existing.ixc_data_agenda || '') !== (os?.data_agenda || ''),
        (existing.ixc_data_agenda_final || '') !== (os?.data_agenda_final || ''),
        (existing.ixc_data_fechamento || '') !== (os?.data_fechamento || ''),
        (existing.ixc_raw_json || '') !== JSON.stringify(os),
      ].some(Boolean);

      const updatedStatus = isFinalizada
        ? 'Concluída'
        : (existing.status === 'Concluída' ? 'Aberta' : (existing.status || 'Aberta'));

      await dbRun(
        `UPDATE agendamentos
           SET cliente = COALESCE(NULLIF(?, ''), cliente),
               cidade = COALESCE(NULLIF(?, ''), cidade),
               assunto = COALESCE(NULLIF(?, ''), assunto),
               observacoes = ?,
               status = ?,
               tipo_os = COALESCE(NULLIF(?, ''), tipo_os),
               tipo_instalacao = ?,
               vagas_ocupadas = ?,
               origem = 'ixc',
               ixc_status = ?,
               ixc_setor_id = ?,
               ixc_assunto_id = ?,
               ixc_tecnico_id = ?,
               ixc_cliente_id = ?,
               ixc_login_id = ?,
               ixc_data_abertura = ?,
               ixc_data_agenda = ?,
               ixc_data_agenda_final = ?,
               ixc_data_fechamento = ?,
               sync_updated_at = ?,
               ixc_raw_json = ?,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          cliente,
          cidade,
          assunto,
          observacoes,
          updatedStatus,
          tipoOs,
          tipoInstalacao,
          vagasOcupadas,
          remoteStatus,
          String(os?.setor || ''),
          String(os?.id_assunto || ''),
          String(os?.id_tecnico || ''),
          ixcClientId,
          ixcLoginId,
          dataAbertura || null,
          os?.data_agenda || null,
          os?.data_agenda_final || null,
          os?.data_fechamento || null,
          os?.ultima_atualizacao || null,
          JSON.stringify(os),
          existing.id
        ]
      );

      if (isFinalizada && existing.status !== 'Concluída') summary.finalized += 1;
      else if (relevantChanged) summary.updated += 1;
      else summary.unchanged += 1;
    } catch (error) {
      summary.errors += 1;
      console.error('[IXC_SYNC] Erro ao sincronizar OS:', error?.response?.data || error.message);
    }
  }

  await dbRun(
    `INSERT INTO config (key, value, updated_at)
     VALUES ('ixc_last_sync_summary', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`,
    [JSON.stringify(summary)]
  );

  return summary;
  })();

  try {
    return await currentSyncPromise;
  } finally {
    currentSyncPromise = null;
  }
}

async function getLastSyncSummary() {
  const row = await dbGet("SELECT value, updated_at FROM config WHERE key = 'ixc_last_sync_summary' LIMIT 1");
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    parsed.updated_at = row.updated_at;
    return parsed;
  } catch {
    return { raw: row.value, updated_at: row.updated_at };
  }
}

async function fetchClientCache(ixcClientId) {
  if (!ixcClientId) return null;
  return await dbGet('SELECT razao, cidade, raw_json FROM ixc_clients WHERE ixc_id = ?', [String(ixcClientId)]);
}

function buildObservacoes(os, cachedClient) {
  let clientRaw = null;
  try {
    clientRaw = cachedClient?.raw_json ? JSON.parse(cachedClient.raw_json) : null;
  } catch {
    clientRaw = null;
  }

  const endereco = [
    clientRaw?.endereco || os?.endereco || '',
    clientRaw?.numero || '',
    clientRaw?.complemento || os?.complemento || '',
    clientRaw?.bairro || '',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');

  const telefone = String(
    clientRaw?.fone ||
    clientRaw?.telefone_comercial ||
    clientRaw?.celular ||
    clientRaw?.whatsapp ||
    os?.telefone ||
    ''
  ).trim();

  const partes = [];
  if (endereco) partes.push(`Endereco: ${endereco}`);
  if (telefone) partes.push(`Telefone: ${telefone}`);
  return partes.join(' | ');
}

module.exports = {
  IXC_SERVICOS_SETOR_ID,
  syncIxcServicosOs,
  getLastSyncSummary,
  ensureSyncColumns,
  fetchAndCacheCity,
  resolveCityName,
  harmonizeExistingCityNames,
};
