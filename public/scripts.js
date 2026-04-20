const STATUS_LABELS = {
  'Em andamento': 'Agendado no IXC',
};

function getStatusLabel(status){
  return STATUS_LABELS[status] || status || '';
}

// Variáveis globais
let currentUser = null;
let config = {};
let charts = {};
let agendamentos = []; // Mantido para os relatórios e dashboard

function hasPermission(permission) {
    return (currentUser?.permissions || []).includes(permission);
}

function applyPermissionVisibility(root = document) {
    root.querySelectorAll('.permission-only').forEach(el => {
        const permission = String(el.getAttribute('data-permission') || '').trim();
        const required = permission
            ? permission.split(',').map(item => item.trim()).filter(Boolean)
            : [];
        const allowed = !required.length || required.every(hasPermission);
        el.style.display = allowed ? '' : 'none';
    });
}

// Inicialização
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

// Inicializar aplicação
async function initializeApp() {
    try {
        await window.darkModeSystem?.loadThemePreference?.();

        // Tenta verificar a autenticação
        await checkAuth(); 
        
        // Se passou (não deu erro), carrega o resto
        await loadConfig();
        setupInterface();
        await loadAllAgendamentos();
        updateChartDefaults();
        hideLoadingScreen();
        const firstSection = hasPermission('agenda.view')
            ? 'dashboard'
            : (hasPermission('vagas.view') ? 'vagas' : (hasPermission('reports.view') ? 'relatorios' : (hasPermission('logs.view') ? 'auditoria' : null)));
        if (firstSection) showSection(firstSection);
        // Gráficos do dashboard
        setTimeout(() => loadReports?.(), 50);
        
} catch (error) {
        // Se der erro de autenticação (401), redireciona para o login silenciosamente
        console.error('Sessão inválida ou expirada:', error);
        window.location.href = '/login.html';
    }
}

// Verificar autenticação
async function checkAuth() {
    // 1. Faz a requisição de sessão
    const response = await fetch('/api/user', { cache: 'no-store' });
    
    // 2. Se a resposta for 401 (ou qualquer erro de status HTTP),
    // a execução sai deste bloco, e a função retorna
    if (!response.ok) {
        // Lançar um novo erro para que initializeApp possa capturá-lo
        throw new Error('Não autenticado ou sessão expirada'); 
    }

    // 3. Se estiver OK (status 200):
    currentUser = await response.json();
    const userNameEl = document.getElementById('userName');
    if (userNameEl) userNameEl.textContent = currentUser.username;
    
    applyPermissionVisibility();
}

// Carregar configurações
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        config = await response.json();
        populateSelects();
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
        showToast('Erro ao carregar configurações', 'error');
    }
}

// Carrega todos os agendamentos para usar no dashboard e relatórios
async function loadAllAgendamentos() {
    if (!hasPermission('agenda.view')) {
        agendamentos = [];
        return;
    }
    try {
        const response = await fetch('/api/agendamentos');
        if (!response.ok) throw new Error('Falha ao carregar agendamentos');
        agendamentos = await response.json();
        updateDashboardStats();
        loadRecentAppointments();
    } catch (error) {
        console.error(error);
        showToast('Não foi possível carregar os dados para o dashboard.', 'error');
    }
}

// Preencher selects
function populateSelects() {
    const selects = {
        'vagasCidade': config.cidades,
        'gvCidade': config.cidades,
        'gvTipo': config.tiposOS,
        'repCidade': config.cidades,
        'repTecnico': config.tecnicos,
        'repAssunto': config.assuntos,
        'repStatus': config.statusPossiveis,
    };
    for (const [id, options] of Object.entries(selects)) {
        const select = document.getElementById(id);
        if (select) {
            // Para selects de relatório, o primeiro item é "Todas"
            const first = (id.startsWith('rep') ? 'Todas' : 'Selecione');
            select.innerHTML = `<option value="">${first}</option>`;
            (options || []).forEach(option => {
                select.innerHTML += `<option value="${option}">${option}</option>`;
            });
        }
    }
}

// Recarregar config (depois de criar/alterar assuntos)
async function reloadConfig() {
    await loadConfig();
}

// Configurar interface e event listeners
function setupInterface() {
    const vagasDataEl = document.getElementById('vagasData');
    if (vagasDataEl) {
        vagasDataEl.value = new Date().toISOString().slice(0, 10);
    }

    updateThemeToggleUi();

    const changePasswordForm = document.getElementById('changePasswordForm');
    if (changePasswordForm && !changePasswordForm.dataset.bound) {
        changePasswordForm.addEventListener('submit', handleChangePasswordSubmit);
        changePasswordForm.dataset.bound = '1';
    }
    
    // O sistema de modo escuro agora é gerenciado pelo dark-mode-system.js
    // Listener para mudanças de tema
    document.addEventListener('themeChanged', function(e) {
        updateThemeToggleUi();
        updateChartDefaults();
        // Recarrega gráficos se estiver na seção de relatórios
        if (document.getElementById('relatorios')?.classList.contains('active')) {
            setTimeout(() => loadReports(), 100);
        }
    });

    document.addEventListener('click', handleGlobalUiClick);
    document.addEventListener('keydown', handleGlobalKeydown);
}

