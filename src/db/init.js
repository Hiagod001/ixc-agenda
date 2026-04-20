const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { ixcConfig, initializeIxcApi } = require("../services/ixc");
const { cidades, tecnicos, statusPossiveis, assuntos, tiposOS, ESTRUTURA_VAGAS } = require("../config/constants");

/**
 * Inicializa o banco de dados e cria/atualiza o schema.
 * Regras:
 * - Tudo que é "config" (cidades, técnicos, assuntos, estrutura de vagas, etc) mora no banco.
 * - O arquivo constants.js vira APENAS fonte de seed/default (para iniciar o sistema do zero).
 * - Não depende de localStorage no front (tema, vagas fechadas, etc).
 */
function initializeDatabase(db) {
  return new Promise((resolve, reject) => {
    const run = (sql, params = []) =>
      new Promise((res, rej) => db.run(sql, params, (err) => (err ? rej(err) : res())));
    const get = (sql, params = []) =>
      new Promise((res, rej) => db.get(sql, params, (err, row) => (err ? rej(err) : res(row))));
    const all = (sql, params = []) =>
      new Promise((res, rej) => db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows))));

    async function ensureColumn(table, column, ddl) {
      const cols = await all(`PRAGMA table_info(${table})`);
      const exists = cols.some((c) => c.name === column);
      if (!exists) {
        await run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        console.log(`[DB] Coluna adicionada: ${table}.${column}`);
      }
    }

    async function seedIfEmpty(table, seedFn) {
      const row = await get(`SELECT COUNT(*) as c FROM ${table}`);
      if ((row?.c || 0) === 0) await seedFn();
    }

    (async () => {
      try {
        // =======================
        // CORE (users, auth)
        // =======================
        await run(`CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT DEFAULT 'user',
          is_active INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await run(`CREATE TABLE IF NOT EXISTS user_permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          permission TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
          UNIQUE(user_id, permission)
        )`);

        await run(`CREATE TABLE IF NOT EXISTS role_permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          permission TEXT NOT NULL,
          UNIQUE(role, permission)
        )`);

        await run(`CREATE TABLE IF NOT EXISTS user_preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
          UNIQUE(user_id, key)
        )`);

        // =======================
        // AUDIT / CONFIG
        // =======================
        await run(`CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user TEXT NOT NULL,
          action TEXT NOT NULL,
          details TEXT,
          ip_address TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Auditoria completa (antes/depois)
        await run(`CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          username TEXT,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          old_value TEXT,
          new_value TEXT,
          ip_address TEXT,
          user_agent TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        await run(`CREATE TABLE IF NOT EXISTS config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT UNIQUE NOT NULL,
          value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // =======================
        // CADASTROS (tudo no banco)
        // =======================
        await run(`CREATE TABLE IF NOT EXISTS cities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          is_active INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await run(`CREATE TABLE IF NOT EXISTS technicians (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          is_active INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await run(`CREATE TABLE IF NOT EXISTS subjects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          is_active INTEGER DEFAULT 1,
          show_in_board INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await run(`CREATE TABLE IF NOT EXISTS os_types (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL, -- ex: FIBRA, RADIO
          is_active INTEGER DEFAULT 1
        )`);

        await run(`CREATE TABLE IF NOT EXISTS periods (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL -- ex: MANHÃ, TARDE
        )`);

        // Template de capacidade (por cidade/tipo/período/assunto)
        await run(`CREATE TABLE IF NOT EXISTS vacancy_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          city_id INTEGER NOT NULL,
          os_type_id INTEGER NOT NULL,
          period_id INTEGER NOT NULL,
          subject_id INTEGER NOT NULL,
          capacity INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(city_id, os_type_id, period_id, subject_id),
          FOREIGN KEY(city_id) REFERENCES cities (id),
          FOREIGN KEY(os_type_id) REFERENCES os_types (id),
          FOREIGN KEY(period_id) REFERENCES periods (id),
          FOREIGN KEY(subject_id) REFERENCES subjects (id)
        )`);

        // Fechamento de VAGA individual (slot index) por dia
        await run(`CREATE TABLE IF NOT EXISTS vacancy_closed_slots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          city_id INTEGER NOT NULL,
          os_type_id INTEGER NOT NULL,
          period_id INTEGER NOT NULL,
          subject_id INTEGER NOT NULL,
          day TEXT NOT NULL, -- YYYY-MM-DD
          slot_index INTEGER NOT NULL,
          closed_by_user_id INTEGER,
          closed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(city_id, os_type_id, period_id, subject_id, day, slot_index),
          FOREIGN KEY(city_id) REFERENCES cities (id),
          FOREIGN KEY(os_type_id) REFERENCES os_types (id),
          FOREIGN KEY(period_id) REFERENCES periods (id),
          FOREIGN KEY(subject_id) REFERENCES subjects (id),
          FOREIGN KEY(closed_by_user_id) REFERENCES users (id)
        )`);

        await run(`CREATE TABLE IF NOT EXISTS vacancy_capacity_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          city_id INTEGER NOT NULL,
          os_type_id INTEGER NOT NULL,
          period_id INTEGER NOT NULL,
          subject_id INTEGER NOT NULL,
          day TEXT NOT NULL,
          capacity INTEGER NOT NULL DEFAULT 0,
          updated_by_user_id INTEGER,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(city_id, os_type_id, period_id, subject_id, day),
          FOREIGN KEY(city_id) REFERENCES cities (id),
          FOREIGN KEY(os_type_id) REFERENCES os_types (id),
          FOREIGN KEY(period_id) REFERENCES periods (id),
          FOREIGN KEY(subject_id) REFERENCES subjects (id),
          FOREIGN KEY(updated_by_user_id) REFERENCES users (id)
        )`);

        // =======================
        // IXC (cache local, multiusuário)
        // =======================
        await run(`CREATE TABLE IF NOT EXISTS ixc_clients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ixc_id TEXT UNIQUE NOT NULL,
          razao TEXT,
          cidade TEXT,
          raw_json TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await run(`CREATE TABLE IF NOT EXISTS ixc_subjects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ixc_id TEXT UNIQUE NOT NULL,
          name TEXT,
          raw_json TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // =======================
        // AGENDAMENTOS
        // =======================
        await run(`CREATE TABLE IF NOT EXISTS agendamentos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cliente TEXT NOT NULL,
          cidade TEXT NOT NULL,
          assunto TEXT NOT NULL,
          data_hora TIMESTAMP,
          tecnico TEXT,
          status TEXT DEFAULT 'Aberta',
          observacoes TEXT,
          tipo_os TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // migrações suaves (se o banco já existia)
        await ensureColumn('agendamentos', 'tipo_os', 'tipo_os TEXT');
        // Período (MANHÃ/TARDE) para não depender de hora/UTC
        await ensureColumn('agendamentos', 'periodo', 'periodo TEXT');
        // Quem alocou o agendamento na vaga (controle interno)
        await ensureColumn('agendamentos', 'alocado_por', 'alocado_por TEXT');
        await ensureColumn('agendamentos', 'alocado_em', 'alocado_em TIMESTAMP');
        await ensureColumn('agendamentos', 'tipo_instalacao', "tipo_instalacao TEXT DEFAULT 'RESIDENCIAL'");
        await ensureColumn('agendamentos', 'vagas_ocupadas', 'vagas_ocupadas INTEGER DEFAULT 1');

        await ensureColumn('agendamentos', 'origem', "origem TEXT DEFAULT 'manual'");
        await ensureColumn('agendamentos', 'ixc_os_id', 'ixc_os_id TEXT');
        await ensureColumn('agendamentos', 'ixc_status', 'ixc_status TEXT');
        await ensureColumn('agendamentos', 'ixc_setor_id', 'ixc_setor_id TEXT');
        await ensureColumn('agendamentos', 'ixc_assunto_id', 'ixc_assunto_id TEXT');
        await ensureColumn('agendamentos', 'ixc_tecnico_id', 'ixc_tecnico_id TEXT');
        await ensureColumn('agendamentos', 'ixc_cliente_id', 'ixc_cliente_id TEXT');
        await ensureColumn('agendamentos', 'ixc_login_id', 'ixc_login_id TEXT');
        await ensureColumn('agendamentos', 'ixc_data_agenda', 'ixc_data_agenda TEXT');
        await ensureColumn('agendamentos', 'ixc_data_agenda_final', 'ixc_data_agenda_final TEXT');
        await ensureColumn('agendamentos', 'ixc_data_fechamento', 'ixc_data_fechamento TEXT');
        await ensureColumn('agendamentos', 'sync_updated_at', 'sync_updated_at TIMESTAMP');
        await ensureColumn('agendamentos', 'ixc_raw_json', 'ixc_raw_json TEXT');
        await ensureColumn('users', 'is_active', 'is_active INTEGER DEFAULT 1');

        await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agendamentos_ixc_os_id
          ON agendamentos(ixc_os_id)
          WHERE ixc_os_id IS NOT NULL AND TRIM(ixc_os_id) <> ''`);

        await run(`CREATE INDEX IF NOT EXISTS idx_agendamentos_board_lookup
          ON agendamentos(cidade, tipo_os, periodo, assunto, data_hora)`);

        await run(`CREATE INDEX IF NOT EXISTS idx_agendamentos_pending_lookup
          ON agendamentos(periodo, status, origem, tipo_os)`);

        await run(`CREATE INDEX IF NOT EXISTS idx_agendamentos_data_hora
          ON agendamentos(data_hora)`);

        await run(`CREATE INDEX IF NOT EXISTS idx_agendamentos_cliente
          ON agendamentos(cliente)`);

        await run(`CREATE INDEX IF NOT EXISTS idx_agendamentos_ixc_login_id
          ON agendamentos(ixc_login_id)`);

        await run(`CREATE INDEX IF NOT EXISTS idx_agendamentos_ixc_cliente_id
          ON agendamentos(ixc_cliente_id)`);

        await run(`CREATE INDEX IF NOT EXISTS idx_vacancy_closed_slots_lookup
          ON vacancy_closed_slots(city_id, os_type_id, period_id, subject_id, day, slot_index)`);

        await run(`CREATE INDEX IF NOT EXISTS idx_vacancy_capacity_overrides_lookup
          ON vacancy_capacity_overrides(city_id, os_type_id, period_id, subject_id, day)`);

        await run(`UPDATE agendamentos
          SET tipo_instalacao = CASE
            WHEN tipo_instalacao IS NULL OR TRIM(tipo_instalacao) = '' THEN 'RESIDENCIAL'
            ELSE UPPER(tipo_instalacao)
          END`);
        await run(`UPDATE agendamentos
          SET vagas_ocupadas = CASE
            WHEN vagas_ocupadas IS NULL OR vagas_ocupadas < 1 THEN 1
            ELSE vagas_ocupadas
          END`);

        // Alguns endpoints atualizam updated_at em subjects (banco antigo pode não ter)
        await ensureColumn('subjects', 'updated_at', 'updated_at TIMESTAMP');
        await ensureColumn('subjects', 'show_in_board', 'show_in_board INTEGER DEFAULT 0');

        // =======================
        // SEEDS (apenas se vazio)
        // =======================

        // Seed inicial apenas para ambiente novo, sem credenciais fixas no repositorio.
        await seedIfEmpty('users', async () => {
          const username = (process.env.INIT_ADMIN_USERNAME || 'admin').trim() || 'admin';
          const password = (process.env.INIT_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url')).trim();
          const hash = await bcrypt.hash(password, 10);
          await run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, hash, 'admin']);
          console.log(`[DB] Usuario administrador inicial criado (${username}).`);
          if (!process.env.INIT_ADMIN_PASSWORD) {
            console.log(`[DB] Senha temporaria gerada para o primeiro acesso: ${password}`);
          }
        });

        // Seed de roles -> permissions (base)
        await seedIfEmpty('role_permissions', async () => {
          const seed = async (role, perms) => {
            for (const p of perms) await run("INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?,?)", [role, p]);
          };

          // Permissões canônicas (use sempre esse padrão nos middlewares)
          const P = {
            AGENDA_VIEW: 'agenda.view',
            AGENDA_CREATE: 'agenda.create',
            AGENDA_EDIT: 'agenda.edit',
            AGENDA_DELETE: 'agenda.delete',
            AGENDA_ALLOCATE: 'agenda.allocate',
            VAGAS_VIEW: 'vagas.view',
            VAGAS_MANAGE: 'vagas.manage',
            CONFIG_VIEW: 'config.view',
            CONFIG_EDIT: 'config.edit',
            USERS_VIEW: 'users.view',
            USERS_MANAGE: 'users.manage',
            LOGS_VIEW: 'logs.view',
            REPORTS_VIEW: 'reports.view',
            REPORTS_EXPORT: 'reports.export',
            SUBJECTS_MANAGE: 'subjects.manage',
            TECHNICIANS_MANAGE: 'technicians.manage',
            CITIES_MANAGE: 'cities.manage',
            IXC_SYNC: 'ixc.sync',
          };

          await seed('admin', Object.values(P));
          await seed('supervisor', [
            P.AGENDA_VIEW,
            P.AGENDA_CREATE,
            P.AGENDA_EDIT,
            P.AGENDA_ALLOCATE,
            P.VAGAS_VIEW,
            P.VAGAS_MANAGE,
            P.CONFIG_VIEW,
            P.USERS_VIEW,
            P.LOGS_VIEW,
            P.REPORTS_VIEW,
            P.SUBJECTS_MANAGE,
            P.TECHNICIANS_MANAGE,
            P.CITIES_MANAGE,
            P.IXC_SYNC,
          ]);
          await seed('agendamento', [P.AGENDA_VIEW, P.AGENDA_CREATE, P.AGENDA_EDIT, P.AGENDA_ALLOCATE, P.VAGAS_VIEW, P.REPORTS_VIEW, P.IXC_SYNC]);
          await seed('suporte', [P.AGENDA_VIEW, P.AGENDA_EDIT, P.VAGAS_VIEW, P.CONFIG_VIEW]);
        });

        // Garante permissões novas mesmo em bancos antigos (seedIfEmpty não roda se já tiver dados)
        const ensureRolePerm = (role, perm) => new Promise((resolve, reject) => {
          db.run("INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?,?)", [role, perm], (err) => {
            if (err) return reject(err);
            resolve();
          });
        });

        try {
          // Relatórios
          await ensureRolePerm('admin', 'reports.view');
          await ensureRolePerm('admin', 'reports.export');
          await ensureRolePerm('supervisor', 'reports.view');
          await ensureRolePerm('agendamento', 'reports.view');

                    // Vagas
          await ensureRolePerm('admin', 'vagas.adjust');
          await ensureRolePerm('supervisor', 'vagas.adjust');

// Assuntos
          await ensureRolePerm('admin', 'subjects.manage');
          await ensureRolePerm('supervisor', 'subjects.manage');

          // Técnicos / Cidades
          await ensureRolePerm('admin', 'technicians.manage');
          await ensureRolePerm('admin', 'cities.manage');
          await ensureRolePerm('supervisor', 'technicians.manage');
          await ensureRolePerm('supervisor', 'cities.manage');
          await ensureRolePerm('admin', 'ixc.sync');
          await ensureRolePerm('supervisor', 'ixc.sync');
          await ensureRolePerm('agendamento', 'ixc.sync');
        } catch (e) {
          console.warn('[DB] Falha ao garantir permissões novas:', e?.message || e);
        }

        // Seed de cadastros base
        await seedIfEmpty('cities', async () => {
          for (const c of cidades) await run("INSERT OR IGNORE INTO cities (name) VALUES (?)", [c]);
        });

        await seedIfEmpty('technicians', async () => {
          for (const t of tecnicos) await run("INSERT OR IGNORE INTO technicians (name) VALUES (?)", [t]);
        });

        await seedIfEmpty('subjects', async () => {
          for (const a of assuntos) await run("INSERT OR IGNORE INTO subjects (name) VALUES (?)", [a]);
        });

        const assuntosPadraoVisiveis = ['SEM CONEXÃO', 'CONEXAO LENTA', 'CONEXÃO LENTA', 'AGENDAMENTO', 'INSTALAÇÃO', 'INSTALACAO', 'MANUTENÇÃO', 'MANUTENCAO'];
        const placeholdersAssuntos = assuntosPadraoVisiveis.map(() => '?').join(',');
        if (placeholdersAssuntos) {
          await run(`UPDATE subjects SET show_in_board = 1 WHERE upper(name) IN (${placeholdersAssuntos})`, assuntosPadraoVisiveis);
        }

        await seedIfEmpty('os_types', async () => {
          for (const t of tiposOS) await run("INSERT OR IGNORE INTO os_types (code) VALUES (?)", [t]);
        });

        await seedIfEmpty('periods', async () => {
          for (const p of ['MANHÃ', 'TARDE']) await run("INSERT OR IGNORE INTO periods (code) VALUES (?)", [p]);
        });

        // Seed do template de vagas (a partir do ESTRUTURA_VAGAS)
        await seedIfEmpty('vacancy_templates', async () => {
          const cityRows = await all("SELECT id, name FROM cities");
          const typeRows = await all("SELECT id, code FROM os_types");
          const periodRows = await all("SELECT id, code FROM periods");
          const subjRows = await all("SELECT id, name FROM subjects");

          const cityId = Object.fromEntries(cityRows.map(r => [r.name, r.id]));
          const typeId = Object.fromEntries(typeRows.map(r => [r.code, r.id]));
          const periodId = Object.fromEntries(periodRows.map(r => [r.code, r.id]));
          const subjId = Object.fromEntries(subjRows.map(r => [r.name, r.id]));

          for (const [cityName, byType] of Object.entries(ESTRUTURA_VAGAS || {})) {
            for (const [typeCode, byPeriod] of Object.entries(byType || {})) {
              for (const [periodCode, bySubject] of Object.entries(byPeriod || {})) {
                for (const [subjectName, cap] of Object.entries(bySubject || {})) {
                  const cid = cityId[cityName];
                  const tid = typeId[typeCode];
                  const pid = periodId[periodCode];
                  const sid = subjId[subjectName];
                  if (!cid || !tid || !pid || !sid) continue;
                  await run(
                    `INSERT OR IGNORE INTO vacancy_templates (city_id, os_type_id, period_id, subject_id, capacity)
                     VALUES (?,?,?,?,?)`,
                    [cid, tid, pid, sid, Number(cap || 0)]
                  );
                }
              }
            }
          }
          console.log('[DB] vacancy_templates seedado a partir do constants.js');
        });

        // IXC config: manter comportamento atual, mas persistir/usar DB
        // (se já existir no DB, o services/ixc pode ler depois; aqui só garante que não fique vazio)
        const urlRow = await get("SELECT * FROM config WHERE key='ixc_api_url'");
        if (!urlRow && ixcConfig.apiUrl) {
          await run("INSERT INTO config (key, value) VALUES (?, ?)", ['ixc_api_url', ixcConfig.apiUrl]);
        }
        const tokRow = await get("SELECT * FROM config WHERE key='ixc_api_token'");
        if (!tokRow && ixcConfig.apiToken) {
          await run("INSERT INTO config (key, value) VALUES (?, ?)", ['ixc_api_token', ixcConfig.apiToken]);
        }

        // Inicializa IXC em memória (pode ser sobrescrito lendo do DB na inicialização do app)
        initializeIxcApi();

        resolve();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

module.exports = { initializeDatabase };
