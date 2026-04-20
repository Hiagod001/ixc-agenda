// Gerenciar Usuários - JavaScript

let usuarios = [];
let usuarioAtual = null;
let canViewUsers = false;
let canManageUsers = false;

// Inicialização
document.addEventListener('DOMContentLoaded', async function() { // 1. Adicione 'async' aqui
    try {
        await verificarAutenticacao(); // 2. Espere a autenticação terminar

        // Apenas continue se a autenticação foi bem sucedida
        if (usuarioAtual) {
            await carregarUsuarios(); // 3. Espere os usuários serem carregados
            configurarEventos();
        }
    } catch (error) {
        console.error("Erro fatal na inicialização da página:", error);
        // Opcional: Redirecionar para o login se tudo der errado
        // window.location.href = '/login.html';
    } finally {
        // Esconder loading screen ao final de tudo
        document.getElementById('loadingScreen').style.display = 'none';
    }
});

 // Verificar autenticação
async function verificarAutenticacao() {
    try {
        const response = await fetch('/api/user');
        if (!response.ok) {
            window.location.href = '/login.html';
            return;
        }
        
        const user = await response.json();
        usuarioAtual = user;
        document.getElementById('userName').textContent = user.username;
        
        const perms = user.permissions || [];
        canViewUsers = perms.includes('users.view') || perms.includes('users.manage');
        canManageUsers = perms.includes('users.manage');

        if (!canViewUsers) {
            mostrarToast('Acesso negado. Você não tem permissão para visualizar usuários.', 'error');
            setTimeout(() => {
                window.location.href = '/index.html';
            }, 2000);
            return;
        }

        aplicarPermissoesNaTela();
    } catch (error) {
        console.error('Erro ao verificar autenticação:', error);
        window.location.href = '/login.html';
    }
}

function aplicarPermissoesNaTela() {
    const addSection = document.querySelector('.add-user-section');
    if (addSection) addSection.style.display = canManageUsers ? '' : 'none';
}

// Configurar eventos
function configurarEventos() {
    // Formulário de adicionar usuário
    if (canManageUsers) {
        document.getElementById('addUserForm').addEventListener('submit', adicionarUsuario);
        document.getElementById('editUserForm').addEventListener('submit', editarUsuario);
        document.getElementById('permissionsForm').addEventListener('submit', salvarPermissoes);
    }
    
    // Fechar modais ao clicar fora
    window.addEventListener('click', function(event) {
        const modals = document.querySelectorAll('.modal');
        modals.forEach(modal => {
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });
    });
}

// Carregar usuários
async function carregarUsuarios() {
    try {
        const response = await fetch('/api/users');
        if (!response.ok) {
            throw new Error('Erro ao carregar usuários');
        }
        
        usuarios = await response.json();
        renderizarUsuarios();
    } catch (error) {
        console.error('Erro ao carregar usuários:', error);
        mostrarToast('Erro ao carregar usuários', 'error');
    }
}

// Renderizar tabela de usuários
function renderizarUsuarios() {
    const tbody = document.getElementById('usersTableBody');
    tbody.innerHTML = '';
    
    usuarios.forEach(usuario => {
        const tr = document.createElement('tr');
        
        // Mapear funções para exibição
        const funcaoDisplay = {
            'admin': 'Administrador',
            'supervisor': 'Supervisor', 
            'agendamento': 'Agendamento',
            'suporte': 'Suporte'
        };
        
        // Mapear classes CSS para as funções
        const funcaoClass = {
            'admin': 'role-admin',
            'supervisor': 'role-supervisor',
            'agendamento': 'role-agendamento', 
            'suporte': 'role-suporte'
        };
        
        const permissoesArray = usuario.permissions || [];
        const permissoesCount = permissoesArray.length;
        
        tr.innerHTML = `
            <td>${usuario.id}</td>
            <td>${usuario.username}</td>
            <td><span class="role-badge ${funcaoClass[usuario.role] || 'role-user'}">${funcaoDisplay[usuario.role] || usuario.role}</span></td>
            <td><span class="permissions-count">${permissoesCount} permissões</span></td>
            <td>${formatarData(usuario.created_at)}</td>
            <td>
                ${canManageUsers ? `
                <button class="btn-permissions" onclick="abrirModalPermissoes(${usuario.id})">
                    <i class="fas fa-key"></i> Permissões
                </button>
                <button class="btn-edit" onclick="abrirModalEditar(${usuario.id})">
                    <i class="fas fa-edit"></i> Editar
                </button>
                ${usuario.id !== usuarioAtual.id ? `
                    <button class="btn-danger" onclick="excluirUsuario(${usuario.id})">
                        <i class="fas fa-trash"></i> Excluir
                    </button>
                ` : ''}
                ` : '<span class="permissions-count">Somente leitura</span>'}
            </td>
        `;
        
        tbody.appendChild(tr);
    });
}

// Obter nome de exibição da função
function getRoleDisplayName(role) {
    const roles = {
        'admin': 'Administrador',
        'supervisor': 'Supervisor',
        'agendamento': 'Agendamento',
        'suporte': 'Suporte'
    };
    return roles[role] || role;
}

// Formatar data
function formatarData(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
}