// Ocultar loading screen
function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
        loadingScreen.style.opacity = '0';
        setTimeout(() => {
            loadingScreen.style.display = 'none';
        }, 500);
    }
}

// Navegação entre seções
function showSection(sectionId) {
    // Gate por permissão
    const perms = currentUser?.permissions || [];
    const gate = {
        'dashboard': 'agenda.view',
        'vagas': 'vagas.view',
        'relatorios': 'reports.view',
        'auditoria': 'logs.view',
        'gerenciarVagas': 'vagas.manage',
        'assuntos': 'subjects.manage',
    };
    const needed = gate[sectionId];
    if (needed && !perms.includes(needed)) {
        showToast('Você não tem permissão para acessar esta área.', 'error');
        return;
    }

    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    const sectionToShow = document.getElementById(sectionId);
    if (sectionToShow) {
        sectionToShow.classList.add('active');
    }
    
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    
    const activeLink = document.querySelector(`.nav-link[onclick*="'${sectionId}'"]`);
    if (activeLink) {
        activeLink.closest('.nav-item').classList.add('active');
    }

    if (sectionId === 'relatorios') {
        // Relatório detalhado (DB)
        setTimeout(() => loadReportsDb?.(), 50);
    }

    if (sectionId === 'dashboard') {
        setTimeout(() => loadReports?.(), 50);
    }

    if (sectionId === 'auditoria') {
        setTimeout(() => initAuditUi?.(), 50);
    }
if (sectionId === 'assuntos') {
        carregarAssuntosUI();
    }
}

// =======================
// GERENCIAR VAGAS (templates)
// =======================
async function carregarVagasTemplates() {
    const city = document.getElementById('gvCidade')?.value;
    const tipo_os = document.getElementById('gvTipo')?.value;
    const periodo = document.getElementById('gvPeriodo')?.value;
    if (!city || !tipo_os || !periodo) {
        showToast('Selecione cidade, tipo de OS e período.', 'warning');
        return;
    }

    try {
        const r = await fetch(`/api/vacancy-templates?city=${encodeURIComponent(city)}&tipo_os=${encodeURIComponent(tipo_os)}&periodo=${encodeURIComponent(periodo)}`);
        if (!r.ok) throw new Error('Falha ao carregar estrutura');
        const rows = await r.json();

        // Monta tabela com todos os assuntos ativos (para ficar consistente)
        const subjects = (config.assuntosComColuna || config.assuntos || []).slice().sort((a,b)=>a.localeCompare(b));
        const map = Object.fromEntries((rows||[]).map(x => [x.assunto, Number(x.capacity||0)]));

        let html = `
        <div class="card" style="padding:16px;">
          <h3 style="margin-top:0;">Capacidades</h3>
          <div style="overflow:auto;">
            <table class="table" style="width:100%; border-collapse:collapse;">
              <thead>
                <tr>
                  <th style="text-align:left; padding:8px; border-bottom:1px solid #e5e7eb;">Assunto</th>
                  <th style="text-align:left; padding:8px; border-bottom:1px solid #e5e7eb; width:160px;">Vagas</th>
                </tr>
              </thead>
              <tbody>
        `;

        subjects.forEach(s => {
            const v = map[s] ?? 0;
            html += `
              <tr>
                <td style="padding:8px; border-bottom:1px solid #f0f2f5;">${escapeHtml(s)}</td>
                <td style="padding:8px; border-bottom:1px solid #f0f2f5;">
                  <input class="gv-cap" data-assunto="${escapeAttr(s)}" type="number" min="0" step="1" value="${v}" style="width:120px; padding:8px; border:1px solid #d1d5db; border-radius:8px;" />
                </td>
              </tr>
            `;
        });

        html += `</tbody></table></div>
          <p style="margin:12px 0 0; color:#6b7280; font-size:13px;">Dica: o dashboard e a consulta de vagas usam essa capacidade como limite por assunto.</p>
        </div>`;

        const wrap = document.getElementById('gvTabelaWrap');
        wrap.innerHTML = html;
        wrap.style.display = 'block';
        document.getElementById('gvSalvarBtn').disabled = false;
    } catch (e) {
        console.error(e);
        showToast('Erro ao carregar estrutura de vagas.', 'error');
    }
}

async function salvarVagasTemplates() {
    const city = document.getElementById('gvCidade')?.value;
    const tipo_os = document.getElementById('gvTipo')?.value;
    const periodo = document.getElementById('gvPeriodo')?.value;
    if (!city || !tipo_os || !periodo) return;

    const caps = {};
    document.querySelectorAll('#gvTabelaWrap .gv-cap').forEach(inp => {
        const assunto = inp.getAttribute('data-assunto');
        const v = Math.max(0, parseInt(inp.value, 10) || 0);
        caps[assunto] = v;
    });

    try {
        const r = await fetch('/api/vacancy-templates', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ city, tipo_os, periodo, capacities: caps })
        });
        const out = await r.json().catch(()=> ({}));
        if (!r.ok) throw new Error(out?.error || 'Falha ao salvar');
        showToast('Vagas salvas com sucesso!', 'success');
        // Atualiza config (para refletir em consulta/agenda)
        await reloadConfig();
    } catch (e) {
        console.error(e);
        showToast('Erro ao salvar vagas.', 'error');
    }
}

