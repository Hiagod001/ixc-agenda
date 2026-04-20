let currentUser = null;

function $(id){ return document.getElementById(id); }

function showToast(message, type = 'info') {
  const container = $('toastContainer') || document.body;
  let wrapper = $('toastContainer');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'toastContainer';
    wrapper.className = 'toast-container';
    document.body.appendChild(wrapper);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" type="button" aria-label="Fechar">&times;</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => toast.remove());

  wrapper.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

function toggleUserMenu() {
  const dd = $('userDropdown');
  if (dd) dd.classList.toggle('show');
}

async function loadCurrentUser() {
  const res = await fetch('/api/user');
  if (!res.ok) {
    window.location.href = '/login.html';
    return null;
  }
  const user = await res.json();
  $('userName').textContent = user?.name || user?.username || 'Usuário';
  currentUser = user;
  return user;
}

async function loadConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Falha ao carregar configurações');
  return await res.json();
}

function populateSelect(selectEl, items) {
  selectEl.innerHTML = '<option value="">Selecione</option>';
  items.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });
}

function populateSubjects(selectEl, subjects) {
  selectEl.innerHTML = '<option value="">Selecione um assunto</option>';
  subjects.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    selectEl.appendChild(opt);
  });
}

async function buscarCliente() {
  const clienteId = $('clienteId').value.trim();
  if (!clienteId) {
    showToast('Digite o ID do cliente', 'warning');
    return;
  }

  try {
    const res = await fetch(`/api/ixc/cliente/${encodeURIComponent(clienteId)}`);
    if (!res.ok) {
      let msg = 'Cliente não encontrado';
      try { msg = (await res.json())?.erro || msg; } catch {}
      $('clienteNome').value = '';
      showToast(msg, 'error');
      return;
    }
    const data = await res.json();
    $('clienteNome').value = data?.razao || data?.nome || '';
    showToast('Cliente encontrado!', 'success');
  } catch (e) {
    console.error(e);
    showToast('Erro ao buscar cliente', 'error');
  }
}

async function criarAgendamento(event) {
  event.preventDefault();

  if (!Array.isArray(currentUser?.permissions) || !currentUser.permissions.includes('agenda.create')) {
    showToast('Sem permissão para criar agendamento', 'error');
    return;
  }

  const form = event.target;
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  data.tipo_instalacao = $('instalacaoPredial')?.checked ? 'PREDIAL' : 'RESIDENCIAL';

  if (!data.cliente) return showToast('Busque o cliente primeiro', 'warning');
  if (!data.cidade) return showToast('Selecione a cidade', 'warning');
  if (!data.assunto) return showToast('Selecione o assunto', 'warning');
  if (!data.tipo_os) return showToast('Selecione o tipo de OS', 'warning');

  try {
    const res = await fetch('/api/agendamentos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err?.error || 'Erro ao criar agendamento', 'error');
      return;
    }

    showToast('Agendamento criado! Ele está em "Aguardando agendamento".', 'success');
    form.reset();
    $('clienteNome').value = '';
    $('clienteId').focus();
  } catch (e) {
    console.error(e);
    showToast('Erro ao criar agendamento', 'error');
  }
}

function bindEvents() {
  const btnUser = $('userMenuBtn');
  if (btnUser) btnUser.addEventListener('click', (e) => { e.stopPropagation(); toggleUserMenu(); });

  document.addEventListener('click', (e) => {
    const dd = $('userDropdown');
    const um = document.querySelector('.user-menu');
    if (dd && um && !um.contains(e.target)) dd.classList.remove('show');
  });

  $('btnBuscarCliente')?.addEventListener('click', buscarCliente);
  $('btnLimpar')?.addEventListener('click', () => {
    $('novoAgendamentoForm').reset();
    $('clienteNome').value = '';
  });

  $('novoAgendamentoForm')?.addEventListener('submit', criarAgendamento);
}

async function init() {
  bindEvents();

  try {
    await loadCurrentUser();

    // bloqueia a página se não tiver permissão
    if (!Array.isArray(currentUser?.permissions) || !currentUser.permissions.includes('agenda.create')) {
      showToast('Sem permissão para criar agendamentos', 'error');
    }

    const cfg = await loadConfig();

    // O endpoint /api/config retorna chaves em PT-BR (cidades/assuntos)
    const cidades = Array.isArray(cfg?.cidades) ? cfg.cidades : [];
    populateSelect($('cidadeOs'), cidades);

    // /api/config já retorna apenas assuntos ativos (strings)
    const assuntos = Array.isArray(cfg?.assuntos) ? cfg.assuntos : [];
    $('assuntoOs').innerHTML = '<option value="">Selecione um assunto</option>';
    assuntos.forEach(nome => {
      const opt = document.createElement('option');
      opt.value = nome;
      opt.textContent = nome;
      $('assuntoOs').appendChild(opt);
    });
  } catch (e) {
    console.error(e);
    showToast('Erro ao carregar dados da página', 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
