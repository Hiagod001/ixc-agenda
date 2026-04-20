const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const BASE_URL = (process.env.SMOKE_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
const USERNAME = process.env.SMOKE_USERNAME || "";
const PASSWORD = process.env.SMOKE_PASSWORD || "";
const DB_PATH = process.env.SMOKE_DB_PATH || path.join(process.cwd(), "agenda.db");
const TEST_PREFIX = `SMOKE_${Date.now()}`;

const cookieJar = new Map();
function log(message) {
  console.log(`[smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function rememberCookies(headers) {
  const setCookie = headers.getSetCookie ? headers.getSetCookie() : headers.raw?.()["set-cookie"] || [];
  for (const entry of setCookie) {
    const [cookie] = String(entry).split(";");
    const [name, value] = cookie.split("=");
    if (name && value) cookieJar.set(name.trim(), value.trim());
  }
}

function getCookieHeader() {
  return Array.from(cookieJar.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function request(method, targetPath, { expectedStatus, body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  const cookieHeader = getCookieHeader();
  if (cookieHeader) finalHeaders.Cookie = cookieHeader;

  let requestBody;
  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${targetPath}`, {
    method,
    headers: finalHeaders,
    body: requestBody,
  });

  rememberCookies(response.headers);

  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  let parsed = raw;

  if (contentType.includes("application/json")) {
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = raw;
    }
  }

  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    fail(`${method} ${targetPath} retornou ${response.status} em vez de ${expectedStatus}. Resposta: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }

  return { response, data: parsed, raw };
}

async function ensure(condition, message) {
  if (!condition) fail(message);
}

async function findByName(targetPath, name) {
  const { data } = await request("GET", targetPath, { expectedStatus: 200 });
  return (Array.isArray(data) ? data : []).find((item) => item && item.name === name) || null;
}

async function cleanup() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.serialize(() => {
      const statements = [
        ["DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM users WHERE username LIKE ?)", [`${TEST_PREFIX}%`]],
        ["DELETE FROM users WHERE username LIKE ?", [`${TEST_PREFIX}%`]],
        ["DELETE FROM technicians WHERE name LIKE ?", [`${TEST_PREFIX}%`]],
        ["DELETE FROM cities WHERE name LIKE ?", [`${TEST_PREFIX}%`]],
        ["DELETE FROM subjects WHERE name LIKE ?", [`${TEST_PREFIX}%`]],
        ["DELETE FROM agendamentos WHERE cliente LIKE ?", [`${TEST_PREFIX}%`]],
      ];

      let index = 0;
      const next = () => {
        if (index >= statements.length) {
          db.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
          return;
        }

        const [sql, params] = statements[index++];
        db.run(sql, params, (err) => {
          if (err) {
            db.close(() => reject(err));
            return;
          }
          next();
        });
      };

      next();
    });
  });
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    fail("Defina SMOKE_USERNAME e SMOKE_PASSWORD para executar o smoke test.");
  }

  log(`base URL: ${BASE_URL}`);

  const publicPages = [
    "/login.html",
    "/index.html",
    "/agenda-dashboard.html",
    "/novo-agendamento.html",
    "/gerenciar-tecnicos.html",
    "/gerenciar-cidades.html",
    "/gerenciar-usuarios.html",
    "/config-ixc.html",
  ];

  for (const page of publicPages) {
    const { response, raw } = await request("GET", page, { expectedStatus: 200 });
    await ensure(raw.includes("<!DOCTYPE html>") || raw.includes("<html"), `Página ${page} não retornou HTML válido.`);
    log(`página OK: ${page} (${response.status})`);
  }

  await request("GET", "/api/user", { expectedStatus: 401 });
  log("bloqueio sem sessão OK");

  await request("POST", "/login", {
    expectedStatus: 200,
    body: { username: USERNAME, password: PASSWORD },
  });
  log("login OK");

  const { data: currentUser } = await request("GET", "/api/user", { expectedStatus: 200 });
  await ensure(Array.isArray(currentUser.permissions) && currentUser.permissions.length > 0, "Sessão sem permissões efetivas.");

  const apiChecks = [
    "/api/config",
    "/api/agendamentos",
    "/api/reports/summary",
    "/api/reports/export",
    "/api/audit/meta",
    "/api/audit?page=1&limit=5",
    "/api/technicians",
    "/api/cities",
    "/api/subjects?active=0",
    "/api/config/ixc",
  ];

  for (const targetPath of apiChecks) {
    const { response } = await request("GET", targetPath, { expectedStatus: 200 });
    log(`API OK: ${targetPath} (${response.status})`);
  }

  const { data: config } = await request("GET", "/api/config", { expectedStatus: 200 });
  const city = config?.cidades?.[0];
  const subject = config?.assuntos?.[0];
  const osType = config?.tiposOS?.[0];
  const technician = config?.tecnicos?.[0];

  await ensure(city && subject && osType && technician, "Configuração insuficiente para validar os fluxos principais.");

  await request("GET", `/api/vagas/${encodeURIComponent(city)}/${new Date().toISOString().slice(0, 10)}`, { expectedStatus: 200 });
  await request("GET", `/api/vagas-detalhadas/${encodeURIComponent(city)}/${encodeURIComponent(osType)}/${new Date().toISOString().slice(0, 10)}`, { expectedStatus: 200 });
  log("consultas de vagas OK");

  const tempUser = `${TEST_PREFIX}_user`;
  const tempTech = `${TEST_PREFIX}_tech`;
  const tempCity = `${TEST_PREFIX}_city`;
  const tempSubject = `${TEST_PREFIX}_subject`;
  const tempClient = `${TEST_PREFIX}_cliente`;

  const { data: userCreate } = await request("POST", "/api/users", {
    expectedStatus: 200,
    body: { username: tempUser, password: "123456", role: "suporte" },
  });
  const createdUserId = userCreate?.user?.id;
  await ensure(createdUserId, "Usuário temporário não foi criado.");
  await request("PUT", `/api/users/${createdUserId}`, {
    expectedStatus: 200,
    body: { username: tempUser, role: "agendamento", is_active: 1 },
  });
  await request("DELETE", `/api/users/${createdUserId}`, { expectedStatus: 200 });
  log("CRUD de usuários OK");

  await request("POST", "/api/technicians", {
    expectedStatus: 200,
    body: { name: tempTech },
  });
  const createdTech = await findByName("/api/technicians", tempTech);
  await ensure(createdTech?.id, "Técnico temporário não encontrado após criação.");
  await request("POST", `/api/technicians/${createdTech.id}/toggle`, { expectedStatus: 200 });
  await request("POST", `/api/technicians/${createdTech.id}/toggle`, { expectedStatus: 200 });
  log("fluxo de técnicos OK");

  await request("POST", "/api/cities", {
    expectedStatus: 200,
    body: { name: tempCity },
  });
  const createdCity = await findByName("/api/cities", tempCity);
  await ensure(createdCity?.id, "Cidade temporária não encontrada após criação.");
  await request("POST", `/api/cities/${createdCity.id}/toggle`, { expectedStatus: 200 });
  await request("POST", `/api/cities/${createdCity.id}/toggle`, { expectedStatus: 200 });
  log("fluxo de cidades OK");

  await request("POST", "/api/subjects", {
    expectedStatus: 201,
    body: { name: tempSubject, show_in_board: 1 },
  });
  const createdSubject = await findByName("/api/subjects?active=0", tempSubject);
  await ensure(createdSubject?.id, "Assunto temporário não encontrado após criação.");
  await request("POST", `/api/subjects/${createdSubject.id}/board-column`, {
    expectedStatus: 200,
    body: { show_in_board: 0 },
  });
  await request("PUT", `/api/subjects/${createdSubject.id}`, {
    expectedStatus: 200,
    body: { name: `${tempSubject}_renamed`, show_in_board: 0 },
  });
  await request("POST", `/api/subjects/${createdSubject.id}/toggle`, {
    expectedStatus: 200,
    body: { is_active: 0 },
  });
  log("fluxo de assuntos OK");

  const { data: createdAgendamento } = await request("POST", "/api/agendamentos", {
    expectedStatus: 201,
    body: {
      cliente: tempClient,
      cidade: city,
      assunto: subject,
      tipo_os: osType,
      observacao: "Criado automaticamente pelo smoke test",
    },
  });
  const createdAgendamentoId = createdAgendamento?.id;
  await ensure(createdAgendamentoId, "Agendamento temporário não foi criado.");
  await request("PUT", `/api/agendamentos/${createdAgendamentoId}`, {
    expectedStatus: 200,
    body: {
      observacoes: "Atualizado automaticamente pelo smoke test",
      tecnico: technician,
      status: "Aberta",
    },
  });
  await request("DELETE", `/api/agendamentos/${createdAgendamentoId}`, { expectedStatus: 200 });
  log("CRUD de agendamentos OK");

  log("smoke test concluído com sucesso");
}

main()
  .catch(async (error) => {
    console.error(`[smoke] falha: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
      log("limpeza final OK");
    } catch (cleanupError) {
      console.error(`[smoke] erro na limpeza: ${cleanupError.message}`);
      process.exitCode = 1;
    }
  });