// =======================
// GERENCIAR ASSUNTOS
// =======================
async function carregarAssuntosUI() {
    try {
        const r = await fetch('/api/subjects?active=0', { cache:'no-store' });
        if (!r.ok) throw new Error('Falha ao buscar assuntos');
        const rows = await r.json();
        const wrap = document.getElementById('listaAssuntos');
        if (!wrap) return;

        const ativos = (rows||[]).filter(x => Number(x.is_active) === 1);
        const inativos = (rows||[]).filter(x => Number(x.is_active) === 0);

        const renderList = (title, list) => {
            let h = `<h3 class="subjects-group-title">${title}</h3>`;
            if (!list.length) return h + `<p class="subjects-empty-state">Nenhum</p>`;
            h += `<div class="subjects-list">`;
            list.forEach(s => {
                h += `
                <div class="subject-row">
                  <div class="subject-row__meta">
                    <strong>${escapeHtml(s.name)}</strong>
                    <small class="subject-row__id">ID: ${s.id}</small>
                    <span class="subject-board-flag ${Number(s.show_in_board) === 1 ? 'on' : 'off'}">${Number(s.show_in_board) === 1 ? 'Com coluna de vagas' : 'Sem coluna de vagas'}</span>
                  </div>
                  <div class="subject-row__actions">
                    <button class="btn btn-secondary" onclick="renomearAssunto(${s.id}, '${escapeAttr(s.name)}', ${Number(s.show_in_board) === 1 ? 1 : 0})"><i class="fas fa-pen"></i></button>
                    <button class="btn ${Number(s.show_in_board) === 1 ? 'btn-warning' : 'btn-info'}" onclick="toggleAssuntoColuna(${s.id}, ${Number(s.show_in_board) === 1 ? 0 : 1})">${Number(s.show_in_board) === 1 ? 'Ocultar coluna' : 'Mostrar coluna'}</button>
                    ${Number(s.is_active) === 1
                      ? `<button class="btn btn-danger" onclick="toggleAssunto(${s.id}, 0)"><i class="fas fa-ban"></i></button>`
                      : `<button class="btn btn-success" onclick="toggleAssunto(${s.id}, 1)"><i class="fas fa-check"></i></button>`
                    }
                  </div>
                </div>`;
            });
            h += `</div>`;
            return h;
        };

        wrap.innerHTML = renderList('Ativos', ativos) + renderList('Inativos', inativos);
    } catch (e) {
        console.error(e);
        showToast('Erro ao carregar assuntos.', 'error');
    }
}

async function criarAssunto() {
    const inp = document.getElementById('novoAssunto');
    const name = String(inp?.value || '').trim();
    if (!name) {
        showToast('Informe o nome do assunto.', 'warning');
        return;
    }
    try {
        const r = await fetch('/api/subjects', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ name, show_in_board: 0 })
        });
        const out = await r.json().catch(()=> ({}));
        if (!r.ok) throw new Error(out?.error || 'Falha ao criar');
        inp.value = '';
        showToast('Assunto criado!', 'success');
        await reloadConfig();
        await carregarAssuntosUI();
        // Se estiver com tabela de vagas aberta, ela passa a ter o assunto novo
        const wrap = document.getElementById('gvTabelaWrap');
        if (wrap && wrap.style.display !== 'none') {
            // não recarrega automaticamente para não perder edições em andamento
        }
    } catch (e) {
        console.error(e);
        showToast('Erro ao criar assunto.', 'error');
    }
}

async function toggleAssunto(id, is_active) {
    try {
        const r = await fetch(`/api/subjects/${id}/toggle`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ is_active })
        });
        const out = await r.json().catch(()=> ({}));
        if (!r.ok) throw new Error(out?.error || 'Falha ao atualizar');
        showToast('Assunto atualizado!', 'success');
        await reloadConfig();
        await carregarAssuntosUI();
    } catch (e) {
        console.error(e);
        showToast('Erro ao atualizar assunto.', 'error');
    }
}

async function toggleAssuntoColuna(id, show_in_board) {
    try {
        const r = await fetch(`/api/subjects/${id}/board-column`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ show_in_board })
        });
        const out = await r.json().catch(()=> ({}));
        if (!r.ok) throw new Error(out?.error || 'Falha ao atualizar coluna');
        showToast('Visibilidade de coluna atualizada!', 'success');
        await reloadConfig();
        await carregarAssuntosUI();
    } catch (e) {
        console.error(e);
        showToast('Erro ao atualizar coluna do assunto.', 'error');
    }
}

async function renomearAssunto(id, current, currentShowInBoard) {
    const novo = prompt('Novo nome do assunto:', current);
    if (novo === null) return;
    const name = String(novo).trim();
    if (!name) {
        showToast('Nome inválido.', 'warning');
        return;
    }
    try {
        const r = await fetch(`/api/subjects/${id}`, {
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ name, show_in_board: currentShowInBoard })
        });
        const out = await r.json().catch(()=> ({}));
        if (!r.ok) throw new Error(out?.error || 'Falha ao renomear');
        showToast('Assunto renomeado!', 'success');
        await reloadConfig();
        await carregarAssuntosUI();
    } catch (e) {
        console.error(e);
        showToast('Erro ao renomear assunto.', 'error');
    }
}

