// Variáveis globais
const loginForm = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginButton = document.querySelector('.login-button');
const buttonText = document.querySelector('.button-text');
const loadingSpinner = document.querySelector('.loading-spinner');
const errorMessage = document.getElementById('errorMessage');

// Event listeners
document.addEventListener('DOMContentLoaded', function() {
    // Verificar se já está logado
    checkAuthStatus();
    
    // Adicionar event listeners
    loginForm.addEventListener('submit', handleLogin);
    usernameInput.addEventListener('input', clearError);
    passwordInput.addEventListener('input', clearError);
    
    // Adicionar animação aos inputs
    setupInputAnimations();
});

// Verificar status de autenticação
async function checkAuthStatus() {
    try {
        const response = await fetch('/api/user', { cache: 'no-store' });
        
        // CORREÇÃO: Agora, se a resposta for 200 (OK) ele redireciona, 
        // se for 401 (Não Autorizado), ele apenas continua na página de login.
        if (response.ok) {
            window.location.href = '/';
        } 
        // Não precisa de else ou throw, se não for OK, ele continua na tela de login
        
    } catch (error) {
        // Este catch pega erros de rede, que são raros mas devem manter o usuário na tela de login
        console.log('Erro de rede ou usuário não autenticado. Continua no login.');
    }
}

// Configurar animações dos inputs
function setupInputAnimations() {
    const inputs = document.querySelectorAll('input');
    
    inputs.forEach(input => {
        // Verificar se o input já tem valor (autocomplete)
        if (input.value) {
            input.classList.add('has-value');
        }
        
        // Verificar periodicamente se há valor (para autocomplete)
        setInterval(() => {
            if (input.value && !input.classList.contains('has-value')) {
                input.classList.add('has-value');
            } else if (!input.value && input.classList.contains('has-value')) {
                input.classList.remove('has-value');
            }
        }, 100);
        
        input.addEventListener('focus', function() {
            this.parentElement.classList.add('focused');
        });
        
        input.addEventListener('blur', function() {
            this.parentElement.classList.remove('focused');
            if (this.value) {
                this.classList.add('has-value');
            } else {
                this.classList.remove('has-value');
            }
        });
        
        input.addEventListener('input', function() {
            if (this.value) {
                this.classList.add('has-value');
            } else {
                this.classList.remove('has-value');
            }
        });
    });
}

// Manipular envio do formulário
async function handleLogin(event) {
    event.preventDefault();
    
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    
    // Validação básica
    if (!username || !password) {
        showError('Por favor, preencha todos os campos.');
        return;
    }
    
    // Mostrar loading
    setLoadingState(true);
    clearError();
    
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            // Login bem-sucedido
            showSuccess('Login realizado com sucesso!');
            
            // Aguardar um pouco para mostrar a mensagem de sucesso
            setTimeout(() => {
                window.location.href = '/';
            }, 1000);
        } else {
            // Erro no login
            showError(data.error || data.message || 'Erro ao fazer login. Tente novamente.');
        }
    } catch (error) {
        console.error('Erro no login:', error);
        showError('Erro de conexão. Verifique sua internet e tente novamente.');
    } finally {
        setLoadingState(false);
    }
}

// Mostrar/ocultar estado de loading
function setLoadingState(loading) {
    if (loading) {
        loginButton.disabled = true;
        buttonText.style.opacity = '0';
        loadingSpinner.style.display = 'block';
    } else {
        loginButton.disabled = false;
        buttonText.style.opacity = '1';
        loadingSpinner.style.display = 'none';
    }
}

// Mostrar mensagem de erro
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    errorMessage.classList.add('shake');
    
    // Remover animação após completar
    setTimeout(() => {
        errorMessage.classList.remove('shake');
    }, 500);
}

// Mostrar mensagem de sucesso
function showSuccess(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    errorMessage.style.background = '#D4EDDA';
    errorMessage.style.color = '#155724';
    errorMessage.style.borderColor = '#C3E6CB';
}

// Limpar mensagem de erro
function clearError() {
    errorMessage.style.display = 'none';
    errorMessage.style.background = '#F8D7DA';
    errorMessage.style.color = '#721C24';
    errorMessage.style.borderColor = '#F5C6CB';
}

// Alternar visibilidade da senha
function togglePassword() {
    const passwordInput = document.getElementById('password');
    const toggleButton = document.querySelector('.toggle-password i');
    
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        toggleButton.classList.remove('fa-eye');
        toggleButton.classList.add('fa-eye-slash');
    } else {
        passwordInput.type = 'password';
        toggleButton.classList.remove('fa-eye-slash');
        toggleButton.classList.add('fa-eye');
    }
}

// Adicionar efeitos visuais
document.addEventListener('DOMContentLoaded', function() {
    // Efeito de partículas no fundo (opcional)
    createParticles();
    
    // Efeito de digitação no título
    typeWriter();
});

// Criar partículas no fundo
function createParticles() {
    const particlesContainer = document.createElement('div');
    particlesContainer.className = 'particles';
    particlesContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 1;
    `;
    
    document.querySelector('.login-background').appendChild(particlesContainer);
    
    // Criar partículas individuais
    for (let i = 0; i < 20; i++) {
        createParticle(particlesContainer);
    }
}

function createParticle(container) {
    const particle = document.createElement('div');
    particle.style.cssText = `
        position: absolute;
        width: 4px;
        height: 4px;
        background: rgba(255, 255, 255, 0.3);
        border-radius: 50%;
        animation: float ${5 + Math.random() * 10}s linear infinite;
        left: ${Math.random() * 100}%;
        top: ${Math.random() * 100}%;
        animation-delay: ${Math.random() * 5}s;
    `;
    
    container.appendChild(particle);
}

// Efeito de digitação no título
function typeWriter() {
    const title = document.querySelector('.login-header h1');
    const text = title.textContent;
    title.textContent = '';
    
    let i = 0;
    const timer = setInterval(() => {
        if (i < text.length) {
            title.textContent += text.charAt(i);
            i++;
        } else {
            clearInterval(timer);
        }
    }, 100);
}

// Adicionar suporte a teclas
document.addEventListener('keydown', function(event) {
    // Enter para submeter o formulário
    if (event.key === 'Enter' && !loginButton.disabled) {
        loginForm.dispatchEvent(new Event('submit'));
    }
    
    // Escape para limpar campos
    if (event.key === 'Escape') {
        usernameInput.value = '';
        passwordInput.value = '';
        clearError();
        usernameInput.focus();
    }
});

// Adicionar efeitos de hover nos inputs
document.querySelectorAll('input').forEach(input => {
    input.addEventListener('mouseenter', function() {
        this.style.transform = 'translateY(-1px)';
    });
    
    input.addEventListener('mouseleave', function() {
        this.style.transform = 'translateY(0)';
    });
});

// O sistema de modo escuro agora é gerenciado pelo dark-mode-system.js
