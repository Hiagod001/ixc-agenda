(function () {
  const STORAGE_KEY = 'agenda-theme';
  let currentTheme = 'light';
  let preferencesLoaded = false;

  function getSavedTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  }

  function saveThemeLocally(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {}
  }

  function applyTheme(theme, options = {}) {
    const nextTheme = theme === 'dark' ? 'dark' : 'light';
    currentTheme = nextTheme;
    document.body.classList.toggle('dark-mode', nextTheme === 'dark');
    document.documentElement.setAttribute('data-theme', nextTheme);
    saveThemeLocally(nextTheme);

    if (!options.silent) {
      document.dispatchEvent(new CustomEvent('themeChanged', {
        detail: { theme: nextTheme, isDark: nextTheme === 'dark' }
      }));
    }
  }

  async function persistTheme(theme) {
    try {
      await fetch('/api/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme })
      });
    } catch (_) {}
  }

  async function loadThemePreference() {
    if (preferencesLoaded) return currentTheme;
    preferencesLoaded = true;

    const localTheme = getSavedTheme();
    if (localTheme) {
      applyTheme(localTheme, { silent: true });
    }

    try {
      const response = await fetch('/api/me/preferences', { cache: 'no-store' });
      if (!response.ok) return currentTheme;
      const preferences = await response.json();
      const serverTheme = preferences?.theme;
      if (serverTheme === 'dark' || serverTheme === 'light') {
        applyTheme(serverTheme, { silent: true });
      }
    } catch (_) {}

    return currentTheme;
  }

  async function setTheme(theme) {
    applyTheme(theme);
    await persistTheme(currentTheme);
    return currentTheme;
  }

  async function toggleTheme() {
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    return setTheme(nextTheme);
  }

  window.darkModeSystem = {
    loadThemePreference,
    applyTheme,
    setTheme,
    toggleTheme,
    getCurrentTheme: () => currentTheme,
    isDarkMode: () => currentTheme === 'dark'
  };

  document.addEventListener('DOMContentLoaded', function () {
    loadThemePreference();
  });
})();