// Helpers de escape
function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(str) {
    return escapeHtml(str).replace(/\n/g,' ');
}

// Toggle sidebar e user menu
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('.main-content');
    if (window.innerWidth <= 1024) {
        if (sidebar) sidebar.classList.toggle('show');
        return;
    }

    document.body.classList.toggle('sidebar-collapsed');
    if (sidebar) sidebar.classList.toggle('collapsed');
    if (main) main.classList.toggle('expanded');
}

function toggleUserMenu() {
    const userDropdown = document.getElementById('userDropdown');
    if (userDropdown) userDropdown.classList.toggle('show');
}

function closeUserMenu() {
    const userDropdown = document.getElementById('userDropdown');
    if (userDropdown) userDropdown.classList.remove('show');
}

function openChangePasswordModal() {
    closeUserMenu();
    const modal = document.getElementById('changePasswordModal');
    if (!modal) return;
    modal.classList.add('show');
    document.body.classList.add('modal-open');
    document.getElementById('changePasswordForm')?.reset();
    setTimeout(() => document.getElementById('currentPassword')?.focus(), 40);
}

function closeChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    if (!modal) return;
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
}

async function handleChangePasswordSubmit(event) {
    event.preventDefault();

    const current_password = document.getElementById('currentPassword')?.value?.trim();
    const new_password = document.getElementById('newPassword')?.value || '';
    const confirm_password = document.getElementById('confirmPassword')?.value || '';
    const submitButton = document.getElementById('changePasswordSubmitBtn');

    if (!current_password || !new_password || !confirm_password) {
        showToast('Preencha todos os campos da troca de senha.', 'warning');
        return;
    }

    if (new_password !== confirm_password) {
        showToast('A confirmação da nova senha não confere.', 'warning');
        return;
    }

    if (new_password.length < 4) {
        showToast('A nova senha precisa ter pelo menos 4 caracteres.', 'warning');
        return;
    }

    try {
        if (submitButton) submitButton.disabled = true;

        const response = await fetch('/api/me/password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_password, new_password, confirm_password })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error || 'Não foi possível alterar a senha.');
        }

        showToast('Senha alterada com sucesso.', 'success');
        closeChangePasswordModal();
    } catch (error) {
        console.error('Erro ao trocar senha:', error);
        showToast(error.message || 'Erro ao alterar senha.', 'error');
    } finally {
        if (submitButton) submitButton.disabled = false;
    }
}

function updateThemeToggleUi() {
    const menuItem = document.getElementById('themeToggleMenuItem');
    const isDark = window.darkModeSystem?.isDarkMode?.() || false;
    const label = isDark ? 'Usar modo claro' : 'Ativar modo escuro';
    const icon = isDark ? 'sun' : 'moon';

    const labelEl = document.getElementById('themeToggleMenuLabel');
    const iconEl = document.getElementById('themeToggleMenuIcon');

    if (labelEl) {
        labelEl.textContent = label;
    } else if (menuItem) {
        menuItem.innerHTML = `<i class="fas fa-${icon}" id="themeToggleMenuIcon"></i> <span id="themeToggleMenuLabel">${label}</span>`;
    }

    if (iconEl) {
        iconEl.className = `fas fa-${icon}`;
    }
}

async function toggleThemeMode() {
    closeUserMenu();
    await window.darkModeSystem?.toggleTheme?.();
    updateThemeToggleUi();
}

function handleGlobalUiClick(event) {
    const dropdown = document.getElementById('userDropdown');
    const button = document.querySelector('.user-button');
    if (dropdown && button && !dropdown.contains(event.target) && !button.contains(event.target)) {
        dropdown.classList.remove('show');
    }

    const modal = document.getElementById('changePasswordModal');
    if (modal && event.target === modal) {
        closeChangePasswordModal();
    }
}

function handleGlobalKeydown(event) {
    if (event.key === 'Escape') {
        closeUserMenu();
        closeChangePasswordModal();
    }
}

// Funções de consultar vagas
async function consultarVagas() {
    const cidade = document.getElementById('vagasCidade').value;
    const data = document.getElementById('vagasData').value;
    if (!cidade || !data) {
        showToast('Selecione a cidade e a data', 'warning');
        return;
    }
    try {
        const response = await fetch(`/api/vagas/${cidade}/${data}`);
        const result = await response.json();

        // Busca vagas fechadas no servidor (sem localStorage)
        // Monta um mapa por chave: cidade_data_tipo_periodo_assunto -> [indices fechados]
        const fechadasMap = {};
        let totalFechadas = 0;
        try {
            const tipos = Object.keys(result.template || {});
            await Promise.all(tipos.map(async (tipo) => {
                const r = await fetch(`/api/vagas-fechadas?cidade=${encodeURIComponent(cidade)}&data=${encodeURIComponent(data)}&tipo=${encodeURIComponent(tipo)}`);
                if (!r.ok) return;
                const vf = await r.json();
                ['MANHÃ','TARDE'].forEach(periodo => {
                    const byAssunto = (vf && vf[periodo]) || {};
                    Object.entries(byAssunto).forEach(([assunto, indices]) => {
                        const key = `${cidade}_${data}_${tipo}_${periodo}_${assunto}`;
                        const arr = Array.isArray(indices) ? indices : [];
                        fechadasMap[key] = arr;
                        totalFechadas += arr.length;
                    });
                });
            }));
        } catch (_) {}

        displayVagas(result, totalFechadas, fechadasMap);
    } catch (error) {
        showToast('Erro ao consultar vagas', 'error');
    }
}

