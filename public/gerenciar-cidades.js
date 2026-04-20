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
  if (!(user.role === 'admin' || perms.includes('cities.manage'))){
    toast('Acesso negado.', 'error');
    window.location.href = '/index.html';
    return null;
  }
  return user;
}

async function fetchCities(){
  const r = await fetch('/api/cities');
  if (!r.ok) throw new Error('Erro ao carregar cidades');
  return await r.json();
}

function render(rows){
  const tbody = document.getElementById('cityTableBody');
  tbody.innerHTML = '';

  rows.forEach(c => {
    const active = Number(c.is_active) === 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.id}</td>
      <td>${c.name}</td>
      <td>${active ? '<span class="badge badge-active">Ativo</span>' : '<span class="badge badge-inactive">Inativo</span>'}</td>
      <td>
        <div class="action-buttons">
          ${active
            ? `<button class="btn btn-danger btn-sm btn-icon" title="Desativar" aria-label="Desativar" data-action="toggle" data-next="0" data-id="${c.id}"><i class="fas fa-ban"></i></button>`
            : `<button class="btn btn-success btn-sm btn-icon" title="Ativar" aria-label="Ativar" data-action="toggle" data-next="1" data-id="${c.id}"><i class="fas fa-check"></i></button>`
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
      const msg = isDeactivate ? 'Desativar esta cidade?' : 'Ativar esta cidade?';
      if (!confirm(msg)) return;
      const r = await fetch(`/api/cities/${id}/toggle`, { method: 'POST' });
      const data = await r.json().catch(()=>({}));
      if (!r.ok) { toast(data.error || 'Erro ao atualizar status', 'error'); return; }
      await refresh();
    });
  });
}

async function refresh(){
  const rows = await fetchCities();
  render(rows);
}

async function onAdd(e){
  e.preventDefault();
  const name = (document.getElementById('cityName').value || '').trim();
  if (!name) return;

  const r = await fetch('/api/cities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) { toast(data.error || 'Erro ao criar cidade', 'error'); return; }
  document.getElementById('addCityForm').reset();
  await refresh();
}

document.addEventListener('DOMContentLoaded', async () => {
  try{
    await loadCurrentUser();
    document.getElementById('addCityForm').addEventListener('submit', onAdd);
    await refresh();
  }catch(e){
    console.error(e);
    toast('Erro ao iniciar tela', 'error');
  }finally{
    const ls = document.getElementById('loadingScreen');
    if (ls) ls.style.display = 'none';
  }
});
