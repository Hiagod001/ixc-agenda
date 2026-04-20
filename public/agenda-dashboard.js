const STATUS_LABELS = {
  'Em andamento': 'Agendado no IXC',
};

const IXC_STATUS_LABELS = {
  'A': 'Aberta no IXC',
  'AG': 'Agendada no IXC',
  'AN': 'Em analise no IXC',
  'AS': 'Assumida no IXC',
  'EX': 'Em execucao no IXC',
  'F': 'Finalizada no IXC',
  'C': 'Cancelada no IXC',
  'CAN': 'Cancelada no IXC',
};

function getStatusLabel(status){
  return STATUS_LABELS[status] || status || '';
}

function getIxcStatusLabel(status) {
    const code = String(status || '').trim().toUpperCase();
    if (!code) return '';
    return IXC_STATUS_LABELS[code] || `IXC ${code}`;
}

function getDisplayStatus(agendamento) {
    if (String(agendamento?.origem || '').toLowerCase() === 'ixc') {
        return getIxcStatusLabel(agendamento?.ixc_status) || getStatusLabel(agendamento?.status) || 'IXC';
    }
    return getStatusLabel(agendamento?.status) || agendamento?.status || '';
}

function getAgendamentoStatusClass(agendamento) {
    if (String(agendamento?.origem || '').toLowerCase() === 'ixc') {
        const code = String(agendamento?.ixc_status || '').trim().toUpperCase();
        if (code) return `ixc-${code.toLowerCase()}`;
    }

    const fallback = String(agendamento?.status || '').trim();
    return fallback
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, '-');
}

function isAgendamentoFinalizado(agendamento) {
    if (String(agendamento?.origem || '').toLowerCase() === 'ixc') {
        const code = String(agendamento?.ixc_status || '').trim().toUpperCase();
        return code === 'F' || code === 'C' || code === 'CAN' || !!agendamento?.ixc_data_fechamento;
    }
    const status = String(agendamento?.status || '').trim().toLowerCase();
    return ['concluida', 'concluída', 'cancelada'].includes(status);
}

let currentUser = null;
let canAdjustVagas = false;

function hasPermission(permission) {
    return (currentUser?.permissions || []).includes(permission);
}

function applyPermissionVisibility(root = document) {
    root.querySelectorAll('.permission-only').forEach((el) => {
        const permission = String(el.getAttribute('data-permission') || '').trim();
        const required = permission
            ? permission.split(',').map((item) => item.trim()).filter(Boolean)
            : [];
        const allowed = !required.length || required.every(hasPermission);
        el.style.display = allowed ? '' : 'none';
    });
}

// Variáveis globais
// Evita erro "Identifier 'config' has already been declared" caso outro script da aplicação
// também declare `config` no escopo global (ex.: scripts.js no menu principal).
// Usamos `var` + `window.config` para ser idempotente.
var config = window.config || {};
window.config = config;
let agendamentosAguardando = [];
let filtroAgendamentoCliente = '';
let filtrosAgendamentoCliente = [];
let filtroAgendamentoCidade = '';
let filtroAgendamentoStatus = '';
let cidadeAtual = ""; // Inicializa vazio para ser preenchido pela config
let dataAtual = new Date().toISOString().slice(0, 10);
let ixcSyncInterval = null;
let ixcSyncInFlight = false;
let currentPeriodoView = 'MANHÃ';
let lastAgendaData = null;
let lastAgendaCacheKey = '';
let agendaRequestController = null;
const agendaCache = new Map();

function getAgendaCacheKey(cidade, tipo, data) {
    return `${cidade}::${tipo}::${data}`;
}

function invalidateAgendaCache() {
    agendaCache.clear();
    lastAgendaData = null;
    lastAgendaCacheKey = '';
}

function formatSaoPauloDateTime(value) {
    if (!value) return '';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(dt);
}
// =======================
// PERSISTÊNCIA (vagas fechadas)
// =======================
// Antes, as vagas fechadas ficavam só em memória e se perdiam ao atualizar a página.
// Agora persistimos em localStorage (por cidade/data/período/assunto).
// vagas fechadas agora vêm do servidor (banco), não do localStorage
let vagasFechadas = {}; // cache opcional (por chave cidade_data_tipo_periodo_assunto)

function getVagasOcupadas(agendamento) {
    return Math.max(Number(agendamento?.vagas_ocupadas || 1), 1);
}

function isPredial(agendamento) {
    return String(agendamento?.tipo_instalacao || '').toUpperCase() === 'PREDIAL' || getVagasOcupadas(agendamento) > 1;
}

function normalizarFiltroAgendamento(valor) {
    return String(valor || '').trim().replace(/\s+/g, ' ');
}

function getFiltrosAgendamentoAtivos() {
    const filtros = [...filtrosAgendamentoCliente];
    const filtroDigitado = normalizarFiltroAgendamento(filtroAgendamentoCliente);
    if (filtroDigitado) filtros.push(filtroDigitado);
    return filtros;
}

function renderFiltrosAgendamento() {
    const tagsContainer = document.getElementById('filtroAgendamentoTags');
    const input = document.getElementById('filtroAgendamentoCliente');
    const box = document.getElementById('filtroAgendamentoBox');
    if (!tagsContainer || !input) return;

    tagsContainer.innerHTML = '';
    filtrosAgendamentoCliente.forEach((filtro, index) => {
        const tag = document.createElement('button');
        tag.type = 'button';
        tag.className = 'aguardando-search-tag';
        tag.innerHTML = `<span>${filtro}</span><i class="fas fa-times"></i>`;
        tag.addEventListener('click', () => removerFiltroAgendamento(index));
        tagsContainer.appendChild(tag);
    });

    if (box) box.classList.toggle('has-tags', filtrosAgendamentoCliente.length > 0);
    input.placeholder = filtrosAgendamentoCliente.length > 0
        ? 'Digite outro termo e pressione Enter'
        : 'Digite um termo e pressione Enter';
}

function adicionarFiltroAgendamento(valor) {
    const filtro = normalizarFiltroAgendamento(valor);
    if (!filtro) return;
    if (filtrosAgendamentoCliente.some((item) => item.toLowerCase() === filtro.toLowerCase())) {
        filtroAgendamentoCliente = '';
        const input = document.getElementById('filtroAgendamentoCliente');
        if (input) input.value = '';
        renderFiltrosAgendamento();
        displayAgendamentosAguardando();
        return;
    }

    filtrosAgendamentoCliente.push(filtro);
    filtroAgendamentoCliente = '';
    const input = document.getElementById('filtroAgendamentoCliente');
    if (input) {
        input.value = '';
        input.focus();
    }
    renderFiltrosAgendamento();
    displayAgendamentosAguardando();
}

function removerFiltroAgendamento(index) {
    if (index < 0 || index >= filtrosAgendamentoCliente.length) return;
    filtrosAgendamentoCliente.splice(index, 1);
    renderFiltrosAgendamento();
    displayAgendamentosAguardando();
}

function limparUltimoFiltroAgendamento() {
    if (!filtrosAgendamentoCliente.length) return;
    filtrosAgendamentoCliente.pop();
    renderFiltrosAgendamento();
    displayAgendamentosAguardando();
}