function displayVagas(data, totalFechadas = 0, fechadasMap = {}) {
    const resultContainer = document.getElementById('vagasResult');
    const { template, ocupadas } = data;
    const cidadeSelecionada = document.getElementById('vagasCidade').value;
    const dataSelecionada = document.getElementById('vagasData').value;
    const nomeCidade = cidadeSelecionada.charAt(0).toUpperCase() + cidadeSelecionada.slice(1).toLowerCase();
    
    let html = `<h3>Disponibilidade para ${nomeCidade} em ${new Date(dataSelecionada + 'T00:00:00').toLocaleDateString('pt-BR')}</h3>`;
    // Resumo (total/ocupadas/fechadas)
    let totalSlots = 0;
    let totalOcupadas = 0;

    // Conta total de slots do template
    Object.values(template).forEach(periodos => {
        Object.values(periodos).forEach(assuntos => {
            Object.values(assuntos).forEach(qt => { totalSlots += Number(qt || 0); });
        });
    });

    // Conta ocupadas (no dia)
    totalOcupadas = Array.isArray(ocupadas) ? ocupadas.length : 0;
    html += `
        <div class="vagas-summary">
            <div class="summary-left">
                <span class="badge"><span class="dot"></span>Total: ${totalSlots}</span>
                <span class="badge badge--warning"><span class="dot"></span>Ocupadas: ${totalOcupadas}</span>
                <span class="badge badge--danger"><span class="dot"></span>Fechadas: ${totalFechadas}</span>
            </div>
        </div>
    `;

    

    Object.entries(template).forEach(([tipoOS, periodos]) => {
        html += `<div class="tipo-os-section"><h2>${tipoOS}</h2><div class="vagas-grid">`;
        Object.entries(periodos).forEach(([periodo, assuntos]) => {
            html += `<div class="periodo-card"><h4>${periodo}</h4>`;
            Object.entries(assuntos).forEach(([assunto, total]) => {
                const ocupadasCount = ocupadas.filter(item => {
                    const hora = new Date(item.data_hora).getHours();
                    const itemPeriodo = hora < 12 ? 'MANHÃ' : 'TARDE';
                    return item.assunto === assunto && itemPeriodo === periodo && item.tipo_os === tipoOS;
                }).length;
                // Contabiliza vagas fechadas (indisponíveis) vindas do servidor
                const key = `${cidadeSelecionada}_${dataSelecionada}_${tipoOS}_${periodo}_${assunto}`;
                const fechadasIndices = Array.isArray(fechadasMap[key]) ? fechadasMap[key] : [];
                const fechadasCount = fechadasIndices.filter(i => Number.isInteger(i) && i >= 0 && i < total).length;

                const totalEfetivo = Math.max(0, total - fechadasCount);
                const disponiveis = Math.max(0, totalEfetivo - ocupadasCount);
                const itemClosed = (total > 0 && fechadasCount >= total);
                const disponibilidadeClass = disponiveis > 0 ? 'vagas-disponiveis' : 'vagas-indisponiveis';
                html += `
                    <div class="assunto-item ${itemClosed ? "is-closed" : ""}">
                        <strong>${assunto}</strong>${itemClosed ? ` <span class="status-badge">VAGA FECHADA</span>` : ``}
                        <div class="vagas-info">
                            <span class="vagas-total">Total: ${total}</span>
                            <span class="vagas-fechadas">Fechadas: ${fechadasCount}</span>
                            <span class="vagas-ocupadas">Ocupadas: ${ocupadasCount}</span>
                            <span class="${disponibilidadeClass}">Disponíveis: ${disponiveis}</span>
                        </div>
                    </div>`;
            });
            html += '</div>';
        });
        html += '</div></div>';
    });
    
    resultContainer.innerHTML = html;
    resultContainer.style.display = 'block';
}

// Funções do Dashboard Inicial
function updateDashboardStats() {
    const total = agendamentos.length;
    const hoje = new Date().toISOString().slice(0, 10);
    const agendamentosHoje = agendamentos.filter(item => item.data_hora && item.data_hora.startsWith(hoje)).length;
    const concluidos = agendamentos.filter(item => item.status === 'Concluída').length;
    const pendentes = agendamentos.filter(item => ['Aberta', 'Agendada', 'Em andamento'].includes(item.status)).length;
    
    const totalEl = document.getElementById('totalAgendamentos');
    const hojeEl = document.getElementById('agendamentosHoje');
    const concluidosEl = document.getElementById('agendamentosConcluidos');
    const pendentesEl = document.getElementById('agendamentosPendentes');

    if (totalEl) totalEl.textContent = total;
    if (hojeEl) hojeEl.textContent = agendamentosHoje;
    if (concluidosEl) concluidosEl.textContent = concluidos;
    if (pendentesEl) pendentesEl.textContent = pendentes;
}