// Filtrar usuários
function filtrarUsuarios() {
    const searchTerm = document.getElementById('searchUsers').value.toLowerCase();
    const rows = document.querySelectorAll('#usersTableBody tr');
    
    rows.forEach(row => {
        const username = row.cells[1].textContent.toLowerCase();
        const role = row.cells[2].textContent.toLowerCase();
        
        if (username.includes(searchTerm) || role.includes(searchTerm)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// Adicionar usuário
async function adicionarUsuario(event) {
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const userData = {
        username: formData.get('username'),
        password: formData.get('password'),
        role: formData.get('role')
    };
    
    try {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userData)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao criar usuário');
        }
        
        mostrarToast('Usuário criado com sucesso!', 'success');
        event.target.reset();
        carregarUsuarios();
    } catch (error) {
        console.error('Erro ao criar usuário:', error);
        mostrarToast(error.message, 'error');
    }
}

// Abrir modal de editar
function abrirModalEditar(userId) {
    if (!canManageUsers) return;
    const usuario = usuarios.find(u => u.id === userId);
    if (!usuario) return;
    
    document.getElementById('editUserId').value = usuario.id;
    document.getElementById('editUsername').value = usuario.username;
    document.getElementById('editPassword').value = '';
    document.getElementById('editRole').value = usuario.role;
    
    document.getElementById('editUserModal').classList.add('show');
}

// Fechar modal de editar
function fecharModalEditar() {
    document.getElementById('editUserModal').classList.remove('show');
}

// Editar usuário
async function editarUsuario(event) {
    if (!canManageUsers) return;
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const userId = formData.get('id');
    const userData = {
        username: formData.get('username'),
        role: formData.get('role')
    };
    
    // Incluir senha apenas se foi fornecida
    const password = formData.get('password');
    if (password && password.trim() !== '') {
        userData.password = password;
    }
    
    try {
        const response = await fetch(`/api/users/${userId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userData)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao atualizar usuário');
        }
        
        mostrarToast('Usuário atualizado com sucesso!', 'success');
        fecharModalEditar();
        carregarUsuarios();
    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        mostrarToast(error.message, 'error');
    }
}

// Excluir usuário
async function excluirUsuario(userId) {
    if (!canManageUsers) return;
    const usuario = usuarios.find(u => u.id === userId);
    if (!usuario) return;
    
    if (!confirm(`Tem certeza que deseja excluir o usuário "${usuario.username}"?`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/users/${userId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao excluir usuário');
        }
        
        mostrarToast('Usuário excluído com sucesso!', 'success');
        carregarUsuarios();
    } catch (error) {
        console.error('Erro ao excluir usuário:', error);
        mostrarToast(error.message, 'error');
    }
}

// Abrir modal de permissões
async function abrirModalPermissoes(userId) {
    if (!canManageUsers) return;
    const usuario = usuarios.find(u => u.id === userId);
    if (!usuario) return;
    
    document.getElementById('permissionUserId').value = usuario.id;
    document.getElementById('permissionUserName').textContent = usuario.username;
    document.getElementById('permissionUserRole').textContent = getRoleDisplayName(usuario.role);
    
    // Carregar permissões atuais
    try {
        const response = await fetch(`/api/users/${userId}/permissions`);
        if (response.ok) {
            const permissions = await response.json();
            
            // Limpar todas as checkboxes
            const checkboxes = document.querySelectorAll('#permissionsForm input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = false);
            
            // Marcar permissões atuais
            permissions.forEach(permission => {
                const checkbox = document.querySelector(`input[value="${permission}"]`);
                if (checkbox) {
                    checkbox.checked = true;
                }
            });
        }
    } catch (error) {
        console.error('Erro ao carregar permissões:', error);
    }
    
    document.getElementById('permissionsModal').classList.add('show');
}

// Fechar modal de permissões
function fecharModalPermissoes() {
    document.getElementById('permissionsModal').classList.remove('show');
}

// Salvar permissões
async function salvarPermissoes(event) {
    if (!canManageUsers) return;
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const userId = formData.get('userId');
    const permissions = formData.getAll('permissions');
    
    try {
        const response = await fetch(`/api/users/${userId}/permissions`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ permissions })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erro ao salvar permissões');
        }
        
        mostrarToast('Permissões salvas com sucesso!', 'success');
        fecharModalPermissoes();
        carregarUsuarios();
    } catch (error) {
        console.error('Erro ao salvar permissões:', error);
        mostrarToast(error.message, 'error');
    }
}

// Toggle do menu do usuário
function toggleUserMenu() {
    const dropdown = document.getElementById('userDropdown');
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
}

// Fechar dropdown ao clicar fora
document.addEventListener('click', function(event) {
    const userMenu = document.querySelector('.user-menu');
    const dropdown = document.getElementById('userDropdown');
    
    if (!userMenu.contains(event.target)) {
        dropdown.style.display = 'none';
    }
});

// Mostrar toast
function mostrarToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icon = type === 'success' ? 'check-circle' : 
                 type === 'error' ? 'exclamation-circle' : 
                 'info-circle';
    
    toast.innerHTML = `
        <i class="fas fa-${icon}"></i>
        <span>${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;
    
    container.appendChild(toast);
    
    // Auto remover após 5 segundos
    setTimeout(() => {
        if (toast.parentElement) {
            toast.remove();
        }
    }, 5000);
    
    // Animação de entrada
    setTimeout(() => {
        toast.classList.add('show');
    }, 100);
}