function populateAguardandoExtraFilters() {
    const cidadeSelect = document.getElementById('filtroAgendamentoCidade');
    const statusSelect = document.getElementById('filtroAgendamentoStatus');
    if (!cidadeSelect || !statusSelect) return;

    const cidades = Array.from(new Set(
        agendamentosAguardando
            .map((item) => String(item?.cidade || '').trim())
            .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const statuses = Array.from(new Set(
        agendamentosAguardando
            .map((item) => getDisplayStatus(item))
            .map((status) => String(status || '').trim())
            .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    cidadeSelect.innerHTML = '<option value="">Todas as cidades</option>';
    cidades.forEach((cidade) => {
        const option = document.createElement('option');
        option.value = cidade;
        option.textContent = cidade;
        cidadeSelect.appendChild(option);
    });
    cidadeSelect.value = filtroAgendamentoCidade;

    statusSelect.innerHTML = '<option value="">Todos os status</option>';
    statuses.forEach((status) => {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = status;
        statusSelect.appendChild(option);
    });
    statusSelect.value = filtroAgendamentoStatus;
}

function ensureDashboardEditPredialField() {
    const observacaoField = document.getElementById('dashboardEditObservacao')?.closest('.form-group');
    const tecnicoField = document.getElementById('dashboardEditTecnico')?.closest('.form-group');
    const statusField = document.getElementById('dashboardEditStatus')?.closest('.form-group');

    if (tecnicoField) tecnicoField.style.display = 'none';
    if (statusField) statusField.style.display = 'none';
    if (!observacaoField || document.getElementById('dashboardEditPredial')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'form-group';
    wrapper.innerHTML = `
        <label class="dashboard-switch" for="dashboardEditPredial">
            <input id="dashboardEditPredial" name="predial" type="checkbox" />
            <span>Instalacao predial: ocupar 2 vagas</span>
        </label>
    `;
    observacaoField.insertAdjacentElement('afterend', wrapper);
}

function ensureDashboardUnallocateButton() {
    const actions = document.querySelector('#dashboardEditForm .form-actions');
    if (!actions || document.getElementById('dashboardUnallocateBtn')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'dashboardUnallocateBtn';
    button.className = 'btn-cancelar';
    button.textContent = 'Tirar da vaga';
    button.addEventListener('click', tirarAgendamentoDaVaga);
    actions.insertBefore(button, actions.querySelector('.btn-cancelar'));
}


// =======================
// TOAST (feedback visual)
// =======================
// O menu principal (public/scripts.js) já possui showToast, mas o dashboard não carrega aquele arquivo.
// Garantimos uma implementação aqui para evitar "showToast is not defined".
if (typeof window.showToast !== 'function') {
    // =======================
    // Toast (fila + anti-spam)
    // =======================
    (function () {
        if (window.__toastManager) return;

        const manager = {
            queue: [],
            showing: false,
            lastMsg: "",
            lastAt: 0,
            maxLen: 180,
            push(message, type = "info") {
                const now = Date.now();
                const msg = String(message ?? "").replace(/\s+/g, " ").trim();

                // anti-spam: não repete a mesma msg em sequência
                if (msg && msg === this.lastMsg && (now - this.lastAt) < 1800) return;
                this.lastMsg = msg;
                this.lastAt = now;

                const clean = msg.replace(/[<>]/g, "");
                const safe = clean.length > this.maxLen ? (clean.slice(0, this.maxLen) + "…") : clean;
                if (clean.length > this.maxLen) console.warn("Toast truncado (mensagem completa):", clean);

                this.queue.push({ message: safe || "Ação inválida", type });
                this._drain();
            },
            _drain() {
                if (this.showing) return;
                const next = this.queue.shift();
                if (!next) return;
                this.showing = true;

                let container = document.getElementById("toastContainer");
                if (!container) {
                    container = document.createElement("div");
                    container.id = "toastContainer";
                    container.className = "toast-container";
                    document.body.appendChild(container);
                }

                const toast = document.createElement("div");
                toast.className = `toast toast--${next.type}`;
                toast.setAttribute("role", "status");
                toast.innerHTML = `
                    <div class="toast__icon"></div>
                    <div class="toast__msg"></div>
                    <button class="toast__close" aria-label="Fechar">×</button>
                `;
                toast.querySelector(".toast__msg").textContent = next.message;

                const closeBtn = toast.querySelector(".toast__close");
                const close = () => {
                    toast.classList.add("toast--hide");
                    setTimeout(() => {
                        toast.remove();
                        this.showing = false;
                        this._drain();
                    }, 220);
                };
                closeBtn.addEventListener("click", close);

                container.appendChild(toast);
                requestAnimationFrame(() => toast.classList.add("toast--show"));
                setTimeout(close, 3200);
            }
        };

        window.__toastManager = manager;
        window.showToast = (message, type = "info") => manager.push(message, type);
    })();
}

// Ajuste rápido de capacidade (+/-) no dashboard
async function ajustarCapacidadeVaga({ city, tipo_os, periodo, assunto, delta, day }) {
    const resp = await fetch('/api/vacancy-templates/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, tipo_os, periodo, assunto, delta, day })
    });
    if (!resp.ok) {
        let msg = 'Erro ao ajustar vagas';
        try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch {}
        throw new Error(msg);
    }
    return await resp.json();
}

let tipoAgendaAtual = 'FIBRA'; // Fibra como padrão

// Estado da Consulta (modal)
let consultaState = {
    page: 1,
    pageSize: 25,
    totalPages: 1,
    total: 0,
    lastMeta: null,
};

// Inicialização
document.addEventListener('DOMContentLoaded', function() {
    initializeAgenda();
});

// Inicializar agenda
async function initializeAgenda() {
    // O tema agora é carregado automaticamente pelo dark-mode-system.js
    try {
        await checkAuth();
        setupInterface();
        const filtroInput = document.getElementById('filtroAgendamentoCliente');
        if (filtroInput) {
            filtroInput.addEventListener('input', (event) => {
                filtroAgendamentoCliente = event.target.value || '';
                displayAgendamentosAguardando();
            });
            filtroInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    adicionarFiltroAgendamento(event.target.value);
                    return;
                }

                if (event.key === 'Backspace' && !String(event.target.value || '').trim()) {
                    limparUltimoFiltroAgendamento();
                }
            });
        }
        const filtroCidade = document.getElementById('filtroAgendamentoCidade');
        if (filtroCidade) {
            filtroCidade.addEventListener('change', (event) => {
                filtroAgendamentoCidade = String(event.target.value || '').trim();
                displayAgendamentosAguardando();
            });
        }
        const filtroStatus = document.getElementById('filtroAgendamentoStatus');
        if (filtroStatus) {
            filtroStatus.addEventListener('change', (event) => {
                filtroAgendamentoStatus = String(event.target.value || '').trim();
                displayAgendamentosAguardando();
            });
        }
        renderFiltrosAgendamento();
        await loadConfig();
        setupDragAndDrop();
        hideLoadingScreen();
    } catch (error) {
        console.error('Erro ao inicializar agenda:', error);
         window.location.href = '/login.html';
    }
}


// Verificar autenticação
async function checkAuth() {
    try {
        const response = await fetch('/api/user');
        if (!response.ok) {
            throw new Error('Não autenticado');
        }
        currentUser = await response.json();
window.currentUser = currentUser;
        const perms = (currentUser && currentUser.permissions) ? currentUser.permissions : [];
        if (!perms.includes('agenda.view') || !perms.includes('vagas.view')) {
            showToast('Você não tem permissão para acessar o dashboard da agenda.', 'error');
            setTimeout(() => { window.location.href = '/index.html'; }, 1200);
            throw new Error('Sem permissão para dashboard da agenda');
        }
        canAdjustVagas = perms.includes('vagas.adjust') || perms.includes('vagas.manage');
        applyPermissionVisibility();
        document.getElementById('userName').textContent = currentUser.username;
        document.getElementById('userNameAgenda').textContent = currentUser.username;
    } catch (error) {
        throw error;
    }
}

// O sistema de modo escuro agora é gerenciado pelo dark-mode-system.js

// Carregar configurações
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        config = await response.json();
        window.config = config;
        
        // Preencher selects
        populateSelects();
        
        // Definir cidade padrão após carregar config
        if (config.cidades && config.cidades.length > 0) {
            cidadeAtual = config.cidades[0]; // Define a primeira cidade como padrão
            document.getElementById('cidadeAgenda').value = cidadeAtual;
            document.getElementById('cidadeAtual').textContent = cidadeAtual;
            
            // Carregar dados iniciais após a configuração da cidade
            await loadInitialData();
        }
        
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
        showToast('Erro ao carregar configurações', 'error');
    }
}

// Preencher selects
function populateSelects() {
    const cidadeSelect = document.getElementById('cidadeAgenda');
    // As OS agora chegam automaticamente do IXC.
    // Esses selects podem não existir mais no dashboard.
    const cidadeOsSelect = document.getElementById('cidadeOs');
    const assuntoSelect = document.getElementById('assuntoOs');
    
    // Limpar e preencher select de cidade da agenda
    cidadeSelect.innerHTML = '<option value="">Selecione a cidade</option>';
    config.cidades.forEach(cidade => {
        const option = document.createElement('option');
        option.value = cidade;
        option.textContent = cidade;
        cidadeSelect.appendChild(option);
    });
    
    // Limpar e preencher selects do formulário de OS (se existirem)
    if (cidadeOsSelect) {
        cidadeOsSelect.innerHTML = '<option value="">Selecione a cidade</option>';
        (config.cidades || []).forEach(cidade => {
            const option = document.createElement('option');
            option.value = cidade;
            option.textContent = cidade;
            cidadeOsSelect.appendChild(option);
        });
    }
    
    if (assuntoSelect) {
        assuntoSelect.innerHTML = '<option value="">Selecione o assunto</option>';
        (config.assuntos || []).forEach(assunto => {
            const option = document.createElement('option');
            option.value = assunto;
            option.textContent = assunto;
            assuntoSelect.appendChild(option);
        });
    }
    
    // Event listeners para mudança de cidade e data
    cidadeSelect.addEventListener('change', carregarAgenda);
    document.getElementById('dataAgenda').addEventListener('change', carregarAgenda);

    // -----------------------
    // Modal de Consulta
    // -----------------------
    const consultaCidade = document.getElementById('consultaCidade');
    const consultaTecnico = document.getElementById('consultaTecnico');
    const consultaStatus = document.getElementById('consultaStatus');
    const consultaTipoOs = document.getElementById('consultaTipoOs');

    if (consultaCidade) {
        consultaCidade.innerHTML = '<option value="">Todas</option>';
        (config.cidades || []).forEach(c => {
            const o = document.createElement('option');
            o.value = c;
            o.textContent = c;
            consultaCidade.appendChild(o);
        });
    }

    if (consultaTecnico) {
        consultaTecnico.innerHTML = '<option value="">Todos</option>';
        (config.tecnicos || []).forEach(t => {
            const o = document.createElement('option');
            o.value = t;
            o.textContent = t;
            consultaTecnico.appendChild(o);
        });
    }

    if (consultaStatus) {
        consultaStatus.innerHTML = '<option value="">Todos</option>';
        (config.statusPossiveis || ['Aberta','Agendada','Em andamento','Concluída','Cancelada']).forEach(s => {
            const o = document.createElement('option');
            o.value = s;
            o.textContent = getStatusLabel(s);
            consultaStatus.appendChild(o);
        });
    }

    if (consultaTipoOs) {
        consultaTipoOs.innerHTML = '<option value="">Todos</option>';
        (config.tiposOS || ['FIBRA','RADIO','Indefinido']).forEach(tp => {
            const o = document.createElement('option');
            o.value = tp;
            o.textContent = tp;
            consultaTipoOs.appendChild(o);
        });
    }
}

// Configurar interface
function setupInterface() {
    // Configurar data padrão
    document.getElementById('dataAgenda').value = dataAtual;
    applyPermissionVisibility();

    const saveBtn = document.querySelector('#dashboardEditForm .btn-salvar');
    const predialField = document.getElementById('dashboardEditPredial')?.closest('.form-group');
    const canEditAgenda = hasPermission('agenda.edit');
    if (saveBtn) saveBtn.style.display = canEditAgenda ? '' : 'none';
    if (predialField) predialField.style.display = canEditAgenda ? '' : 'none';
    
    // Event listeners
    setupEventListeners();
}