function loadRecentAppointments() {
    const recent = agendamentos
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 5);
    
    const container = document.getElementById('recentAppointments');
    if (!container) return;

    if (recent.length === 0) {
        container.innerHTML = '<p class="empty-message">Nenhum agendamento recente.</p>';
        return;
    }
    
    container.innerHTML = recent.map(agendamento => `
        <div class="appointment-item">
            <div class="appointment-info">
                <h4>${agendamento.cliente}</h4>
                <p>${agendamento.assunto} - ${agendamento.cidade}</p>
            </div>
            <span class="appointment-status status-${(agendamento.status || '').toLowerCase().replace(' ', '-')}">
                ${getStatusLabel(agendamento.status)}
            </span>
        </div>
    `).join('');
}

// Funções de Relatórios
function loadReports() {
    if (typeof Chart === 'undefined') return;
    loadStatusChart();
    loadCidadeChart();
    loadTecnicoChart();
    loadMesChart();
}

// =======================
// RELATÓRIO DETALHADO (DB) + CSV
// =======================
async function loadReportsDb() {
    try {
        const qs = new URLSearchParams();
        const inicio = document.getElementById('repInicio')?.value;
        const fim = document.getElementById('repFim')?.value;
        const cidade = document.getElementById('repCidade')?.value;
        const assunto = document.getElementById('repAssunto')?.value;
        const tecnico = document.getElementById('repTecnico')?.value;
        const tipo_os = document.getElementById('repTipo')?.value;
        const status = document.getElementById('repStatus')?.value;

        if (inicio) qs.set('data_inicio', inicio);
        if (fim) qs.set('data_fim', fim);
        if (cidade) qs.set('cidade', cidade);
        if (assunto) qs.set('assunto', assunto);
        if (tecnico) qs.set('tecnico', tecnico);
        if (tipo_os) qs.set('tipo_os', tipo_os);
        if (status) qs.set('status', status);

        const wrap = document.getElementById('repResumoWrap');
        if (wrap) wrap.innerHTML = `<div class="muted">Carregando...</div>`;

        const resp = await fetch(`/api/reports/summary?${qs.toString()}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error('Erro ao carregar relatório');
        const data = await resp.json();
        const rows = data?.rows || [];

        // Habilita export CSV se tiver permissão
        const btn = document.getElementById('btnExportCsv');
        if (btn) {
            const canExport = (currentUser?.permissions || []).includes('reports.export');
            btn.disabled = !canExport;
            btn.dataset.qs = qs.toString();
        }

        if (!wrap) return;

        if (rows.length === 0) {
            wrap.innerHTML = `<div class="muted">Nenhum dado encontrado com esses filtros.</div>`;
            return;
        }

        const html = [
            '<table class="table">',
            '<thead><tr>',
            '<th>Cidade</th><th>Técnico</th><th>Assunto</th><th>Tipo</th><th>Status</th><th>Total</th>',
            '</tr></thead><tbody>'
        ];

        rows.forEach(r => {
            html.push('<tr>');
            html.push(`<td>${escapeHtml(r.cidade || '-')}</td>`);
            html.push(`<td>${escapeHtml(r.tecnico || '-')}</td>`);
            html.push(`<td>${escapeHtml(r.assunto || '-')}</td>`);
            html.push(`<td>${escapeHtml(r.tipo_os || '-')}</td>`);
            html.push(`<td>${escapeHtml(getStatusLabel(r.status) || "-")}</td>`);
            html.push(`<td><b>${Number(r.total || 0)}</b></td>`);
            html.push('</tr>');
        });

        html.push('</tbody></table>');
        wrap.innerHTML = html.join('');
    } catch (e) {
        console.error(e);
        const wrap = document.getElementById('repResumoWrap');
        if (wrap) wrap.innerHTML = `<div class="muted">Erro ao carregar relatório.</div>`;
        showToast('Erro ao carregar relatório', 'error');
    }
}

function exportReportsCsv() {
    const btn = document.getElementById('btnExportCsv');
    const canExport = (currentUser?.permissions || []).includes('reports.export');
    if (!canExport) return showToast('Você não tem permissão para exportar CSV.', 'error');
    const qs = btn?.dataset?.qs || '';
    window.open(`/api/reports/export${qs ? ('?' + qs) : ''}`, '_blank');
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// =======================
// AUDITORIA (DB)
// =======================
let __auditState = { page: 1, limit: 50, total: 0 };

async function initAuditUi() {
    try {
        const perms = currentUser?.permissions || [];
        if (!perms.includes('logs.view')) return;

        // Carrega meta para filtros (uma vez)
        if (!window.__auditMetaLoaded) {
            const resp = await fetch('/api/audit/meta', { cache: 'no-store' });
            if (resp.ok) {
                const meta = await resp.json();
                fillSelect('audUser', meta.users?.map(u => ({ value: u.id, label: u.username })) || [], 'Todos');
                fillSelect('audAction', (meta.actions || []).map(a => ({ value: a, label: a })) || [], 'Todas');
                fillSelect('audEntity', (meta.entity_types || []).map(t => ({ value: t, label: t })), 'Todas');
                window.__auditMetaLoaded = true;
            }
        }
    } catch (e) {
        console.error(e);
    }
}

function fillSelect(id, items, firstLabel) {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = `<option value="">${firstLabel || 'Todos'}</option>`;
    (items || []).forEach(it => {
        sel.innerHTML += `<option value="${escapeHtml(it.value)}">${escapeHtml(it.label)}</option>`;
    });
}

async function loadAudit(page = 1) {
    try {
        const perms = currentUser?.permissions || [];
        if (!perms.includes('logs.view')) return;

        const qs = new URLSearchParams();
        const inicio = document.getElementById('audInicio')?.value;
        const fim = document.getElementById('audFim')?.value;
        const user_id = document.getElementById('audUser')?.value;
        const action = document.getElementById('audAction')?.value;
        const entity_type = document.getElementById('audEntity')?.value;

        if (inicio) qs.set('from', inicio);
        if (fim) qs.set('to', fim);
        if (user_id) qs.set('user_id', user_id);
        if (action) qs.set('action', action);
        if (entity_type) qs.set('entity_type', entity_type);
        qs.set('page', String(page));
        qs.set('limit', String(__auditState.limit));

        const wrap = document.getElementById('auditWrap');
        if (wrap) wrap.innerHTML = `<div class="muted">Carregando...</div>`;

        const resp = await fetch(`/api/audit?${qs.toString()}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error('Erro ao carregar auditoria');
        const data = await resp.json();
        const rows = data?.rows || [];
        const meta = data?.meta || { page, limit: __auditState.limit, total: 0 };
        __auditState = { ...__auditState, page: meta.page || page, total: meta.total || 0 };

        renderAuditTable(rows);
        updateAuditPager();
    } catch (e) {
        console.error(e);
        const wrap = document.getElementById('auditWrap');
        if (wrap) wrap.innerHTML = `<div class="muted">Erro ao carregar auditoria.</div>`;
        showToast('Erro ao carregar auditoria', 'error');
    }
}

function renderAuditTable(rows) {
    const wrap = document.getElementById('auditWrap');
    if (!wrap) return;
    if (!rows || rows.length === 0) {
        wrap.innerHTML = `<div class="muted">Nenhum registro encontrado.</div>`;
        return;
    }

    const html = [
        '<table class="table">',
        '<thead><tr>',
        '<th>Quando</th><th>Usuário</th><th>Ação</th><th>Entidade</th><th>ID</th><th>Antes / Depois</th>',
        '</tr></thead><tbody>'
    ];

    rows.forEach(r => {
        const when = r.created_at || r.timestamp || '';
        const before = safeJson(r.old_value);
        const after = safeJson(r.new_value);
        const detailsId = `aud_${r.id}`;

        html.push('<tr>');
        html.push(`<td>${escapeHtml(when)}</td>`);
        html.push(`<td>${escapeHtml(r.username || '-')}</td>`);
        html.push(`<td><b>${escapeHtml(r.action || '-')}</b></td>`);
        html.push(`<td>${escapeHtml(r.entity_type || '-')}</td>`);
        html.push(`<td>${escapeHtml(r.entity_id || '-')}</td>`);
        html.push(`<td>
            <details id="${detailsId}">
              <summary class="link-like">ver</summary>
              <div class="audit-diff">
                <div><div class="muted" style="margin-bottom:6px;">ANTES</div><pre>${escapeHtml(before)}</pre></div>
                <div><div class="muted" style="margin-bottom:6px;">DEPOIS</div><pre>${escapeHtml(after)}</pre></div>
              </div>
            </details>
        </td>`);
        html.push('</tr>');
    });

    html.push('</tbody></table>');
    wrap.innerHTML = html.join('');
}

function safeJson(v) {
    if (v == null) return '';
    try {
        const obj = typeof v === 'string' ? JSON.parse(v) : v;
        return JSON.stringify(obj, null, 2);
    } catch {
        return String(v);
    }
}

function updateAuditPager() {
    const prev = document.getElementById('auditPrev');
    const next = document.getElementById('auditNext');
    const info = document.getElementById('auditPageInfo');

    const page = __auditState.page || 1;
    const total = __auditState.total || 0;
    const limit = __auditState.limit || 50;
    const maxPage = Math.max(Math.ceil(total / limit) || 1, 1);

    if (info) info.textContent = `Página ${page} de ${maxPage} (total: ${total})`;
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= maxPage;
}

function auditPageNav(dir) {
    const page = __auditState.page || 1;
    loadAudit(page + (dir || 0));
}

function loadStatusChart() {
    const ctx = document.getElementById('statusChart')?.getContext('2d');
    if (!ctx) return;
    const statusCount = {};
    (config.statusPossiveis || []).forEach(status => {
        statusCount[status] = agendamentos.filter(item => item.status === status).length;
    });
    if (charts.statusChart) charts.statusChart.destroy();
    charts.statusChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(statusCount).map(s => getStatusLabel(s)),
            datasets: [{
                data: Object.values(statusCount),
                backgroundColor: ['#FFC107', '#28A745', '#17A2B8', '#6C757D', '#DC3545']
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
}

function loadCidadeChart() {
    const ctx = document.getElementById('cidadeChart')?.getContext('2d');
    if (!ctx) return;
    const cidadeCount = {};
    (config.cidades || []).forEach(cidade => {
        cidadeCount[cidade] = agendamentos.filter(item => item.cidade === cidade).length;
    });
    if (charts.cidadeChart) charts.cidadeChart.destroy();
    charts.cidadeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Object.keys(cidadeCount),
            datasets: [{ label: 'Agendamentos', data: Object.values(cidadeCount), backgroundColor: '#E31E24' }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
}

function loadTecnicoChart() {
    const ctx = document.getElementById('tecnicoChart')?.getContext('2d');
    if (!ctx) return;
    const tecnicoCount = {};
    (config.tecnicos || []).forEach(tecnico => {
        tecnicoCount[tecnico] = agendamentos.filter(item => item.tecnico === tecnico).length;
    });
    if (charts.tecnicoChart) charts.tecnicoChart.destroy();
    charts.tecnicoChart = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: Object.keys(tecnicoCount),
            datasets: [{ data: Object.values(tecnicoCount), backgroundColor: ['#E31E24', '#F39C12', '#28A745', '#17A2B8'] }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
}

function loadMesChart() {
    const ctx = document.getElementById('mesChart')?.getContext('2d');
    if (!ctx) return;
    const mesCount = {};
    const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    meses.forEach((mes, index) => {
        mesCount[mes] = agendamentos.filter(item => item.data_hora && new Date(item.data_hora).getMonth() === index).length;
    });
    if (charts.mesChart) charts.mesChart.destroy();
    charts.mesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Object.keys(mesCount),
            datasets: [{ label: 'Agendamentos', data: Object.values(mesCount), borderColor: '#E31E24', backgroundColor: 'rgba(227, 30, 36, 0.1)', tension: 0.4 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
}

// Variáveis de controle globais (devem ficar FORA da função)
let ultimoErroMsg = '';
let ultimoErroTempo = 0;

function showToast(message, type = 'info') {
    const agora = Date.now();
    const msg = String(message ?? '').replace(/\s+/g, ' ').trim();

    if (msg && msg === ultimoErroMsg && (agora - ultimoErroTempo) < 1800) return;
    ultimoErroMsg = msg;
    ultimoErroTempo = agora;

    if (!window.__toastManager) {
        window.__toastManager = {
            queue: [],
            showing: false,
            maxLen: 180,
            push(m, t) {
                const clean = String(m ?? '').replace(/[<>]/g, '').trim();
                const safe = clean.length > this.maxLen ? (clean.slice(0, this.maxLen) + '…') : clean;
                if (clean.length > this.maxLen) console.warn('Toast truncado (mensagem completa):', clean);
                this.queue.push({ message: safe || 'Ação inválida', type: t || 'info' });
                this.drain();
            },
            drain() {
                if (this.showing) return;
                const next = this.queue.shift();
                if (!next) return;
                this.showing = true;

                let container = document.getElementById('toastContainer');
                if (!container) {
                    container = document.createElement('div');
                    container.id = 'toastContainer';
                    container.className = 'toast-container';
                    document.body.appendChild(container);
                }

                const toast = document.createElement('div');
                toast.className = `toast toast--${next.type}`;
                toast.setAttribute('role', 'status');
                toast.innerHTML = `
                    <div class="toast__icon"></div>
                    <div class="toast__msg"></div>
                    <button class="toast__close" aria-label="Fechar">×</button>
                `;
                toast.querySelector('.toast__msg').textContent = next.message;

                const close = () => {
                    toast.classList.add('toast--hide');
                    setTimeout(() => {
                        toast.remove();
                        this.showing = false;
                        this.drain();
                    }, 220);
                };
                toast.querySelector('.toast__close').addEventListener('click', close);

                container.appendChild(toast);
                requestAnimationFrame(() => toast.classList.add('toast--show'));
                setTimeout(close, 3200);
            }
        };
    }

    window.__toastManager.push(msg, type);
}
// --- LÓGICA DO MODO NOTURNO (INTEGRADA COM DARK-MODE-SYSTEM) ---
function updateChartDefaults() {
    // VERIFICAÇÃO DE SEGURANÇA MELHORADA
    // Se o Chart não existe OU se o Chart.defaults não existe, sai da função sem fazer nada
    if (typeof Chart === 'undefined' || !Chart.defaults) return;
    
    const isDarkMode = window.darkModeSystem?.isDarkMode?.() || false;
    const textColor = isDarkMode ? '#b0b0b0' : '#6c757d';
    const gridColor = isDarkMode ? '#404040' : '#dee2e6';
    
    // Agora é seguro acessar
    if (Chart.defaults) {
        Chart.defaults.color = textColor;
        Chart.defaults.borderColor = gridColor;
        
        if (Chart.defaults.plugins && Chart.defaults.plugins.legend && Chart.defaults.plugins.legend.labels) {
            Chart.defaults.plugins.legend.labels.color = textColor;
        }
        
        if (Chart.defaults.scales && Chart.defaults.scales.linear && Chart.defaults.scales.linear.grid) {
            Chart.defaults.scales.linear.grid.color = gridColor;
            Chart.defaults.scales.linear.ticks.color = textColor;
        }
        
        if (Chart.defaults.scales && Chart.defaults.scales.category && Chart.defaults.scales.category.grid) {
            Chart.defaults.scales.category.grid.color = gridColor;
            Chart.defaults.scales.category.ticks.color = textColor;
        }
    }
}
