let currentUser = null;

function toast(msg, type='info'){
  if (typeof window.showToast === 'function') return window.showToast(msg, type);
  alert(msg);
}

async function loadCurrentUser(){
  const r = await fetch('/api/user');
  if (!r.ok) { window.location.href = '/login.html'; return null; }
  const user = await r.json();
  currentUser = user;
  document.getElementById('userName').textContent = user.username;

  const perms = user.permissions || [];
  if (!(user.role === 'admin' || perms.includes('technicians.manage'))){
    toast('Acesso negado.', 'error');
    window.location.href = '/index.html';
    return null;
  }
  return user;
}

async function fetchTechs(){
  const r = await fetch('/api/technicians');
  if (!r.ok) throw new Error('Erro ao carregar técnicos');
  return await r.json();
}

function render(rows){
  const tbody = document.getElementById('techTableBody');
  tbody.innerHTML = '';

  rows.forEach(t => {
    const tr = document.createElement('tr');
    const active = Number(t.is_active) === 1;
    tr.innerHTML = `
      <td>${t.id}</td>
      <td>${t.name}</td>
      <td>${active ? '<span class="badge badge-active">Ativo</span>' : '<span class="badge badge-inactive">Inativo</span>'}</td>
      <td>
        <div class="action-buttons">
          ${active
            ? `<button class="btn btn-danger btn-sm btn-icon" title="Desativar" aria-label="Desativar" data-action="toggle" data-next="0" data-id="${t.id}"><i class="fas fa-ban"></i></button>`
            : `<button class="btn btn-success btn-sm btn-icon" title="Ativar" aria-label="Ativar" data-action="toggle" data-next="1" data-id="${t.id}"><i class="fas fa-check"></i></button>`
          }
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-action="toggle"]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const id = btn.getAttribute('data-id');
      const next = btn.getAttribute('data-next');
      const isDeactivate = String(next) === '0';
      const msg = isDeactivate ? 'Desativar este técnico?' : 'Ativar este técnico?';
      if (!confirm(msg)) return;

      const r = await fetch(`/api/technicians/${id}/toggle`, { method: 'POST' });
      const data = await r.json().catch(()=>({}));
      if (!r.ok) { toast(data.error || 'Erro ao atualizar status', 'error'); return; }
      await refresh();
    });
  });
}

async function refresh(){
  const rows = await fetchTechs();
  render(rows);
}

async function onAdd(e){
  e.preventDefault();
  const name = (document.getElementById('techName').value || '').trim();
  if (!name) return;

  const r = await fetch('/api/technicians', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) { toast(data.error || 'Erro ao criar técnico', 'error'); return; }
  document.getElementById('addTechForm').reset();
  await refresh();
}

document.addEventListener('DOMContentLoaded', async () => {
  try{
    await loadCurrentUser();
    document.getElementById('addTechForm').addEventListener('submit', onAdd);
    await refresh();
  }catch(e){
    console.error(e);
    toast('Erro ao iniciar tela', 'error');
  }finally{
    const ls = document.getElementById('loadingScreen');
    if (ls) ls.style.display = 'none';
  }
});