// Configurar event listeners
function setupEventListeners() {
    ensureDashboardEditPredialField();
    ensureDashboardUnallocateButton();
    // Formulário de nova OS
    const novaOsForm = document.getElementById('novaOsForm');
    if (novaOsForm) {
        novaOsForm.addEventListener('submit', handleNovaOsSubmit);
    }
    
    // Clique fora do dropdown do usuário para fechar
    document.addEventListener('click', function(e) {
        const userMenu = document.querySelector('.user-menu');
        const userDropdown = document.getElementById('userDropdown');
        
        if (userMenu && userDropdown && !userMenu.contains(e.target)) {
            userDropdown.classList.remove('show');
        }
    });
    
    // Toggle menu no dashboard
    const menuToggleBtn = document.getElementById('menuToggleBtn');
    if (menuToggleBtn) {
        menuToggleBtn.addEventListener('click', toggleSidebar);
    }
    
    // O sistema de modo escuro agora é gerenciado pelo dark-mode-system.js

    // Event listener para o novo modal de edição do dashboard
    const dashboardEditForm = document.getElementById('dashboardEditForm');
    if (dashboardEditForm) {
        dashboardEditForm.addEventListener('submit', async function(event) {
            event.preventDefault();
            if (!hasPermission('agenda.edit')) {
                showToast('Você não tem permissão para editar agendamentos.', 'error');
                return;
            }
            const id = document.getElementById('dashboardEditId').value;
            const data = {
                observacoes: document.getElementById('dashboardEditObservacao')?.value || '',
                tipo_instalacao: document.getElementById('dashboardEditPredial')?.checked ? 'PREDIAL' : 'RESIDENCIAL'
            };
        
            try {
                const response = await fetch(`/api/agendamentos/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
        
                if (response.ok) {
                    showToast('Agendamento atualizado com sucesso!', 'success');
                    fecharModalDashboard();
                    invalidateAgendaCache();
                    await carregarAgenda();
                } else {
                    const err = await response.json().catch(() => ({}));
                    showToast(err?.error || 'Erro ao atualizar agendamento.', 'error');
                }
            } catch (error) {
                showToast('Erro de conexão.', 'error');
            }
        });
    }

    // =======================
    // CONSULTA (FILTROS + PAGINAÇÃO)
    // =======================
    const btnAbrirConsulta = document.getElementById('btnAbrirConsulta');
    if (btnAbrirConsulta) {
        btnAbrirConsulta.addEventListener('click', () => abrirConsultaModal());
    }

    const btnSyncIxc = document.getElementById('btnSyncIxc');
    if (btnSyncIxc) {
        btnSyncIxc.addEventListener('click', async () => {
            atualizarSyncStatus('Sincronizando IXC…');
            const ok = await syncIxcIfPossible(true, 'full');
            if (ok) {
                await reloadConfigSilently();
                await Promise.all([carregarAgendamentosAguardando(), carregarAgenda()]);
                await atualizarSyncStatusRemoto();
            }
        });
    }

    const btnPeriodoManha = document.getElementById('btnPeriodoManha');
    const btnPeriodoTarde = document.getElementById('btnPeriodoTarde');
    if (btnPeriodoManha) btnPeriodoManha.addEventListener('click', () => mudarPeriodoVisualizacao('MANHÃ'));
    if (btnPeriodoTarde) btnPeriodoTarde.addEventListener('click', () => mudarPeriodoVisualizacao('TARDE'));

    const btnFecharConsulta = document.getElementById('btnFecharConsulta');
    if (btnFecharConsulta) {
        btnFecharConsulta.addEventListener('click', fecharConsultaModal);
    }

    const consultaModal = document.getElementById('consultaModal');
    if (consultaModal) {
        consultaModal.addEventListener('click', (e) => {
            if (e.target === consultaModal) fecharConsultaModal();
        });
    }

    const btnBuscarConsulta = document.getElementById('btnBuscarConsulta');
    if (btnBuscarConsulta) {
        btnBuscarConsulta.addEventListener('click', (e) => {
            e.preventDefault();
            consultarAgendamentos(1);
        });
    }

    const btnLimparConsulta = document.getElementById('btnLimparConsulta');
    if (btnLimparConsulta) {
        btnLimparConsulta.addEventListener('click', limparConsulta);
    }

    const consultaPrev = document.getElementById('consultaPrev');
    const consultaNext = document.getElementById('consultaNext');
    if (consultaPrev) consultaPrev.addEventListener('click', () => consultarAgendamentos(consultaState.page - 1));
    if (consultaNext) consultaNext.addEventListener('click', () => consultarAgendamentos(consultaState.page + 1));

    const consultaCliente = document.getElementById('consultaCliente');
    if (consultaCliente) {
        // debounce para não bater na API a cada tecla
        let t = null;
        consultaCliente.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(() => consultarAgendamentos(1), 450);
        });
        consultaCliente.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                consultarAgendamentos(1);
            }
        });
    }

    const consultaPageSize = document.getElementById('consultaPageSize');
    if (consultaPageSize) {
        consultaPageSize.addEventListener('change', () => consultarAgendamentos(1));
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('agendaSidebar');
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
    }
}

// Configurar drag and drop
// Configurar drag and drop (Versão Corrigida e Anti-Spam)
function setupDragAndDrop() {
    if (!hasPermission('agenda.allocate')) return;
    // Variável local para controlar o spam de alertas DURANTE o arrastar
    let lastAlertTime = 0;

    setTimeout(() => {
        const aguardandoContainer = document.getElementById('agendamentosAguardando');
        if (aguardandoContainer && aguardandoContainer.dataset.sortableBound !== '1') {
            aguardandoContainer.dataset.sortableBound = '1';
            new Sortable(aguardandoContainer, {
                group: { name: 'agendamentos', pull: true, put: false },
                animation: 150,
                ghostClass: 'sortable-ghost',
                // Impede que cliques em botões dentro do card iniciem o drag
                filter: '.agendamento-delete-btn',
                preventOnFilter: false,
            });
        }

        const vagasContainers = document.querySelectorAll('.vagas-container');
        vagasContainers.forEach(container => {
            if (container.dataset.sortableBound === '1') return;
            container.dataset.sortableBound = '1';
            new Sortable(container, {
                group: {
                    name: 'agendamentos',
                    pull: true,
                    put: function (to, from, draggedEl) {
                        // Verificação de tempo para não spamar o processador
                        const now = Date.now();
                        const shouldAlert = (now - lastAlertTime > 2000); // Só alerta a cada 2 segundos

                        try {
                            // Validação 1: Tipo de OS
                            // OBS: Algumas OS antigas não têm tipo_os no banco; nesses casos
                            // tratamos como "Indefinido" e NÃO bloqueamos o drop.
                            const tipoItem = (draggedEl.dataset.tipo || 'Indefinido');
                            // Só valida quando o tipo vier preenchido e não for "Indefinido"
                            if (tipoItem && tipoItem !== 'Indefinido' && tipoItem !== tipoAgendaAtual) {
                                if (shouldAlert) {
                                    showToast(`Agenda de ${tipoAgendaAtual} não aceita OS de ${tipoItem}.`, 'error');
                                    lastAlertTime = now;
                                }
                                return false;
                            }
                    
                            // Validação 2: Cidade
                            const itemCidade = draggedEl.dataset.cidade;
                            // Normaliza as strings para evitar erro por maiúscula/minúscula
                            if (itemCidade && itemCidade.toUpperCase() !== cidadeAtual.toUpperCase()) {
                                if (shouldAlert) {
                                    showToast(`Esta OS é para ${itemCidade}, mas a agenda atual é para ${cidadeAtual}.`, 'error');
                                    lastAlertTime = now;
                                }
                                return false;
                            }
                    
                            // Validação 3: Limite de Vagas
                            const tipoVaga = to.el.dataset.assunto;
                            const limiteTotal = parseInt(to.el.dataset.limite) || 0;
                            const vagasJaOcupadas = Array.from(to.el.querySelectorAll('.vaga-ocupada, .vaga-reservada-os'))
                                .reduce((acc, el) => acc + Math.max(Number(el.dataset.vagasConsumidas || 1), 1), 0);
                            const vagasFechadas = to.el.querySelectorAll('.vaga-fechada').length;
                            const vagasDisponiveis = limiteTotal - vagasFechadas;
                            const vagasNecessarias = Math.max(Number(draggedEl.dataset.vagasOcupadas || 1), 1);

                            if ((vagasJaOcupadas + vagasNecessarias) > vagasDisponiveis) {
                                if (shouldAlert) {
                                    showToast(`Não há vagas suficientes para '${tipoVaga}'. Esta OS precisa de ${vagasNecessarias} vaga(s).`, 'warning');
                                    lastAlertTime = now;
                                }
                                return false;
                            }

                            return true; // Tudo certo, permite soltar
                
                        } catch (error) {
                            console.error("Erro na validação 'put':", error);
                            return false;
                        }
                    }
                },
                filter: '.vaga-vazia, .vaga-fechada', 
                animation: 150,
                ghostClass: 'sortable-ghost',
                onAdd: function(evt) {
                    handleDropAgendamento(evt);
                }
            });
        });
    }, 1000);
}

// Carregar dados iniciais
async function syncIxcIfPossible(showFeedback = false, mode = 'light') {
    if (!hasPermission('ixc.sync')) return false;
    if (ixcSyncInFlight) return false;
    ixcSyncInFlight = true;
    try {
        const response = await fetch(`/api/ixc/sync?mode=${encodeURIComponent(mode)}`, { method: 'POST' });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Falha na sincronização com o IXC');
        }
        const payload = await response.json();
        if (showFeedback && payload?.summary) {
            const s = payload.summary;
            showToast(`IXC sincronizado · setor 6 · ${s.created || 0} nova(s), ${s.updated || 0} atualizada(s), ${s.finalized || 0} finalizada(s)`, 'success');
        }
        return true;
    } catch (error) {
        console.error('Erro ao sincronizar IXC:', error);
        if (showFeedback) showToast(error.message || 'Erro ao sincronizar com o IXC', 'error');
        return false;
    } finally {
        ixcSyncInFlight = false;
    }
}

function startIxcRealtimeSync() {
    if (!hasPermission('ixc.sync')) return;
    if (ixcSyncInterval) clearInterval(ixcSyncInterval);
    ixcSyncInterval = setInterval(async () => {
        await atualizarSyncStatusRemoto();
        const ok = await syncIxcIfPossible(false, 'light');
        if (ok) {
            await reloadConfigSilently();
            await Promise.all([
                carregarAgendamentosAguardando(),
                carregarAgenda()
            ]);
            await atualizarSyncStatusRemoto();
        }
    }, 30000);
}

function atualizarSyncStatus(texto) {
    const el = document.getElementById('ixcSyncStatus');
    if (el) el.textContent = texto;
}

async function atualizarSyncStatusRemoto() {
    try {
        const response = await fetch('/api/ixc/sync-status');
        if (!response.ok) return;
        const payload = await response.json();
        const summary = payload?.summary;
        if (!summary?.syncedAt && !summary?.updated_at) {
            atualizarSyncStatus('Quadro local carregado · sync IXC automática a cada 30s');
            return;
        }
        const dataRef = summary.syncedAt || summary.updated_at;
        atualizarSyncStatus(`Última sync IXC: ${formatSaoPauloDateTime(dataRef)}`);
    } catch (_) {}
}

async function loadInitialData() {
    atualizarSyncStatus('Carregando quadro local…');
    await Promise.all([
        carregarAgendamentosAguardando(),
        carregarAgenda()
    ]);
    await atualizarSyncStatusRemoto();
    if (hasPermission('ixc.sync')) {
        setTimeout(async () => {
            atualizarSyncStatus('Sincronizando IXC na inicializacao…');
            const ok = await syncIxcIfPossible(false, 'full');
            if (ok) {
                await reloadConfigSilently();
                await Promise.all([carregarAgendamentosAguardando(), carregarAgenda()]);
                await atualizarSyncStatusRemoto();
            }
        }, 300);
    }
    startIxcRealtimeSync();
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

// Toggle user menu
function toggleUserMenu() {
    const userDropdown = document.getElementById('userDropdown');
    if (userDropdown) {
        userDropdown.classList.toggle('show');
    }
}


async function reloadConfigSilently() {
    try {
        const cidadeSelecionada = document.getElementById('cidadeAgenda')?.value || cidadeAtual || '';
        const response = await fetch('/api/config');
        if (!response.ok) return;
        config = await response.json();
        window.config = config;
        populateSelects();
        if (cidadeSelecionada && (config.cidades || []).includes(cidadeSelecionada)) {
            document.getElementById('cidadeAgenda').value = cidadeSelecionada;
            cidadeAtual = cidadeSelecionada;
            document.getElementById('cidadeAtual').textContent = `${cidadeAtual} - ${tipoAgendaAtual}`;
        }
    } catch (_) {}
}

// Buscar cliente
async function buscarCliente() {
    const clienteId = document.getElementById('clienteId').value.trim();
    
    if (!clienteId) {
        showToast('Digite o ID do cliente', 'warning');
        return;
    }
    
    try {
        const response = await fetch(`/api/ixc/cliente/${clienteId}`);
        
        if (response.ok) {
            const data = await response.json();
            document.getElementById("clienteNome").value = data.razao;
            showToast("Cliente encontrado!", "success");
        } else {
            const error = await response.json();
            showToast(error.erro || 'Cliente não encontrado', 'error');
            document.getElementById('clienteNome').value = '';
        }
    } catch (error) {
        console.error('Erro ao buscar cliente:', error);
        showToast('Erro ao buscar cliente', 'error');
    }
}

// Manipular envio do formulário de nova OS
async function handleNovaOsSubmit(event) {
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const data = Object.fromEntries(formData.entries());
    
    // Validações
    if (!data.cliente) {
        showToast('Busque o cliente primeiro', 'warning');
        return;
    }
    if (!data.cidade) {
        showToast('Selecione a cidade', 'warning');
        return;
    }
    if (!data.assunto) {
        showToast('Selecione o assunto', 'warning');
        return;
    }
    
    data.status = 'Aberta';
    
    try {
        const response = await fetch('/api/agendamentos', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            showToast('OS adicionada à agenda!', 'success');
            limparFormularioOs();
            await carregarAgendamentosAguardando();
        } else {
            const error = await response.json();
            showToast(error.error || 'Erro ao criar OS', 'error');
        }
    } catch (error) {
        console.error('Erro ao criar OS:', error);
        showToast('Erro ao criar OS', 'error');
    }
}

// Limpar formulário de OS
function limparFormularioOs() {
    document.getElementById('novaOsForm').reset();
    document.getElementById('clienteNome').value = '';
}

// Carregar agendamentos aguardando
async function carregarAgendamentosAguardando() {
    try {
        const response = await fetch('/api/agendamentos'); 
        if (!response.ok) {
            throw new Error('Erro ao carregar agendamentos');
        }
        const todos = await response.json();
        agendamentosAguardando = (todos || []).filter(item => {
            const status = String(item?.status || '').toLowerCase();
            const periodo = String(item?.periodo || '').trim();
            return !['concluída', 'concluida', 'cancelada'].includes(status) && !periodo;
        });
        displayAgendamentosAguardando();
    } catch (error) {
        console.error('Erro ao carregar agendamentos aguardando:', error);
        showToast('Erro ao carregar agendamentos aguardando', 'error');
    }
}


function filtrarAgendamentosAguardando() {
    const filtros = getFiltrosAgendamentoAtivos().map((item) => item.toLowerCase());
    return agendamentosAguardando.filter(agendamento => {
        const cidadeItem = String(agendamento?.cidade || '').trim();
        if (filtroAgendamentoCidade && cidadeItem !== filtroAgendamentoCidade) return false;

        const statusItem = String(getDisplayStatus(agendamento) || '').trim();
        if (filtroAgendamentoStatus && statusItem !== filtroAgendamentoStatus) return false;

        if (!filtros.length) return true;

        const origemId = String(agendamento?.ixc_os_id || agendamento?.id || '').trim();
        const obs = String(agendamento?.observacoes || '').trim();
        const obsResumida = obs.length > 80 ? `${obs.slice(0, 80)}...` : obs;
        const termos = [
            origemId,
            agendamento?.cliente,
            agendamento?.assunto,
            agendamento?.cidade,
            agendamento?.tipo_os,
            obsResumida,
            getDisplayStatus(agendamento),
        ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

        return filtros.every((filtro) => termos.includes(filtro));
    });
}

// Exibir agendamentos aguardando
function displayAgendamentosAguardando() {
    const container = document.getElementById('agendamentosAguardando');
    if (!container) return;
    
    container.innerHTML = '';
    
    const listaFiltrada = filtrarAgendamentosAguardando();

    if (listaFiltrada.length === 0) {
        const mensagem = getFiltrosAgendamentoAtivos().length
            ? 'Nenhum agendamento encontrado para o filtro informado'
            : 'Nenhuma OS aguardando agendamento';
        container.innerHTML = `<p style="text-align: center; color: var(--medium-gray); padding: 1rem;">${mensagem}</p>`;
        return;
    }
    
    const canDelete = Array.isArray(window.currentUser?.permissions)
        && window.currentUser.permissions.includes('agenda.delete');

    listaFiltrada.forEach(agendamento => {
        const item = document.createElement('div');
        item.className = 'agendamento-item';
        item.dataset.id = agendamento.id;
        item.dataset.assunto = agendamento.assunto;
        item.dataset.cidade = agendamento.cidade;
        // OS antigas podem não ter tipo_os no banco
        item.dataset.tipo = agendamento.tipo_os || 'Indefinido';
        item.dataset.vagasOcupadas = getVagasOcupadas(agendamento);
        item.dataset.tipoInstalacao = agendamento.tipo_instalacao || 'RESIDENCIAL';


        const origemId = agendamento.ixc_os_id || agendamento.id;
        const obs = String(agendamento.observacoes || '').trim();
        const obsResumida = obs.length > 120 ? `${obs.slice(0, 120)}…` : obs;
        const assuntoLabel = String(agendamento.assunto || '').trim() || 'Sem assunto';
        const cidadeLabel = String(agendamento.cidade || '').trim() || 'Cidade não informada';
        const statusLabel = String(agendamento.status || 'Aberta').trim();
        item.innerHTML = `
            <div class="agendamento-card-top">
                <span class="agendamento-id">#${origemId}</span>
                <span class="agendamento-tipo">${agendamento.tipo_os || 'Indefinido'}</span>
                ${canDelete ? `
                    <button class="agendamento-delete-btn" title="Excluir agendamento">
                        <i class="fas fa-trash"></i>
                    </button>
                ` : ''}
            </div>
            <div class="agendamento-cliente">${agendamento.cliente || 'Cliente não informado'}</div>
            <div class="agendamento-assunto-row">
                <span class="agendamento-assunto">${assuntoLabel}</span>
            </div>
            <div class="agendamento-meta-grid">
                <span class="agendamento-meta-chip"><i class="fas fa-map-marker-alt"></i>${cidadeLabel}</span>
                <span class="agendamento-meta-chip"><i class="fas fa-info-circle"></i>${statusLabel}</span>
            </div>
            ${obsResumida ? `<div class="agendamento-obs">${obsResumida}</div>` : ''}
        `;

        if (canDelete) {
            const btn = item.querySelector('.agendamento-delete-btn');
            if (btn) {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    excluirAgendamento(agendamento.id);
                });
            }
        }
        
        container.appendChild(item);
    });
}

// =======================
// CONSULTA (FILTROS + PAGINAÇÃO + ORDENAÇÃO)
// =======================
function abrirConsultaModal() {
    const modal = document.getElementById('consultaModal');
    if (!modal) return;
    modal.style.display = 'flex';

    // Defaults amigáveis: último 7 dias
    const ini = document.getElementById('consultaDataIni');
    const fim = document.getElementById('consultaDataFim');
    if (ini && !ini.value) {
        const d = new Date();
        d.setDate(d.getDate() - 7);
        ini.value = d.toISOString().slice(0, 10);
    }
    if (fim && !fim.value) {
        fim.value = new Date().toISOString().slice(0, 10);
    }

    const ps = document.getElementById('consultaPageSize');
    if (ps) {
        consultaState.pageSize = parseInt(ps.value || '25', 10) || 25;
    }

    consultarAgendamentos(1);
}

function fecharConsultaModal() {
    const modal = document.getElementById('consultaModal');
    if (!modal) return;
    modal.style.display = 'none';
}

function limparConsulta() {
    const ids = [
        'consultaCliente',
        'consultaCidade',
        'consultaTecnico',
        'consultaStatus',
        'consultaPeriodo',
        'consultaTipoOs',
        'consultaDataIni',
        'consultaDataFim',
        'consultaOrdenacao',
        'consultaPageSize'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === 'INPUT') el.value = '';
        if (el.tagName === 'SELECT') el.selectedIndex = 0;
    });
    consultarAgendamentos(1);
}

function getConsultaParams() {
    const get = (id) => (document.getElementById(id)?.value || '').trim();

    const ordenacao = get('consultaOrdenacao');
    let sort_by = 'data_hora', sort_dir = 'desc';
    if (ordenacao) {
        const [by, dir] = ordenacao.split(':');
        if (by) sort_by = by;
        if (dir) sort_dir = dir;
    }

    return {
        cliente: get('consultaCliente'),
        cidade: get('consultaCidade'),
        tecnico: get('consultaTecnico'),
        status: get('consultaStatus'),
        periodo: get('consultaPeriodo'),
        tipo_os: get('consultaTipoOs'),
        data_inicio: get('consultaDataIni'),
        data_fim: get('consultaDataFim'),
        sort_by,
        sort_dir,
    };
}

async function consultarAgendamentos(targetPage = 1) {
    const tbody = document.getElementById('consultaTbody');
    const metaEl = document.getElementById('consultaMeta');
    const pageInfo = document.getElementById('consultaPageInfo');
    const btnPrev = document.getElementById('consultaPrev');
    const btnNext = document.getElementById('consultaNext');

    if (!tbody) return;

    const ps = document.getElementById('consultaPageSize');
    if (ps) {
        consultaState.pageSize = parseInt(ps.value || String(consultaState.pageSize), 10) || consultaState.pageSize;
    }

    const pageNum = Math.max(parseInt(targetPage || 1, 10) || 1, 1);

    const params = getConsultaParams();
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
        if (v) qs.set(k, v);
    });
    qs.set('page', String(pageNum));
    qs.set('page_size', String(consultaState.pageSize));

    // loading
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 12px;">Carregando...</td></tr>`;
    if (metaEl) metaEl.textContent = '';

    try {
        const resp = await fetch(`/api/agendamentos/search?${qs.toString()}`);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || 'Erro ao consultar');
        }
        const data = await resp.json();

        const rows = data.rows || [];
        const meta = data.meta || {};

        consultaState.page = meta.page || pageNum;
        consultaState.totalPages = meta.total_pages || 1;
        consultaState.total = meta.total || 0;
        consultaState.lastMeta = meta;

        renderConsultaRows(rows);

        if (metaEl) {
            metaEl.textContent = `Total: ${consultaState.total} • Página ${consultaState.page} de ${consultaState.totalPages}`;
        }
        if (pageInfo) {
            pageInfo.textContent = `${consultaState.page}/${consultaState.totalPages}`;
        }
        if (btnPrev) btnPrev.disabled = consultaState.page <= 1;
        if (btnNext) btnNext.disabled = consultaState.page >= consultaState.totalPages;

    } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 12px;">${e.message}</td></tr>`;
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
    }
}

function formatDateTimeBR(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function renderConsultaRows(rows) {
    const tbody = document.getElementById('consultaTbody');
    if (!tbody) return;

    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 12px;">Nenhum resultado</td></tr>`;
        return;
    }

    tbody.innerHTML = '';
    rows.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>#${r.id}</td>
            <td>${(r.cliente || '').toString()}</td>
            <td>${(r.cidade || '').toString()}</td>
            <td>${(r.assunto || '').toString()}</td>
            <td>${getStatusLabel((r.status || '').toString())}</td>
            <td>${(r.tecnico || '').toString()}</td>
            <td>${formatDateTimeBR(r.data_hora || r.created_at)}</td>
            <td>${(r.tipo_os || '').toString()}</td>
`;
        tbody.appendChild(tr);
    });
}

// Carregar agenda
async function carregarAgenda() {
    const cidade = document.getElementById('cidadeAgenda').value;
    const data = document.getElementById('dataAgenda').value;
    
    if (!cidade || !data) return;
    
    cidadeAtual = cidade;
    dataAtual = data;
    
    try {
        // A URL agora inclui o tipo de agenda
        const response = await fetch(`/api/vagas-detalhadas/${cidade}/${tipoAgendaAtual}/${data}`);
        
        if (response.ok) {
            const vagasData = await response.json();
            // monta cache em formato compatível com o layout atual
vagasFechadas = {};
try {
    const vf = vagasData.vagasFechadas || {};
    ['MANHÃ','TARDE'].forEach(periodo => {
        const byAssunto = vf[periodo] || {};
        Object.keys(byAssunto).forEach(assunto => {
            const key = `${cidadeAtual}_${dataAtual}_${tipoAgendaAtual}_${periodo}_${assunto}`;
            vagasFechadas[key] = (byAssunto[assunto] || []).map(n => Number(n));
        });
    });
} catch (_) {}
displayAgenda(vagasData);
            document.getElementById('cidadeAtual').textContent = `${cidade} - ${tipoAgendaAtual}`;
        } else {
            const error = await response.json();
            showToast(error.error || 'Erro ao carregar agenda', 'error');
        }
    } catch (error) {
        console.error('Erro ao carregar agenda:', error);
        showToast('Erro ao carregar agenda', 'error');
    }
}

// Exibir agenda
function displayAgenda(data) {
    const template = data?.template || {};
    const agendamentos = data?.agendamentos || {};
    const board = document.getElementById('kanbanBoard');
    if (!board) return;

    const assuntos = template[currentPeriodoView] || {};
    const ocupadasPorAssunto = agendamentos[currentPeriodoView] || {};

    board.innerHTML = '';

    const assuntosOrdenados = Object.keys(assuntos).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    if (!assuntosOrdenados.length) {
        board.innerHTML = '<div class="kanban-empty-state">Nenhuma coluna configurada para este período.</div>';
        setupDragAndDrop();
        return;
    }

    assuntosOrdenados.forEach((assunto) => {
        const total = Number(assuntos[assunto] || 0);
        const column = document.createElement('div');
        column.className = 'kanban-column';

        const header = document.createElement('div');
        header.className = 'kanban-column-header';
        header.innerHTML = `
            <div class="kanban-column-top">
                <div class="kanban-column-title-wrap">
                    <div class="kanban-column-title" title="${assunto}">${assunto}</div>
                    <div class="kanban-column-meta">${total} vaga(s)</div>
                </div>
                ${canAdjustVagas ? `
                    <div class="capacity-actions" title="Ajustar quantidade de vagas deste assunto">
                        <button class="capacity-btn capacity-minus" type="button" data-capacity-action="minus" data-assunto="${assunto}" aria-label="Retirar vaga">
                            <i class="fas fa-minus"></i>
                        </button>
                        <button class="capacity-btn capacity-plus" type="button" data-capacity-action="plus" data-assunto="${assunto}" aria-label="Adicionar vaga">
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>` : ''}
            </div>
        `;
        if (canAdjustVagas) {
            header.querySelector('[data-capacity-action="minus"]')?.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    await ajustarCapacidadeVaga({ city: cidadeAtual, tipo_os: tipoAgendaAtual, periodo: currentPeriodoView, assunto, delta: -1, day: dataAtual });
                    showToast(`Vaga removida de ${assunto}`, 'success');
                    invalidateAgendaCache();
                    await carregarAgenda();
                } catch (error) {
                    showToast(error.message || 'Erro ao retirar vaga', 'error');
                }
            });
            header.querySelector('[data-capacity-action="plus"]')?.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    await ajustarCapacidadeVaga({ city: cidadeAtual, tipo_os: tipoAgendaAtual, periodo: currentPeriodoView, assunto, delta: 1, day: dataAtual });
                    showToast(`Vaga adicionada em ${assunto}`, 'success');
                    invalidateAgendaCache();
                    await carregarAgenda();
                } catch (error) {
                    showToast(error.message || 'Erro ao adicionar vaga', 'error');
                }
            });
        }

        const container = document.createElement('div');
        container.className = 'vagas-container kanban-cards';
        container.id = getContainerId(currentPeriodoView, assunto);
        container.dataset.assunto = assunto;
        container.dataset.periodo = currentPeriodoView;
        container.dataset.limite = total;

        const vagaKeyNew = `${cidadeAtual}_${dataAtual}_${tipoAgendaAtual}_${currentPeriodoView}_${assunto}`;
        const vagaKeyOld = `${cidadeAtual}_${dataAtual}_${currentPeriodoView}_${assunto}`;
        const indicesFechados = Array.from(new Set([
            ...(vagasFechadas[vagaKeyNew] || []),
            ...(vagasFechadas[vagaKeyOld] || []),
        ]));

        const ocupadas = ocupadasPorAssunto[assunto] || [];
        let vagasConsumidas = 0;
        ocupadas.forEach(agendamento => {
            const vagaElement = createVagaElement(agendamento);
            container.appendChild(vagaElement);
            vagasConsumidas += getVagasOcupadas(agendamento);
            const reservasExtras = getVagasOcupadas(agendamento) - 1;
            for (let extra = 0; extra < reservasExtras; extra++) {
                container.appendChild(createReservedSlotElement(agendamento, extra + 1));
            }
        });

        const disponiveis = Math.max(total - vagasConsumidas, 0);
        for (let i = 0; i < disponiveis; i++) {
            if (indicesFechados.includes(i)) {
                const vagaFechada = document.createElement('div');
                vagaFechada.className = 'vaga-fechada';
                const btnReabrir = document.createElement('button');
                btnReabrir.className = 'btn-reabrir-vaga';
                btnReabrir.innerHTML = `<i class="fas fa-unlock"></i> Reabrir`;
                btnReabrir.addEventListener('click', () => reabrirVagaUnica(currentPeriodoView, assunto, i));
                vagaFechada.appendChild(btnReabrir);
                container.appendChild(vagaFechada);
            } else {
                const slotVazio = document.createElement('div');
                slotVazio.className = 'vaga-vazia';
                const texto = document.createElement('span');
                texto.textContent = 'Arraste uma OS aqui';
                const btnFechar = document.createElement('button');
                btnFechar.className = 'btn-indisponibilizar-vaga';
                btnFechar.title = 'Tornar vaga indisponível';
                btnFechar.innerHTML = `<i class="fas fa-times"></i>`;
                btnFechar.addEventListener('click', () => fecharVagaUnica(currentPeriodoView, assunto, i));
                slotVazio.appendChild(texto);
                slotVazio.appendChild(btnFechar);
                container.appendChild(slotVazio);
            }
        }

        column.appendChild(header);
        column.appendChild(container);
        board.appendChild(column);
    });

    setupDragAndDrop();
}

function mudarPeriodoVisualizacao(periodo) {
    currentPeriodoView = periodo;
    document.getElementById('btnPeriodoManha')?.classList.toggle('active', periodo === 'MANHÃ');
    document.getElementById('btnPeriodoTarde')?.classList.toggle('active', periodo === 'TARDE');
    carregarAgenda();
}

// NOVA FUNÇÃO para fechar uma vaga INDIVIDUAL
function fecharVagaUnica(periodo, assunto, index) {
    const vagaKey = `${cidadeAtual}_${dataAtual}_${tipoAgendaAtual}_${periodo}_${assunto}`;
    const vagaKeyOld = `${cidadeAtual}_${dataAtual}_${periodo}_${assunto}`;
    
    if (!vagasFechadas[vagaKey]) {
        vagasFechadas[vagaKey] = [];
    }
    
    if (!vagasFechadas[vagaKey].includes(index)) {
        vagasFechadas[vagaKey].push(index);
    }

    // limpeza/migração: remove do formato antigo pra evitar contagem duplicada
    if (vagasFechadas[vagaKeyOld]) {
        vagasFechadas[vagaKeyOld] = (vagasFechadas[vagaKeyOld] || []).filter(i => i !== index);
        if (vagasFechadas[vagaKeyOld].length === 0) delete vagasFechadas[vagaKeyOld];
    }

    // persiste no servidor
fetch('/api/vagas-fechadas', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cidade: cidadeAtual, data: dataAtual, tipo: tipoAgendaAtual, periodo, assunto, index, closed: true })
}).then(() => {
    invalidateAgendaCache();
    return carregarAgenda();
}).catch(() => {
    invalidateAgendaCache();
    return carregarAgenda();
});
    showToast('Vaga indisponibilizada com sucesso!', 'success');
}

// NOVA FUNÇÃO para reabrir uma vaga INDIVIDUAL
function reabrirVagaUnica(periodo, assunto, index) {
    const vagaKey = `${cidadeAtual}_${dataAtual}_${tipoAgendaAtual}_${periodo}_${assunto}`;
    const vagaKeyOld = `${cidadeAtual}_${dataAtual}_${periodo}_${assunto}`;
    
    if (vagasFechadas[vagaKey]) {
        vagasFechadas[vagaKey] = vagasFechadas[vagaKey].filter(i => i !== index);
    }

    // também garante reabertura caso ainda exista no formato antigo
    if (vagasFechadas[vagaKeyOld]) {
        vagasFechadas[vagaKeyOld] = vagasFechadas[vagaKeyOld].filter(i => i !== index);
        if (vagasFechadas[vagaKeyOld].length === 0) delete vagasFechadas[vagaKeyOld];
    }

    // persiste no servidor
fetch('/api/vagas-fechadas', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cidade: cidadeAtual, data: dataAtual, tipo: tipoAgendaAtual, periodo, assunto, index, closed: false })
}).then(() => {
    invalidateAgendaCache();
    return carregarAgenda();
}).catch(() => {
    invalidateAgendaCache();
    return carregarAgenda();
});
    showToast('Vaga reaberta com sucesso!', 'success');
}

// Criar elemento de vaga ocupada
function createVagaElement(agendamento) {
    const vaga = document.createElement('div');
    vaga.className = 'vaga-ocupada';
    vaga.dataset.id = agendamento.id;
    vaga.dataset.vagasConsumidas = 1;
    vaga.dataset.assunto = agendamento.assunto || '';
    vaga.dataset.cidade = agendamento.cidade || '';
    vaga.dataset.tipo = agendamento.tipo_os || 'Indefinido';
    vaga.dataset.vagasOcupadas = getVagasOcupadas(agendamento);
    vaga.dataset.tipoInstalacao = agendamento.tipo_instalacao || 'RESIDENCIAL';

    const canDelete = Array.isArray(window.currentUser?.permissions)
        && window.currentUser.permissions.includes('agenda.delete');

    // Adiciona a classe de status ao elemento principal do card
    if (agendamento.status) {
        const statusClass = agendamento.status.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(' ', '-');
        vaga.classList.add(`status-${statusClass}`);
    }

    // Lógica para formatar a hora de forma segura
    let horaFormatada = 'N/A';
    if (agendamento.data_hora) {
        horaFormatada = new Date(agendamento.data_hora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    const statusKey = agendamento.status || 'Status N/D';
    const statusText = STATUS_LABELS[statusKey] || statusKey;
    const statusClass = (statusKey)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(' ', '-');

    // Monta o HTML do card com todas as informações
    vaga.innerHTML = `
        <div class="vaga-header">
            <div class="vaga-header-main">
                <span class="vaga-cliente">${agendamento.cliente}</span>
            </div>
            ${canDelete ? `
                <button class="vaga-remove" data-action="delete" title="Excluir agendamento">
                    <i class="fas fa-trash"></i>
                </button>
            ` : ''}
        </div>
        <div class="vaga-info">
            <span class="vaga-tecnico">
                <i class="fas fa-user-cog"></i> 
                ${agendamento.tecnico || 'A definir'}
            </span>
            ${agendamento.alocado_por ? `
                <span class="vaga-alocado-por" title="Usuário que alocou esta OS na vaga">
                    <i class="fas fa-user-check"></i>
                    ${agendamento.alocado_por}
                </span>
            ` : ''}
            <span class="vaga-status status-${statusClass}">
                ${statusText}
            </span>
        </div>
        ${agendamento.observacoes ? `
            <div class="vaga-obs">
                <strong><i class="fas fa-comment-dots"></i> Obs:</strong> ${agendamento.observacoes}
            </div>
        ` : ''}
    `;

    if (canDelete) {
        const btn = vaga.querySelector('button[data-action="delete"]');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                excluirAgendamento(agendamento.id);
            });
        }
    }

    vaga.addEventListener('click', () => abrirModalDashboard(agendamento));
    return vaga;
}


function createReservedSlotElement(agendamento, ordemExtra = 1) {
    const vaga = document.createElement('div');
    vaga.className = 'vaga-reservada-os';
    vaga.dataset.id = agendamento.id;
    vaga.dataset.vagasConsumidas = 1;
    vaga.innerHTML = `
        <div class="vaga-reservada-topo">
            <span><i class="fas fa-link"></i> Continuação da OS #${agendamento.id}</span>
        </div>
        <div class="vaga-reservada-cliente">${agendamento.cliente}</div>
        <div class="vaga-reservada-texto">Vaga extra reservada para instalação predial (${ordemExtra + 1}/${getVagasOcupadas(agendamento)}).</div>
    `;
    vaga.addEventListener('click', () => abrirModalDashboard(agendamento));
    return vaga;
}

function removerAgendamentoDaTela(id) {
    const normalizedId = String(id);

    document.querySelectorAll(`.vaga-ocupada[data-id="${normalizedId}"], .vaga-reservada-os[data-id="${normalizedId}"]`)
        .forEach((element) => element.remove());

    const aguardandoIndex = agendamentosAguardando.findIndex((item) => String(item?.id) === normalizedId);
    if (aguardandoIndex >= 0) {
        agendamentosAguardando.splice(aguardandoIndex, 1);
        displayAgendamentosAguardando();
    }

    if (!lastAgendaData?.agendamentos) return;

    Object.keys(lastAgendaData.agendamentos).forEach((periodo) => {
        const porAssunto = lastAgendaData.agendamentos?.[periodo] || {};
        Object.keys(porAssunto).forEach((assunto) => {
            porAssunto[assunto] = (porAssunto[assunto] || []).filter((item) => String(item?.id) !== normalizedId);
        });
    });

    displayAgenda(lastAgendaData);
}

// Excluir agendamento (DELETE no banco) e recarregar a UI
async function excluirAgendamento(id) {
    if (!id && id !== 0) return;
    const ok = confirm('Tem certeza que deseja EXCLUIR este agendamento? Essa ação não pode ser desfeita.');
    if (!ok) return;

    try {
        const resp = await fetch(`/api/agendamentos/${id}`, { method: 'DELETE' });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(err?.error || 'Erro ao excluir agendamento', 'error');
            return;
        }
        showToast('Agendamento excluído com sucesso!', 'success');
        fecharModalDashboard();
        invalidateAgendaCache();
        await Promise.all([
            carregarAgenda(),
            carregarAgendamentosAguardando()
        ]);
    } catch (e) {
        showToast('Erro de conexão ao excluir agendamento', 'error');
    }
}

// Handler do botão "Excluir" dentro do modal
function excluirAgendamentoDoDashboard() {
    const id = document.getElementById('dashboardEditId')?.value;
    excluirAgendamento(id);
}

// Manipular drop de agendamento
async function handleDropAgendamento(evt) {
    const agendamentoId = evt.item.dataset.id;
    // Sortable às vezes entrega um container filho; subimos até achar os datasets.
    let targetContainer = evt.to;
    while (targetContainer && targetContainer !== document && (!targetContainer.dataset || (!targetContainer.dataset.periodo || !targetContainer.dataset.assunto))) {
        targetContainer = targetContainer.parentElement;
    }
    if (!targetContainer || !targetContainer.dataset) {
        showToast('Destino inválido para alocar.', 'error');
        return;
    }
    
    evt.item.remove();

    const periodo = targetContainer.dataset.periodo;
    const vagaAssunto = targetContainer.dataset.assunto;
    const dataHora = prepararDataHora(dataAtual, periodo);

    try {
        // Usa a rota /alocar para também gravar o ASSUNTO da vaga.
        const response = await fetch(`/api/agendamentos/${agendamentoId}/alocar`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data_hora: dataHora,
                periodo,
                vaga_assunto: vagaAssunto
            })
        });

        if (response.ok) {
            showToast('Agendamento alocado com sucesso!', 'success');
        } else {
            const err = await response.json().catch(() => ({}));
            showToast(err?.error || 'Erro no servidor ao alocar.', 'error');
        }
    } catch (error) {
        showToast('Erro de conexão ao alocar.', 'error');
    } finally {
        invalidateAgendaCache();
        await Promise.all([
            carregarAgenda(),
            carregarAgendamentosAguardando()
        ]);
    }
}

// Preparar data e hora para o agendamento
function prepararDataHora(data, periodo) {
    const dataObj = new Date(data + 'T00:00:00'); 
    
    if (periodo === 'MANHÃ') {
        dataObj.setHours(9, 0, 0); // 09:00
    } else {
        dataObj.setHours(14, 0, 0); // 14:00
    }
    
    return dataObj.toISOString();
}

// Obter ID do container de vagas
function getContainerId(periodo, assunto) {
    // Prioriza achar pelo dataset (funciona para blocos fixos e dinâmicos)
    const el = document.querySelector(`.vagas-container[data-periodo="${CSS.escape(periodo)}"][data-assunto="${CSS.escape(assunto)}"]`);
    if (el?.id) return el.id;

    // Fallback: id gerado por slug
    const slug = (s) => String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

    return `vaga_${slug(periodo)}_${slug(assunto)}`;
}

// Mudar tipo agenda
function mudarAgenda(tipo) {
    tipoAgendaAtual = tipo; // Atualiza o estado global

    // Atualiza o estilo das abas
    document.getElementById('tab-fibra').classList.toggle('active', tipo === 'FIBRA');
    document.getElementById('tab-radio').classList.toggle('active', tipo === 'RADIO');

    // Recarrega a agenda com o novo tipo selecionado
    carregarAgenda();
}


// Obter ID do contador de vagas
function getCountId(periodo, assunto) {
    const containerId = getContainerId(periodo, assunto);
    return `${containerId}Count`;
}

// Obter informações do container a partir do próprio elemento (data-attributes)
function getContainerInfo(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return [null, null];

    const periodo = String(el.dataset.periodo || "").trim().toUpperCase();
    const assunto = String(el.dataset.assunto || "").trim().toUpperCase();

    return [periodo || null, assunto || null];
}


function abrirModalDashboard(agendamento) {
    console.log("Tentando abrir o modal de edição para o agendamento:", agendamento);
    try {
        if (!agendamento || typeof agendamento.id === 'undefined') {
            console.error("Erro: dados do agendamento inválidos ou ausentes.", agendamento);
            showToast("Não foi possível carregar os dados deste agendamento.", "error");
            return;
        }

        const tecnicoSelect = document.getElementById('dashboardEditTecnico');
        if (tecnicoSelect && config.tecnicos) {
            tecnicoSelect.innerHTML = '<option value="">Selecione um técnico</option>';
            config.tecnicos.forEach(t => tecnicoSelect.innerHTML += `<option value="${t}">${t}</option>`);
        }

        const statusSelect = document.getElementById('dashboardEditStatus');
        if (statusSelect && config.statusPossiveis) {
            statusSelect.innerHTML = '';
            config.statusPossiveis.forEach(s => statusSelect.innerHTML += `<option value="${s}">${getStatusLabel(s)}</option>`);
        }

        document.getElementById('dashboardEditId').value = agendamento.id;
        document.getElementById('dashboardEditTecnico').value = agendamento.tecnico || '';
        document.getElementById('dashboardEditStatus').value = agendamento.status || 'Agendada';
        document.getElementById('dashboardEditObservacao').value = agendamento.observacoes || '';

        // Mostra/oculta o botão de excluir conforme permissão
        const delBtn = document.getElementById('dashboardDeleteBtn');
        const canDelete = Array.isArray(window.currentUser?.permissions)
            && window.currentUser.permissions.includes('agenda.delete');
        if (delBtn) delBtn.style.display = canDelete ? 'inline-flex' : 'none';

        // CORREÇÃO: Usa classList.add('show') para exibir o modal
        const modal = document.getElementById('dashboardEditModal');
        if (modal) {
            modal.classList.add('show');
            console.log("Modal de edição exibido com sucesso.");
        } else {
            console.error("ERRO GRAVE: O elemento do modal 'dashboardEditModal' não foi encontrado no HTML!");
        }

    } catch (error) {
        console.error("Erro catastrófico ao tentar abrir o modal de edição:", error);
        showToast("Ocorreu um erro inesperado ao tentar editar.", "error");
    }
}

// Adicione esta função ao seu ficheiro se ela não existir, ou substitua a existente
function fecharModalDashboard() {
    const modal = document.getElementById('dashboardEditModal');
    if (modal) {
        // CORREÇÃO: Usa classList.remove('show') para esconder o modal
        modal.classList.remove('show');
    }
}

// Função para sair do sistema
function logout() {
    window.location.href = '/logout';
}

async function carregarAgendamentosAguardando() {
    try {
        const response = await fetch('/api/agendamentos');
        if (!response.ok) throw new Error('Erro ao carregar agendamentos');
        const todos = await response.json();
        agendamentosAguardando = (todos || []).filter((item) => {
            const periodo = String(item?.periodo || '').trim();
            return !isAgendamentoFinalizado(item) && !periodo;
        });
        populateAguardandoExtraFilters();
        displayAgendamentosAguardando();
    } catch (error) {
        console.error('Erro ao carregar agendamentos aguardando:', error);
        showToast('Erro ao carregar agendamentos aguardando', 'error');
    }
}

function displayAgendamentosAguardando() {
    const container = document.getElementById('agendamentosAguardando');
    if (!container) return;

    container.innerHTML = '';
    const listaFiltrada = filtrarAgendamentosAguardando();

    if (listaFiltrada.length === 0) {
        const mensagem = getFiltrosAgendamentoAtivos().length
            ? 'Nenhum agendamento encontrado para o filtro informado'
            : 'Nenhuma OS aguardando agendamento';
        container.innerHTML = `<p style="text-align: center; color: var(--medium-gray); padding: 1rem;">${mensagem}</p>`;
        return;
    }

    const canDelete = Array.isArray(window.currentUser?.permissions)
        && window.currentUser.permissions.includes('agenda.delete');

    listaFiltrada.forEach((agendamento) => {
        const item = document.createElement('div');
        item.className = 'agendamento-item';
        item.dataset.id = agendamento.id;
        item.dataset.assunto = agendamento.assunto;
        item.dataset.cidade = agendamento.cidade;
        item.dataset.tipo = agendamento.tipo_os || 'Indefinido';
        item.dataset.vagasOcupadas = getVagasOcupadas(agendamento);
        item.dataset.tipoInstalacao = agendamento.tipo_instalacao || 'RESIDENCIAL';

        const origemId = agendamento.ixc_os_id || agendamento.id;
        const obs = String(agendamento.observacoes || '').trim();
        const obsResumida = obs.length > 80 ? `${obs.slice(0, 80)}...` : obs;
        const assuntoLabel = String(agendamento.assunto || '').trim() || 'Sem assunto';
        const cidadeLabel = String(agendamento.cidade || '').trim() || 'Cidade nao informada';
        const statusLabel = getDisplayStatus(agendamento) || 'Aberta';

        item.innerHTML = `
            <div class="agendamento-card-top">
                <span class="agendamento-id">#${origemId}</span>
                <span class="agendamento-tipo">${agendamento.tipo_os || 'Indefinido'}</span>
                <span class="agendamento-vagas ${isPredial(agendamento) ? 'predial' : 'residencial'}">
                    <i class="fas fa-layer-group"></i>${getVagasOcupadas(agendamento)}
                </span>
                ${canDelete ? `
                    <button class="agendamento-delete-btn" title="Excluir agendamento">
                        <i class="fas fa-trash"></i>
                    </button>
                ` : ''}
            </div>
            <div class="agendamento-cliente">${agendamento.cliente || 'Cliente nao informado'}</div>
            <div class="agendamento-assunto-row">
                <span class="agendamento-assunto">${assuntoLabel}</span>
            </div>
            <div class="agendamento-meta-grid compact">
                <span class="agendamento-meta-chip"><i class="fas fa-map-marker-alt"></i>${cidadeLabel}</span>
                <span class="agendamento-meta-chip"><i class="fas fa-signal"></i>${statusLabel}</span>
            </div>
            ${obsResumida ? `<div class="agendamento-obs">${obsResumida}</div>` : ''}
        `;

        if (canDelete) {
            item.querySelector('.agendamento-delete-btn')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                excluirAgendamento(agendamento.id);
            });
        }

        container.appendChild(item);
    });
}

function createVagaElement(agendamento) {
    const vaga = document.createElement('div');
    const statusClass = getAgendamentoStatusClass(agendamento);
    vaga.className = `vaga-ocupada vaga-ocupada-compacta status-${statusClass}`;
    vaga.dataset.id = agendamento.id;
    vaga.dataset.vagasConsumidas = 1;
    vaga.dataset.assunto = agendamento.assunto || '';
    vaga.dataset.cidade = agendamento.cidade || '';
    vaga.dataset.tipo = agendamento.tipo_os || 'Indefinido';
    vaga.dataset.vagasOcupadas = getVagasOcupadas(agendamento);
    vaga.dataset.tipoInstalacao = agendamento.tipo_instalacao || 'RESIDENCIAL';

    const canDelete = Array.isArray(window.currentUser?.permissions)
        && window.currentUser.permissions.includes('agenda.delete');
    const statusText = getDisplayStatus(agendamento) || 'Status N/D';
    const assuntoLabel = String(agendamento.assunto || '').trim() || 'Sem assunto';

    vaga.innerHTML = `
        <div class="vaga-header">
            <div class="vaga-header-main">
                <span class="vaga-cliente">${agendamento.cliente}</span>
                <div class="vaga-info">
                    <span class="vaga-status status-${statusClass}">${statusText}</span>
                    <span class="vaga-capacidade-badge ${isPredial(agendamento) ? 'predial' : 'residencial'}">
                        <i class="fas fa-layer-group"></i>${getVagasOcupadas(agendamento)} vaga(s)
                    </span>
                </div>
            </div>
            ${canDelete ? `
                <button class="vaga-remove" data-action="delete" title="Excluir agendamento">
                    <i class="fas fa-trash"></i>
                </button>
            ` : ''}
        </div>
        <div class="vaga-info">
            <span class="vaga-assunto-chip" title="Assunto do agendamento">
                <i class="fas fa-tag"></i>${assuntoLabel}
            </span>
        </div>
        ${agendamento.alocado_por ? `
            <div class="vaga-info">
                <span class="vaga-alocado-por" title="Usuario que alocou esta OS na vaga">
                    <i class="fas fa-user-check"></i>${agendamento.alocado_por}
                </span>
            </div>
        ` : ''}
        ${agendamento.observacoes ? `
            <div class="vaga-obs">
                <strong><i class="fas fa-comment-dots"></i> Obs:</strong> ${agendamento.observacoes}
            </div>
        ` : ''}
    `;

    if (canDelete) {
        vaga.querySelector('button[data-action="delete"]')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            excluirAgendamento(agendamento.id);
        });
    }

    vaga.addEventListener('click', () => abrirModalDashboard(agendamento));
    return vaga;
}

function abrirModalDashboard(agendamento) {
    try {
        if (!agendamento || typeof agendamento.id === 'undefined') {
            showToast('Nao foi possivel carregar os dados deste agendamento.', 'error');
            return;
        }
        if (!hasPermission('agenda.edit') && !hasPermission('agenda.allocate') && !hasPermission('agenda.delete')) {
            return;
        }

        ensureDashboardEditPredialField();
        ensureDashboardUnallocateButton();
        document.getElementById('dashboardEditId').value = agendamento.id;
        document.getElementById('dashboardEditObservacao').value = agendamento.observacoes || '';
        const predialInput = document.getElementById('dashboardEditPredial');
        if (predialInput) predialInput.checked = isPredial(agendamento);

        const delBtn = document.getElementById('dashboardDeleteBtn');
        const unallocateBtn = document.getElementById('dashboardUnallocateBtn');
        const saveBtn = document.querySelector('#dashboardEditForm .btn-salvar');
        const canDelete = hasPermission('agenda.delete');
        const canEdit = hasPermission('agenda.edit');
        const canUnallocate = hasPermission('agenda.allocate');
        if (delBtn) delBtn.style.display = canDelete ? 'inline-flex' : 'none';
        if (unallocateBtn) unallocateBtn.style.display = canUnallocate ? 'inline-flex' : 'none';
        if (saveBtn) saveBtn.style.display = canEdit ? 'inline-flex' : 'none';
        if (predialInput?.closest('.form-group')) {
            predialInput.closest('.form-group').style.display = canEdit ? '' : 'none';
        }
        const observacaoInput = document.getElementById('dashboardEditObservacao');
        if (observacaoInput) observacaoInput.disabled = !canEdit;

        const modal = document.getElementById('dashboardEditModal');
        if (modal) modal.classList.add('show');
    } catch (error) {
        console.error('Erro ao abrir modal do dashboard:', error);
        showToast('Ocorreu um erro inesperado ao tentar editar.', 'error');
    }
}

async function tirarAgendamentoDaVaga() {
    if (!hasPermission('agenda.allocate')) {
        showToast('Você não tem permissão para retirar agendamentos da vaga.', 'error');
        return;
    }
    const id = document.getElementById('dashboardEditId')?.value;
    if (!id) return;
    const ok = confirm('Deseja retirar este agendamento da vaga e devolve-lo para aguardando agendamento?');
    if (!ok) return;

    try {
        const response = await fetch(`/api/agendamentos/${id}/desalocar`, { method: 'PUT' });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showToast(err?.error || 'Erro ao retirar agendamento da vaga.', 'error');
            return;
        }
        showToast('Agendamento retirado da vaga com sucesso!', 'success');
        fecharModalDashboard();
        invalidateAgendaCache();
        await Promise.all([carregarAgenda(), carregarAgendamentosAguardando()]);
    } catch (error) {
        showToast('Erro de conexao ao retirar agendamento da vaga.', 'error');
    }
}

async function excluirAgendamento(id) {
    if (!id && id !== 0) return;
    const ok = confirm('Tem certeza que deseja EXCLUIR este agendamento? Essa acao nao pode ser desfeita.');
    if (!ok) return;

    try {
        const resp = await fetch(`/api/agendamentos/${id}`, { method: 'DELETE' });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(err?.error || 'Erro ao excluir agendamento', 'error');
            return;
        }

        removerAgendamentoDaTela(id);
        showToast('Agendamento excluido com sucesso!', 'success');
        fecharModalDashboard();
        invalidateAgendaCache();
        await Promise.all([
            carregarAgenda(),
            carregarAgendamentosAguardando()
        ]);
    } catch (error) {
        showToast('Erro de conexao ao excluir agendamento', 'error');
    }
}

function applyAgendaDataToBoard(cidade, data, payload) {
    cidadeAtual = cidade;
    dataAtual = data;
    lastAgendaData = payload;
    lastAgendaCacheKey = getAgendaCacheKey(cidade, tipoAgendaAtual, data);

    vagasFechadas = {};
    try {
        const vf = payload?.vagasFechadas || {};
        ['MANHÃ', 'TARDE'].forEach((periodo) => {
            const byAssunto = vf[periodo] || {};
            Object.keys(byAssunto).forEach((assunto) => {
                const key = `${cidadeAtual}_${dataAtual}_${tipoAgendaAtual}_${periodo}_${assunto}`;
                vagasFechadas[key] = (byAssunto[assunto] || []).map((n) => Number(n));
            });
        });
    } catch (_) {}

    displayAgenda(payload);
    document.getElementById('cidadeAtual').textContent = `${cidade} - ${tipoAgendaAtual}`;
}

async function carregarAgenda() {
    const cidade = document.getElementById('cidadeAgenda')?.value;
    const data = document.getElementById('dataAgenda')?.value;
    if (!cidade || !data) return;

    const cacheKey = getAgendaCacheKey(cidade, tipoAgendaAtual, data);
    if (agendaCache.has(cacheKey)) {
        applyAgendaDataToBoard(cidade, data, agendaCache.get(cacheKey));
        return;
    }

    if (agendaRequestController) agendaRequestController.abort();
    agendaRequestController = new AbortController();

    try {
        const response = await fetch(`/api/vagas-detalhadas/${cidade}/${tipoAgendaAtual}/${data}`, {
            signal: agendaRequestController.signal
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            showToast(error.error || 'Erro ao carregar agenda', 'error');
            return;
        }

        const vagasData = await response.json();
        agendaCache.set(cacheKey, vagasData);
        applyAgendaDataToBoard(cidade, data, vagasData);
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('Erro ao carregar agenda:', error);
        showToast('Erro ao carregar agenda', 'error');
    } finally {
        agendaRequestController = null;
    }
}

function mudarPeriodoVisualizacao(periodo) {
    currentPeriodoView = periodo;
    document.getElementById('btnPeriodoManha')?.classList.toggle('active', periodo === 'MANHÃ');
    document.getElementById('btnPeriodoTarde')?.classList.toggle('active', periodo === 'TARDE');
    if (lastAgendaData) {
        displayAgenda(lastAgendaData);
        return;
    }
    carregarAgenda();
}
