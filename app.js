const API = {
  token: localStorage.getItem('promake_access_token') || '',
  refreshToken: localStorage.getItem('promake_refresh_token') || '',
  baseUrl: (window.location.protocol === 'file:') ? 'http://localhost:8081' : window.location.origin,
  _refreshing: null,
  async request(method, url, body) {
    const fullUrl = this.baseUrl + url;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body) opts.body = JSON.stringify(body);
    try {
      let res = await fetch(fullUrl, opts);
      if (res.status === 401 && this.refreshToken) {
        const refreshed = await this._tryRefresh();
        if (refreshed) {
          opts.headers['Authorization'] = 'Bearer ' + this.token;
          res = await fetch(fullUrl, opts);
        }
      }
      if (res.status === 401) {
        return await res.json().catch(() => ({ error: 'Não autorizado' }));
      }
      if (res.status === 429) {
        const errData = await res.json().catch(() => ({ error: 'Muitas tentativas' }));
        return errData;
      }
      const ct = res.headers.get('content-type') || '';
      if (ct && !ct.includes('json')) {
        const text = await res.text();
        console.error('[API] Non-JSON response', res.status, text.slice(0,200));
        return null;
      }
      return await res.json().catch(() => null);
    } catch(e) {
      console.error('[API] Request failed', fullUrl, e);
      return null;
    }
  },
  async _tryRefresh() {
    if (this._refreshing) return this._refreshing;
    if (!this.refreshToken) return false;
    this._refreshing = (async () => {
      try {
        const res = await fetch(this.baseUrl + '/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: this.refreshToken })
        });
        if (!res.ok) {
          this.token = '';
          this.refreshToken = '';
          localStorage.removeItem('promake_access_token');
          localStorage.removeItem('promake_refresh_token');
          return false;
        }
        const data = await res.json();
        if (!data.access_token) {
          this.token = '';
          this.refreshToken = '';
          localStorage.removeItem('promake_access_token');
          localStorage.removeItem('promake_refresh_token');
          return false;
        }
        this.token = data.access_token;
        this.refreshToken = data.refresh_token || '';
        localStorage.setItem('promake_access_token', data.access_token);
        localStorage.setItem('promake_refresh_token', data.refresh_token || '');
        return true;
      } catch(e) {
        this.token = '';
        this.refreshToken = '';
        localStorage.removeItem('promake_access_token');
        localStorage.removeItem('promake_refresh_token');
        return false;
      } finally {
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  del(url) { return this.request('DELETE', url); },
  async upload(url, formData) {
    const fullUrl = this.baseUrl + url;
    const opts = { method: 'POST', body: formData };
    if (this.token) opts.headers = { 'Authorization': 'Bearer ' + this.token };
    try {
      let res = await fetch(fullUrl, opts);
      if (res.status === 401 && this.refreshToken) {
        const refreshed = await this._tryRefresh();
        if (refreshed) {
          opts.headers = { 'Authorization': 'Bearer ' + this.token };
          res = await fetch(fullUrl, opts);
        }
      }
      if (res.status === 401 && this.token) { App.logout(); return null; }
      if (res.status === 401) return null;
      return await res.json();
    } catch(e) {
      App.toast('Erro de conexão com o servidor', 'error');
      return null;
    }
  }
};

const App = {
  currentPage: 'dashboard',
  user: null,
      chartInstances: {},
  finVisible: true,
  lang: 'pt-BR',
  __(key) { const t = this.i18n?.[this.lang]; return t?.[key] || this.i18n?.['pt-BR']?.[key] || key; },
  i18n: {
    'pt-BR': {
      dashboard:'Dashboard', leads:'CRM / Leads', clients:'Clientes', projects:'Projetos',
      kanban:'Kanban', services:'Ordem de serviço', contracts:'Contratos',
      finance:'Financeiro', calendar:'Calendário', reports:'Relatórios',
      activity:'Logs', team:'Equipe', settings:'Configurações', integracoes:'Integrações', systems:'Sistemas',
      plans:'Planos', marketing:'Marketing', whatsapp:'WhatsApp', design:'Painel Criativo', festefe:'Chamados',
      active_clients:'Clientes Ativos', total_clients:'Total de clientes',
      active_projects:'Projetos em Andamento', overdue:'atrasados',
      monthly_revenue:'Faturamento no Mes', profit:'Lucro',
      new_leads:'Novos Leads', total:'Total', projects:'Projetos',
      recent_projects:'Deadline', no_projects:'Nenhum projeto',
      pending:'Pendente', in_progress:'Em Andamento', completed:'Concluído', overdue_st:'Atrasado',
      project:'Projeto', client:'Cliente', status:'Status', deadline:'Prazo', value:'Valor',
      revenue_vs_expenses:'Receita vs Despesas', revenue:'Receita', expenses:'Despesas',
      projects_by_status:'Projetos por Status', projects_by_type:'Projetos por Tipo',
      leads_by_status:'Leads por Status',
    },
    'en': {
      dashboard:'Dashboard', leads:'CRM / Leads', clients:'Clients', projects:'Projects',
      kanban:'Kanban', services:'Service Orders', contracts:'Contracts',
      finance:'Finance', calendar:'Calendar', reports:'Reports',
      activity:'Activity', team:'Team', settings:'Settings', integracoes:'Integrations', systems:'Systems',
      plans:'Plans', marketing:'Marketing', whatsapp:'WhatsApp', design:'Creative Board', festefe:'Tickets',
      active_clients:'Active Clients', total_clients:'Total clients',
      active_projects:'Projects in Progress', overdue:'overdue',
      monthly_revenue:'Monthly Revenue', profit:'Profit',
      new_leads:'New Leads', total:'Total', projects:'projects',
      recent_projects:'Deadline', no_projects:'No projects',
      pending:'Pending', in_progress:'In Progress', completed:'Completed', overdue_st:'Overdue',
      project:'Project', client:'Client', status:'Status', deadline:'Deadline', value:'Value',
      revenue_vs_expenses:'Revenue vs Expenses', revenue:'Revenue', expenses:'Expenses',
      projects_by_status:'Projects by Status', projects_by_type:'Projects by Type',
      leads_by_status:'Leads by Status',
    },
  },
  globeRunning: false,
  _saTimer: null,
  _saGlobeState: null,
  notifOpen: false,
  notifPrefs: null,
  calendarDate: new Date(),
  taskFieldCount: 0,
  filterCache: null,

  esc(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  },

  async init() {
    const params = new URLSearchParams(window.location.search);
    const resetToken = params.get('reset_token');
    if (resetToken) {
      this.loadTheme();
      document.getElementById('lpYear').textContent = new Date().getFullYear();
      this.loadPublicSlides();
      this.loadLandingContent();
      window.history.replaceState({}, document.title, window.location.pathname);
      setTimeout(() => this.openResetPassword(resetToken), 500);
      return;
    }
    const accessToken = localStorage.getItem('promake_access_token');
    const refreshToken = localStorage.getItem('promake_refresh_token');
    if (accessToken) {
      API.token = accessToken;
      API.refreshToken = refreshToken || '';
      try {
        const res = await fetch(API.baseUrl + '/api/auth/profile', {
          headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        if (res.ok) {
          const profile = await res.json();
          if (profile && !profile.error) {
            this.user = profile;
            await this.loadDashboardHTML();
            this.showApp();
            return;
          }
        }
      } catch(e) {}
      API.token = '';
      API.refreshToken = '';
      localStorage.removeItem('promake_access_token');
      localStorage.removeItem('promake_refresh_token');
    }
    this.loadTheme();
    document.getElementById('lpYear').textContent = new Date().getFullYear();
    this.loadPublicSlides();
    this.loadLandingContent();
    const savedEmail = localStorage.getItem('promake_email') || '';
    document.getElementById('loginEmail').value = savedEmail;
    if (savedEmail) document.getElementById('rememberUser').checked = true;
    const h = () => this.handleLogin();
    document.getElementById('loginBtn').addEventListener('click', h);
    document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') h(); });
    document.getElementById('loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') h(); });
    document.getElementById('loginForm').addEventListener('submit', e => e.preventDefault());
  },

  openLandingLogin() {
    const el = document.getElementById('loginScreen');
    el.classList.add('show');
    document.getElementById('loginError').classList.remove('show');
    el.onclick = (e) => { if (e.target === el) this.closeLandingLogin(); };
    setTimeout(() => document.getElementById('loginEmail')?.focus(), 100);
  },

  closeLandingLogin() {
    document.getElementById('loginScreen').classList.remove('show');
  },

  async handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    if (!email || !password) {
      errorEl.textContent = 'Preencha email e senha.';
      errorEl.classList.add('show'); return;
    }
    if (document.getElementById('rememberUser').checked) {
      localStorage.setItem('promake_email', email);
    } else {
      localStorage.removeItem('promake_email');
    }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Entrando...';
    errorEl.classList.remove('show');
    const data = await API.post('/api/auth/login', { email, password });
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Entrar';
    if (data && !data.error) {
      if (data.user?.role === "client" && data.system) {
        const resultHtml =
          '<div style="text-align:center;padding:8px 0">' +
          '<i class="fas fa-external-link-alt" style="font-size:32px;color:var(--primary)""></i>' +
          '<h4 style="margin:8px 0 4px">Acesso ao Portal</h4>' +
          '<p style="color:var(--text-muted);font-size:13px">Sua conta e de cliente. Acesse seu portal:</p>' +
          '<br><a href="' + data.system.portal_url + '" target="_blank" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">' +
          '<i class="fas fa-rocket"></i> Abrir Portal</a>' +
          '</div>';
        this.temporaryModal(resultHtml);
        localStorage.removeItem('promake_access_token');
        localStorage.removeItem('promake_refresh_token');
        return;
      }
      if (data.mfa_required) {
        this._mfaToken = data.mfa_token;
        this.showMfaChallenge();
        return;
      }
      API.token = data.access_token;
      API.refreshToken = data.refresh_token;
      this.user = data.user;
      localStorage.setItem('promake_access_token', API.token);
      localStorage.setItem('promake_refresh_token', API.refreshToken);
      await this.loadDashboardHTML();
      this.showApp();
    } else {
      errorEl.textContent = (data && data.error) ? data.error : 'Erro de conexão com o servidor.';
      errorEl.classList.add('show');
    }
  },

  // ── Forgot Password (code-based) ──

  _forgotEmail: '',

  openForgotPassword(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    document.getElementById('forgotStep1').style.display = 'block';
    document.getElementById('forgotStep2').style.display = 'none';
    document.getElementById('forgotStep3').style.display = 'none';
    document.getElementById('forgotEmail').value = '';
    document.getElementById('forgotCode').value = '';
    document.getElementById('forgotNewPassword').value = '';
    document.getElementById('forgotConfirmPassword').value = '';
    document.getElementById('forgotError').style.display = 'none';
    document.getElementById('forgotResetError').style.display = 'none';
    this._forgotEmail = '';
    document.getElementById('loginScreen').classList.remove('show');
    this.openModal('forgotPasswordModal');
    setTimeout(() => document.getElementById('forgotEmail')?.focus(), 100);
  },

  closeForgotPassword() {
    this.closeModal('forgotPasswordModal');
    document.getElementById('loginScreen').classList.add('show');
  },

  async sendResetCode() {
    const email = document.getElementById('forgotEmail').value.trim();
    const errorEl = document.getElementById('forgotError');
    if (!email) {
      errorEl.textContent = 'Digite seu email.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const data = await API.post('/api/auth/send-reset-code', { email });
    if (data && !data.error) {
      this._forgotEmail = email;
      document.getElementById('forgotCodeEmail').textContent = email;
      document.getElementById('forgotStep1').style.display = 'none';
      document.getElementById('forgotStep2').style.display = 'block';
      document.getElementById('forgotCode').value = '';
      document.getElementById('forgotResetError').style.display = 'none';
      if (data.dev_mode) {
        document.getElementById('forgotCode').value = data.code;
      }
      setTimeout(() => document.getElementById('forgotCode')?.focus(), 100);
    } else {
      errorEl.textContent = data?.error || 'Email nao encontrado.';
      errorEl.style.display = 'block';
    }
  },

  async resetWithCode() {
    const code = document.getElementById('forgotCode').value.trim();
    const password = document.getElementById('forgotNewPassword').value;
    const confirm = document.getElementById('forgotConfirmPassword').value;
    const errorEl = document.getElementById('forgotResetError');
    if (!code || code.length !== 6) {
      errorEl.textContent = 'Digite o codigo de 6 digitos.';
      errorEl.style.display = 'block';
      return;
    }
    if (!password || password.length < 6) {
      errorEl.textContent = 'Senha deve ter no minimo 6 caracteres.';
      errorEl.style.display = 'block';
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Senhas nao conferem.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const data = await API.post('/api/auth/reset-with-code', { email: this._forgotEmail, code, password });
    if (data && !data.error) {
      document.getElementById('forgotStep2').style.display = 'none';
      document.getElementById('forgotStep3').style.display = 'block';
      this.toast('Senha redefinida com sucesso!', 'success');
    } else {
      errorEl.textContent = data?.error || 'Codigo invalido ou expirado.';
      errorEl.style.display = 'block';
    }
  },

  // ── Reset Password (via URL token) ──

  async requestResetToken() {
    const email = document.getElementById('forgotEmail').value.trim();
    const errorEl = document.getElementById('forgotError');
    if (!email) {
      errorEl.textContent = 'Digite seu email.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const data = await API.post('/api/auth/forgot-password', { email });
    if (data && !data.error) {
      document.getElementById('forgotStep1').style.display = 'none';
      document.getElementById('forgotStep2').style.display = 'block';
      const msgEl = document.getElementById('forgotSuccessMessage');
      if (data.dev_mode) {
        msgEl.innerHTML = 'Modo desenvolvimento: <strong style="color:var(--warning)">' + data.token + '</strong><br><br><a href="#" onclick="App.openResetPassword(\'' + data.token + '\');return false" style="color:var(--primary);font-weight:600">Clique aqui para redefinir</a>';
      } else {
        msgEl.textContent = 'Verifique sua caixa de entrada (' + data.email + ') e siga as instrucoes para redefinir sua senha.';
      }
    } else {
      errorEl.textContent = data?.error || 'Email nao encontrado.';
      errorEl.style.display = 'block';
    }
  },

  openResetPassword(token) {
    this._resetToken = token;
    document.getElementById('resetNewPassword').value = '';
    document.getElementById('resetConfirmPassword').value = '';
    document.getElementById('resetError').style.display = 'none';
    this.closeForgotPassword();
    this.closeLandingLogin();
    this.openModal('resetPasswordModal');
    setTimeout(() => document.getElementById('resetNewPassword')?.focus(), 100);
  },

  closeResetPassword() {
    this.closeModal('resetPasswordModal');
    this._resetToken = null;
    document.getElementById('loginScreen').classList.add('show');
  },

  async confirmResetPassword() {
    const password = document.getElementById('resetNewPassword').value;
    const confirm = document.getElementById('resetConfirmPassword').value;
    const errorEl = document.getElementById('resetError');
    if (!password || password.length < 6) {
      errorEl.textContent = 'Senha deve ter no minimo 6 caracteres.';
      errorEl.style.display = 'block';
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Senhas nao conferem.';
      errorEl.style.display = 'block';
      return;
    }
    if (!this._resetToken) {
      errorEl.textContent = 'Token invalido. Solicite um novo link.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const data = await API.post('/api/auth/reset-password', { token: this._resetToken, password });
    if (data && !data.error) {
      this.toast('Senha redefinida com sucesso! Faca login com a nova senha.', 'success');
      this.closeModal('resetPasswordModal');
      this._resetToken = null;
      document.getElementById('loginScreen').classList.add('show');
    } else {
      errorEl.textContent = data?.error || 'Erro ao redefinir senha. Token pode ter expirado.';
      errorEl.style.display = 'block';
    }
  },

  // ── Signup with email verification ──

  _signupData: null,
  _signupEmail: '',

  openSignup(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    document.getElementById('signupStep1').style.display = 'block';
    document.getElementById('signupStep2').style.display = 'none';
    document.getElementById('signupStep3').style.display = 'none';
    document.getElementById('signupName').value = '';
    document.getElementById('signupEmail').value = '';
    document.getElementById('signupCompany').value = '';
    document.getElementById('signupPassword').value = '';
    document.getElementById('signupCode').value = '';
    document.getElementById('signupError').style.display = 'none';
    document.getElementById('signupCodeError').style.display = 'none';
    this._signupData = null;
    this._signupEmail = '';
    document.getElementById('loginScreen').classList.remove('show');
    this.openModal('signupModal');
    setTimeout(() => document.getElementById('signupName')?.focus(), 100);
  },

  closeSignup() {
    this.closeModal('signupModal');
    document.getElementById('loginScreen').classList.add('show');
  },

  async doSignup() {
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const company = document.getElementById('signupCompany').value.trim();
    const password = document.getElementById('signupPassword').value;
    const errorEl = document.getElementById('signupError');
    if (!name || !email || !password) {
      errorEl.textContent = 'Preencha nome, email e senha.';
      errorEl.style.display = 'block';
      return;
    }
    if (password.length < 6) {
      errorEl.textContent = 'Senha deve ter no minimo 6 caracteres.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    document.getElementById('signupSubmitBtn').disabled = true;
    document.getElementById('signupSubmitBtn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
    const data = await API.post('/api/auth/send-verification', { email });
    document.getElementById('signupSubmitBtn').disabled = false;
    document.getElementById('signupSubmitBtn').innerHTML = '<i class="fas fa-paper-plane"></i> Enviar Codigo';
    if (data && !data.error) {
      this._signupName = name;
      this._signupEmail = email;
      this._signupCompany = company;
      this._signupPassword = password;
      document.getElementById('signupCodeEmail').textContent = email;
      document.getElementById('signupStep1').style.display = 'none';
      document.getElementById('signupStep2').style.display = 'block';
      document.getElementById('signupCode').value = '';
      document.getElementById('signupCodeError').style.display = 'none';
      if (data.dev_mode) {
        document.getElementById('signupCode').value = data.code;
      }
      setTimeout(() => document.getElementById('signupCode')?.focus(), 100);
    } else {
      errorEl.textContent = data?.error || 'Erro ao enviar codigo.';
      errorEl.style.display = 'block';
    }
  },

  async verifySignup() {
    const code = document.getElementById('signupCode').value.trim();
    const errorEl = document.getElementById('signupCodeError');
    if (!code || code.length !== 6) {
      errorEl.textContent = 'Digite o codigo de 6 digitos enviado por email.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const data = await API.post('/api/auth/signup', {
      name: this._signupName,
      email: this._signupEmail,
      password: this._signupPassword,
      company: this._signupCompany,
      code
    });
    if (data && !data.error) {
      this._signupData = data;
      document.getElementById('signupStep2').style.display = 'none';
      document.getElementById('signupStep3').style.display = 'block';
      document.getElementById('signupResult').innerHTML =
        '<div style="margin-bottom:8px"><strong>Portal:</strong> <a href="' + data.portal_url + '" target="_blank" style="color:var(--primary)">' + data.portal_url + '</a></div>' +
        '<div style="margin-bottom:8px"><strong>Senha do Portal:</strong> <code style="background:var(--bg-card);padding:2px 8px;border-radius:4px;font-size:14px">' + data.portal_password + '</code> <button class="btn btn-xs btn-outline" onclick="App.copyText(\'' + data.portal_password + '\')" style="vertical-align:middle"><i class="fas fa-copy"></i></button></div>' +
        '<div style="color:var(--text-muted);font-size:12px">Guarde estas informacoes. Voce precisara da senha do portal para acessar.</div>';
      this.toast('Conta criada com sucesso!', 'success');
    } else {
      errorEl.textContent = data?.error || 'Erro ao criar conta.';
      errorEl.style.display = 'block';
    }
  },

  async resendCode() {
    if (!this._signupEmail) return;
    const link = document.getElementById('resendCodeLink');
    link.textContent = 'Enviando...';
    const data = await API.post('/api/auth/send-verification', { email: this._signupEmail });
    link.textContent = 'Reenviar codigo';
    if (data && !data.error) {
      if (data.dev_mode) {
        document.getElementById('signupCode').value = data.code;
      }
      this.toast('Codigo reenviado!', 'success');
    } else {
      this.toast(data?.error || 'Erro ao reenviar', 'error');
    }
  },

  openPortalAfterSignup() {
    if (this._signupData) {
      window.open(this._signupData.portal_url, '_blank');
    }
  },

  copyText(text) {
    navigator.clipboard?.writeText(text);
    this.toast('Copiado!', 'success');
  },

  togglePassword() {
    const input = document.getElementById('loginPassword');
    const btn = document.getElementById('toggleSenha');
    if (input.type === 'password') {
      input.type = 'text';
      btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
    } else {
      input.type = 'password';
      btn.innerHTML = '<i class="fas fa-eye"></i>';
    }
  },

  async loadDashboardHTML() {
    const resp = await fetch(API.baseUrl + '/api/dashboard-html');
    if (!resp.ok) return;
    const html = await resp.text();
    document.getElementById('app').outerHTML = html;
  },

  showApp() {
    API.userId = this.user?.id;
    document.getElementById('landingPage').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('show');
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.add('active');
    document.getElementById('userName').textContent = this.user?.name || 'Admin';
    const avatarEl = document.getElementById('userAvatar');
    if (this.user?.avatar) {
      avatarEl.innerHTML = '<img src="' + API.baseUrl + '/api/photo/' + this.user.avatar + '?t=' + Date.now() + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
    } else {
      avatarEl.textContent = (this.user?.name || 'A')[0];
    }
    document.getElementById('settingsUser').textContent = this.user?.name || 'Admin';
    if (localStorage.getItem('promake_sidebar') === 'collapsed') {
      document.getElementById('sidebar').classList.add('collapsed');
    }
    this.updateSidebarArrows();
    this.setupNavigation();
    const savedPage = localStorage.getItem('promake_page');
    if (savedPage) {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      const navItem = document.querySelector(`.nav-item[data-page="${savedPage}"]`);
      if (navItem) navItem.classList.add('active');
    }
    this.loadPage(savedPage || 'dashboard');
    this.loadNotifications();
    this.loadNotifPrefs();
    this.loadBrandLogo();
    this.loadFinVisibility();
    this.loadLang();
    this.checkCookieConsent();
    this.initTableScrollDetection();
    this.initSwipeSidebar();
    this.initResizeHandler();
    this.initMusicPlayer();
    this.initNavDrag();
    setInterval(() => this.loadNotifications(), 30000);
  },

  logout() {
    const rt = API.refreshToken;
    API.token = '';
    API.refreshToken = '';
    this.user = null;
    localStorage.removeItem('promake_access_token');
    localStorage.removeItem('promake_refresh_token');
    localStorage.removeItem('promake_page');
    if (rt) {
      fetch(API.baseUrl + '/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt })
      }).catch(() => {});
    }
    document.getElementById('app').classList.remove('active');
    document.getElementById('landingPage').classList.remove('hidden');
    document.getElementById('loginScreen').classList.remove('show');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginError').classList.remove('show');
    this.loadPublicSlides();
    this.loadLandingContent();
  },

  toggleNavSection(key) {
    const section = document.querySelector(`.nav-section[data-section="${key}"]`);
    if (!section) return;
    section.classList.toggle('open');
    const state = JSON.parse(localStorage.getItem('promake_nav_sections') || '{}');
    state[key] = section.classList.contains('open');
    localStorage.setItem('promake_nav_sections', JSON.stringify(state));
  },

  updateSidebarArrows() {
    const state = JSON.parse(localStorage.getItem('promake_nav_sections') || '{}');
    document.querySelectorAll('.nav-section').forEach(s => {
      const key = s.dataset.section;
      if (state[key] !== false) s.classList.add('open');
    });
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const isMobile = window.innerWidth <= 768;
    const isHidden = isMobile ? !sidebar.classList.contains('open') : sidebar.classList.contains('collapsed');
    const icon = isHidden ? 'fa-chevron-right' : 'fa-chevron-left';
    document.querySelectorAll('.mobile-toggle i').forEach(el => {
      el.className = 'fas ' + icon;
    });
  },

  _navId(item) {
    return item.dataset.page || item.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  },

  _makeIndicator() {
    let el = document.getElementById('navDragIndicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'navDragIndicator';
      el.style.cssText = 'position:fixed;left:0;right:0;height:3px;background:var(--primary);z-index:9999;pointer-events:none;display:none;border-radius:2px;box-shadow:0 0 8px var(--primary)';
      document.body.appendChild(el);
    }
    return el;
  },

  initNavDrag() {
    const container = document.querySelector('.sidebar-nav');
    if (!container) return;
    const indicator = this._makeIndicator();
    let dragType = ''; // 'item' or 'section'

    // ── restore saved order ──
    try {
      const secOrder = JSON.parse(localStorage.getItem('promake_nav_order') || '[]');
      if (secOrder.length) {
        const sections = [...container.querySelectorAll('.nav-section')];
        sections.sort((a, b) => {
          const ai = secOrder.indexOf(a.dataset.section);
          const bi = secOrder.indexOf(b.dataset.section);
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        sections.forEach(s => container.appendChild(s));
      }
      const itemsOrder = JSON.parse(localStorage.getItem('promake_nav_items_order') || '{}');
      container.querySelectorAll('.nav-section').forEach(section => {
        const order = itemsOrder[section.dataset.section];
        if (!order || !order.length) return;
        const parent = section.querySelector('.nav-section-items');
        if (!parent) return;
        const items = [...parent.querySelectorAll('.nav-item')];
        items.sort((a, b) => {
          const ai = order.indexOf(this._navId(a));
          const bi = order.indexOf(this._navId(b));
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        items.forEach(el => parent.appendChild(el));
      });
    } catch(e) {}

    // ── shared helpers ──
    const showIndicator = (e, target, parent) => {
      const rect = target.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const above = e.clientY < mid;
      indicator.style.display = 'block';
      indicator.style.left = rect.left + 'px';
      indicator.style.width = rect.width + 'px';
      if (above) {
        indicator.style.top = (rect.top - 1.5) + 'px';
      } else {
        indicator.style.top = (rect.bottom - 1.5) + 'px';
      }
      target.classList.add('drag-hover');
      if (above) {
        target.dataset.dragPos = 'before';
      } else {
        target.dataset.dragPos = 'after';
      }
    };

    const hideIndicator = () => {
      indicator.style.display = 'none';
    };

    // ── nav items ──
    const bindDrag = (selector, type) => {
      container.querySelectorAll(selector).forEach(el => {
        el.draggable = true;
        el.classList.add('draggable-nav');

        el.addEventListener('dragstart', e => {
          dragType = type;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', this._navId(el));
          el.classList.add('dragging');
          const section = el.closest('.nav-section');
          e.dataTransfer.setData('nav-section', section ? section.dataset.section : '');
        });

        el.addEventListener('dragend', () => {
          el.classList.remove('dragging');
          hideIndicator();
          container.querySelectorAll('.drag-hover').forEach(h => h.classList.remove('drag-hover'));
        });

        el.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const dragged = container.querySelector('.dragging');
          if (!dragged || dragged === el) return;
          // hide indicator on children when dragging a section
          if (type === 'section' && el.querySelector('.dragging')) return;
          showIndicator(e, el, el.parentElement);
        });

        el.addEventListener('dragleave', () => {
          el.classList.remove('drag-hover');
          hideIndicator();
        });

        el.addEventListener('drop', e => {
          e.preventDefault();
          hideIndicator();
          container.querySelectorAll('.drag-hover').forEach(h => h.classList.remove('drag-hover'));
          const dragged = container.querySelector('.dragging');
          if (!dragged || dragged === el) return;
          const pos = el.dataset.dragPos || 'after';
          if (pos === 'before') {
            el.parentElement.insertBefore(dragged, el);
          } else {
            el.parentElement.insertBefore(dragged, el.nextSibling);
          }
          this._saveNavOrder();
        });
      });
    };

    bindDrag('.nav-item', 'item');
    bindDrag('.nav-section-header', 'section');

    // hide indicator when leaving the sidebar
    container.addEventListener('dragleave', e => {
      if (!container.contains(e.relatedTarget)) {
        hideIndicator();
        container.querySelectorAll('.drag-hover').forEach(h => h.classList.remove('drag-hover'));
      }
    });

    // ── touch drag support ──
    if ('ontouchstart' in window) {
      let touchDragEl = null;
      const touchStart = (e) => {
        const el = e.currentTarget;
        const touch = e.touches[0];
        touchDragEl = { el, type: el.classList.contains('nav-section-header') ? 'section' : 'item', startY: touch.clientY, moved: false };
        el.classList.add('dragging');
      };
      const touchMove = (e) => {
        if (!touchDragEl) return;
        e.preventDefault();
        const touch = e.touches[0];
        if (Math.abs(touch.clientY - touchDragEl.startY) < 5 && !touchDragEl.moved) return;
        touchDragEl.moved = true;
        const targets = container.querySelectorAll(touchDragEl.type === 'section' ? '.nav-section-header' : '.nav-item');
        let target = null;
        for (const t of targets) {
          const r = t.getBoundingClientRect();
          if (touch.clientY >= r.top && touch.clientY <= r.bottom) {
            target = t; break;
          }
        }
        if (target && target !== touchDragEl.el) {
          showIndicator(touch, target, target.parentElement);
        } else if (!target) {
          hideIndicator();
          container.querySelectorAll('.drag-hover').forEach(h => h.classList.remove('drag-hover'));
        }
      };
      const touchEnd = (e) => {
        if (!touchDragEl) return;
        hideIndicator();
        container.querySelectorAll('.drag-hover').forEach(h => h.classList.remove('drag-hover'));
        const el = touchDragEl.el;
        el.classList.remove('dragging');
        if (!touchDragEl.moved) { touchDragEl = null; return; } // was a tap
        const touch = e.changedTouches[0];
        const targets = container.querySelectorAll(touchDragEl.type === 'section' ? '.nav-section-header' : '.nav-item');
        let targetEl = null;
        for (const t of targets) {
          const r = t.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          if (touch.clientY >= r.top && touch.clientY <= r.bottom) {
            targetEl = t;
            targetEl.dataset.dragPos = touch.clientY < mid ? 'before' : 'after';
            break;
          }
        }
        if (targetEl && targetEl !== el) {
          const pos = targetEl.dataset.dragPos || 'after';
          if (pos === 'before') {
            targetEl.parentElement.insertBefore(el, targetEl);
          } else {
            targetEl.parentElement.insertBefore(el, targetEl.nextSibling);
          }
          this._saveNavOrder();
        }
        touchDragEl = null;
      };
      container.querySelectorAll('.nav-item, .nav-section-header').forEach(el => {
        el.addEventListener('touchstart', touchStart, { passive: true });
        el.addEventListener('touchmove', touchMove, { passive: false });
        el.addEventListener('touchend', touchEnd);
      });
    }
  },

  _saveNavOrder() {
    const container = document.querySelector('.sidebar-nav');
    if (!container) return;
    const sections = container.querySelectorAll('.nav-section');
    const secOrder = [...sections].map(s => s.dataset.section);
    localStorage.setItem('promake_nav_order', JSON.stringify(secOrder));
    const itemsOrder = {};
    sections.forEach(s => {
      itemsOrder[s.dataset.section] = [...s.querySelectorAll('.nav-item')].map(el => this._navId(el));
    });
    localStorage.setItem('promake_nav_items_order', JSON.stringify(itemsOrder));
  },

  setupNavigation() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        this.loadPage(item.dataset.page);
        const section = item.closest('.nav-section');
        if (section) section.classList.add('open');
        if (window.innerWidth <= 768) this.toggleSidebar();
      });
    });
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const parent = tab.parentElement;
        parent.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (tab.dataset.tab) this.switchTab(tab.dataset.tab);
      });
    });
    ['festefeSearch'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => setTimeout(() => { if (App.currentPage === 'festefe') App.renderFestefe(); }, 300));
    });
    ['leadSearch','clientSearch','projectSearch','financeSearch','contractSearch'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => setTimeout(() => this.loadPage(this.currentPage), 300));
    });
    ['festefeStatusFilter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => { if (App.currentPage === 'festefe') App.renderFestefe(); });
    });
    ['leadStatusFilter','leadSourceFilter','clientStatusFilter','projectStatusFilter','projectTypeFilter',
     'soStatusFilter','soProjectFilter','contractStatusFilter','finTypeFilter','finCategoryFilter',
     'finStartDate','finEndDate'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this.loadPage(this.currentPage));
    });
  },

  switchTab(tab) {
    document.getElementById('finTransactions').style.display = tab === 'transactions' ? 'block' : 'none';
    document.getElementById('finDre').style.display = tab === 'dre' ? 'block' : 'none';
    document.getElementById('finCommissions').style.display = tab === 'commissions' ? 'block' : 'none';
    if (tab === 'dre') this.renderDRE();
    if (tab === 'commissions') this.renderCommissions();

    document.getElementById('reportOverview').style.display = tab === 'report-overview' ? 'block' : 'none';
    document.getElementById('reportClients').style.display = tab === 'report-clients' ? 'block' : 'none';
    document.getElementById('reportProjects').style.display = tab === 'report-projects' ? 'block' : 'none';
    document.getElementById('reportFinancial').style.display = tab === 'report-financial' ? 'block' : 'none';
    if (tab.startsWith('report-')) {
      const rtab = tab.replace('report-','');
      if (rtab === 'overview') this.renderReportOverview();
      if (rtab === 'clients') this.renderReportClients();
      if (rtab === 'projects') this.renderReportProjects();
      if (rtab === 'financial') this.renderReportFinancial();
    }
    ['wa-send','wa-templates','wa-history'].forEach(id => {
      document.getElementById(id).style.display = id === tab ? 'block' : 'none';
    });
    if (tab === 'wa-templates') this.loadWATemplates();
    if (tab === 'wa-history') this.loadWALog();
    ['mkt-meta','mkt-google'].forEach(id => {
      document.getElementById(id).style.display = id === tab ? 'block' : 'none';
    });
    if (tab === 'mkt-meta') this.renderMetaAds();
    if (tab === 'mkt-google') this.renderGoogleAds();
    ['int-wa','int-meta','int-google','int-looker'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = id === tab ? 'block' : 'none';
    });
    if (tab === 'int-looker') this.loadIntLookerConfig();
    // Design tabs
    if (tab === 'design-board') {
      document.getElementById('design-board').style.display = 'block';
      document.getElementById('design-timeline').style.display = 'none';
      if (this._currentDesignId) this.renderDesignBoard(this._currentDesignId);
    }
    if (tab === 'design-timeline') {
      document.getElementById('design-board').style.display = 'none';
      document.getElementById('design-timeline').style.display = 'block';
      if (this._currentDesignId) this.renderTimeline();
    }

  },

  loadPage(page) {
    this.currentPage = page;
    localStorage.setItem('promake_page', page);
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const el = document.getElementById('page-' + page);
    if (el) el.classList.add('active');
    const contentEl = document.querySelector('.content');
    if (contentEl) contentEl.style.paddingTop = page === 'design' ? '0' : '';
    const enT = { dashboard:'Dashboard', leads:'CRM / Leads', clients:'Clients', projects:'Projects',
      kanban:'Kanban', services:'Service Orders', contracts:'Contracts',
      finance:'Finance', calendar:'Calendar', reports:'Reports',
      activity:'Activity', team:'Team', settings:'Settings', integracoes:'Integrations', systems:'Systems', plans:'Plans', chat:'AI Assistant', developments:'Developments', slides:'Slides', landing:'Landing Page', design:'Creative Board', notes:'Notes', calculator:'Calculator', spotify:'Spotify', festefe:'Festefe Tickets' };
    const ptT = { dashboard:'Dashboard', leads:'CRM / Leads', clients:'Clientes', projects:'Projetos',
      kanban:'Kanban', services:'Ordem de serviço', contracts:'Contratos',
      finance:'Financeiro', calendar:'Calendário', reports:'Relatórios',
      activity:'Logs', team:'Equipe', settings:'Configurações', integracoes:'Integrações', systems:'Sistemas', plans:'Planos', chat:'Assistente AI', permissions:'Permissões', developments:'Empreendimentos', slides:'Slides', landing:'Landing Page', design:'Painel Criativo', notes:'Notas', calculator:'Calculadora', spotify:'Spotify', festefe:'Chamado Festefe', security:'Segurança', super_admin:'Super Admin' };
    const titles = this.lang === 'en' ? enT : ptT;
    const icons = {
      dashboard:'fa-chart-pie', leads:'fa-funnel-dollar', clients:'fa-users', projects:'fa-tasks',
      kanban:'fa-columns',       services:'fa-clipboard-list', contracts:'fa-file-signature', marketing:'fa-ad',
      finance:'fa-dollar-sign', calendar:'fa-calendar', reports:'fa-chart-bar',
      activity:'fa-history', team:'fa-user-friends', settings:'fa-cog', integracoes:'fa-plug', systems:'fa-globe', plans:'fa-box', chat:'fa-robot', permissions:'fa-shield-alt', developments:'fa-building', slides:'fa-images', landing:'fa-palette', design:'fa-paint-brush', notes:'fa-sticky-note', calculator:'fa-calculator', spotify:'fa-spotify', festefe:'fa-ticket-alt', security:'fa-shield-alt', super_admin:'fa-user-shield'
    };
    const titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.innerHTML = `<i class="fas ${icons[page] || 'fa-circle'}"></i> ${titles[page] || page}`;

    switch(page) {
      case 'dashboard': this.renderDashboard(); break;
      case 'leads': this.renderLeads(); break;
      case 'clients': this.renderClients(); break;
      case 'projects': this.renderProjects(); break;
      case 'kanban': this.renderKanban(); break;
      case 'services': this.renderServices(); break;
      case 'contracts': this.renderContracts(); break;
      case 'finance': this.renderFinance(); break;
      case 'calendar': this.renderCalendar(); break;
      case 'reports': this.renderReports(); break;
      case 'marketing': this.renderMarketing(); break;
      case 'activity': this.renderActivityLog(); break;
      case 'whatsapp': this.renderWhatsApp(); break;
      case 'team': this.renderTeam(); break;
      case 'integracoes': this.renderIntegracoes(); break;
      case 'design': this.renderDesign(); break;
      case 'notes': this.loadNotes(); break;
      case 'festefe': this.renderFestefe(); break;
      case 'systems': this.renderSystems(); break;
      case 'plans': this.renderPlans(); break;
      case 'chat': this.renderChat(); break;
      case 'permissions': this.renderPermissions(); break;
      case 'developments': this.renderDevelopments(); break;
      case 'slides': this.renderSlides(); break;
      case 'landing': this.renderLanding(); break;
      case 'security': this.renderSecurity(); break;
      case 'super_admin': this.renderSuperAdmin(); break;
      case 'calculator': this.renderCalculator(); break;
      case 'spotify': this.renderSpotify(); break;
    }
  },

  async loadFilterOptions() {
    if (this.filterCache) return this.filterCache;
    const data = await API.get('/api/filters/options');
    if (!data) return {};
    this.filterCache = data;

    // Populate selects
    const typeFilter = document.getElementById('projectTypeFilter');
    if (typeFilter && data.project_types) {
      typeFilter.innerHTML = '<option value="todos">Todos Tipos</option>' + data.project_types.map(t =>
        `<option value="${t}">${t}</option>`).join('');
    }
    const sourceFilter = document.getElementById('leadSourceFilter');
    if (sourceFilter && data.lead_sources) {
      sourceFilter.innerHTML = '<option value="todos">Todas Origens</option>' + data.lead_sources.map(s =>
        `<option value="${s}">${s}</option>`).join('');
    }
    const catFilter = document.getElementById('finCategoryFilter');
    if (catFilter && data.transaction_categories) {
      catFilter.innerHTML = '<option value="todos">Todas Categorias</option>' + data.transaction_categories.map(c =>
        `<option value="${c}">${c}</option>`).join('');
    }
    const soProject = document.getElementById('soProjectFilter');
    if (soProject && data.clients) {
      // Actually load projects
    }
    return data;
  },

  // ====== DASHBOARD ======
  async renderDashboard() {
    const data = await API.get('/api/dashboard');
    if (!data) return;
    const $ = k => this.__(k);
    const fm = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', {minimumFractionDigits:2});

    document.getElementById('dashCards').innerHTML = `
      <div class="card card-hover"><div class="card-icon purple"><i class="fas fa-users"></i></div><div class="card-label">${$('active_clients')}</div><div class="card-value">${data.active_clients}</div><div class="card-change up"><i class="fas fa-arrow-up"></i> ${$('total_clients')}</div></div>
      <div class="card card-hover"><div class="card-icon green"><i class="fas fa-tasks"></i></div><div class="card-label">${$('active_projects')}</div><div class="card-value">${data.active_projects}</div><div class="card-change up"><i class="fas fa-arrow-up"></i> ${data.overdue_projects} ${$('overdue')}</div></div>
      <div class="card card-hover"><div class="card-icon blue"><i class="fas fa-dollar-sign"></i></div><div class="card-label">${$('monthly_revenue')}</div><div class="card-value">${fm(data.revenue_month)}</div><div class="card-change up"><i class="fas fa-arrow-up"></i> ${$('profit')}: ${fm(data.profit_month)}</div></div>
      <div class="card card-hover"><div class="card-icon orange"><i class="fas fa-funnel-dollar"></i></div><div class="card-label">${$('new_leads')}</div><div class="card-value">${data.new_leads}</div><div class="card-change"><i class="fas fa-chart-bar"></i> ${$('total')}: ${data.total_projects} ${$('projects')}</div></div>`;

    const tbody = document.getElementById('dashRecentProjects');
    const hoje = new Date();
    const sl = { pending: $('pending'), active: $('in_progress'), completed: $('completed'), atrasado: $('overdue_st') };
    tbody.innerHTML = (data.recent_projects||[]).map(p => {
      const st = p.status !== 'completed' && p.deadline && new Date(p.deadline+'T23:59:59') < hoje ? 'atrasado' : p.status;
      return `<tr><td>${this.esc(p.name)}</td><td>${this.esc(p.client_name||'')}</td>
      <td><span class="status ${st}">${sl[st]||st}</span></td>
      <td>${p.deadline||'-'}</td><td>R$ ${(p.value||0).toFixed(2)}</td></tr>`;
    }).join('') || '<tr><td colspan="5"><div class="empty-state"><i class="fas fa-tasks"></i><h3>' + $('no_projects') + '</h3></div></td></tr>';

    const chartTitles = document.querySelectorAll('#page-dashboard .chart-card h3');
    if (chartTitles.length >= 4) {
      const ct = [$('revenue_vs_expenses'), $('projects_by_status'), $('projects_by_type'), $('leads_by_status'), $('recent_projects')];
      chartTitles.forEach((el, i) => { if (ct[i]) el.innerHTML = el.innerHTML.replace(/>([^<]+)</, '>' + ct[i] + '<'); });
    }
    const recentTitle = document.querySelector('#dashRecentProjects').closest('.chart-card').querySelector('h3');
    if (recentTitle) recentTitle.innerHTML = '<i class="fas fa-clock"></i> ' + $('recent_projects');
    const tableHeaders = document.querySelectorAll('#dashRecentProjects ~ thead tr th, #dashRecentProjects thead tr th');
    const thsProjetos = document.querySelector('#dashRecentProjects').closest('.chart-card').querySelector('thead tr');
    if (thsProjetos) {
      const hd = [$('project'), $('client'), $('status'), $('deadline'), $('value')];
      thsProjetos.querySelectorAll('th').forEach((th, i) => { if (hd[i]) th.textContent = hd[i]; });
    }
    const activitiesBody = document.getElementById('dashRecentActivities');
    if (activitiesBody) {
      activitiesBody.innerHTML = (data.recent_activities||[]).map(a =>
        `<tr><td style="white-space:nowrap">${a.created_at||''}</td><td>${this.esc(a.user_name||'')}</td><td>${this.esc(a.action)}</td><td>${this.esc(a.description||'')}</td></tr>`
      ).join('') || '<tr><td colspan="4"><div class="empty-state"><i class="fas fa-history"></i><h3>Nenhuma atividade recente</h3></div></td></tr>';
    }
    this.initDashCharts(data);
    this.startGlobe();
    this.startEarth();
    this.loadGlobeStats();
    this.loadMobileStats(data);
  },

  async loadGlobeStats() {
    const st = await API.get('/api/stats');
    if (!st) return;
    const v = document.getElementById('globeVisits');
    const u = document.getElementById('globeUptime');
    if (v) v.innerHTML = '<i class="fas fa-eye"></i> Hoje: <strong>' + st.today_visits + '</strong> | Total: <strong>' + st.total_visits + '</strong>';
    if (u) {
      const parts = st.uptime.match(/(\d+)d\s*(\d+)h\s*(\d+)m\s*(\d+)s/);
      if (parts) {
        let secs = parseInt(parts[1])*86400 + parseInt(parts[2])*3600 + parseInt(parts[3])*60 + parseInt(parts[4]);
        u.innerHTML = '<i class="fas fa-clock"></i> Uptime: <strong id="uptimeDisplay">' + st.uptime + '</strong>';
        setInterval(() => {
          secs++;
          const d = Math.floor(secs / 86400);
          const h = Math.floor((secs % 86400) / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = secs % 60;
          const el = document.getElementById('uptimeDisplay');
          if (el) el.textContent = d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
        }, 1000);
      } else {
        u.innerHTML = '<i class="fas fa-clock"></i> Uptime: <strong>' + st.uptime + '</strong>';
      }
    }
    const ms = document.getElementById('mobileGlobeVisits');
    const mu = document.getElementById('mobileGlobeUptime');
    if (ms) ms.innerHTML = '<i class="fas fa-eye"></i> <strong>' + st.today_visits + '</strong> hoje';
    if (mu) mu.innerHTML = '<i class="fas fa-clock"></i> <strong>' + (st.uptime || '--') + '</strong>';
  },

  loadMobileStats(data) {
    const area = document.querySelector('.globe-area');
    if (!area) return;
    if (window.innerWidth <= 768) {
      area.classList.add('mobile-stats');
      if (!document.getElementById('mobileGlobeVisits')) {
        area.innerHTML = `
          <div class="globe-info"><span class="status-dot"></span> Sistema online</div>
          <div class="globe-info" id="mobileGlobeVisits"><i class="fas fa-eye"></i> <strong>0</strong> hoje</div>
          <div class="globe-info" id="mobileGlobeUptime"><i class="fas fa-clock"></i> <strong>--</strong></div>
        `;
      }
    } else {
      area.classList.remove('mobile-stats');
    }
  },

  startGlobe() {
    if (this.globeRunning) return;
    this.globeRunning = true;
    const canvas = document.getElementById('globeCanvas');
    if (!canvas) { this.globeRunning = false; return; }
    const ctx = canvas.getContext('2d');
    const w = 200, h = 200, cx = w/2, cy = h/2, r = 58;
    let t = 0;
    const stars = [];
    const n = 60;
    for (let i = 0; i < n; i++) {
      const theta = Math.acos(2 * Math.random() - 1);
      const phi = Math.random() * Math.PI * 2;
      stars.push({
        x: r * Math.sin(theta) * Math.cos(phi),
        y: r * Math.cos(theta),
        z: r * Math.sin(theta) * Math.sin(phi),
        size: 1.5 + Math.random() * 2,
        pulse: Math.random() * Math.PI * 2
      });
    }
    const connDist = r * 1.5;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      t += 0.02;
      const angleX = t * 0.3;
      const angleY = t * 0.5;
      const projected = stars.map(s => {
        let x = s.x, y = s.y, z = s.z;
        const cosY = Math.cos(angleY), sinY = Math.sin(angleY);
        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        x = x1; z = z1;
        const cosX = Math.cos(angleX), sinX = Math.sin(angleX);
        const y1 = y * cosX - z * sinX;
        const z2 = y * sinX + z * cosX;
        y = y1; z = z2;
        const scale = 90 / (90 + z);
        return { sx: cx + x * scale, sy: cy + y * scale, z, size: s.size, pulse: s.pulse, star: s };
      });
      projected.sort((a, b) => a.z - b.z);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      for (let i = 0; i < projected.length; i++) {
        for (let j = i + 1; j < projected.length; j++) {
          const dx = projected[i].sx - projected[j].sx;
          const dy = projected[i].sy - projected[j].sy;
          if (dx * dx + dy * dy < connDist * connDist) {
            const avgZ = (projected[i].z + projected[j].z) / 2;
            const alpha = 0.1 + 0.3 * (1 - (avgZ + r) / (r * 2));
            ctx.beginPath();
            ctx.moveTo(projected[i].sx, projected[i].sy);
            ctx.lineTo(projected[j].sx, projected[j].sy);
            ctx.strokeStyle = `rgba(0,176,255,${alpha})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
      ctx.restore();
      projected.forEach(p => {
        const pulse = 0.5 + 0.5 * Math.sin(t * 2 + p.pulse);
        const alpha = 0.3 + 0.7 * (1 - (p.z + r) / (r * 2));
        const size = p.size * (0.5 + 0.5 * pulse);
        const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, size * 4);
        glow.addColorStop(0, `rgba(108,92,231,${alpha * 0.6})`);
        glow.addColorStop(0.5, `rgba(0,176,255,${alpha * 0.2})`);
        glow.addColorStop(1, 'rgba(0,176,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, size * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,220,255,${alpha})`;
        ctx.fill();
      });
      requestAnimationFrame(draw);
    };
    draw();
  },

  startEarth() {
    const canvas = document.getElementById('globeEarth');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = 200, h = 200, cx = w/2, cy = h/2, r = 55;
    let t = 0;
    const bpairs = 16;
    let strands = [];
    for (let i = 0; i < bpairs; i++) {
      const pct = i / bpairs;
      strands.push({ pct, phase: i * 0.4 });
    }
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      t += 0.025;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0, 0, w, h);
      const helix = (offset) => strands.map(s => {
        const angle = s.pct * Math.PI * 4 + t + offset;
        const x = cx + r * 0.7 * Math.cos(angle);
        const y = cy + (s.pct - 0.5) * r * 1.6;
        const z = Math.sin(angle);
        return { x, y, z, pct: s.pct };
      });
      const s1 = helix(0);
      const s2 = helix(Math.PI);
      const all = s1.map((p, i) => ({ ...p, pair: s2[i] }));
      all.sort((a, b) => a.z - b.z);
      all.forEach(p => {
        const alpha = 0.3 + 0.7 * (1 - (p.z + 1) / 2);
        const sz = 2 + p.z * 2;
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, sz * 5);
        glow.addColorStop(0, `rgba(0,176,255,${alpha * 0.6})`);
        glow.addColorStop(0.5, `rgba(108,92,231,${alpha * 0.2})`);
        glow.addColorStop(1, 'rgba(0,176,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz * 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,230,255,${alpha})`;
        ctx.fill();
        if (p.pair) {
          const dx = p.pair.x - p.x;
          const dy = p.pair.y - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < r * 1.5) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.pair.x, p.pair.y);
            ctx.strokeStyle = `rgba(108,92,231,${alpha * 0.3})`;
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }
      });
      const both = [...s1, ...s2];
      for (let i = 0; i < both.length - 1; i++) {
        const a = both[i];
        const b = both[i + 1];
        if (Math.abs(a.pct - b.pct) < 0.1) {
          const avgAlpha = 0.2 + 0.5 * (1 - (Math.abs(a.z + b.z) / 2 + 1) / 2);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(0,176,255,${avgAlpha * 0.25})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(108,92,231,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
      requestAnimationFrame(draw);
    };
    draw();
  },

  initDashCharts(data) {
    if (this.chartInstances.revenue) this.chartInstances.revenue.destroy();
    if (this.chartInstances.status) this.chartInstances.status.destroy();
    if (this.chartInstances.type) this.chartInstances.type.destroy();
    if (this.chartInstances.leads) this.chartInstances.leads.destroy();
    const $ = k => this.__(k);

    const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const revData = new Array(12).fill(0);
    const expData = new Array(12).fill(0);
    (data.revenue_by_month||[]).forEach(r => { const m = parseInt(r.mes)-1; if(m>=0) revData[m]=r.total; });
    (data.expenses_by_month||[]).forEach(r => { const m = parseInt(r.mes)-1; if(m>=0) expData[m]=r.total; });

    this.chartInstances.revenue = new Chart(document.getElementById('revenueChart'), {
      type: 'line', data: { labels: months, datasets: [
        { label: $('revenue'), data: revData, borderColor: '#6C5CE7', backgroundColor: 'rgba(108,92,231,0.1)', fill: true, tension: 0.4 },
        { label: $('expenses'), data: expData, borderColor: '#FF1744', backgroundColor: 'rgba(255,23,68,0.1)', fill: true, tension: 0.4 }
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#8888AA' } } },
        scales: { x: { ticks: { color: '#8888AA' }, grid: { color: 'rgba(42,42,69,0.5)' } },
                 y: { ticks: { color: '#8888AA', callback: v => 'R$ '+v }, grid: { color: 'rgba(42,42,69,0.5)' } } } }
    });

    const sc = { active: 0, completed: 0, pending: 0, atrasado: 0 };
    (data.projects_by_status||[]).forEach(p => { if (sc[p.status]!==undefined) sc[p.status]=p.total; });
    this.chartInstances.status = new Chart(document.getElementById('statusChart'), {
      type: 'doughnut', data: { labels: [$('in_progress'), $('completed'), $('pending'), $('overdue_st')],
        datasets: [{ data: [sc.active, sc.completed, sc.pending, sc.atrasado],
          backgroundColor: ['#6C5CE7','#00C853','#FFD600','#FF1744'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: '#8888AA', padding: 12, boxWidth: 12, font: { size: 13 } } } }, cutout: '65%' }
    });

    this.chartInstances.type = new Chart(document.getElementById('typeChart'), {
      type: 'bar', data: { labels: ['Social Media','Trafego','Design','Web','Conteudo','Consultoria'],
        datasets: [{ label: 'Projetos', data: [0,0,0,0,0,0], backgroundColor: '#6C5CE7', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: '#8888AA' }, grid: { display: false } },
                 y: { ticks: { color: '#8888AA' }, grid: { color: 'rgba(42,42,69,0.5)' } } } }
    });

    this.chartInstances.leads = new Chart(document.getElementById('leadsChart'), {
      type: 'bar', data: { labels: ['Novo','Contato','Qualificado','Proposta','Convertido','Perdido'],
        datasets: [{ label: 'Leads', data: [0,0,0,0,0,0], backgroundColor: '#00B0FF', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: '#8888AA' }, grid: { display: false } },
                 y: { ticks: { color: '#8888AA' }, grid: { color: 'rgba(42,42,69,0.5)' } } } }
    });
  },

  // ====== LEADS ======
  async renderLeads() {
    await this.loadFilterOptions();
    const q = document.getElementById('leadSearch').value;
    const status = document.getElementById('leadStatusFilter').value;
    const source = document.getElementById('leadSourceFilter').value;
    let url = '/api/leads';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status && status !== 'todos') params.set('status', status);
    if (source && source !== 'todos') params.set('source', source);
    const qs = params.toString();
    if (qs) url += '?' + qs;
    const leads = await API.get(url) || [];
    this.renderLeadFunnel(leads);
    const tbody = document.getElementById('leadsTable');
    if (!leads.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><i class="fas fa-funnel-dollar"></i><h3>Nenhum lead encontrado</h3></div></td></tr>';
      return;
    }
    const sl = { novo:'Novo',contato:'Contato',qualificado:'Qualificado',proposta:'Proposta',convertido:'Convertido',perdido:'Perdido' };
    const stc = { novo:'active_s',contato:'andamento',qualificado:'andamento',proposta:'active',convertido:'completed',perdido:'inactive' };
    tbody.innerHTML = leads.map(l => `
      <tr>
        <td><strong>${this.esc(l.name)}</strong></td>
        <td>${this.esc(l.email)}<br><small style="color:var(--text-muted)">${this.esc(l.phone||'')}</small></td>
        <td>${this.esc(l.company||'-')}</td>
        <td>${l.source||'-'}</td>
        <td><span class="status ${stc[l.status]||'pending'}">${sl[l.status]||l.status}</span></td>
        <td><strong>R$ ${(l.value||0).toFixed(2)}</strong></td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.editLead(${l.id})"><i class="fas fa-edit"></i></button>
          ${l.status !== 'convertido' ? `<button class="btn btn-xs btn-success" onclick="App.convertLead(${l.id})" title="Converter em Cliente"><i class="fas fa-exchange-alt"></i></button>` : ''}
          ${l.phone ? `<button class="btn btn-xs btn-info-btn" onclick="App.openWhatsAppSend('lead',${l.id},'${this.esc(l.name)}','${this.esc(l.phone)}')" title="Enviar WhatsApp"><i class="fab fa-whatsapp"></i></button>` : ''}
          <button class="btn btn-xs btn-danger" onclick="App.deleteItem('leads',${l.id},'Lead removido')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  renderLeadFunnel(leads) {
    const stages = ['novo','contato','qualificado','proposta','convertido','perdido'];
    const labels = ['Novo','Contato','Qualificado','Proposta','Convertido','Perdido'];
    const colors = ['#00B0FF','#6C5CE7','#FFD600','#00C853','#8888AA','#FF1744'];
    const counts = {}; const values = {};
    stages.forEach(s => { counts[s]=0; values[s]=0; });
    leads.forEach(l => { if (counts[l.status]!==undefined) { counts[l.status]++; values[l.status]+=l.value||0; } });
    const maxCount = Math.max(...stages.map(s => counts[s]), 1);
    const fm = v => 'R$ '+(v||0).toLocaleString('pt-BR',{minimumFractionDigits:0});
    document.getElementById('leadFunnel').innerHTML = stages.map((s,i) => `
      <div class="funnel-stage">
        <div style="width:30px;height:30px;border-radius:50%;background:${colors[i]};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0">${counts[s]}</div>
        <div class="stage-info"><div class="stage-name">${labels[i]}</div><div class="stage-count">${counts[s]} leads</div><div class="funnel-bar"><div class="funnel-bar-inner ${s}" style="width:${(counts[s]/maxCount*100).toFixed(0)}%"></div></div></div>
        <div class="stage-value">${fm(values[s])}</div>
      </div>
    `).join('');
  },

  async openLeadModal(data) {
    await this.loadFilterOptions();
    const users = await API.get('/api/team') || [];
    document.getElementById('leadAssigned').innerHTML = '<option value="">Nao definido</option>' + users.map(u =>
      `<option value="${u.id}" ${data&&data.assigned_to===u.id?'selected':''}>${this.esc(u.name)}</option>`).join('');
    document.getElementById('leadId').value = data ? data.id : '';
    document.getElementById('leadModalTitle').textContent = data ? 'Editar Lead' : 'Novo Lead';
    document.getElementById('leadName').value = data ? data.name : '';
    document.getElementById('leadEmail').value = data ? data.email : '';
    document.getElementById('leadPhone').value = data ? data.phone : '';
    document.getElementById('leadCompany').value = data ? data.company : '';
    document.getElementById('leadSource').value = data ? data.source : 'website';
    document.getElementById('leadStatus').value = data ? data.status : 'novo';
    document.getElementById('leadValue').value = data ? data.value : '';
    document.getElementById('leadNotes').value = data ? data.notes : '';
    this.openModal('leadModal');
  },
  editLead(id) { API.get('/api/leads/'+id).then(d => { if(d) this.openLeadModal(d); }); },

  async saveLead() {
    const id = document.getElementById('leadId').value;
    const data = {
      name: document.getElementById('leadName').value.trim(),
      email: document.getElementById('leadEmail').value.trim(),
      phone: document.getElementById('leadPhone').value.trim(),
      company: document.getElementById('leadCompany').value.trim(),
      source: document.getElementById('leadSource').value,
      status: document.getElementById('leadStatus').value,
      value: parseFloat(document.getElementById('leadValue').value) || 0,
      notes: document.getElementById('leadNotes').value.trim(),
      assigned_to: parseInt(document.getElementById('leadAssigned').value) || null
    };
    if (!data.name) { this.toast('Digite o nome do lead.', 'error'); return; }
    if (id) await API.put('/api/leads/'+id, data);
    else await API.post('/api/leads', data);
    this.closeModal('leadModal');
    this.renderLeads();
    this.toast(id ? 'Lead atualizado!' : 'Lead cadastrado!');
  },

  async convertLead(id) {
    const result = await API.post(`/api/leads/${id}/convert`);
    if (result && result.ok) { this.toast('Lead convertido em cliente!'); this.renderLeads(); }
  },

  // ====== CLIENTS ======
  async renderClients() {
    const q = document.getElementById('clientSearch').value;
    const status = document.getElementById('clientStatusFilter').value;
    let url = '/api/clients';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status && status !== 'todos') params.set('status', status);
    const qs = params.toString();
    if (qs) url += '?' + qs;
    const clients = await API.get(url) || [];
    const tbody = document.getElementById('clientsTable');
    if (!clients.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><i class="fas fa-users"></i><h3>Nenhum cliente encontrado</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = clients.map(c => `
      <tr>
        <td><strong>${this.esc(c.name)}</strong></td>
        <td>${this.esc(c.email)}</td>
        <td>${this.esc(c.phone||'-')}</td>
        <td>${this.esc(c.company||'-')}</td>
        <td><span class="status ${c.status}">${c.status === 'active' ? 'Ativo' : 'Inativo'}</span></td>
        <td>${c.project_count||0}</td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.editClient(${c.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.showClientPlans(${c.id},'${this.esc(c.name)}')" title="Planos"><i class="fas fa-box"></i></button>
          ${c.phone ? `<button class="btn btn-xs btn-info-btn" onclick="App.openWhatsAppSend('client',${c.id},'${this.esc(c.name)}','${this.esc(c.phone)}')" title="Enviar WhatsApp"><i class="fab fa-whatsapp"></i></button>` : ''}
          <button class="btn btn-xs btn-danger" onclick="App.deleteItem('clients',${c.id},'Cliente removido')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
    document.getElementById('clientPlansPanel').style.display = 'none';
  },

  openClientModal(data) {
    document.getElementById('clientId').value = data ? data.id : '';
    document.getElementById('clientModalTitle').textContent = data ? 'Editar Cliente' : 'Novo Cliente';
    document.getElementById('clientName').value = data ? data.name : '';
    document.getElementById('clientEmail').value = data ? data.email : '';
    document.getElementById('clientPhone').value = data ? data.phone : '';
    document.getElementById('clientCompany').value = data ? data.company : '';
    document.getElementById('clientStatus').value = data ? data.status : 'active';
    document.getElementById('clientTags').value = data ? data.tags||'' : '';
    document.getElementById('clientNotes').value = data ? data.notes||'' : '';
    this.openModal('clientModal');
  },
  editClient(id) { API.get('/api/clients/'+id).then(d => { if(d) this.openClientModal(d); }); },

  async saveClient() {
    const id = document.getElementById('clientId').value;
    const data = {
      name: document.getElementById('clientName').value.trim(),
      email: document.getElementById('clientEmail').value.trim(),
      phone: document.getElementById('clientPhone').value.trim(),
      company: document.getElementById('clientCompany').value.trim(),
      status: document.getElementById('clientStatus').value,
      tags: document.getElementById('clientTags').value.trim(),
      notes: document.getElementById('clientNotes').value.trim()
    };
    if (!data.name || !data.email) { this.toast('Preencha nome e email.', 'error'); return; }
    if (id) await API.put('/api/clients/'+id, data);
    else await API.post('/api/clients', data);
    this.closeModal('clientModal');
    this.renderClients();
    this.toast(id ? 'Cliente atualizado!' : 'Cliente cadastrado!');
  },

  // ====== PROJECTS ======
  async renderProjects() {
    await this.loadFilterOptions();
    const q = document.getElementById('projectSearch').value;
    const status = document.getElementById('projectStatusFilter').value;
    const type = document.getElementById('projectTypeFilter').value;
    let url = '/api/projects';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status && status !== 'todos') params.set('status', status);
    if (type && type !== 'todos') params.set('type', type);
    const qs = params.toString();
    if (qs) url += '?' + qs;
    const projects = await API.get(url) || [];
    const tbody = document.getElementById('projectsTable');
    const sl = { pending:'Pendente', active:'Em Andamento', completed:'Concluído', atrasado:'Atrasado' };
    const hoje = new Date();
    if (!projects.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-tasks"></i><h3>Nenhum projeto</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = projects.map(p => {
      const statusAtrasado = p.status !== 'completed' && p.deadline && new Date(p.deadline+'T23:59:59') < hoje ? 'atrasado' : p.status;
      return `<tr>
        <td><strong>${this.esc(p.name)}</strong></td>
        <td>${this.esc(p.client_name||'')}</td>
        <td>${p.type}</td>
        <td><span class="status ${statusAtrasado}">${sl[statusAtrasado]||statusAtrasado}</span></td>
        <td>${p.deadline||'-'}</td>
        <td>R$ ${(p.value||0).toFixed(2)}</td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.uploadFile('project',${p.id})" title="Anexar arquivo"><i class="fas fa-paperclip"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.exportPDF('project',${p.id})" title="Exportar PDF"><i class="fas fa-file-pdf"></i></button>
          <button class="btn btn-xs btn-outline" onclick="App.viewFiles('project',${p.id})" title="Ver arquivos"><i class="fas fa-folder-open"></i></button>
        </td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.editProject(${p.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.viewProjectOS(${p.id})" title="Ordem de serviço"><i class="fas fa-clipboard-list"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteItem('projects',${p.id},'Projeto removido')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  },

  async openProjectModal(data) {
    await this.loadFilterOptions();
    const clients = await API.get('/api/clients?status=active') || [];
    document.getElementById('projectClient').innerHTML = '<option value="">Selecione</option>' + clients.map(c =>
      `<option value="${c.id}" ${data&&data.client_id===c.id?'selected':''}>${this.esc(c.name)} - ${this.esc(c.company||'')}</option>`).join('');
    document.getElementById('projectId').value = data ? data.id : '';
    document.getElementById('projectModalTitle').textContent = data ? 'Editar Projeto' : 'Novo Projeto';
    document.getElementById('projectName').value = data ? data.name : '';
    if (data && data.client_id) document.getElementById('projectClient').value = data.client_id;
    document.getElementById('projectType').value = data ? data.type : 'Social Media';
    document.getElementById('projectStatus').value = data ? data.status : 'active';
    document.getElementById('projectDeadline').value = data ? data.deadline : '';
    document.getElementById('projectValue').value = data ? data.value : '';
    document.getElementById('projectCommission').value = 0;
    document.getElementById('projectDesc').value = data ? data.description||'' : '';
    this.openModal('projectModal');
  },
  editProject(id) { API.get('/api/projects/'+id).then(d => { if(d) this.openProjectModal(d); }); },

  async saveProject() {
    const id = document.getElementById('projectId').value;
    const data = {
      name: document.getElementById('projectName').value.trim(),
      client_id: parseInt(document.getElementById('projectClient').value) || null,
      type: document.getElementById('projectType').value,
      status: document.getElementById('projectStatus').value,
      deadline: document.getElementById('projectDeadline').value,
      value: parseFloat(document.getElementById('projectValue').value) || 0,
      description: document.getElementById('projectDesc').value.trim()
    };
    if (!data.name) { this.toast('Digite o nome do projeto.', 'error'); return; }
    let res;
    if (id) res = await API.put('/api/projects/'+id, data);
    else res = await API.post('/api/projects', data);
    if (!res || res.error) {
      this.toast('Erro ao salvar projeto: ' + (res?.error || 'sem resposta do servidor'), 'error');
      return;
    }
    this.closeModal('projectModal');
    if (this.currentPage === 'kanban') this.renderKanban();
    else this.renderProjects();
    this.renderDashboard();
    this.toast(id ? 'Projeto atualizado!' : 'Projeto criado!');
  },

  viewProjectOS(pid) { this.loadPage('services'); document.getElementById('soProjectFilter').value = pid; this.renderServices(); },

  // ====== KANBAN ======
  async renderKanban() {
    const data = await API.get('/api/projects/kanban') || {};
    const cols = ['pending','active','completed','atrasado'];
    const colLabels = { pending:'Pendente', active:'Em Andamento', completed:'Concluído', atrasado:'Atrasado' };
    const colColors = { pending:'#FFD600', active:'#6C5CE7', completed:'#00C853', atrasado:'#FF1744' };
    const board = document.getElementById('kanbanBoard');
    board.innerHTML = cols.map(c => `
      <div class="kanban-col" data-status="${c}" ondragover="event.preventDefault();this.classList.add('drag-over')" ondragleave="this.classList.remove('drag-over')" ondrop="App.kanbanDrop(event,'${c}')">
        <h4 style="color:${colColors[c]}"><i class="fas fa-circle"></i> ${colLabels[c]} <span class="count">${(data[c]||[]).length}</span></h4>
        ${(data[c]||[]).map(p => `
          <div class="kanban-card" draggable="true" ondragstart="App.kanbanDrag(event,${p.id})" onclick="App.editProject(${p.id})">
            <div class="card-title">${this.esc(p.name)}</div>
            <div class="card-sub">${this.esc(p.client_name||'')} · ${p.type}</div>
            <div class="card-footer">
              <span style="font-size:12px;font-weight:600">R$ ${(p.value||0).toFixed(0)}</span>
              <span style="font-size:11px;color:var(--text-muted)">${p.deadline||'-'}</span>
            </div>
          </div>
        `).join('') || '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">Nenhum projeto</div>'}
      </div>
    `).join('');
  },

  kanbanDrag(ev, id) { ev.dataTransfer.setData('text/plain', id); },
  async kanbanDrop(ev, status) {
    ev.preventDefault();
    ev.target.classList.remove('drag-over');
    const id = parseInt(ev.dataTransfer.getData('text/plain'));
    if (!id) return;
    await API.post('/api/projects/kanban/reorder', { items: [{ id, status, order: 0 }] });
    this.renderKanban();
    this.renderDashboard();
    this.toast('Projeto movido para ' + ({pending:'Pendente',active:'Em Andamento',completed:'Concluído',atrasado:'Atrasado'}[status]||status));
  },

  // ====== SERVICE ORDERS ======
  async renderServices() {
    await this.loadFilterOptions();
    const status = document.getElementById('soStatusFilter').value;
    const pid = document.getElementById('soProjectFilter').value;
    let url = '/api/service-orders';
    const params = new URLSearchParams();
    if (status && status !== 'todos') params.set('status', status);
    if (pid) params.set('project_id', pid);
    const qs = params.toString();
    if (qs) url += '?' + qs;
    const orders = await API.get(url) || [];
    const hoje = new Date();

    // Populate project filter
    const projects = await API.get('/api/projects') || [];
    const pf = document.getElementById('soProjectFilter');
    pf.innerHTML = '<option value="">Todos Projetos</option>' + projects.map(p =>
      `<option value="${p.id}" ${pid==p.id?'selected':''}>${this.esc(p.name)}</option>`).join('');

    const tbody = document.getElementById('servicesTable');
    const sl = { pending:'Pendente', active:'Em Andamento', completed:'Concluído', atrasado:'Atrasado' };
    const pr = { alta:'priority-alta', media:'priority-media', baixa:'priority-baixa' };
    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-clipboard-list"></i><h3>Nenhuma OS encontrada</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = orders.map(o => {
      const statusAtrasado = o.status !== 'completed' && o.deadline && new Date(o.deadline+'T23:59:59') < hoje ? 'atrasado' : o.status;
      return `<tr>
        <td><strong>${this.esc(o.title)}</strong></td>
        <td>${this.esc(o.project_name||'')}</td>
        <td class="${pr[o.priority]||''}"><strong>${o.priority||'media'}</strong></td>
        <td><span class="status ${statusAtrasado}">${sl[statusAtrasado]||statusAtrasado}</span></td>
        <td>${this.esc(o.assigned_name||'-')}</td>
        <td>${o.deadline||'-'}</td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.uploadFile('service-order',${o.id})" title="Anexar arquivo"><i class="fas fa-paperclip"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.exportPDF('service-order',${o.id})" title="Exportar PDF"><i class="fas fa-file-pdf"></i></button>
          <button class="btn btn-xs btn-outline" onclick="App.viewFiles('service-order',${o.id})" title="Ver arquivos"><i class="fas fa-folder-open"></i></button>
        </td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.editSO(${o.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.openTaskModalFor(${o.id})" title="Tarefas"><i class="fas fa-tasks"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteItem('service-orders',${o.id},'OS removida')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
  },

  async openSOModal(data) {
    await this.loadFilterOptions();
    const projects = await API.get('/api/projects') || [];
    const users = await API.get('/api/team') || [];
    document.getElementById('soProject').innerHTML = '<option value="">Selecione</option>' + projects.map(p =>
      `<option value="${p.id}" ${data&&data.project_id===p.id?'selected':''}>${this.esc(p.name)}</option>`).join('');
    document.getElementById('soAssigned').innerHTML = '<option value="">Nao definido</option>' + users.map(u =>
      `<option value="${u.id}" ${data&&data.assigned_to===u.id?'selected':''}>${this.esc(u.name)}</option>`).join('');
    document.getElementById('soId').value = data ? data.id : '';
    document.getElementById('soModalTitle').textContent = data ? 'Editar OS' : 'Nova Ordem de serviço';
    document.getElementById('soTitle').value = data ? data.title : '';
    document.getElementById('soPriority').value = data ? data.priority : 'media';
    document.getElementById('soStatus').value = data ? data.status : 'active';
    document.getElementById('soDeadline').value = data ? data.deadline : '';
    document.getElementById('soHours').value = data ? data.estimated_hours||'' : '';
    document.getElementById('soDesc').value = data ? data.description||'' : '';
    this.taskFieldCount = 0;
    document.getElementById('soTasksList').innerHTML = '';
    if (data && data.id) {
      const tasks = await API.get(`/api/service-orders/${data.id}/tasks`) || [];
      tasks.forEach(t => this.addTaskField(t));
    }
    this.openModal('soModal');
  },
  editSO(id) { API.get('/api/service-orders/'+id).then(d => { if(d) this.openSOModal(d); }); },

  addTaskField(task) {
    const idx = this.taskFieldCount++;
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
    div.innerHTML = `
      <input type="text" id="taskField_${idx}" placeholder="Tarefa" style="flex:1;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px" value="${this.esc(task?.title||'')}">
      <select id="taskFieldStatus_${idx}" style="padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px">
        <option value="pending" ${task?.status==='pending'?'selected':''}>Pendente</option>
        <option value="active" ${task?.status==='active'?'selected':''}>Andamento</option>
        <option value="completed" ${task?.status==='completed'?'selected':''}>Concluida</option>
      </select>
      <button class="btn btn-xs btn-danger" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
    `;
    document.getElementById('soTasksList').appendChild(div);
  },

  async saveSO() {
    const id = document.getElementById('soId').value;
    const data = {
      title: document.getElementById('soTitle').value.trim(),
      project_id: parseInt(document.getElementById('soProject').value) || null,
      priority: document.getElementById('soPriority').value,
      status: document.getElementById('soStatus').value,
      assigned_to: parseInt(document.getElementById('soAssigned').value) || null,
      deadline: document.getElementById('soDeadline').value,
      estimated_hours: parseFloat(document.getElementById('soHours').value) || 0,
      description: document.getElementById('soDesc').value.trim()
    };
    if (!data.title) { this.toast('Digite o título da OS.', 'error'); return; }
    let result;
    if (id) result = await API.put('/api/service-orders/'+id, data);
    else result = await API.post('/api/service-orders', data);
    if (result && result.id) {
      for (let i = 0; i < this.taskFieldCount; i++) {
        const titleEl = document.getElementById('taskField_'+i);
        const statusEl = document.getElementById('taskFieldStatus_'+i);
        if (titleEl && titleEl.value.trim()) {
          await API.post(`/api/service-orders/${result.id}/tasks`, {
            title: titleEl.value.trim(),
            status: statusEl ? statusEl.value : 'pending'
          });
        }
      }
    }
    this.closeModal('soModal');
    this.renderServices();
    this.toast(id ? 'OS atualizada!' : 'OS criada!');
  },

  async openTaskModalFor(soId) {
    const users = await API.get('/api/team') || [];
    document.getElementById('taskSOId').value = soId;
    document.getElementById('taskId').value = '';
    document.getElementById('taskModalTitle').textContent = 'Nova Tarefa';
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskStatus').value = 'pending';
    document.getElementById('taskDeadline').value = '';
    document.getElementById('taskAssigned').innerHTML = '<option value="">Nao definido</option>' + users.map(u =>
      `<option value="${u.id}">${this.esc(u.name)}</option>`).join('');
    this.openModal('taskModal');
  },

  async saveTask() {
    const soId = document.getElementById('taskSOId').value;
    const id = document.getElementById('taskId').value;
    const data = {
      title: document.getElementById('taskTitle').value.trim(),
      status: document.getElementById('taskStatus').value,
      assigned_to: parseInt(document.getElementById('taskAssigned').value) || null,
      deadline: document.getElementById('taskDeadline').value
    };
    if (!data.title) { this.toast('Digite o título da tarefa.', 'error'); return; }
    if (id) await API.put('/api/tasks/'+id, data);
    else await API.post(`/api/service-orders/${soId}/tasks`, data);
    this.closeModal('taskModal');
    this.toast('Tarefa salva!');
  },

  // ====== CONTRACTS ======
  async renderContracts() {
    await this.loadFilterOptions();
    const q = document.getElementById('contractSearch').value;
    const status = document.getElementById('contractStatusFilter').value;
    let url = '/api/contracts';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status && status !== 'todos') params.set('status', status);
    const qs = params.toString();
    if (qs) url += '?' + qs;
    const contracts = await API.get(url) || [];
    const tbody = document.getElementById('contractsTable');
    const stl = { active:'Ativo', expired:'Expirado', cancelled:'Cancelado' };
    const renewalLabels = { monthly:'Mensal', quarterly:'Trimestral', semiannual:'Semestral', annual:'Anual', none:'Sem renovacao' };
    if (!contracts.length) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><i class="fas fa-file-signature"></i><h3>Nenhum contrato</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = contracts.map(c => `
      <tr>
        <td><strong>${this.esc(c.title)}</strong></td>
        <td>${this.esc(c.client_name||'')}</td>
        <td><strong>R$ ${(c.value||0).toFixed(2)}</strong></td>
        <td>${c.start_date||'-'}</td>
        <td>${c.end_date||'-'}</td>
        <td>${renewalLabels[c.renewal_type]||c.renewal_type}</td>
        <td><span class="status ${c.status}">${stl[c.status]||c.status}</span></td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.uploadFile('contract',${c.id})" title="Anexar arquivo"><i class="fas fa-paperclip"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.exportPDF('contract',${c.id})" title="Exportar PDF"><i class="fas fa-file-pdf"></i></button>
          <button class="btn btn-xs btn-outline" onclick="App.viewFiles('contract',${c.id})" title="Ver arquivos"><i class="fas fa-folder-open"></i></button>
        </td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.editContract(${c.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteItem('contracts',${c.id},'Contrato removido')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  async openContractModal(data) {
    const clients = await API.get('/api/clients?status=active') || [];
    document.getElementById('contractClient').innerHTML = '<option value="">Selecione</option>' + clients.map(c =>
      `<option value="${c.id}" ${data&&data.client_id===c.id?'selected':''}>${this.esc(c.name)}</option>`).join('');
    document.getElementById('contractId').value = data ? data.id : '';
    document.getElementById('contractModalTitle').textContent = data ? 'Editar Contrato' : 'Novo Contrato';
    document.getElementById('contractTitle').value = data ? data.title : '';
    document.getElementById('contractValue').value = data ? data.value : '';
    document.getElementById('contractStart').value = data ? data.start_date : '';
    document.getElementById('contractEnd').value = data ? data.end_date : '';
    document.getElementById('contractRenewal').value = data ? data.renewal_type : 'monthly';
    document.getElementById('contractStatus').value = data ? data.status : 'active';
    document.getElementById('contractDesc').value = data ? data.description||'' : '';
    this.openModal('contractModal');
  },
  editContract(id) { API.get('/api/contracts/'+id).then(d => { if(d) this.openContractModal(d); }); },

  async saveContract() {
    const id = document.getElementById('contractId').value;
    const data = {
      client_id: parseInt(document.getElementById('contractClient').value) || null,
      title: document.getElementById('contractTitle').value.trim(),
      value: parseFloat(document.getElementById('contractValue').value) || 0,
      start_date: document.getElementById('contractStart').value,
      end_date: document.getElementById('contractEnd').value,
      renewal_type: document.getElementById('contractRenewal').value,
      status: document.getElementById('contractStatus').value,
      description: document.getElementById('contractDesc').value.trim()
    };
    if (!data.title) { this.toast('Digite o título do contrato.', 'error'); return; }
    if (id) await API.put('/api/contracts/'+id, data);
    else await API.post('/api/contracts', data);
    this.closeModal('contractModal');
    this.renderContracts();
    this.toast(id ? 'Contrato atualizado!' : 'Contrato criado!');
  },

  // ====== FINANCE ======
  async renderFinance() {
    await this.loadFilterOptions();
    const summary = await API.get('/api/finance/summary') || {};
    const fm = v => 'R$ '+(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
    document.getElementById('finRevenueMonth').textContent = fm(summary.revenue_month);
    document.getElementById('finExpensesMonth').textContent = fm(summary.expenses_month);
    const profit = (summary.revenue_month||0) - (summary.expenses_month||0);
    const profitEl = document.getElementById('finProfitMonth');
    profitEl.textContent = fm(profit);
    profitEl.className = 'value ' + (profit >= 0 ? 'positive' : 'negative');

    const q = document.getElementById('financeSearch').value;
    const type = document.getElementById('finTypeFilter').value;
    const cat = document.getElementById('finCategoryFilter').value;
    const start = document.getElementById('finStartDate').value;
    const end = document.getElementById('finEndDate').value;
    let url = '/api/finance/transactions';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (type && type !== 'todos') params.set('type', type);
    if (cat && cat !== 'todos') params.set('category', cat);
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    const qs = params.toString();
    if (qs) url += '?' + qs;
    const transactions = await API.get(url) || [];
    const tbody = document.getElementById('financeTable');
    if (!transactions.length) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><i class="fas fa-dollar-sign"></i><h3>Nenhuma transacao</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = transactions.map(t => `
      <tr>
        <td>${t.date}</td>
        <td>${this.esc(t.description)}</td>
        <td><span class="status ${t.type==='income'?'active':'inactive'}">${t.type==='income'?'Receita':'Despesa'}</span></td>
        <td>${t.category}</td>
        <td style="color:${t.type==='income'?'var(--success)':'var(--danger)'};font-weight:600">${t.type==='income'?'+':'-'} R$ ${(t.value||0).toFixed(2)}</td>
        <td>${t.payment_method||'-'}</td>
        <td><span class="status ${t.status==='completed'?'active':t.status==='pending'?'pending':'inactive'}">${t.status==='completed'?'Pago':'Pendente'}</span></td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.uploadFile('transaction',${t.id})" title="Anexar arquivo"><i class="fas fa-paperclip"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.exportPDF('transaction',${t.id})" title="Exportar PDF"><i class="fas fa-file-pdf"></i></button>
          <button class="btn btn-xs btn-outline" onclick="App.viewFiles('transaction',${t.id})" title="Ver arquivos"><i class="fas fa-folder-open"></i></button>
        </td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.editTransaction(${t.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteItem('finance/transactions',${t.id},'Transacao removida')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  async openTransactionModal(data) {
    const clients = await API.get('/api/clients') || [];
    const projects = await API.get('/api/projects') || [];
    document.getElementById('transClient').innerHTML = '<option value="">Nenhum</option>' + clients.map(c =>
      `<option value="${c.id}" ${data&&data.client_id===c.id?'selected':''}>${this.esc(c.name)}</option>`).join('');
    document.getElementById('transProject').innerHTML = '<option value="">Nenhum</option>' + projects.map(p =>
      `<option value="${p.id}" ${data&&data.project_id===p.id?'selected':''}>${this.esc(p.name)}</option>`).join('');
    document.getElementById('transactionId').value = data ? data.id : '';
    document.getElementById('transModalTitle').textContent = data ? 'Editar Transacao' : 'Nova Transacao';
    document.getElementById('transDesc').value = data ? data.description : '';
    document.getElementById('transType').value = data ? data.type : 'income';
    document.getElementById('transCategory').value = data ? data.category : 'Mensalidade';
    document.getElementById('transValue').value = data ? data.value : '';
    document.getElementById('transDate').value = data ? data.date : new Date().toISOString().split('T')[0];
    document.getElementById('transMethod').value = data ? data.payment_method||'' : '';
    document.getElementById('transStatus').value = data ? data.status : 'completed';
    this.openModal('transactionModal');
  },
  editTransaction(id) { API.get('/api/finance/transactions/'+id).then(d => { if(d) this.openTransactionModal(d); }); },

  async saveTransaction() {
    const id = document.getElementById('transactionId').value;
    const data = {
      description: document.getElementById('transDesc').value.trim(),
      type: document.getElementById('transType').value,
      category: document.getElementById('transCategory').value,
      value: parseFloat(document.getElementById('transValue').value) || 0,
      date: document.getElementById('transDate').value,
      client_id: parseInt(document.getElementById('transClient').value) || null,
      project_id: parseInt(document.getElementById('transProject').value) || null,
      payment_method: document.getElementById('transMethod').value,
      status: document.getElementById('transStatus').value
    };
    if (!data.description) { this.toast('Descreva a transacao.', 'error'); return; }
    if (data.value <= 0) { this.toast('Valor deve ser maior que zero.', 'error'); return; }
    if (id) await API.put('/api/finance/transactions/'+id, data);
    else await API.post('/api/finance/transactions', data);
    this.closeModal('transactionModal');
    this.renderFinance();
    this.toast(id ? 'Transacao atualizada!' : 'Transacao registrada!');
  },

  async renderDRE() {
    const yearSelect = document.getElementById('dreYear');
    const currentYear = new Date().getFullYear();
    yearSelect.innerHTML = '';
    for (let y = currentYear - 2; y <= currentYear + 1; y++) {
      yearSelect.innerHTML += `<option value="${y}" ${y===currentYear?'selected':''}>${y}</option>`;
    }
    const year = yearSelect.value;
    const dre = await API.get(`/api/finance/dre?year=${year}`) || {};
    const tbody = document.getElementById('dreTable');
    const fm = v => 'R$ '+(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
    if (!dre.months || !dre.months.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><h3>Sem dados</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = dre.months.map(m => `
      <tr>
        <td><strong>${m.month_name}</strong></td>
        <td style="color:var(--success)">${fm(m.revenue)}</td>
        <td style="color:var(--danger)">${fm(m.expenses)}</td>
        <td style="color:${m.profit>=0?'var(--success)':'var(--danger)'};font-weight:600">${fm(m.profit)}</td>
        <td>${m.revenue > 0 ? ((m.profit/m.revenue*100).toFixed(1)+'%') : '-'}</td>
      </tr>
    `).join('');
    yearSelect.onchange = () => this.renderDRE();
  },

  async renderCommissions() {
    const commissions = await API.get('/api/finance/commissions') || [];
    const tbody = document.getElementById('commissionsTable');
    if (!commissions.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i class="fas fa-dollar-sign"></i><h3>Nenhuma comissao</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = commissions.map(c => `
      <tr>
        <td>${this.esc(c.user_name||'')}</td>
        <td>${this.esc(c.project_name||'')}</td>
        <td>R$ ${(c.value||0).toFixed(2)}</td>
        <td>${(c.percentage||0).toFixed(1)}%</td>
        <td><strong>R$ ${(((c.value||0)*(c.percentage||0))/100).toFixed(2)}</strong></td>
        <td><span class="status ${c.status==='paid'?'completed':'pending'}">${c.status==='paid'?'Pago':'Pendente'}</span></td>
      </tr>
    `).join('');
  },

  // ====== CALENDAR ======
  renderCalendar() {
    const year = this.calendarDate.getFullYear();
    const month = this.calendarDate.getMonth();
    const monthNames = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    document.getElementById('calendarTitle').textContent = monthNames[month] + ' ' + year;
    this.loadCalendarEvents(year, month);
  },

  async loadCalendarEvents(year, month) {
    const events = await API.get(`/api/calendar?month=${month+1}&year=${year}`) || [];
    this.drawCalendar(year, month, events);
  },

  drawCalendar(year, month, events) {
    const grid = document.getElementById('calendarGrid');
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const dayNames = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'];
    let html = dayNames.map(d => `<div class="calendar-header">${d}</div>`).join('');
    for (let i = firstDay - 1; i >= 0; i--) {
      html += `<div class="calendar-day other-month"><div class="day-num">${daysInPrevMonth - i}</div></div>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
      const dayEvents = events.filter(e => {
        const ed = new Date(e.date + 'T00:00:00');
        return ed.getDate() === d && ed.getMonth() === month && ed.getFullYear() === year;
      });
      const dots = dayEvents.map(e => `<span class="event-dot ${e.type||'evento'}" title="${this.esc(e.title)}"></span>`).join('');
      html += `<div class="calendar-day ${isToday?'today':''}" onclick="App.selectDay(${year},${month},${d})"><div class="day-num">${d}</div>${dots}</div>`;
    }
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells <= 35 ? 35 - totalCells : 42 - totalCells;
    for (let i = 1; i <= remaining; i++) {
      html += `<div class="calendar-day other-month"><div class="day-num">${i}</div></div>`;
    }
    grid.innerHTML = html;
    document.getElementById('calendarDayEvents').innerHTML = 'Selecione um dia no calendário';
  },

  async selectDay(year, month, day) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const events = await API.get(`/api/calendar?month=${month+1}&year=${year}`) || [];
    const dayEvents = events.filter(e => e.date === dateStr);
    const container = document.getElementById('calendarDayEvents');
    if (!dayEvents.length) {
      container.innerHTML = `<div style="padding:12px;color:var(--text-muted);text-align:center">Nenhum evento em ${dateStr}</div>
        <button class="btn btn-sm btn-primary" onclick="App.openEventModalForDate('${dateStr}')" style="margin:8px auto;display:block"><i class="fas fa-plus"></i> Adicionar Evento</button>`;
      return;
    }
    const typeIcons = { reuniao:'fa-handshake', prazo:'fa-clock', evento:'fa-calendar-check', aniversario:'fa-birthday-cake', task:'fa-tasks', holiday:'fa-star', seasonal:'fa-leaf' };
    container.innerHTML = dayEvents.map(e => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid var(--border)">
        <i class="fas ${typeIcons[e.type]||'fa-calendar'}" style="color:${e.type==='task'?'var(--warning)':e.type==='holiday'?'var(--danger)':e.type==='seasonal'?'var(--success)':'var(--primary)'};width:16px"></i>
        <div style="flex:1"><strong>${this.esc(e.title)}</strong><br><small style="color:var(--text-muted)">${e.type==='task'?'Tarefa - '+this.esc(e.description||''):e.type==='holiday'||e.type==='seasonal'?this.esc(e.description||''):e.time||'Dia todo'} ${e.description && e.type!=='task' && e.type!=='holiday' && e.type!=='seasonal' ? '- '+this.esc(e.description) : ''}</small></div>
        ${e.id?`<button class="btn btn-xs btn-danger" onclick="App.deleteCalendarEvent(${e.id})"><i class="fas fa-trash"></i></button>`:''}
      </div>
    `).join('');
    container.innerHTML += `<button class="btn btn-sm btn-primary" onclick="App.openEventModalForDate('${dateStr}')" style="margin:8px auto;display:block"><i class="fas fa-plus"></i> Adicionar Evento</button>`;
  },

  openEventModalForDate(dateStr) { document.getElementById('eventDate').value = dateStr; this.openEventModal(); },
  calendarPrev() { this.calendarDate.setMonth(this.calendarDate.getMonth() - 1); this.renderCalendar(); },
  calendarNext() { this.calendarDate.setMonth(this.calendarDate.getMonth() + 1); this.renderCalendar(); },

  openEventModal(data) {
    document.getElementById('eventId').value = data ? data.id : '';
    document.getElementById('eventModalTitle').textContent = data ? 'Editar Evento' : 'Novo Evento';
    document.getElementById('eventTitle').value = data ? data.title : '';
    document.getElementById('eventDate').value = data ? data.date : new Date().toISOString().split('T')[0];
    document.getElementById('eventTime').value = data ? data.time||'' : '';
    document.getElementById('eventType').value = data ? data.type : 'evento';
    document.getElementById('eventDesc').value = data ? data.description||'' : '';
    this.openModal('eventModal');
  },

  async saveEvent() {
    const id = document.getElementById('eventId').value;
    const data = {
      title: document.getElementById('eventTitle').value.trim(),
      date: document.getElementById('eventDate').value,
      time: document.getElementById('eventTime').value,
      type: document.getElementById('eventType').value,
      description: document.getElementById('eventDesc').value.trim()
    };
    if (!data.title || !data.date) { this.toast('Preencha título e data.', 'error'); return; }
    if (id) await API.put('/api/calendar/'+id, data);
    else await API.post('/api/calendar', data);
    this.closeModal('eventModal');
    this.renderCalendar();
    this.toast(id ? 'Evento atualizado!' : 'Evento criado!');
  },

    confirmAsync(msg) {
    return new Promise(resolve => {
      this._confirmResolve = resolve;
      document.getElementById('confirmTitle').textContent = msg || 'Tem certeza?';
      document.getElementById('confirmOkBtn').innerHTML = '<i class="fas fa-trash"></i> Confirmar';
      this.openModal('confirmModal');
    });
  },
  closeConfirm() {
    this.closeModal('confirmModal');
    if (this._confirmResolve) this._confirmResolve(false);
  },
  confirmOk() {
    this.closeModal('confirmModal');
    if (this._confirmResolve) this._confirmResolve(true);
  },

  async deleteCalendarEvent(id) {
    const ok = await this.confirmAsync('Remover este evento?');
    if (!ok) return;
    await API.del('/api/calendar/'+id);
    this.renderCalendar();
    this.toast('Evento removido.');
  },

  // ====== REPORTS ======
  async renderReports() { this.switchTab('report-overview'); },

  async renderReportOverview() {
    const rp = await API.get('/api/reports/projects') || [];
    const rc = await API.get('/api/reports/clients') || [];
    const rf = await API.get('/api/reports/financial') || {};
    const fm = v => 'R$ '+(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});

    document.getElementById('reportCards').innerHTML = `
      <div class="stat-card"><div class="stat-value" style="color:var(--success)">${fm(rf.total_revenue)}</div><div class="stat-label">Receita Total</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--danger)">${fm(rf.total_expenses)}</div><div class="stat-label">Despesas Totais</div></div>
      <div class="stat-card"><div class="stat-value" style="color:${rf.net_profit>0?'var(--success)':'var(--danger)'}">${fm(rf.net_profit)}</div><div class="stat-label">Lucro Liquido</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--info)">${(rf.profit_margin||0).toFixed(1)}%</div><div class="stat-label">Margem de Lucro</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--warning)">${fm(rf.pending_invoices)}</div><div class="stat-label">Faturas Pendentes</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--primary)">${rc.length}</div><div class="stat-label">Total de Clientes</div></div>`;

    if (this.chartInstances.reportProjects) this.chartInstances.reportProjects.destroy();
    if (this.chartInstances.reportClients) this.chartInstances.reportClients.destroy();

    const statuses = [...new Set(rp.map(r => r.status))];
    const types = [...new Set(rp.map(r => r.type))];
    const typeColors = ['#6C5CE7','#00C853','#FFD600','#00B0FF','#FF6B6B','#FF9800','#E040FB','#00BCD4','#8BC34A'];
    this.chartInstances.reportProjects = new Chart(document.getElementById('reportProjectsChart'), {
      type: 'bar', data: {
        labels: types,
        datasets: statuses.map((s,i) => ({
          label: s==='active'?'Em Andamento':s==='completed'?'Concluído':'Pendente',
          data: types.map(t => { const f=rp.find(r=>r.status===s&&r.type===t); return f?f.total:0; }),
          backgroundColor: typeColors[i % typeColors.length]
        }))
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#8888AA' } } },
        scales: { x: { ticks: { color: '#8888AA' }, grid: { display: false } },
                 y: { ticks: { color: '#8888AA' }, grid: { color: 'rgba(42,42,69,0.5)' } } } }
    });

    const topClients = rc.slice(0, 10);
    this.chartInstances.reportClients = new Chart(document.getElementById('reportClientsChart'), {
      type: 'bar', data: {
        labels: topClients.map(c => c.name),
        datasets: [{ label: 'Receita Total', data: topClients.map(c => c.total_revenue), backgroundColor: '#6C5CE7', borderRadius: 4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: '#8888AA' }, grid: { display: false } },
                 y: { ticks: { color: '#8888AA', callback: v => 'R$ '+v }, grid: { color: 'rgba(42,42,69,0.5)' } } } }
    });
  },

  async renderReportClients() {
    const rc = await API.get('/api/reports/clients') || [];
    const fm = v => 'R$ '+(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
    const tbody = document.getElementById('reportClientsTable');
    if (!rc.length) { tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><h3>Sem dados</h3></div></td></tr>'; return; }
    tbody.innerHTML = rc.map(c => `
      <tr><td><strong>${this.esc(c.name)}</strong></td><td>${this.esc(c.company||'-')}</td>
      <td>${c.total_projects||0}</td><td>${c.active_projects||0}</td>
      <td>${fm(c.total_revenue)}</td><td>${fm(c.month_revenue)}</td></tr>
    `).join('');
  },

  async renderReportProjects() {
    const rp = await API.get('/api/reports/projects') || [];
    const tbody = document.getElementById('reportProjectsTable');
    const fm = v => 'R$ '+(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
    const sl = { active:'Em Andamento', completed:'Concluído', pending:'Pendente', atrasado:'Atrasado' };
    if (!rp.length) { tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><h3>Sem dados</h3></div></td></tr>'; return; }
    tbody.innerHTML = rp.map(r => `
      <tr><td><span class="status ${r.status}">${sl[r.status]||r.status}</span></td>
      <td>${r.type}</td><td>${r.total}</td><td>${fm(r.total_value)}</td><td>${fm(r.avg_value)}</td></tr>
    `).join('');
  },

  async renderReportFinancial() {
    const rf = await API.get('/api/reports/financial') || {};
    const fm = v => 'R$ '+(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
    document.getElementById('finReportCards').innerHTML = `
      <div class="stat-card"><div class="stat-value" style="color:var(--success)">${fm(rf.total_revenue)}</div><div class="stat-label">Receita Total</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--danger)">${fm(rf.total_expenses)}</div><div class="stat-label">Despesas Totais</div></div>
      <div class="stat-card"><div class="stat-value" style="color:${rf.net_profit>0?'var(--success)':'var(--danger)'}">${fm(rf.net_profit)}</div><div class="stat-label">Lucro Liquido</div></div>`;

    const dre = await API.get(`/api/finance/dre?year=${new Date().getFullYear()}`) || {};
    if (this.chartInstances.finReport) this.chartInstances.finReport.destroy();
    if (dre.months) {
      this.chartInstances.finReport = new Chart(document.getElementById('finReportChart'), {
        type: 'line', data: {
          labels: dre.months.map(m => m.month_name),
          datasets: [
            { label: 'Receita', data: dre.months.map(m => m.revenue), borderColor: '#6C5CE7', backgroundColor: 'rgba(108,92,231,0.1)', fill: true, tension: 0.4 },
            { label: 'Despesas', data: dre.months.map(m => m.expenses), borderColor: '#FF1744', backgroundColor: 'rgba(255,23,68,0.1)', fill: true, tension: 0.4 }
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#8888AA' } } },
          scales: { x: { ticks: { color: '#8888AA' }, grid: { color: 'rgba(42,42,69,0.5)' } },
                   y: { ticks: { color: '#8888AA', callback: v => 'R$ '+v }, grid: { color: 'rgba(42,42,69,0.5)' } } } }
      });
    }
    const totalRevenueEl = document.getElementById('finReportChart');
  },

  async exportReport(type) {
    const data = await API.get(`/api/reports/export/csv?type=${type}`);
    if (!data) return;
    // Since API is JSON, download JSON as CSV
    window.open(`/api/reports/export/csv?type=${type}`, '_blank');
  },

  // ====== TEAM ======
  async renderTeam() {
    const users = await API.get('/api/team') || [];
    const container = document.getElementById('teamCards');
    if (!users.length) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-friends"></i><h3>Nenhum membro</h3></div>';
      return;
    }
    const roleLabels = { admin:'Administrador', manager:'Gerente', broker:'Corretor', designer:'Designer', developer:'Desenvolvedor', marketing:'Marketing', intern:'Estagiario', art_director:'Diretor de Arte', digital_strategist:'Estrategista Digital', freelancer:'Freelancer', filmmaker:'Filmmaker', fotografo:'Fotógrafo' };
    const roleColors = { admin:'#FF1744', manager:'#FFD600', broker:'#00BCD4', designer:'#6C5CE7', developer:'#00B0FF', marketing:'#00C853', intern:'#8888AA', art_director:'#E91E63', digital_strategist:'#FF5722', freelancer:'#9E9E9E', filmmaker:'#3F51B5', fotografo:'#FF9800' };
    container.innerHTML = users.map(u => `
      <div class="card" style="display:flex;align-items:center;gap:16px;padding:20px 24px;cursor:pointer" onclick="App.editUser(${u.id})">
        <div style="width:44px;height:44px;border-radius:50%;background:${roleColors[u.role]||'var(--primary)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:#fff;flex-shrink:0">${(u.name||'?')[0]}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:15px">${this.esc(u.name)}</div>
          <span style="font-size:12px;padding:2px 8px;border-radius:4px;background:${roleColors[u.role]||'var(--border)'}22;color:${roleColors[u.role]||'var(--text)'}">${roleLabels[u.role]||u.role}</span>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0" onclick="event.stopPropagation()">
          <button class="btn btn-xs btn-outline" onclick="App.editUser(${u.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteUser(${u.id})"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    `).join('');
  },

  openUserModal(data) {
    document.getElementById('userId').value = data ? data.id : '';
    document.getElementById('userModalTitle').textContent = data ? 'Editar Membro' : 'Novo Membro';
    document.getElementById('userNameInput').value = data ? data.name : '';
    document.getElementById('userEmailInput').value = data ? data.email||'' : '';
    document.getElementById('userPhone').value = data ? data.phone||'' : '';
    document.getElementById('userPassword').value = '';
    document.getElementById('userRole').value = data ? data.role : 'designer';
    document.getElementById('userActive').value = data ? (data.active!==0?'1':'0') : '1';
    this.openModal('userModal');
  },
  editUser(id) {
    API.get('/api/team').then(users => {
      const u = (users||[]).find(x => x.id === id);
      if (u) this.openUserModal(u);
    });
  },

  async saveUser() {
    const id = document.getElementById('userId').value;
    const name = document.getElementById('userNameInput').value.trim();
    const email = document.getElementById('userEmailInput').value.trim();
    const phone = document.getElementById('userPhone').value.trim();
    const role = document.getElementById('userRole').value;
    const active = parseInt(document.getElementById('userActive').value);
    const password = document.getElementById('userPassword').value;
    if (!name) { this.toast('Digite o nome do membro.', 'error'); return; }
    if (id) {
      const data = { name, role, phone, active };
      if (email) data.email = email;
      if (password) data.password = password;
      await API.put('/api/team/'+id, data);
    } else {
      const finalEmail = email || (name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'.').replace(/\.+/g,'.').replace(/^\.|\.$/g,'') + '.' + Date.now() + '@equipe.promake');
      await API.post('/api/auth/register', { name, email: finalEmail, role, phone, password: password || '123456' });
    }
    this.closeModal('userModal');
    this.renderTeam();
    this.toast(id ? 'Membro atualizado!' : 'Membro cadastrado!');
  },

  async deleteUser(id) {
    if (id === this.user?.id) { this.toast('Nao pode remover a si mesmo.', 'error'); return; }
    if (!await this.confirmAsync('Remover este membro?')) return;
    await API.del('/api/team/'+id);
    this.renderTeam();
    this.toast('Membro removido.');
  },

  // ====== PERMISSIONS ======

  async renderPermissions() {
    const data = await API.get('/api/permissions') || [];
    const tbody = document.getElementById('permissionsTable');
    const users = await API.get('/api/team') || [];
    if (!data.length && !users.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><i class="fas fa-shield-alt"></i><h3>Nenhuma permissão configurada</h3></div></td></tr>';
      return;
    }
    const permMap = {};
    data.forEach(p => { permMap[p.user_id] = p.permissions; });
    const permLabels = { none:'Sem acesso', view:'Visualizar', all:'Total' };
    tbody.innerHTML = users.filter(u => u.role !== 'admin').map(u => {
      const perms = permMap[u.id] || {};
      const acs = Object.keys(perms).length
        ? Object.entries(perms).filter(([,v]) => v !== 'none').map(([k]) => `<span style="font-size:11px;padding:2px 6px;border-radius:4px;background:rgba(0,200,83,0.15);color:var(--success);margin:1px;display:inline-block">${k}</span>`).join('') || '<span style="color:var(--text-muted);font-size:12px">Sem acesso</span>'
        : '<span style="color:var(--text-muted);font-size:12px">Nenhuma permissão</span>';
      return `<tr>
        <td style="display:flex;align-items:center;gap:10px"><div style="width:32px;height:32px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px">${(u.name||'?')[0]}</div><div><div style="font-weight:600">${this.esc(u.name)}</div><div style="font-size:11px;color:var(--text-muted)">${u.email||''}</div></div></td>
        <td><span style="font-size:12px;padding:2px 8px;border-radius:4px;background:rgba(108,92,231,0.15);color:var(--primary)">${u.role||'-'}</span></td>
        <td>${acs}</td>
        <td><button class="btn btn-xs btn-outline" onclick="App.openPermModal(${u.id})"><i class="fas fa-edit"></i></button></td>
      </tr>`;
    }).join('');
  },

  async openPermModal(userId) {
    const users = await API.get('/api/team') || [];
    const u = users.find(x => x.id === userId);
    if (!u) return;
    document.getElementById('permUserId').value = userId;
    document.getElementById('permUserName').textContent = u.name;
    const data = await API.get('/api/permissions') || [];
    const p = data.find(x => x.user_id === userId);
    const perms = p ? p.permissions : {};
    const modules = ['dashboard','leads','clients','projects','kanban','services','contracts','finance','marketing','calendar','reports','team','developments'];
    modules.forEach(mod => {
      const sel = document.getElementById('perm-'+mod);
      if (sel) sel.value = perms[mod] || 'none';
    });
    this.openModal('permModal');
  },

  async savePermissions() {
    const userId = parseInt(document.getElementById('permUserId').value);
    if (!userId) { this.toast('Erro: usuário não identificado', 'error'); return; }
    const modules = ['dashboard','leads','clients','projects','kanban','services','contracts','finance','marketing','calendar','reports','team','developments'];
    const perms = {};
    modules.forEach(mod => {
      const sel = document.getElementById('perm-'+mod);
      if (sel) perms[mod] = sel.value;
    });
    await API.post('/api/permissions', { user_id: userId, permissions: perms });
    this.closeModal('permModal');
    this.renderPermissions();
    this.toast('Permissões salvas!');
  },

  // ====== DEVELOPMENTS ======

  selectedDevId: null,

  async renderDevelopments() {
    const container = document.getElementById('developmentsContainer');
    const detail = document.getElementById('devDetailContainer');
    detail.style.display = 'none';
    container.style.display = 'block';
    this.selectedDevId = null;
    const data = await API.get('/api/developments') || [];
    const tbody = document.getElementById('developmentsTable');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i class="fas fa-building"></i><h3>Nenhum empreendimento cadastrado</h3><p>Cadastre empreendimentos para gerenciar unidades e liberar corretores.</p></div></td></tr>';
      return;
    }
    const statusClass = { 'lançamento':'pending', 'obras':'active_s', 'pronto':'completed' };
    const statusLabel = { 'lançamento':'Lançamento', 'obras':'Em Obras', 'pronto':'Pronto' };
    tbody.innerHTML = data.map(d => `
      <tr style="cursor:pointer" onclick="App.openDevDetail(${d.id})">
        <td><strong>${this.esc(d.name)}</strong></td>
        <td>${this.esc(d.builder||'-')}</td>
        <td><span class="status ${statusClass[d.status]||'pending'}">${statusLabel[d.status]||d.status}</span></td>
        <td>${d.total_units||0}</td>
        <td>${d.delivery_date||'-'}</td>
        <td>
          <button class="btn btn-xs btn-info-btn" onclick="event.stopPropagation();App.openDevDetail(${d.id})" title="Detalhes"><i class="fas fa-eye"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="event.stopPropagation();App.editDevelopment(${d.id})" title="Editar"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();App.deleteDevelopment(${d.id})" title="Excluir"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  async openDevDetail(id) {
    this.selectedDevId = id;
    const devs = await API.get('/api/developments') || [];
    const dev = devs.find(d => d.id === id);
    if (!dev) return;
    document.getElementById('developmentsContainer').style.display = 'none';
    const detail = document.getElementById('devDetailContainer');
    detail.style.display = 'block';
    document.getElementById('devDetailTitle').textContent = dev.name;
    await this.renderUnits(id);
    await this.renderBrokerDevList(id);
  },

  backToDevList() {
    this.selectedDevId = null;
    document.getElementById('developmentsContainer').style.display = 'block';
    document.getElementById('devDetailContainer').style.display = 'none';
  },

  async openDevModal(data) {
    document.getElementById('devId').value = data ? data.id : '';
    document.getElementById('devModalTitle').textContent = data ? 'Editar Empreendimento' : 'Novo Empreendimento';
    document.getElementById('devName').value = data ? data.name : '';
    document.getElementById('devBuilder').value = data ? (data.builder||'') : '';
    document.getElementById('devStatus').value = data ? (data.status||'lançamento') : 'lançamento';
    document.getElementById('devAddress').value = data ? (data.address||'') : '';
    document.getElementById('devTotalUnits').value = data ? (data.total_units||0) : '';
    document.getElementById('devDeliveryDate').value = data ? (data.delivery_date||'') : '';
    document.getElementById('devDescription').value = data ? (data.description||'') : '';
    this.openModal('devModal');
  },

  async editDevelopment(id) {
    const data = await API.get('/api/developments') || [];
    const dev = data.find(d => d.id === id);
    if (dev) this.openDevModal(dev);
  },

  async saveDevelopment() {
    const id = document.getElementById('devId').value;
    const body = {
      name: document.getElementById('devName').value,
      builder: document.getElementById('devBuilder').value,
      status: document.getElementById('devStatus').value,
      address: document.getElementById('devAddress').value,
      total_units: parseInt(document.getElementById('devTotalUnits').value) || 0,
      delivery_date: document.getElementById('devDeliveryDate').value,
      description: document.getElementById('devDescription').value
    };
    if (id) {
      await API.put('/api/developments/'+id, body);
    } else {
      await API.post('/api/developments', body);
    }
    this.closeModal('devModal');
    this.renderDevelopments();
    this.toast('Empreendimento salvo!');
  },

  async deleteDevelopment(id) {
    if (!await this.confirmAsync('Excluir este empreendimento e todas as suas unidades?')) return;
    await API.del('/api/developments/'+id);
    this.renderDevelopments();
    this.toast('Empreendimento excluído.');
  },

  async renderUnits(devId) {
    const data = await API.get('/api/developments/'+devId+'/units') || [];
    const tbody = document.getElementById('unitsTable');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><i class="fas fa-door-open"></i><h3>Nenhuma unidade cadastrada</h3></div></td></tr>';
      return;
    }
    const statusClass = { 'disponivel':'completed', 'reservado':'pending', 'vendido':'active_s' };
    const statusLabel = { 'disponivel':'Disponível', 'reservado':'Reservado', 'vendido':'Vendido' };
    tbody.innerHTML = data.map(u => `
      <tr>
        <td><strong>${this.esc(u.number)}</strong></td>
        <td>${this.esc(u.tower||'-')}</td>
        <td>${this.esc(u.block||'-')}</td>
        <td>${u.area ? u.area+' m²' : '-'}</td>
        <td>${u.bedrooms||0}</td>
        <td>R$ ${(u.price||0).toLocaleString('pt-BR', {minimumFractionDigits:2})}</td>
        <td><span class="status ${statusClass[u.status]||'pending'}">${statusLabel[u.status]||u.status}</span></td>
        <td>
          <button class="btn btn-xs btn-info-btn" onclick="App.openUnitModal(${u.id},${devId})" title="Editar"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteUnit(${u.id},${devId})" title="Excluir"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  async openUnitModal(unitId, devId) {
    document.getElementById('unitModalTitle').textContent = unitId ? 'Editar Unidade' : 'Nova Unidade';
    document.getElementById('unitId').value = unitId || '';
    let data = {};
    if (unitId) {
      const units = await API.get('/api/developments/'+devId+'/units') || [];
      data = units.find(u => u.id === unitId) || {};
    }
    document.getElementById('unitNumber').value = data.number || '';
    document.getElementById('unitTower').value = data.tower || '';
    document.getElementById('unitBlock').value = data.block || '';
    document.getElementById('unitFloor').value = data.floor || '';
    document.getElementById('unitArea').value = data.area || '';
    document.getElementById('unitPrice').value = data.price || '';
    document.getElementById('unitBedrooms').value = data.bedrooms || '';
    document.getElementById('unitSuites').value = data.suites || '';
    document.getElementById('unitBathrooms').value = data.bathrooms || '';
    document.getElementById('unitParking').value = data.parking_spots || '';
    document.getElementById('unitStatus').value = data.status || 'disponivel';
    document.getElementById('unitNotes').value = data.notes || '';
    this.openModal('unitModal');
  },

  async saveUnit() {
    const id = document.getElementById('unitId').value;
    const devId = this.selectedDevId;
    if (!devId) { this.toast('Erro: empreendimento não selecionado', 'error'); return; }
    const body = {
      number: document.getElementById('unitNumber').value,
      tower: document.getElementById('unitTower').value,
      block: document.getElementById('unitBlock').value,
      floor: document.getElementById('unitFloor').value,
      area: parseFloat(document.getElementById('unitArea').value) || 0,
      price: parseFloat(document.getElementById('unitPrice').value) || 0,
      bedrooms: parseInt(document.getElementById('unitBedrooms').value) || 0,
      suites: parseInt(document.getElementById('unitSuites').value) || 0,
      bathrooms: parseInt(document.getElementById('unitBathrooms').value) || 0,
      parking_spots: parseInt(document.getElementById('unitParking').value) || 0,
      status: document.getElementById('unitStatus').value,
      notes: document.getElementById('unitNotes').value
    };
    if (id) {
      await API.put('/api/developments/'+devId+'/units/'+id, body);
    } else {
      await API.post('/api/developments/'+devId+'/units', body);
    }
    this.closeModal('unitModal');
    this.renderUnits(devId);
    this.toast('Unidade salva!');
  },

  async deleteUnit(id, devId) {
    if (!await this.confirmAsync('Excluir esta unidade?')) return;
    await API.del('/api/developments/'+devId+'/units/'+id);
    this.renderUnits(devId);
    this.toast('Unidade excluída.');
  },

  async renderBrokerDevList(devId) {
    const container = document.getElementById('brokerDevList');
    const brokers = await API.get('/api/team') || [];
    const brokerList = brokers.filter(u => u.role === 'broker');
    const devs = await API.get('/api/developments') || [];
    const dev = devs.find(d => d.id === devId);
    const assigned = dev ? (dev.brokers||[]) : [];
    if (!brokerList.length) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Nenhum corretor cadastrado. Crie usuários com cargo "Corretor" em Equipe.</p>';
      return;
    }
    container.innerHTML = brokerList.map(b => {
      const a = assigned.find(x => x.user_id === b.id);
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:32px;height:32px;border-radius:50%;background:#00BCD4;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px">${b.name[0]}</div>
          <div><div style="font-weight:600">${this.esc(b.name)}</div><div style="font-size:11px;color:var(--text-muted)">${b.email||''}</div></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${a ? `<span style="font-size:12px;color:var(--success)"><i class="fas fa-check-circle"></i> ${a.commission_pct||3}%</span><button class="btn btn-xs btn-danger" onclick="App.removeBrokerDev(${devId},${b.id})"><i class="fas fa-times"></i></button>` : `<button class="btn btn-xs btn-primary" onclick="App.openBrokerDevModal(${devId},${b.id})"><i class="fas fa-plus"></i> Liberar</button>`}
        </div>
      `;
    }).join('');
  },

  async openBrokerDevModal(devId, userId) {
    document.getElementById('brokerDevId').value = devId;
    document.getElementById('brokerDevPct').value = 3.0;
    const brokers = await API.get('/api/team') || [];
    const broker = brokers.find(u => u.id === userId);
    const sel = document.getElementById('brokerDevUser');
    sel.innerHTML = `<option value="${userId}">${broker ? broker.name : 'Corretor'}</option>`;
    this.openModal('brokerDevModal');
  },

  async saveBrokerDev() {
    const devId = parseInt(document.getElementById('brokerDevId').value);
    const userId = parseInt(document.getElementById('brokerDevUser').value);
    const pct = parseFloat(document.getElementById('brokerDevPct').value) || 3.0;
    await API.post('/api/developments/'+devId+'/brokers', { user_id: userId, commission_pct: pct });
    this.closeModal('brokerDevModal');
    this.renderBrokerDevList(devId);
    this.toast('Corretor liberado!');
  },

  async removeBrokerDev(devId, userId) {
    if (!await this.confirmAsync('Remover acesso deste corretor?')) return;
    await API.del('/api/developments/'+devId+'/brokers/'+userId);
    this.renderBrokerDevList(devId);
    this.toast('Acesso removido.');
  },

  // ====== SYSTEMS ======
  async renderSystems() {
    const data = await API.get('/api/systems') || [];
    const tbody = document.getElementById('systemsTable');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i class="fas fa-globe"></i><h3>Nenhum sistema criado</h3><p>Crie portais para seus clientes acompanharem projetos, OS e financeiro.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.map(s => `
      <tr>
        <td><strong>${this.esc(s.name)}</strong></td>
        <td>${this.esc(s.client_name||'-')}</td>
        <td><code>${this.esc(s.slug)}</code></td>
        <td>${s.active ? '<span class="badge badge-success">Ativo</span>' : '<span class="badge badge-danger">Inativo</span>'}</td>
        <td><button class="btn btn-xs btn-outline" onclick="App.copyPortalLink('${this.esc(s.slug)}')" title="Copiar link"><i class="fas fa-link"></i></button></td>
        <td>
          <button class="btn btn-xs btn-info-btn" onclick="App.editSystem(${s.id})" title="Editar"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-info-btn" onclick="App.manageSystemModules(${s.id})" title="Modulos"><i class="fas fa-puzzle-piece"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteSystem(${s.id})" title="Excluir"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  async openSystemModal(data) {
    document.getElementById('systemId').value = data ? data.id : '';
    document.getElementById('systemModalTitle').textContent = data ? 'Editar Sistema' : 'Novo Sistema';
    document.getElementById('systemName').value = data ? data.name : '';
    document.getElementById('systemSlug').value = data ? data.slug : '';
    document.getElementById('systemColor').value = data ? (data.primary_color||'#6C5CE7') : '#6C5CE7';
    document.getElementById('systemLogo').value = data ? (data.logo_url||'') : '';
    document.getElementById('systemPassword').value = '';
    const select = document.getElementById('systemClient');
    select.innerHTML = '<option value="">Selecione</option>';
    const clients = await API.get('/api/clients') || [];
    clients.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (data && data.client_id == c.id) opt.selected = true;
      select.appendChild(opt);
    });
    this.openModal('systemModal');
  },

  async saveSystem() {
    const id = document.getElementById('systemId').value;
    const body = {
      name: document.getElementById('systemName').value.trim(),
      client_id: parseInt(document.getElementById('systemClient').value) || null,
      slug: document.getElementById('systemSlug').value.trim(),
      primary_color: document.getElementById('systemColor').value,
      logo_url: document.getElementById('systemLogo').value.trim(),
      portal_password: document.getElementById('systemPassword').value.trim() || '1234',
      admin_password: document.getElementById('systemAdminPassword').value.trim()
    };
    if (!body.name) { this.toast('Digite o nome do sistema.', 'error'); return; }
    if (!body.slug) { this.toast('Digite o slug.', 'error'); return; }
    const r = id ? await API.put('/api/systems/'+id, body) : await API.post('/api/systems', body);
    if (!r || r.error) { this.toast(r?.error || 'Erro ao salvar', 'error'); return; }
    this.closeModal('systemModal');
    this.renderSystems();
    this.toast(id ? 'Sistema atualizado!' : 'Sistema criado!');
  },

  async editSystem(id) {
    const data = await API.get('/api/systems/'+id);
    if (data) this.openSystemModal(data);
  },

  async deleteSystem(id) {
    if (!await this.confirmAsync('Excluir este sistema?')) return;
    await API.del('/api/systems/'+id);
    this.renderSystems();
    this.toast('Sistema excluído.');
  },

  copyPortalLink(slug) {
    const link = window.location.origin + '/portal/' + slug;
    navigator.clipboard.writeText(link).then(() => this.toast('Link copiado!')).catch(() => this.toast(link));
  },

  async manageSystemModules(sid) {
    const data = await API.get('/api/systems/'+sid);
    if (!data) return;
    this._editModulesSid = sid;
    const section = document.getElementById('systemsModulesSection');
    const toggles = document.getElementById('systemsModulesToggles');
    const moduleLabels = { dashboard:'Dashboard', projects:'Projetos', service_orders:'Ordem de serviço', finance:'Financeiro', calendar:'Calendário', files:'Arquivos', developments:'Empreendimentos' };
    toggles.innerHTML = (data.modules||[]).map(m => `
      <label style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--bg);border-radius:8px;border:1px solid var(--border);cursor:pointer">
        <input type="checkbox" ${m.enabled ? 'checked' : ''} data-key="${m.module_key}" onchange="App.saveSystemModules()">
        ${moduleLabels[m.module_key] || m.module_key}
      </label>
    `).join('');
    section.style.display = 'block';
    this.toast('Modulos carregados para edicao.');
  },

  hideSystemModules() {
    document.getElementById('systemsModulesSection').style.display = 'none';
  },

  async saveSystemModules() {
    const sid = this._editModulesSid;
    if (!sid) return;
    const data = {};
    document.querySelectorAll('#systemsModulesToggles input[type="checkbox"]').forEach(cb => {
      data[cb.dataset.key] = cb.checked;
    });
    await API.post('/api/systems/'+sid+'/modules', data);
  },

  // ====== PLANS ======
  async renderPlans() {
    const plans = await API.get('/api/plans') || [];
    const container = document.getElementById('plansContainer');
    const bcLabels = { monthly:'Mensal', quarterly:'Trimestral', semiannual:'Semestral', annual:'Anual' };
    if (!plans.length) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-box-open"></i><h3>Nenhum plano cadastrado</h3><p>Crie planos de servico para seus clientes.</p></div>';
      return;
    }
    container.innerHTML = plans.map(p => `
      <div class="plan-card" style="background:var(--bg-card);border-radius:var(--radius);border:1px solid var(--border);overflow:hidden;position:relative;transition:border-color .2s,transform .2s">
        <div style="padding:24px;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div><h3 style="font-size:18px;margin:0">${this.esc(p.name)}</h3><span style="font-size:12px;color:var(--text-muted)">${bcLabels[p.billing_cycle]||p.billing_cycle}</span></div>
            <div style="text-align:right"><div style="font-size:24px;font-weight:700;color:var(--primary)">R$ ${(p.price||0).toFixed(0)}</div><span style="font-size:11px;color:var(--text-muted)">/${bcLabels[p.billing_cycle]||'mes'}</span></div>
          </div>
          <p style="font-size:13px;color:var(--text-muted);margin-top:8px;line-height:1.5">${this.esc(p.description)}</p>
        </div>
        <div style="padding:16px 24px">
          ${(() => {
            try { const f = typeof p.features === 'string' ? JSON.parse(p.features) : (p.features||[]); return f.map(fe => '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px"><i class="fas fa-check-circle" style="color:var(--success);font-size:14px"></i> '+this.esc(fe)+'</div>').join(''); }
            catch(e) { return ''; }
          })()}
        </div>
        <div style="padding:12px 24px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-xs btn-outline" onclick="App.editPlan(${p.id})"><i class="fas fa-edit"></i> Editar</button>
          <button class="btn btn-xs btn-danger" onclick="App.deletePlan(${p.id})"><i class="fas fa-trash"></i> Excluir</button>
        </div>
      </div>
    `).join('');
  },

  async openPlanModal(data) {
    document.getElementById('planId').value = data ? data.id : '';
    document.getElementById('planModalTitle').textContent = data ? 'Editar Plano' : 'Novo Plano';
    document.getElementById('planName').value = data ? data.name : '';
    document.getElementById('planDesc').value = data ? data.description : '';
    document.getElementById('planPrice').value = data ? data.price : '';
    document.getElementById('planBilling').value = data ? data.billing_cycle : 'monthly';
    document.getElementById('planActive').value = data ? (data.active!==0?'1':'0') : '1';
    document.getElementById('planFeatures').value = data ? (() => { try { return JSON.parse(data.features||'[]').join('\n'); } catch(e) { return ''; } })() : '';
    this.openModal('planModal');
  },
  editPlan(id) { API.get('/api/plans/'+id).then(d => { if(d) this.openPlanModal(d); }); },

  async savePlan() {
    const id = document.getElementById('planId').value;
    const featuresRaw = document.getElementById('planFeatures').value.trim();
    const features = featuresRaw ? featuresRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];
    const data = {
      name: document.getElementById('planName').value.trim(),
      description: document.getElementById('planDesc').value.trim(),
      price: parseFloat(document.getElementById('planPrice').value) || 0,
      billing_cycle: document.getElementById('planBilling').value,
      active: parseInt(document.getElementById('planActive').value),
      features
    };
    if (!data.name) { this.toast('Digite o nome do plano.', 'error'); return; }
    if (id) await API.put('/api/plans/'+id, data);
    else await API.post('/api/plans', data);
    this.closeModal('planModal');
    this.renderPlans();
    this.toast(id ? 'Plano atualizado!' : 'Plano criado!');
  },

  async deletePlan(id) {
    if (!await this.confirmAsync('Excluir este plano?')) return;
    await API.del('/api/plans/'+id);
    this.renderPlans();
    this.toast('Plano excluído.');
  },

  // ====== CLIENT PLANS ======
  async showClientPlans(clientId, clientName) {
    const panel = document.getElementById('clientPlansPanel');
    document.getElementById('clientPlansTitle').textContent = 'Planos de ' + clientName;
    document.getElementById('clientPlansClientId').value = clientId;
    panel.style.display = 'block';
    await this.renderClientPlans(clientId);
    panel.scrollIntoView({ behavior: 'smooth' });
  },

  async renderClientPlans(clientId) {
    const data = await API.get('/api/client-plans?client_id='+clientId) || [];
    const container = document.getElementById('clientPlansList');
    const bcLabels = { monthly:'Mensal', quarterly:'Trimestral', semiannual:'Semestral', annual:'Anual' };
    if (!data.length) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">Nenhum plano contratado</div>';
      return;
    }
    container.innerHTML = data.map(cp => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
        <div style="flex:1">
          <strong style="font-size:14px">${this.esc(cp.plan_name)}</strong>
          <span style="font-size:12px;color:var(--text-muted)"> - R$ ${((cp.price_override||cp.plan_price)||0).toFixed(2)}/${bcLabels[cp.billing_cycle]||'mes'}</span>
          <br><span class="status ${cp.status}" style="font-size:11px">${cp.status==='active'?'Ativo':'Inativo'}</span>
          <span style="font-size:11px;color:var(--text-muted);margin-left:12px">Inicio: ${cp.start_date||'-'}</span>
        </div>
        <button class="btn btn-xs btn-danger" onclick="App.deleteClientPlan(${cp.id},${clientId})"><i class="fas fa-trash"></i></button>
      </div>
    `).join('');
  },

  async openClientPlanModal(clientId) {
    const plans = await API.get('/api/plans') || [];
    const select = document.getElementById('clientPlanSelect');
    select.innerHTML = '<option value="">Selecione</option>' + plans.filter(p => p.active).map(p =>
      `<option value="${p.id}">${this.esc(p.name)} - R$ ${(p.price||0).toFixed(2)}</option>`).join('');
    document.getElementById('clientPlanClientId').value = clientId;
    document.getElementById('clientPlanStartDate').value = new Date().toISOString().split('T')[0];
    this.openModal('clientPlanModal');
  },

  async saveClientPlan() {
    const clientId = document.getElementById('clientPlanClientId').value;
    const planId = document.getElementById('clientPlanSelect').value;
    if (!planId) { this.toast('Selecione um plano.', 'error'); return; }
    await API.post('/api/client-plans', {
      client_id: parseInt(clientId),
      plan_id: parseInt(planId),
      start_date: document.getElementById('clientPlanStartDate').value
    });
    this.closeModal('clientPlanModal');
    this.renderClientPlans(clientId);
    this.toast('Plano vinculado ao cliente!');
  },

  async deleteClientPlan(cpid, clientId) {
    if (!await this.confirmAsync('Remover este plano do cliente?')) return;
    await API.del('/api/client-plans/'+cpid);
    this.renderClientPlans(clientId);
    this.toast('Plano removido do cliente.');
  },

  // ====== SETTINGS ======
  openSettings(section) {
    const content = document.getElementById('settingsModalContent');
    if (section === 'perfil') {
      content.innerHTML = `<h3><i class="fas fa-user"></i> Perfil</h3>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
          <div id="profilePhotoPreview" style="width:64px;height:64px;border-radius:50%;background:rgba(108,92,231,0.12);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:var(--primary);overflow:hidden;flex-shrink:0;border:2px solid var(--border)">${(this.user?.name||'A')[0]}</div>
          <div><button class="btn btn-sm btn-outline" onclick="App.uploadProfilePhoto()"><i class="fas fa-camera"></i> Alterar Foto</button>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">PNG, JPG. Max 2MB.</div></div>
        </div>
        <div class="form-group"><label>Nome</label><input type="text" id="sName" value="${this.esc(this.user?.name||'')}"></div>
        <div class="form-group"><label>Email</label><input type="email" id="sEmail" value="${this.esc(this.user?.email||'')}"></div>
        <div class="form-group"><label>Telefone</label><input type="text" id="sPhone" value="${this.esc(this.user?.phone||'')}"></div>
        <div class="modal-actions">
          <button class="btn btn-outline btn-sm" onclick="App.closeModal('settingsModal')">Cancelar</button>
          <button class="btn btn-primary btn-sm" onclick="App.saveProfile()"><i class="fas fa-check"></i> Salvar</button>
        </div>`;
    } else if (section === 'notificacoes') {
      const prefs = this.notifPrefs || {};
      content.innerHTML = `<h3><i class="fas fa-bell"></i> Notificações</h3>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Escolha quais notificações deseja receber no sistema.</p>
        <div style="margin-bottom:20px">
          <label style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px;cursor:pointer">
            <input type="checkbox" id="notifOverdue" style="accent-color:var(--primary);width:18px;height:18px" ${prefs.overdue!==false?'checked':''}>
            <div><div style="font-weight:600;font-size:14px">Projetos Atrasados</div><div style="font-size:12px;color:var(--text-muted)">Alertar quando um projeto estiver atrasado</div></div>
          </label>
          <label style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px;cursor:pointer">
            <input type="checkbox" id="notifNewLead" style="accent-color:var(--primary);width:18px;height:18px" ${prefs.new_lead!==false?'checked':''}>
            <div><div style="font-weight:600;font-size:14px">Novos Leads</div><div style="font-size:12px;color:var(--text-muted)">Notificar quando um novo lead for cadastrado</div></div>
          </label>
          <label style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px;cursor:pointer">
            <input type="checkbox" id="notifTask" style="accent-color:var(--primary);width:18px;height:18px" ${prefs.task!==false?'checked':''}>
            <div><div style="font-weight:600;font-size:14px">Tarefas Atribuídas</div><div style="font-size:12px;color:var(--text-muted)">Notificar quando uma tarefa for atribuída a você</div></div>
          </label>
          <label style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px;cursor:pointer">
            <input type="checkbox" id="notifPayment" style="accent-color:var(--primary);width:18px;height:18px" ${prefs.payment!==false?'checked':''}>
            <div><div style="font-weight:600;font-size:14px">Pagamentos</div><div style="font-size:12px;color:var(--text-muted)">Alertar sobre contas a vencer e recebimentos</div></div>
          </label>
          <label style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;border:1px solid var(--border);cursor:pointer">
            <input type="checkbox" id="notifAudio" style="accent-color:var(--primary);width:18px;height:18px" ${prefs.audio?'checked':''}>
            <div><div style="font-weight:600;font-size:14px">Notificação Sonora</div><div style="font-size:12px;color:var(--text-muted)">Tocar um som ao receber notificação</div></div>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline btn-sm" onclick="App.closeModal('settingsModal')">Cancelar</button>
          <button class="btn btn-primary btn-sm" onclick="App.saveNotifPrefs()"><i class="fas fa-check"></i> Salvar</button>
        </div>`;
    } else if (section === 'aparencia') {
      const colors = ['#6C5CE7','#00C853','#FF6B6B','#00B0FF','#FFD600','#FF9800'];
      content.innerHTML = `<h3><i class="fas fa-palette"></i> Aparência</h3>
        <div style="margin-bottom:16px"><label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:8px">Cor Primaria</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${colors.map(c =>
          `<div style="width:40px;height:40px;border-radius:8px;background:${c};cursor:pointer;border:2px solid transparent" onclick="document.documentElement.style.setProperty('--primary','${c}');document.documentElement.style.setProperty('--primary-dark','${c}');App.toast('Cor alterada!')"></div>`
        ).join('')}</div></div>
        <div class="modal-actions"><button class="btn btn-primary btn-sm" onclick="App.closeModal('settingsModal')">Fechar</button></div>`;
    } else if (section === 'seguranca') {
      content.innerHTML = `<h3><i class="fas fa-shield-alt"></i> Segurança</h3>
        <div class="form-group"><label>Senha atual</label><input type="password" id="sPassOld" placeholder="Digite sua senha atual"></div>
        <div class="form-group"><label>Nova senha</label><input type="password" id="sPassNew" placeholder="Digite a nova senha (min 6 caracteres)"></div>
        <div class="form-group"><label>Confirmar nova senha</label><input type="password" id="sPassConfirm" placeholder="Repita a nova senha"></div>
        <div id="sPassError" style="color:var(--danger);font-size:13px;margin-bottom:12px;display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-outline btn-sm" onclick="App.closeModal('settingsModal')">Cancelar</button>
          <button class="btn btn-primary btn-sm" onclick="App.changePassword()"><i class="fas fa-check"></i> Alterar Senha</button>
        </div>`;
    } else if (section === 'spotify') {
      content.innerHTML = `<h3><i class="fab fa-spotify"></i> Integração Spotify</h3>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Cole abaixo o Client ID e Client Secret do seu App no <a href="https://developer.spotify.com/dashboard" target="_blank" style="color:var(--primary)">Spotify Developer Dashboard</a>.</p>
        <div class="form-group"><label>Client ID</label><input type="text" id="sSpotifyClientId" placeholder="Cole o Client ID aqui"></div>
        <div class="form-group"><label>Client Secret</label><input type="password" id="sSpotifyClientSecret" placeholder="Cole o Client Secret aqui"></div>
        <div class="form-group"><label>Redirect URI</label><input type="text" id="sSpotifyRedirectUri" value="http://127.0.0.1:8081/api/spotify/callback" placeholder="http://127.0.0.1:8081/api/spotify/callback"></div>
        <div id="sSpotifyStatus" style="font-size:13px;margin-bottom:12px"></div>
        <div class="modal-actions">
          <button class="btn btn-outline btn-sm" onclick="App.closeModal('settingsModal')">Fechar</button>
          <button class="btn btn-primary btn-sm" onclick="App.saveSpotifyConfig()"><i class="fas fa-check"></i> Salvar</button>
        </div>`;
      this.loadSpotifyConfig();
    } else if (section === 'email') {
      content.innerHTML = `<h3><i class="fas fa-envelope"></i> Configuração de Email (SMTP)</h3>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Configure o servidor SMTP para envio de emails de recuperação de senha e notificações.</p>
        <div class="form-group"><label>Servidor SMTP</label><input type="text" id="sSmtpHost" placeholder="smtp.gmail.com"></div>
        <div class="form-row">
          <div class="form-group"><label>Porta</label><input type="number" id="sSmtpPort" placeholder="587" value="587"></div>
          <div class="form-group"><label>Segurança</label><select id="sSmtpSecurity"><option value="tls">TLS</option><option value="ssl">SSL</option></select></div>
        </div>
        <div class="form-group"><label>Email de envio (from)</label><input type="email" id="sSmtpFrom" placeholder="noreply@seudominio.com"></div>
        <div class="form-group"><label>Usuário</label><input type="text" id="sSmtpUser" placeholder="seu@email.com"></div>
        <div class="form-group"><label>Senha</label><input type="password" id="sSmtpPass" placeholder="Senha ou App Password"></div>
        <div id="sSmtpStatus" style="font-size:13px;margin-bottom:12px"></div>
        <div class="modal-actions">
          <button class="btn btn-outline btn-sm" onclick="App.testSmtpConfig()"><i class="fas fa-paper-plane"></i> Testar</button>
          <button class="btn btn-outline btn-sm" onclick="App.closeModal('settingsModal')">Cancelar</button>
          <button class="btn btn-primary btn-sm" onclick="App.saveSmtpConfig()"><i class="fas fa-check"></i> Salvar</button>
        </div>`;
      this.loadSmtpConfig();
    }
    this.openModal('settingsModal');
  },

  async saveProfile() {
    const data = {
      name: document.getElementById('sName').value.trim(),
      email: document.getElementById('sEmail').value.trim(),
      phone: document.getElementById('sPhone').value.trim()
    };
    if (!data.name || !data.email) { this.toast('Nome e email obrigatórios.', 'error'); return; }
    if (this.user) {
      const r = await API.put('/api/team/'+this.user.id, data);
      if (r && r.error) { this.toast(r.error, 'error'); return; }
      this.user.name = data.name;
      this.user.email = data.email;
      this.user.phone = data.phone;
      document.getElementById('userName').textContent = data.name;
      if (!this.user.avatar) document.getElementById('userAvatar').textContent = data.name.charAt(0).toUpperCase();
      document.getElementById('settingsUser').textContent = data.name;
    }
    this.closeModal('settingsModal');
    this.toast('Perfil atualizado!');
  },

  async changePassword() {
    const oldPw = document.getElementById('sPassOld').value;
    const newPw = document.getElementById('sPassNew').value;
    const confirmPw = document.getElementById('sPassConfirm').value;
    const errEl = document.getElementById('sPassError');
    if (!oldPw || !newPw) { errEl.textContent = 'Preencha senha atual e nova.'; errEl.style.display = 'block'; return; }
    if (newPw.length < 6) { errEl.textContent = 'Nova senha deve ter no minimo 6 caracteres.'; errEl.style.display = 'block'; return; }
    if (newPw !== confirmPw) { errEl.textContent = 'Confirmação não confere.'; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';
    const r = await API.put('/api/team/'+this.user.id, { password: newPw });
    if (r && r.ok) {
      this.closeModal('settingsModal');
      this.toast('Senha alterada com sucesso!');
    } else {
      errEl.textContent = r?.error || 'Erro ao alterar senha.';
      errEl.style.display = 'block';
    }
  },

  uploadProfilePhoto() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg';
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 2*1024*1024) { this.toast('Maximo 2MB.', 'error'); return; }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', 'user_photo');
      fd.append('entity_id', this.user?.id || 0);
      const r = await fetch(API.baseUrl + '/api/upload/photo', { method: 'POST', headers: { 'Authorization': 'Bearer ' + API.token }, body: fd });
      const j = await r.json();
      if (j.error) { this.toast(j.error, 'error'); return; }
      if (this.user) {
        this.user.avatar = j.filename;
        await API.put('/api/team/' + this.user.id, { avatar: j.filename });
      }
      const url = API.baseUrl + '/api/photo/' + j.filename + '?t=' + Date.now();
      const preview = document.getElementById('profilePhotoPreview');
      if (preview) preview.innerHTML = '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover">';
      const avatarEl = document.getElementById('userAvatar');
      if (avatarEl) avatarEl.innerHTML = '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
      this.toast('Foto atualizada!');
    };
    input.click();
  },

  async loadSpotifyConfig() {
    const r = await API.get('/api/spotify/config');
    if (r && !r.error) {
      if (r.client_id) document.getElementById('sSpotifyClientId').value = r.client_id;
      if (r.client_secret) document.getElementById('sSpotifyClientSecret').value = r.client_secret;
      if (r.redirect_uri) document.getElementById('sSpotifyRedirectUri').value = r.redirect_uri;
    }
  },

  async saveSpotifyConfig() {
    const body = {
      client_id: document.getElementById('sSpotifyClientId').value.trim(),
      client_secret: document.getElementById('sSpotifyClientSecret').value.trim(),
      redirect_uri: document.getElementById('sSpotifyRedirectUri').value.trim()
    };
    if (!body.client_id || !body.client_secret) {
      document.getElementById('sSpotifyStatus').style.color = 'var(--danger)';
      document.getElementById('sSpotifyStatus').textContent = 'Preencha Client ID e Client Secret.';
      return;
    }
    const r = await API.put('/api/spotify/config', body);
    if (r && r.ok) {
      document.getElementById('sSpotifyStatus').style.color = 'var(--success)';
      document.getElementById('sSpotifyStatus').textContent = 'Configuração salva!';
      this.toast('Configuração Spotify salva!');
    } else {
      document.getElementById('sSpotifyStatus').style.color = 'var(--danger)';
      document.getElementById('sSpotifyStatus').textContent = r?.error || 'Erro ao salvar.';
    }
  },

  async loadSmtpConfig() {
    const r = await API.get('/api/smtp/config');
    if (r && !r.error) {
      if (r.host) document.getElementById('sSmtpHost').value = r.host;
      if (r.port) document.getElementById('sSmtpPort').value = r.port;
      if (r.from_email) document.getElementById('sSmtpFrom').value = r.from_email;
      if (r.user) document.getElementById('sSmtpUser').value = r.user;
      if (r.password) document.getElementById('sSmtpPass').value = r.password;
    }
  },

  async saveSmtpConfig() {
    const body = {
      host: document.getElementById('sSmtpHost').value.trim(),
      port: parseInt(document.getElementById('sSmtpPort').value) || 587,
      from_email: document.getElementById('sSmtpFrom').value.trim(),
      user: document.getElementById('sSmtpUser').value.trim(),
      password: document.getElementById('sSmtpPass').value
    };
    if (!body.host || !body.user || !body.password) {
      document.getElementById('sSmtpStatus').style.color = 'var(--danger)';
      document.getElementById('sSmtpStatus').textContent = 'Preencha host, usuario e senha.';
      return;
    }
    const r = await API.put('/api/smtp/config', body);
    if (r && r.ok) {
      document.getElementById('sSmtpStatus').style.color = 'var(--success)';
      document.getElementById('sSmtpStatus').textContent = 'Configuracao salva!';
      this.toast('Configuracao SMTP salva!');
    } else {
      document.getElementById('sSmtpStatus').style.color = 'var(--danger)';
      document.getElementById('sSmtpStatus').textContent = r?.error || 'Erro ao salvar.';
    }
  },

  async testSmtpConfig() {
    const statusEl = document.getElementById('sSmtpStatus');
    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = 'Enviando email de teste...';
    const q = prompt('Digite o email para receber o teste:');
    if (!q) { statusEl.textContent = ''; return; }
    const r = await API.post('/api/smtp/test', { to_email: q.trim() });
    if (r && r.ok) {
      statusEl.style.color = 'var(--success)';
      statusEl.textContent = r.message || 'Email de teste enviado!';
      this.toast('Email de teste enviado!');
    } else {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = r?.error || 'Falha ao enviar teste.';
    }
  },

  async uploadLogo() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg';
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 2*1024*1024) { this.toast('Maximo 2MB.', 'error'); return; }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', 'logo');
      fd.append('entity_id', 0);
      const r = await fetch(API.baseUrl + '/api/upload/photo', { method: 'POST', headers: { 'Authorization': 'Bearer ' + API.token }, body: fd });
      const j = await r.json();
      if (j.error) { this.toast(j.error, 'error'); return; }
      const logoDiv = document.getElementById('brandLogo');
      if (logoDiv) logoDiv.innerHTML = '<img src="' + API.baseUrl + '/api/photo/' + j.filename + '?t=' + Date.now() + '" style="width:100%;height:100%;object-fit:cover">';
      this.toast('Logo atualizada!');
    };
    input.click();
  },

  async loadBrandLogo() {
    const cfg = await API.get('/api/config');
    if (!cfg || !cfg.brand_logo) return;
    const logoDiv = document.getElementById('brandLogo');
    if (logoDiv) logoDiv.innerHTML = '<img src="' + API.baseUrl + '/api/photo/' + cfg.brand_logo + '?t=' + Date.now() + '" style="width:100%;height:100%;object-fit:cover">';
  },

  // ====== NOTIFICATIONS ======
  async loadNotifications() {
    const data = await API.get('/api/notifications');
    if (!data) return;
    document.getElementById('notifBadge').textContent = data.unread || 0;
    document.getElementById('notifBadge').style.display = (data.unread||0) > 0 ? 'inline' : 'none';
    const list = document.getElementById('notifList');
    if (!data.notifications || !data.notifications.length) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">Nenhuma notificação</div>';
      return;
    }
    const typeIcons = { info:'fa-info-circle', warning:'fa-exclamation-triangle', success:'fa-check-circle', danger:'fa-times-circle' };
    list.innerHTML = data.notifications.map(n => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;border-radius:8px;${!n.read?'background:rgba(108,92,231,0.08);':''}">
        <i class="fas ${typeIcons[n.type]||'fa-bell'}" style="color:var(--primary);margin-top:2px;flex-shrink:0"></i>
        <div style="flex:1;min-width:0;cursor:pointer" onclick="App.markRead(${n.id})">
          <div style="font-size:13px;font-weight:${!n.read?'600':'400'}">${this.esc(n.title)}</div>
          ${n.message ? `<div style="font-size:11px;color:var(--text-muted)">${this.esc(n.message)}</div>` : ''}
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px">${n.created_at||''}</div>
        </div>
        <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();App.deleteNotification(${n.id})" title="Excluir" style="flex-shrink:0;padding:2px 6px"><i class="fas fa-trash"></i></button>
      </div>
    `).join('');
  },

  async loadNotifPrefs() {
    const cfg = await API.get('/api/config');
    if (cfg && cfg.notification_prefs) {
      this.notifPrefs = cfg.notification_prefs;
    } else {
      this.notifPrefs = { overdue: true, new_lead: true, task: true, payment: true, audio: false };
    }
  },

  async saveNotifPrefs() {
    const prefs = {
      overdue: document.getElementById('notifOverdue').checked,
      new_lead: document.getElementById('notifNewLead').checked,
      task: document.getElementById('notifTask').checked,
      payment: document.getElementById('notifPayment').checked,
      audio: document.getElementById('notifAudio').checked
    };
    const cfg = await API.get('/api/config') || {};
    cfg.notification_prefs = prefs;
    await API.post('/api/config', cfg);
    this.notifPrefs = prefs;
    this.closeModal('settingsModal');
    this.toast('Preferências de notificação salvas!');
  },

  toggleNotifications() {
    this.notifOpen = !this.notifOpen;
    document.getElementById('notifPanel').style.display = this.notifOpen ? 'block' : 'none';
    document.getElementById('notifOverlay').classList.toggle('show', this.notifOpen);
  },
  closeNotifications() { this.notifOpen = false; document.getElementById('notifPanel').style.display = 'none'; document.getElementById('notifOverlay').classList.remove('show'); },
  async markRead(id) { await API.post('/api/notifications/read', { id }); this.loadNotifications(); },
  async markAllRead() { await API.post('/api/notifications/read', {}); this.loadNotifications(); this.toast('Notificações marcadas como lidas.'); },
  async deleteNotification(id) {
    if (!await this.confirmAsync('Excluir esta notificação?')) return;
    await API.del('/api/notifications/' + id);
    this.loadNotifications();
    this.toast('Notificação excluída.');
  },

  // ====== GENERIC ======
  async deleteItem(endpoint, id, msg) {
    if (!await this.confirmAsync('Tem certeza?')) return;
    await API.del(`/api/${endpoint}/${id}`);
    if (this.currentPage === 'dashboard') {
      this.renderDashboard();
    } else {
      this.loadPage(this.currentPage);
      if (document.getElementById('page-dashboard')) this.renderDashboard();
    }
    this.toast(msg || 'Item removido.');
  },

  openModal(id) {
    const overlay = document.getElementById(id);
    overlay.classList.add('show');
    if (!overlay._modalInit) {
      overlay._modalInit = true;
      overlay.querySelector('.modal')?.addEventListener('click', e => e.stopPropagation());
      overlay.addEventListener('click', () => {
        if (id === 'confirmModal' && this._confirmResolve) this._confirmResolve(false);
        this.closeModal(id);
      });
    }
  },
  closeModal(id) { document.getElementById(id).classList.remove('show'); },

  temporaryModal(html) {
    let overlay = document.getElementById('tempModalOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tempModalOverlay';
      overlay.className = 'modal-overlay';
      overlay.innerHTML = '<div class="modal" style="max-width:420px;text-align:center" id="tempModalContent"></div>';
      overlay.addEventListener('click', () => { overlay.classList.remove('show'); overlay.remove(); });
      overlay.querySelector('.modal')?.addEventListener('click', e => e.stopPropagation());
      document.body.appendChild(overlay);
    }
    document.getElementById('tempModalContent').innerHTML = html;
    overlay.classList.add('show');
  },

  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (window.innerWidth <= 768) {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('show');
    } else {
      sidebar.classList.toggle('collapsed');
      localStorage.setItem('promake_sidebar', sidebar.classList.contains('collapsed') ? 'collapsed' : '');
    }
    this.updateSidebarArrows();
    setTimeout(() => this.updateSidebarToggleIcon(), 10);
  },

  updateSidebarToggleIcon() {
    const isOpen = window.innerWidth <= 768
      ? document.getElementById('sidebar').classList.contains('open')
      : !document.getElementById('sidebar').classList.contains('collapsed');
    const icon = isOpen ? 'fa-chevron-left' : 'fa-chevron-right';
    document.querySelectorAll('.mobile-toggle i').forEach(el => {
      el.className = 'fas ' + icon;
    });
  },

  initTableScrollDetection() {
    document.querySelectorAll('.table-container').forEach(el => {
      const check = () => {
        el.classList.toggle('is-scrollable', el.scrollWidth > el.clientWidth);
      };
      check();
      el.addEventListener('scroll', check);
      window.addEventListener('resize', check);
      new ResizeObserver(check).observe(el);
    });
  },

  initSwipeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (!sidebar) return;
    let startX = 0, currentX = 0, isDragging = false;
    const onTouchStart = (e) => {
      if (window.innerWidth > 768) return;
      const touch = e.touches[0];
      startX = touch.clientX;
      if (sidebar.classList.contains('open') && startX > sidebar.offsetWidth - 40) {
        isDragging = true;
      } else if (!sidebar.classList.contains('open') && startX < 40) {
        isDragging = true;
      }
    };
    const onTouchMove = (e) => {
      if (!isDragging) return;
      currentX = e.touches[0].clientX;
      const diff = currentX - startX;
      if (sidebar.classList.contains('open')) {
        if (diff < 0) {
          sidebar.style.transform = 'translateX(' + diff + 'px)';
          overlay.style.opacity = 1 - Math.abs(diff) / sidebar.offsetWidth;
        }
      } else {
        if (diff > 0) {
          sidebar.style.transform = 'translateX(' + (diff - sidebar.offsetWidth) + 'px)';
          overlay.style.opacity = diff / sidebar.offsetWidth;
          overlay.classList.add('show');
        }
      }
    };
    const onTouchEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      const diff = currentX - startX;
      const threshold = 60;
      sidebar.style.transform = '';
      overlay.style.opacity = '';
      if (sidebar.classList.contains('open') && diff < -threshold) {
        this.toggleSidebar();
      } else if (!sidebar.classList.contains('open') && diff > threshold) {
        this.toggleSidebar();
      } else {
        overlay.style.opacity = '1';
      }
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
  },

  initResizeHandler() {
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.updateSidebarArrows();
        this.updateSidebarToggleIcon();
        if (this.currentPage === 'dashboard') {
          this.loadMobileStats();
          this.loadGlobeStats();
        }
        this.initTableScrollDetection();
      }, 200);
    });
  },

  loadTheme() {
    const theme = localStorage.getItem('promake_theme') || 'dark';
    document.body.classList.toggle('theme-light', theme === 'light');
    document.getElementById('themeBtn').innerHTML = theme === 'light' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
  },
  toggleTheme() {
    const isLight = document.body.classList.toggle('theme-light');
    localStorage.setItem('promake_theme', isLight ? 'light' : 'dark');
    document.getElementById('themeBtn').innerHTML = isLight ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
    this.toast(isLight ? 'Tema claro ativado' : 'Tema escuro ativado');
  },

  toggleFaturamento() {
    this.finVisible = !this.finVisible;
    localStorage.setItem('promake_fin_visible', this.finVisible);
    const btn = document.getElementById('toggleFaturamento');
    if (btn) btn.innerHTML = this.finVisible ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
    document.getElementById('page-dashboard').classList.toggle('hide-finance', !this.finVisible);
    this.toast(this.finVisible ? 'Valores visiveis' : 'Valores ocultos');
  },

  loadFinVisibility() {
    const saved = localStorage.getItem('promake_fin_visible');
    if (saved === 'false') {
      this.finVisible = false;
      document.getElementById('page-dashboard').classList.add('hide-finance');
      const btn = document.getElementById('toggleFaturamento');
      if (btn) btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
    }
  },

  toggleLang() {
    this.lang = this.lang === 'pt-BR' ? 'en' : 'pt-BR';
    localStorage.setItem('promake_lang', this.lang);
    this.applyLang();
  },

  async applyLang() {
    const t = this.i18n[this.lang] || this.i18n['pt-BR'];
    const btn = document.getElementById('langBtn');
    if (btn) btn.innerHTML = '<img src="img/flag-' + (this.lang === 'en' ? 'us' : 'br') + '.svg" style="width:20px;height:20px;border-radius:3px;vertical-align:middle">';
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      const page = item.dataset.page;
      if (t[page]) item.children[1].textContent = t[page];
    });
    const page = this.currentPage;
    if (page) {
      const titles = { dashboard:'Dashboard', leads:'CRM / Leads', clients:'Clientes', projects:'Projetos',
        kanban:'Kanban', services:'Ordem de serviço', contracts:'Contratos',
        finance:'Financeiro', calendar:'Calendário', reports:'Relatórios',
        activity:'Logs', team:'Equipe', settings:'Configurações', integracoes:'Integrações',
        marketing:'Marketing', whatsapp:'WhatsApp' };
      const enTitles = { dashboard:'Dashboard', leads:'CRM / Leads', clients:'Clients', projects:'Projects',
        kanban:'Kanban', services:'Service Orders', contracts:'Contracts',
        finance:'Finance', calendar:'Calendar', reports:'Reports',
        activity:'Activity', team:'Team', settings:'Settings', integracoes:'Integrations',
        marketing:'Marketing', whatsapp:'WhatsApp' };
      const titlesMap = this.lang === 'en' ? enTitles : titles;
      const icons = { dashboard:'fa-chart-pie', leads:'fa-funnel-dollar', clients:'fa-users', projects:'fa-tasks',
        kanban:'fa-columns', services:'fa-clipboard-list', contracts:'fa-file-signature', marketing:'fa-ad',
        finance:'fa-dollar-sign', calendar:'fa-calendar', reports:'fa-chart-bar',
        activity:'fa-history', team:'fa-user-friends', settings:'fa-cog', integracoes:'fa-plug' };
      const titleEl = document.getElementById('pageTitle');
      if (titleEl) titleEl.innerHTML = `<i class="fas ${icons[page] || 'fa-circle'}"></i> ${titlesMap[page] || page}`;
    }
    this.loadPage(this.currentPage);
  },

  loadLang() {
    const saved = localStorage.getItem('promake_lang');
    if (saved) this.lang = saved;
    this.applyLang();
  },

  cookieConsent(accepted) {
    localStorage.setItem('promake_cookie_consent', accepted ? 'accepted' : 'declined');
    document.getElementById('cookieBanner').style.display = 'none';
    if (accepted) this.toast('Cookies aceitos!');
    else this.toast('Cookies recusados. Apenas cookies essenciais serao usados.');
  },

  showPrivacyPolicy() {
    this.openModal('privacyModal');
  },

  checkCookieConsent() {
    const consent = localStorage.getItem('promake_cookie_consent');
    if (!consent) {
      setTimeout(() => {
        const el = document.getElementById('cookieBanner');
        if (el) el.style.display = 'block';
      }, 1000);
    }
  },
  async renderActivityLog() {
    const entity = document.getElementById('activityEntityFilter').value;
    const data = await API.get(`/api/activity-log?limit=200&entity=${entity}`);
    const tbody = document.getElementById('activityTable');
    if (!data || data.error) { tbody.innerHTML = '<tr><td colspan="5">Erro ao carregar atividades.</td></tr>'; return; }
    tbody.innerHTML = data.map(a => `<tr><td style="white-space:nowrap">${a.created_at||''}</td><td>${this.esc(a.user_name)}</td><td>${this.esc(a.action)}</td><td>${this.esc(a.entity_type||'')}</td><td>${this.esc(a.description||'')}</td></tr>`).join('');
  },

  // ====== WHATSAPP ======

  async renderWhatsApp() {
    this.switchTab('wa-send');
    await this.loadWAEntities();
    await this.loadWATemplateSelect();
    document.getElementById('waEntityType').onchange = () => this.loadWAEntities();
    document.getElementById('waTemplateSelect').onchange = () => this.previewWATemplate();
    document.getElementById('waEntityId').onchange = () => {
      const sel = document.getElementById('waEntityId');
      const opt = sel.options[sel.selectedIndex];
      if (opt && opt.dataset.phone) document.getElementById('waPhone').value = opt.dataset.phone;
      this.previewWATemplate();
    };
  },

  async loadWAEntities() {
    const type = document.getElementById('waEntityType').value;
    const list = document.getElementById('waEntityId');
    const data = type === 'lead' ? await API.get('/api/leads') : await API.get('/api/clients');
    if (!data) return;
    list.innerHTML = '<option value="">Selecione</option>' + data.map(e => {
      const phone = e.phone || '';
      return `<option value="${e.id}" data-phone="${this.esc(phone)}">${this.esc(e.name)} ${phone ? '- '+this.esc(phone) : ''}</option>`;
    }).join('');
  },

  async loadWATemplateSelect() {
    const data = await API.get('/api/whatsapp/templates') || [];
    const sel = document.getElementById('waTemplateSelect');
    sel.innerHTML = '<option value="">Sem template</option>' + data.map(t =>
      `<option value="${t.id}">${this.esc(t.name)}</option>`
    ).join('');
  },

  async previewWATemplate() {
    const sel = document.getElementById('waTemplateSelect');
    const tid = sel.value;
    if (!tid) return;
    const r = await API.get('/api/whatsapp/templates') || [];
    const t = r.find(x => x.id == tid);
    if (!t) return;
    const entitySel = document.getElementById('waEntityId');
    const opt = entitySel.options[entitySel.selectedIndex];
    let name = opt ? opt.textContent.split('-')[0].trim() : '';
    document.getElementById('waMessage').value = t.content.replace('{{nome}}', name);
  },

  async sendWhatsApp() {
    const phone = document.getElementById('waPhone').value.trim();
    const message = document.getElementById('waMessage').value.trim();
    const entityType = document.getElementById('waEntityType').value;
    const entitySel = document.getElementById('waEntityId');
    const entityId = entitySel.value ? parseInt(entitySel.value) : null;
    const templateId = document.getElementById('waTemplateSelect').value || null;
    const statusEl = document.getElementById('waSendStatus');

    if (!phone) { this.toast('Digite o telefone.', 'error'); return; }
    if (!message) { this.toast('Digite a mensagem.', 'error'); return; }

    statusEl.style.display = 'block';
    statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
    statusEl.style.color = 'var(--text-muted)';

    const r = await API.post('/api/whatsapp/send', {
      phone, message, template_id: templateId,
      entity_type: entityType, entity_id: entityId
    });

    if (r && !r.error) {
      statusEl.innerHTML = '<i class="fas fa-check-circle" style="color:var(--success)"></i> Mensagem enviada com sucesso!';
      statusEl.style.color = 'var(--success)';
      this.loadWALog();
    } else {
      statusEl.innerHTML = '<i class="fas fa-times-circle" style="color:var(--danger)"></i> ' + (r?.error || 'Erro ao enviar');
      statusEl.style.color = 'var(--danger)';
    }
  },

  async loadWATemplates() {
    const data = await API.get('/api/whatsapp/templates') || [];
    const tbody = document.getElementById('waTemplatesTable');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><i class="fas fa-file-alt"></i><h3>Nenhum template</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.map(t => `
      <tr>
        <td><strong>${this.esc(t.name)}</strong></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(t.content)}</td>
        <td>${t.created_at||''}</td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="App.editWATemplate(${t.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteWATemplate(${t.id})"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  openWATemplateModal(data) {
    document.getElementById('waTemplateId').value = data ? data.id : '';
    document.getElementById('waTemplateModalTitle').textContent = data ? 'Editar Template' : 'Novo Template';
    document.getElementById('waTemplateName').value = data ? data.name : '';
    document.getElementById('waTemplateContent').value = data ? data.content : '';
    this.openModal('waTemplateModal');
  },
  editWATemplate(id) { API.get('/api/whatsapp/templates').then(list => { const t = (list||[]).find(x=>x.id===id); if(t) this.openWATemplateModal(t); }); },

  async saveWATemplate() {
    const id = document.getElementById('waTemplateId').value;
    const name = document.getElementById('waTemplateName').value.trim();
    const content = document.getElementById('waTemplateContent').value.trim();
    if (!name || !content) { this.toast('Preencha nome e conteudo.', 'error'); return; }
    if (id) await API.put('/api/whatsapp/templates/'+id, { name, content });
    else await API.post('/api/whatsapp/templates', { name, content });
    this.closeModal('waTemplateModal');
    this.loadWATemplates();
    this.loadWATemplateSelect();
    this.toast(id ? 'Template atualizado!' : 'Template criado!');
  },

  async deleteWATemplate(id) {
    if (!await this.confirmAsync('Excluir template?')) return;
    await API.del('/api/whatsapp/templates/'+id);
    this.loadWATemplates();
    this.loadWATemplateSelect();
    this.toast('Template excluído.');
  },

  async loadWALog() {
    const data = await API.get('/api/whatsapp/logs') || [];
    const tbody = document.getElementById('waLogTable');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><i class="fas fa-history"></i><h3>Nenhum disparo</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.map(l => `
      <tr>
        <td style="white-space:nowrap">${l.created_at||''}</td>
        <td>${l.to_phone||''}</td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(l.message||'')}</td>
        <td><span class="status ${l.status==='sent'?'active':'inactive'}">${l.status==='sent'?'Enviado':'Erro'}</span></td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(l.response||l.status||'')}</td>
      </tr>
    `).join('');
  },

  async openWhatsAppSend(entity, id, name, phone) {
    document.getElementById('waEntityType').value = entity;
    await this.loadWAEntities();
    document.getElementById('waEntityId').value = id;
    document.getElementById('waPhone').value = phone || '';
    document.getElementById('waMessage').value = '';
    document.getElementById('waSendStatus').style.display = 'none';
    const r = await API.get('/api/whatsapp/templates') || [];
    if (r.length) {
      document.getElementById('waTemplateSelect').value = r[0].id;
      document.getElementById('waMessage').value = r[0].content.replace('{{nome}}', name);
    }
    this.loadPage('whatsapp');
    setTimeout(() => {
      const tab = document.querySelector('#page-whatsapp .tab[data-tab="wa-send"]');
      if (tab) tab.click();
    }, 100);
  },

  // ====== INTEGRACOES ======

  async renderIntegracoes() {
    this.switchTab('int-wa');
    setTimeout(() => {
      this.loadIntWhatsAppConfig();
      this.loadIntMetaAdsConfig();
      this.loadIntGoogleAdsConfig();
    }, 100);
  },

  toEmbedUrl(url) {
    if (!url) return '';
    let u = url.trim();
    if (u.includes('/u/') && /\/u\/\d+\/reporting\//.test(u)) {
      u = u.replace(/\/u\/\d+\/reporting\//, '/embed/reporting/');
    } else if (/\/reporting\//.test(u) && !/\/embed\/reporting\//.test(u)) {
      u = u.replace(/\/reporting\//, '/embed/reporting/');
    }
    if (!u.includes('/embed/')) return u;
    if (u.includes('?')) u += '&embedded=true'; else u += '?embedded=true';
    return u;
  },

  async loadIntLookerConfig() {
    const cfg = await API.get('/api/config');
    if (!cfg) return;
    const lk = cfg.looker_studio || {};
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('intLookerUrl', lk.url);
    setVal('intLookerName', lk.name);
    const st = document.getElementById('intLookerStatus');
    const preview = document.getElementById('lookerEmbedPreview');
    const iframe = document.getElementById('lookerIframe');
    const openLink = document.getElementById('lookerOpenNewTab');
    const errMsg = document.getElementById('lookerEmbedError');
    if (st) {
      if (lk.url) {
        st.style.display = 'block';
        st.innerHTML = '<i class="fas fa-check-circle" style="color:var(--success)"></i> Relatorio configurado';
        if (preview) {
          preview.style.display = 'block';
          const embedUrl = this.toEmbedUrl(lk.url);
          if (iframe) { iframe.src = embedUrl; iframe.title = lk.name || 'Looker Studio'; iframe.onerror = () => { if (errMsg) errMsg.style.display = 'inline'; }; }
          if (openLink) openLink.href = lk.url;
        }
        if (errMsg) errMsg.style.display = 'none';
      } else {
        st.style.display = 'none';
        if (preview) preview.style.display = 'none';
      }
    }
  },

  async saveIntLookerConfig() {
    const url = document.getElementById('intLookerUrl').value.trim();
    const name = document.getElementById('intLookerName').value.trim();
    const cfg = await API.get('/api/config') || {};
    cfg.looker_studio = { url, name: name || 'Looker Studio' };
    await API.post('/api/config', cfg);
    this.loadIntLookerConfig();
    this.toast('Configuracao Looker Studio salva!');
  },

  async loadIntWhatsAppConfig() {
    const cfg = await API.get('/api/whatsapp/config');
    if (!cfg) return;
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('intWaWebhookUrl', cfg.webhook_url);
    setVal('intWaApiKey', cfg.api_key);
    setVal('intWaApiKeyHeader', cfg.api_key_header);
    setVal('intWaMethod', cfg.method);
    setVal('intWaBodyTemplate', cfg.body_template);
    const icon = document.getElementById('intWaStatusIcon');
    const txt = document.getElementById('intWaStatusText');
    if (icon) icon.className = cfg.configured ? 'fas fa-check-circle' : 'fas fa-times-circle';
    if (icon) icon.style.color = cfg.configured ? 'var(--success)' : 'var(--danger)';
    if (txt) txt.textContent = cfg.configured ? 'WhatsApp configurado' : 'Nao configurado';
  },

  async saveIntWhatsAppConfig() {
    await API.post('/api/whatsapp/config', {
      webhook_url: document.getElementById('intWaWebhookUrl').value.trim(),
      api_key: document.getElementById('intWaApiKey').value.trim(),
      api_key_header: document.getElementById('intWaApiKeyHeader').value.trim(),
      method: document.getElementById('intWaMethod').value,
      body_template: document.getElementById('intWaBodyTemplate').value.trim()
    });
    this.loadIntWhatsAppConfig();
    this.toast('Configuracao WhatsApp salva!');
  },

  async loadIntMetaAdsConfig() {
    const cfg = await API.get('/api/ads/meta/config');
    if (!cfg) return;
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('intMetaAccessToken', cfg.access_token);
    setVal('intMetaAdAccountId', cfg.ad_account_id);
  },

  async saveIntMetaAdsConfig() {
    await API.post('/api/ads/meta/config', {
      access_token: document.getElementById('intMetaAccessToken').value.trim(),
      ad_account_id: document.getElementById('intMetaAdAccountId').value.trim()
    });
    this.loadIntMetaAdsConfig();
    this.toast('Configuracao Meta Ads salva!');
  },

  async loadIntGoogleAdsConfig() {
    const cfg = await API.get('/api/ads/google/config');
    if (!cfg) return;
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('intGoogleCustomerId', cfg.customer_id);
    setVal('intGoogleDevToken', cfg.developer_token);
    setVal('intGoogleClientId', cfg.client_id);
    setVal('intGoogleClientSecret', cfg.client_secret);
    setVal('intGoogleRefreshToken', cfg.refresh_token);
  },

  async saveIntGoogleAdsConfig() {
    await API.post('/api/ads/google/config', {
      customer_id: document.getElementById('intGoogleCustomerId').value.trim(),
      developer_token: document.getElementById('intGoogleDevToken').value.trim(),
      client_id: document.getElementById('intGoogleClientId').value.trim(),
      client_secret: document.getElementById('intGoogleClientSecret').value.trim(),
      refresh_token: document.getElementById('intGoogleRefreshToken').value.trim()
    });
    this.loadIntGoogleAdsConfig();
    this.toast('Configuracao Google Ads salva!');
  },

  // ====== MARKETING / ADS ======

  async renderMarketing() {
    this.switchTab('mkt-meta');
  },

  async renderMetaAds() {
    const cfg = await API.get('/api/ads/meta/config');
    if (!cfg || !cfg.configured) {
      document.getElementById('mktMetaNotConfigured').style.display = 'block';
      document.getElementById('mktMetaContent').style.display = 'none';
      return;
    }
    document.getElementById('mktMetaNotConfigured').style.display = 'none';
    document.getElementById('mktMetaContent').style.display = 'block';

    const daily = await API.get('/api/ads/meta/daily');
    const camps = await API.get('/api/ads/meta/campaigns');
    const fm = v => 'R$ ' + (v||0).toLocaleString('pt-BR', {minimumFractionDigits:2});
    const fn = v => (v||0).toLocaleString('pt-BR');

    // Cards
    let totalSpend = 0, totalImpr = 0, totalClicks = 0;
    if (camps && camps.data) {
      camps.data.forEach(c => {
        totalSpend += parseFloat(c.spend || 0);
        totalImpr += parseInt(c.impressions || 0);
        totalClicks += parseInt(c.clicks || 0);
      });
    }
    document.getElementById('mktMetaCards').innerHTML = `
      <div class="card card-hover"><div class="card-icon purple"><i class="fas fa-dollar-sign"></i></div><div class="card-label">Gasto Total</div><div class="card-value">${fm(totalSpend)}</div></div>
      <div class="card card-hover"><div class="card-icon blue"><i class="fas fa-eye"></i></div><div class="card-label">Impressoes</div><div class="card-value">${fn(totalImpr)}</div></div>
      <div class="card card-hover"><div class="card-icon green"><i class="fas fa-mouse-pointer"></i></div><div class="card-label">Cliques</div><div class="card-value">${fn(totalClicks)}</div></div>
      <div class="card card-hover"><div class="card-icon orange"><i class="fas fa-percentage"></i></div><div class="card-label">CTR Medio</div><div class="card-value">${totalImpr ? ((totalClicks/totalImpr)*100).toFixed(2)+'%' : '0%'}</div></div>`;

    // Daily chart
    if (this.chartInstances.metaDaily) this.chartInstances.metaDaily.destroy();
    if (daily && daily.data) {
      const days = daily.data.map(d => d.date_start?.slice(5) || '');
      const spends = daily.data.map(d => parseFloat(d.spend || 0));
      const clicks = daily.data.map(d => parseInt(d.clicks || 0));
      this.chartInstances.metaDaily = new Chart(document.getElementById('mktMetaDailyChart'), {
        type: 'line',
        data: {
          labels: days,
          datasets: [
            { label: 'Gasto (R$)', data: spends, borderColor: '#6C5CE7', backgroundColor: 'rgba(108,92,231,0.1)', fill: true, tension: 0.3, yAxisID: 'y' },
            { label: 'Cliques', data: clicks, borderColor: '#00B0FF', backgroundColor: 'rgba(0,176,255,0.1)', fill: true, tension: 0.3, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: '#8888AA' } } },
          scales: {
            x: { ticks: { color: '#8888AA', maxTicksLimit: 10 }, grid: { color: 'rgba(42,42,69,0.5)' } },
            y: { type: 'linear', position: 'left', ticks: { color: '#8888AA', callback: v => 'R$ '+v }, grid: { color: 'rgba(42,42,69,0.5)' } },
            y1: { type: 'linear', position: 'right', ticks: { color: '#00B0FF' }, grid: { display: false } }
          }
        }
      });
    }

    // Table
    const tbody = document.getElementById('mktMetaTable');
    if (!camps || !camps.data || !camps.data.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><h3>Nenhuma campanha</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = camps.data.map(c => {
      const spend = parseFloat(c.spend || 0);
      const impr = parseInt(c.impressions || 0);
      const clk = parseInt(c.clicks || 0);
      const ctr = parseFloat(c.ctr || 0);
      const cpc = parseFloat(c.cpc || 0);
      const cpm = parseFloat(c.cpm || 0);
      return `<tr>
        <td><strong>${this.esc(c.campaign_name || '')}</strong></td>
        <td>${fm(spend)}</td>
        <td>${fn(impr)}</td>
        <td>${fn(clk)}</td>
        <td>${ctr.toFixed(2)}%</td>
        <td>${fm(cpc)}</td>
        <td>${fm(cpm)}</td>
      </tr>`;
    }).join('');
  },

  async renderGoogleAds() {
    const cfg = await API.get('/api/ads/google/config');
    if (!cfg || !cfg.configured) {
      document.getElementById('mktGoogleNotConfigured').style.display = 'block';
      document.getElementById('mktGoogleContent').style.display = 'none';
      return;
    }
    document.getElementById('mktGoogleNotConfigured').style.display = 'none';
    document.getElementById('mktGoogleContent').style.display = 'block';

    const data = await API.get('/api/ads/google/campaigns');
    const fm = v => 'R$ ' + ((v||0)/1000000).toLocaleString('pt-BR', {minimumFractionDigits:2});
    const fn = v => (v||0).toLocaleString('pt-BR');
    const sl = { ENABLED:'Ativo', PAUSED:'Pausado', REMOVED:'Removido' };
    const sc = { ENABLED:'active', PAUSED:'pending', REMOVED:'inactive' };

    // Cards
    let totalSpend = 0, totalImpr = 0, totalClicks = 0;
    const results = data?.results || [];
    results.forEach(c => {
      const m = c.metrics || {};
      totalSpend += parseInt(m.costMicros || 0);
      totalImpr += parseInt(m.impressions || 0);
      totalClicks += parseInt(m.clicks || 0);
    });
    document.getElementById('mktGoogleCards').innerHTML = `
      <div class="card card-hover"><div class="card-icon purple"><i class="fas fa-dollar-sign"></i></div><div class="card-label">Gasto Total</div><div class="card-value">${fm(totalSpend)}</div></div>
      <div class="card card-hover"><div class="card-icon blue"><i class="fas fa-eye"></i></div><div class="card-label">Impressoes</div><div class="card-value">${fn(totalImpr)}</div></div>
      <div class="card card-hover"><div class="card-icon green"><i class="fas fa-mouse-pointer"></i></div><div class="card-label">Cliques</div><div class="card-value">${fn(totalClicks)}</div></div>
      <div class="card card-hover"><div class="card-icon orange"><i class="fas fa-percentage"></i></div><div class="card-label">CTR Medio</div><div class="card-value">${totalImpr ? ((totalClicks/totalImpr)*100).toFixed(2)+'%' : '0%'}</div></div>`;

    const tbody = document.getElementById('mktGoogleTable');
    if (!results.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><h3>Nenhuma campanha</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = results.map(c => {
      const camp = c.campaign || {};
      const m = c.metrics || {};
      const spend = parseFloat(m.costMicros || 0) / 1000000;
      const impr = parseInt(m.impressions || 0);
      const clk = parseInt(m.clicks || 0);
      const ctr = parseFloat(m.ctr || 0);
      const cpc = parseFloat(m.averageCpc || 0) / 1000000;
      return `<tr>
        <td><strong>${this.esc(camp.name || '')}</strong></td>
        <td><span class="status ${sc[camp.status]||'pending'}">${sl[camp.status]||camp.status||'-'}</span></td>
        <td>${fm(parseInt(m.costMicros||0))}</td>
        <td>${fn(impr)}</td>
        <td>${fn(clk)}</td>
        <td>${ctr.toFixed(2)}%</td>
        <td>${fm(parseInt(m.averageCpc||0))}</td>
      </tr>`;
    }).join('');
  },

  async uploadFile(entity, eid) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx,.zip';
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 5*1024*1024) { this.toast('Arquivo muito grande. Maximo 5MB.', 'error'); return; }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', entity);
      fd.append('entity_id', eid);
      const r = await fetch(API.baseUrl + '/api/upload', { method: 'POST', headers: { 'Authorization': 'Bearer ' + API.token }, body: fd });
      const j = await r.json();
      if (j.error) { this.toast(j.error, 'error'); return; }
      this.toast('Arquivo enviado!', 'success');
      this.updateStorageInfo();
    };
    input.click();
  },

  async exportPDF(type, id) {
    try {
      const r = await fetch(API.baseUrl + `/api/export/pdf/${type}/${id}`, {
        headers: { 'Authorization': 'Bearer ' + API.token }
      });
      if (!r.ok) { this.toast('Erro ao exportar PDF', 'error'); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) {
      this.toast('Erro ao exportar PDF', 'error');
    }
  },

  async updateStorageInfo() {
    const data = await API.get('/api/files');
    if (!data || data.error) return;
    const el = document.getElementById('storageInfo');
    if (!el) return;
    const pct = (data.storage_used / data.storage_max * 100).toFixed(1);
    const mbUsed = (data.storage_used / 1024 / 1024).toFixed(1);
    el.innerHTML = `<i class="fas fa-database"></i> ${mbUsed}MB / 5MB <span style="font-size:11px;color:var(--text-muted)">(${pct}%)</span>`;
  },

  async viewFiles(entity, eid) {
    const data = await API.get(`/api/files?entity=${entity}&entity_id=${eid}`);
    if (!data) return;
    const files = data.files || [];
    const container = document.getElementById('filesModalBody');
    if (!files.length) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)"><i class="fas fa-folder-open" style="font-size:40px;display:block;margin-bottom:12px;opacity:0.4"></i> Nenhum arquivo anexado</div>';
    } else {
      container.innerHTML = files.map(f => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;border:1px solid var(--border);margin-bottom:8px">
          <i class="fas fa-file" style="color:var(--primary);font-size:20px"></i>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(f.original_name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${(f.size/1024).toFixed(1)}KB - ${f.created_at||''}</div>
          </div>
          <button class="btn btn-xs btn-outline" onclick="App.downloadFile(${f.id})" title="Baixar"><i class="fas fa-download"></i></button>
          <button class="btn btn-xs btn-danger" onclick="App.deleteFile(${f.id},'${entity}',${eid})" title="Excluir"><i class="fas fa-trash"></i></button>
        </div>
      `).join('');
    }
    document.getElementById('filesModalTitle').textContent = 'Arquivos - ' + entity + ' #' + eid;
    this.openModal('filesModal');
  },

  async deleteFile(fid, entity, eid) {
    if (!await this.confirmAsync('Excluir este arquivo?')) return;
    await API.del('/api/files/'+fid);
    this.viewFiles(entity, eid);
    this.updateStorageInfo();
    this.toast('Arquivo excluído.');
  },

  async downloadFile(fid) {
    try {
      const r = await fetch(API.baseUrl + '/api/download/' + fid, {
        headers: { 'Authorization': 'Bearer ' + API.token }
      });
      if (!r.ok) { this.toast('Erro ao baixar arquivo', 'error'); return; }
      const blob = await r.blob();
      const disp = r.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename[^;=\n]*=([^"'\n]*)/);
      const name = match ? match[1].trim() : 'arquivo';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = decodeURIComponent(name);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) {
      this.toast('Erro ao baixar arquivo', 'error');
    }
  },

  // ====== AI CHAT ======
  chatHistory: [],

  renderChat() {
    const container = document.getElementById('chatMessages');
    if (!container.querySelector('.chat-msg')) return;
    this.chatHistory = [];
    document.getElementById('chatInput').focus();
  },

  async sendChat() {
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    this.addChatMessage(msg, 'user');
    const sendBtn = document.getElementById('chatSendBtn');
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    const loading = document.createElement('div');
    loading.className = 'chat-loading';
    loading.id = 'chatLoading';
    loading.innerHTML = '<div class="dots"><span></span><span></span><span></span></div><span>Pensando...</span>';
    document.getElementById('chatMessages').appendChild(loading);
    try {
      const data = await API.post('/api/chat', { message: msg, history: this.chatHistory.slice(-20) });
      if (data && data.response) {
        this.addChatMessage(data.response, 'bot');
        this.chatHistory.push({ role: 'user', content: msg });
        this.chatHistory.push({ role: 'assistant', content: data.response });
      } else {
        this.addChatMessage('Desculpe, ocorreu um erro ao processar sua mensagem.', 'bot');
      }
    } catch(e) {
      this.addChatMessage('Erro de conexão com o servidor.', 'bot');
    }
    const l = document.getElementById('chatLoading');
    if (l) l.remove();
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
    document.getElementById('chatInput').focus();
  },

  addChatMessage(text, role) {
    const container = document.getElementById('chatMessages');
    const welcome = container.querySelector('div:first-child > i.fa-robot');
    if (welcome) container.innerHTML = '';
    const now = new Date();
    const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.innerHTML = `
      <div class="avatar"><i class="fas ${role === 'user' ? 'fa-user' : 'fa-robot'}"></i></div>
      <div>
        <div class="bubble">${this.escChat(text)}</div>
        <div class="time">${time}</div>
      </div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  },

  escChat(text) {
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  },

  quickChat(msg) {
    document.getElementById('chatInput').value = msg;
    this.sendChat();
  },

  // ── Landing Page Config (Elementor Style) ──

  toggleLandingPanel(headerEl) {
    const body = headerEl.nextElementSibling;
    const toggle = headerEl.querySelector('.e-toggle');
    if (body.classList.contains('open')) {
      body.classList.remove('open');
      toggle.classList.remove('open');
    } else {
      body.classList.add('open');
      toggle.classList.add('open');
    }
  },

  async renderLanding() {
    const config = await API.get('/api/landing/config') || {};
    const c = (s, k) => config[s]?.[k] || '';
    const esc = (v) => this.esc(v);
    const container = document.getElementById('landingEditorContainer');

    const panel = (icon, bg, title, badge, fieldHtml, open) =>
      '<div class="lp-elementor-panel">' +
        '<div class="lp-elementor-header" onclick="App.toggleLandingPanel(this)">' +
          '<div class="e-icon" style="background:' + bg + '"><i class="' + icon + '"></i></div>' +
          '<span class="e-title">' + title + '</span>' +
          '<span class="e-badge">' + badge + '</span>' +
          '<span class="e-toggle' + (open ? ' open' : '') + '"><i class="fas fa-chevron-down"></i></span>' +
        '</div>' +
        '<div class="lp-elementor-body' + (open ? ' open' : '') + '">' +
          fieldHtml +
        '</div>' +
      '</div>';

    const field = (id, label, icon, type, placeholder, desc, extra) => {
      const parts = id.split('-');
      const val = esc(c(parts[0], parts.slice(1).join('_')));
      let input = '';
      if (type === 'textarea') {
        input = '<textarea id="lcfg-' + id + '" rows="3" placeholder="' + placeholder + '">' + val + '</textarea>';
      } else if (type === 'select') {
        const opts = extra || [];
        const options = opts.map(o => '<option value="' + o.value + '"' + (val === o.value ? ' selected' : '') + '>' + o.label + '</option>').join('');
        input = '<select id="lcfg-' + id + '">' + options + '</select>';
      } else {
        input = '<input type="text" id="lcfg-' + id + '" value="' + val + '" placeholder="' + placeholder + '">';
      }
      return '<div class="lp-elementor-field">' +
        '<label><i class="' + icon + '"></i> ' + label + '</label>' +
        input +
        (desc ? '<div class="field-desc">' + desc + '</div>' : '') +
      '</div>';
    };

    const fieldRow = (fields) => '<div class="field-row">' + fields + '</div>';

    // ── Hero ──
    const heroFields =
      fieldRow(
        field('hero-badge', 'Badge', 'fas fa-tag', 'text', 'Ex: Ecossistema Completo', 'Texto destacado no topo do hero') +
        field('hero-badge_icon', 'Ícone do Badge', 'fas fa-icons', 'text', 'fas fa-crown', 'Classe do ícone FontAwesome')
      ) +
      field('hero-title', 'Título Principal', 'fas fa-heading', 'textarea', 'Título principal do hero', 'Máximo de 60 caracteres recomendado') +
      field('hero-subtitle', 'Subtítulo', 'fas fa-quote-right', 'textarea', 'Subtítulo do hero', 'Breve descrição abaixo do título') +
      fieldRow(
        field('hero-btn1_text', 'Texto Botão 1', 'fas fa-square-check', 'text', 'Acessar Agora', 'Botão principal (CTA)') +
        field('hero-btn2_text', 'Texto Botão 2', 'fas fa-square', 'text', 'Conhecer Módulos', 'Botão secundário')
      );

    // ── Stats ──
    let statsFields = '';
    for (let i = 1; i <= 4; i++) {
      statsFields +=
        '<div style="background:var(--bg);border-radius:8px;padding:14px;border:1px solid var(--border);margin-bottom:10px">' +
        '<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:8px"><i class="fas fa-chart-line"></i> Estatística ' + i + '</div>' +
        fieldRow(
          field('stats-' + i + '_num', 'Número', 'fas fa-hashtag', 'text', 'Ex: 100%', 'Valor numérico ou percentual') +
          field('stats-' + i + '_label', 'Label', 'fas fa-tag', 'text', 'Ex: Gratuito', 'Descrição da estatística')
        ) +
        '</div>';
    }

    // ── Features ──
    const featuresFields =
      field('features-title', 'Título da Seção', 'fas fa-heading', 'textarea', 'Título da seção de features', 'Aparece acima dos cards de recursos') +
      field('features-subtitle', 'Subtítulo', 'fas fa-quote-right', 'textarea', 'Subtítulo da seção de features', 'Breve descrição abaixo do título');

    // ── Plans ──
    const plansFields =
      field('plans-title', 'Título da Seção', 'fas fa-heading', 'textarea', 'Título da seção de planos', 'Título acima dos cards de planos') +
      field('plans-subtitle', 'Subtítulo', 'fas fa-quote-right', 'textarea', 'Subtítulo da seção de planos', 'Breve descrição abaixo do título');

    // ── CTA ──
    const ctaFields =
      field('cta-title', 'Título do CTA', 'fas fa-heading', 'textarea', 'Ex: Pronto para transformar sua gestão?', 'Chamada principal do CTA') +
      field('cta-subtitle', 'Subtítulo do CTA', 'fas fa-quote-right', 'textarea', 'Subtítulo da seção de CTA', 'Breve descrição de apoio') +
      field('cta-btn_text', 'Texto do Botão', 'fas fa-square-check', 'text', 'Começar Agora', 'Texto do botão de chamada para ação');

    // ── Footer ──
    const footerFields =
      field('footer-text', 'Texto do Footer', 'fas fa-file-lines', 'text', 'Gestão para Agências Digitais', 'Texto exibido no rodapé da landing page');

    container.innerHTML =
      panel('fas fa-crown', '#6C5CE7', 'Hero', 'Principal', heroFields, true) +
      panel('fas fa-chart-simple', '#00B894', 'Estatísticas', '4 itens', statsFields, true) +
      panel('fas fa-cubes', '#0984E3', 'Features', 'Recursos', featuresFields, true) +
      panel('fas fa-boxes', '#FDCB6E', 'Planos', 'Assinaturas', plansFields, true) +
      panel('fas fa-bullhorn', '#E17055', 'CTA', 'Chamada', ctaFields, true) +
      panel('fas fa-file-lines', '#636E72', 'Footer', 'Rodapé', footerFields, true);
  },

  async saveLandingConfig() {
    const ids = [
      'hero-badge','hero-badge_icon','hero-title','hero-subtitle','hero-btn1_text','hero-btn2_text',
      'stats-1_num','stats-1_label','stats-2_num','stats-2_label','stats-3_num','stats-3_label','stats-4_num','stats-4_label',
      'features-title','features-subtitle',
      'plans-title','plans-subtitle',
      'cta-title','cta-subtitle','cta-btn_text',
      'footer-text'
    ];
    const config = {};
    ids.forEach(id => {
      const el = document.getElementById('lcfg-' + id);
      if (!el) return;
      const [section, ...keyParts] = id.split('-');
      const key = keyParts.join('_');
      if (!config[section]) config[section] = {};
      config[section][key] = el.value;
    });
    const r = await API.put('/api/landing/config', config);
    if (!r || r.error) { this.toast(r?.error || 'Erro ao salvar', 'error'); return; }
    this.applyLandingConfig(r);
    this.toast('Landing page atualizada!');
  },

  applyLandingConfig(config) {
    if (!config) return;
    const map = {
      'hero': [
        ['lp-hero-badge-text', 'badge'],
        ['lp-hero-badge-icon', 'badge_icon', (v, el) => { el.className = v || 'fas fa-crown'; }],
        ['lp-hero-title', 'title'],
        ['lp-hero-subtitle', 'subtitle'],
        ['lp-hero-btn1 span', 'btn1_text'],
        ['lp-hero-btn2 span', 'btn2_text'],
      ],
      'stats': [
        ['lp-stat-1-num', '1_num'], ['lp-stat-1-label', '1_label'],
        ['lp-stat-2-num', '2_num'], ['lp-stat-2-label', '2_label'],
        ['lp-stat-3-num', '3_num'], ['lp-stat-3-label', '3_label'],
        ['lp-stat-4-num', '4_num'], ['lp-stat-4-label', '4_label'],
      ],
      'features': [
        ['lp-features-title', 'title'],
        ['lp-features-subtitle', 'subtitle'],
      ],
      'plans': [
        ['lp-plans-title', 'title'],
        ['lp-plans-subtitle', 'subtitle'],
      ],
      'cta': [
        ['lp-cta-title', 'title', (v, el) => { const i = el.querySelector('i'); el.innerHTML = ''; if(i)el.appendChild(i); el.append(' '+v); }],
        ['lp-cta-subtitle', 'subtitle'],
        ['lp-cta-btn span', 'btn_text'],
      ],
      'footer': [
        ['lp-footer-text', 'text', (v, el) => { const i = el.querySelector('i'); const s = el.querySelector('strong'); const y = el.querySelector('#lpYear'); el.innerHTML = ''; if(i)el.appendChild(i); el.append(' '); if(s)el.appendChild(s); el.append(' — ' + v + ' — '); if(y)el.appendChild(y); }],
      ],
    };
    for (const [section, items] of Object.entries(map)) {
      const secData = config[section];
      if (!secData) continue;
      for (const [elId, key, customFn] of items) {
        const el = document.getElementById(elId);
        if (!el) continue;
        const val = secData[key] || '';
        if (customFn) {
          customFn(val, el);
        } else {
          el.textContent = val;
        }
      }
    }
  },

  async loadLandingContent() {
    try {
      const config = await (await fetch('/api/landing/config')).json();
      this.applyLandingConfig(config);
    } catch(e) {
      // fallback content already in HTML
    }
  },

  // ── Slides ──

  async renderSlides() {
    const data = await API.get('/api/slides') || [];
    const container = document.getElementById('slidesContainer');
    if (!data.length) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-images"></i><h3>Nenhum slide criado</h3><p>Crie slides para aparecerem no banner principal da landing page.</p></div>';
      return;
    }
    container.innerHTML = data.map((s, i) => `
      <div class="card" style="margin-bottom:14px;overflow:hidden">
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:16px">
          <div style="flex-shrink:0;width:140px;height:80px;border-radius:8px;overflow:hidden;background:var(--bg);border:1px solid var(--border)">
            ${s.image_url ? `<img src="/api/photo/${s.image_url}" style="width:100%;height:100%;object-fit:cover">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:24px"><i class="fas fa-image"></i></div>'}
          </div>
          <div style="flex:1;min-width:150px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <strong>${this.esc(s.title||'Sem título')}</strong>
              <span class="badge ${s.active?'badge-success':'badge-danger'}">${s.active?'Ativo':'Inativo'}</span>
              <span style="font-size:11px;color:var(--text-muted)">Ordem: ${s.sort_order}</span>
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${this.esc(s.subtitle||'')}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-xs btn-info-btn" onclick="App.editSlide(${s.id})"><i class="fas fa-edit"></i></button>
            <button class="btn btn-xs btn-danger" onclick="App.deleteSlide(${s.id})"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      </div>
    `).join('');
  },

  async openSlideModal(data) {
    document.getElementById('slideId').value = data ? data.id : '';
    document.getElementById('slideModalTitle').textContent = data ? 'Editar Slide' : 'Novo Slide';
    document.getElementById('slideImage').value = data ? (data.image_url||'') : '';
    document.getElementById('slideTitle').value = data ? (data.title||'') : '';
    document.getElementById('slideSubtitle').value = data ? (data.subtitle||'') : '';
    document.getElementById('slideBadge').value = data ? (data.badge_text||'') : '';
    document.getElementById('slideLinkText').value = data ? (data.link_text||'Acessar Agora') : 'Acessar Agora';
    document.getElementById('slideLinkUrl').value = data ? (data.link_url||'') : '';
    document.getElementById('slideBtn2Text').value = data ? (data.btn2_text||'') : '';
    document.getElementById('slideBtn2Url').value = data ? (data.btn2_url||'') : '';
    document.getElementById('slideOrder').value = data ? (data.sort_order||0) : 0;
    document.getElementById('slideActive').value = data ? (data.active||1) : 1;
    const preview = document.getElementById('slidePreview');
    if (data && data.image_url) {
      preview.innerHTML = `<img src="/api/photo/${data.image_url}" style="max-width:100%;max-height:120px;border-radius:6px">`;
    } else {
      preview.innerHTML = '<div style="padding:20px;color:var(--text-muted);font-size:13px">Nenhuma imagem</div>';
    }
    this.openModal('slideModal');
  },

  async saveSlide() {
    const id = document.getElementById('slideId').value;
    const body = {
      image_url: document.getElementById('slideImage').value.trim(),
      title: document.getElementById('slideTitle').value.trim(),
      subtitle: document.getElementById('slideSubtitle').value.trim(),
      badge_text: document.getElementById('slideBadge').value.trim(),
      link_text: document.getElementById('slideLinkText').value.trim() || 'Acessar Agora',
      link_url: document.getElementById('slideLinkUrl').value.trim(),
      btn2_text: document.getElementById('slideBtn2Text').value.trim(),
      btn2_url: document.getElementById('slideBtn2Url').value.trim(),
      sort_order: parseInt(document.getElementById('slideOrder').value) || 0,
      active: parseInt(document.getElementById('slideActive').value) || 1
    };
    const r = id ? await API.put('/api/slides/'+id, body) : await API.post('/api/slides', body);
    if (!r || r.error) { this.toast(r?.error || 'Erro ao salvar', 'error'); return; }
    this.closeModal('slideModal');
    this.renderSlides();
    this.loadPublicSlides();
    this.toast(id ? 'Slide atualizado!' : 'Slide criado!');
  },

  async editSlide(id) {
    const data = (await API.get('/api/slides')).find(s => s.id === id);
    if (data) this.openSlideModal(data);
  },

  async deleteSlide(id) {
    if (!await this.confirmAsync('Excluir este slide?')) return;
    await API.del('/api/slides/'+id);
    this.renderSlides();
    this.loadPublicSlides();
    this.toast('Slide excluído.');
  },

  async uploadSlideImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch(API.baseUrl + '/api/upload/photo', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + API.token }, body: fd
        });
        const j = await r.json();
        if (j.filename) {
          document.getElementById('slideImage').value = j.filename;
          document.getElementById('slidePreview').innerHTML = `<img src="/api/photo/${j.filename}" style="max-width:100%;max-height:120px;border-radius:6px">`;
          this.toast('Imagem enviada!');
        } else {
          this.toast('Erro ao enviar imagem', 'error');
        }
      } catch(e) {
        this.toast('Erro ao enviar: '+e.message, 'error');
      }
    };
    input.click();
  },

  async loadPublicSlides() {
    try {
      const slides = await (await fetch('/api/slides/public')).json();
      this._slides = slides || [];
      this.renderSlideCarousel();
    } catch(e) {
      this._slides = [];
    }
  },

  renderSlideCarousel() {
    const container = document.getElementById('slideCarousel');
    if (!container) return;
    const slides = this._slides || [];
    if (!slides.length) {
      container.innerHTML = '';
      document.querySelector('.lp-hero-default')?.classList.remove('hidden');
      return;
    }
    document.querySelector('.lp-hero-default')?.classList.add('hidden');
    let idx = 0;
    const render = () => {
      const s = slides[idx];
      if (!s) return;
      container.innerHTML = `
        <div class="slide-track" style="animation:fadeIn .5s ease">
          ${s.badge_text ? `<div class="lp-hero-badge"><i class="${s.badge_icon||'fas fa-crown'}"></i> ${this.esc(s.badge_text)}</div>` : ''}
          <div class="lp-hero-icon"><i class="fas fa-crown"></i></div>
          <h1>${this.esc(s.title||'')}</h1>
          <p>${this.esc(s.subtitle||'')}</p>
          <div class="lp-hero-btns">
            <button class="btn btn-primary" onclick="${s.link_url ? `window.open('${this.esc(s.link_url)}','_blank')` : 'App.openLandingLogin()'}"><i class="fas fa-rocket"></i> ${this.esc(s.link_text||'Acessar Agora')}</button>
            ${s.btn2_text ? `<button class="btn btn-outline" onclick="${s.btn2_url ? `window.open('${this.esc(s.btn2_url)}','_blank')` : 'App.openLandingLogin()'}"><i class="fas fa-info-circle"></i> ${this.esc(s.btn2_text)}</button>` : ''}
          </div>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:24px">
            ${slides.map((_, i) => `<span onclick="App.goToSlide(${i})" style="width:${i===idx?'24px':'10px'};height:10px;border-radius:5px;background:${i===idx?'var(--primary)':'var(--border)'};cursor:pointer;transition:all .3s"></span>`).join('')}
          </div>
        </div>
      `;
    };
    render();
    clearInterval(this._carouselTimer);
    if (slides.length > 1) {
      this._carouselTimer = setInterval(() => {
        idx = (idx + 1) % slides.length;
        render();
      }, 6000);
    }
    this._goToSlide = (i) => { idx = i; render(); };
  },

  goToSlide(i) {
    if (this._goToSlide) this._goToSlide(i);
    clearInterval(this._carouselTimer);
    const slides = this._slides || [];
    if (slides.length > 1) {
      let idx = i;
      this._carouselTimer = setInterval(() => {
        idx = (idx + 1) % slides.length;
        if (this._goToSlide) this._goToSlide(idx);
      }, 6000);
    }
  },

  toast(msg, type) {
    const t = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    t.className = 'toast show ' + (type||'success');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  },

  // ====== PAINEL CRIATIVO (Miro-style Board) ======

  async renderDesign() {
    const projects = await API.get('/api/design-projects') || [];
    const grid = document.getElementById('designProjectsGrid');
    if (!projects.length) {
      grid.innerHTML = '<div style="grid-column:1/-1"><div class="empty-state"><i class="fas fa-paint-brush"></i><h3>Nenhum projeto criativo</h3><p>Crie projetos para organizar o cronograma de desenvolvimento de material grafico.</p></div></div>';
      document.getElementById('designBoardView').style.display = 'none';
      document.getElementById('designListView').style.display = 'block';
      return;
    }
    grid.innerHTML = projects.map(p => `
      <div class="card card-hover" style="cursor:pointer" onclick="App.openDesignBoard(${p.id})">
        <div class="card-icon purple"><i class="fas fa-paint-brush"></i></div>
        <div class="card-label">${this.esc(p.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin:4px 0">${this.esc(p.client_name||'Sem cliente')}</div>
        <div style="font-size:12px;color:var(--text-muted)">${p.deadline ? 'Prazo: '+p.deadline : 'Sem prazo'}</div>
        <div style="display:flex;gap:6px;margin-top:12px">
          <button class="btn btn-xs btn-outline" onclick="event.stopPropagation();App.editDesign(${p.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();App.deleteDesign(${p.id})"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    `).join('');
  },

  async openDesignModal(data) {
    document.getElementById('designId').value = data ? data.id : '';
    document.getElementById('designModalTitle').textContent = data ? 'Editar Projeto' : 'Novo Projeto Criativo';
    document.getElementById('designName').value = data ? data.name : '';
    document.getElementById('designDesc').value = data ? data.description||'' : '';
    document.getElementById('designClient').value = data ? data.client_name||'' : '';
    document.getElementById('designDeadline').value = data ? data.deadline||'' : '';
    this.openModal('designModal');
  },

  editDesign(id) {
    API.get('/api/design-projects/'+id).then(d => { if (d) this.openDesignModal(d); });
  },

  async saveDesign() {
    const id = document.getElementById('designId').value;
    const body = {
      name: document.getElementById('designName').value.trim(),
      description: document.getElementById('designDesc').value.trim(),
      client_name: document.getElementById('designClient').value.trim(),
      deadline: document.getElementById('designDeadline').value
    };
    if (!body.name) { this.toast('Digite o nome do projeto.', 'error'); return; }
    const r = id ? await API.put('/api/design-projects/'+id, body) : await API.post('/api/design-projects', body);
    if (!r || r.error) { this.toast(r?.error || 'Erro ao salvar', 'error'); return; }
    this.closeModal('designModal');
    this.renderDesign();
    this.toast(id ? 'Projeto atualizado!' : 'Projeto criado!');
  },

  async deleteDesign(id) {
    try {
      if (!await this.confirmAsync('Excluir este projeto criativo?')) return;
      const r = await API.del('/api/design-projects/'+id);
      if (!r || r.error) { this.toast(r?.error || 'Erro ao excluir projeto', 'error'); return; }
      this._currentDesignId = null;
      this.renderDesign();
      this.toast('Projeto excluído.');
    } catch(e) {
      this.toast('Erro ao excluir projeto', 'error');
    }
  },

  _currentDesignId: null,
  _timelineZoom: 100,
  _panOffset: {x:0, y:0},

  async openDesignBoard(pid) {
    this._currentDesignId = pid;
    const project = await API.get('/api/design-projects/'+pid);
    if (!project) return;
    document.getElementById('designProjectTitle').textContent = project.name + (project.client_name ? ' - '+project.client_name : '');
    document.getElementById('designListView').style.display = 'none';
    document.getElementById('designProjectView').style.display = 'block';

    document.getElementById('design-timeline').style.display = 'none';
    document.getElementById('design-board').style.display = 'block';
    document.querySelector('#design-board').closest('.page').querySelector('.tab[data-tab="design-board"]').classList.add('active');
    document.querySelector('#design-board').closest('.page').querySelector('.tab[data-tab="design-timeline"]').classList.remove('active');

    await this.renderDesignBoard(pid);
    this.initTimelineCanvas();
  },

  backToDesignList() {
    this._currentDesignId = null;
    document.getElementById('designProjectView').style.display = 'none';
    document.getElementById('designListView').style.display = 'block';
  },

  async renderDesignBoard(pid) {
    const cards = await API.get('/api/design-projects/'+pid+'/cards') || [];
    const stages = [
      {key:'briefing', label:'Briefing', color:'#6C5CE7'},
      {key:'criacao', label:'Criação', color:'#00B0FF'},
      {key:'revisao', label:'Revisão', color:'#FFD600'},
      {key:'aprovacao', label:'Aprovação', color:'#FF9800'},
      {key:'finalizado', label:'Finalizado', color:'#00C853'}
    ];
    const board = document.getElementById('designBoard');
    const maxCards = Math.max(...stages.map(s => cards.filter(c => c.stage === s.key).length), 1);
    board.innerHTML = stages.map(s => {
      const stageCards = cards.filter(c => c.stage === s.key);
      return `
        <div class="kanban-col" data-stage="${s.key}" ondragover="event.preventDefault();this.classList.add('drag-over')" ondragleave="this.classList.remove('drag-over')" ondrop="App.designCardDrop(event,'${s.key}')" style="min-height:${Math.min(maxCards,5) * 100 + 60}px">
          <h4 style="color:${s.color}"><i class="fas fa-circle"></i> ${s.label} <span class="count">${stageCards.length}</span></h4>
          ${stageCards.length ? stageCards.map(c => `
            <div class="kanban-card" data-card-id="${c.id}" draggable="true" ondragstart="App.designCardDrag(event,${c.id})" style="${c.color_tag ? 'border-left:4px solid '+c.color_tag : ''}">
              <div class="card-title">${this.esc(c.title)}</div>
              <div class="card-sub">${c.assigned_to ? this.esc(c.assigned_to) : ''}${c.deadline ? ' · '+c.deadline : ''}</div>
              ${c.description ? '<div class="card-sub" style="margin-top:4px;font-size:11px;opacity:0.7">'+this.esc(c.description.substring(0,60))+'</div>' : ''}
              <div class="card-footer" style="margin-top:6px;padding-top:6px">
                <button class="btn btn-xs btn-danger design-delete-card-btn" data-card-id="${c.id}" style="padding:2px 6px;font-size:10px"><i class="fas fa-trash"></i></button>
              </div>
            </div>
          `).join('') : '<div class="kanban-empty">Nenhum card</div>'}
        </div>
      `;
    }).join('');
    if (!board._delegateInit) {
      board._delegateInit = true;
      board.addEventListener('click', e => {
        const btn = e.target.closest('.design-delete-card-btn');
        if (btn) {
          e.stopPropagation();
          this.deleteDesignCard(parseInt(btn.dataset.cardId));
          return;
        }
        const card = e.target.closest('.kanban-card');
        if (card) {
          this.openCardModal(parseInt(card.dataset.cardId));
        }
      });
    }
  },

  designCardDrag(ev, id) { ev.dataTransfer.setData('text/plain', 'card_'+id); },

  async designCardDrop(ev, stage) {
    ev.preventDefault();
    ev.target.classList.remove('drag-over');
    const data = ev.dataTransfer.getData('text/plain');
    if (!data.startsWith('card_')) return;
    const id = parseInt(data.replace('card_',''));
    if (!id) return;
    const pid = this._currentDesignId;
    const cards = await API.get('/api/design-projects/'+pid+'/cards') || [];
    const stageCards = cards.filter(c => c.stage === stage);
    const items = [{ id, stage, order: stageCards.length }];
    await API.put('/api/design-cards/reorder', { items });
    this.renderDesignBoard(pid);
    this.toast('Card movido!');
  },

  async openCardModal(data) {
    if (data && typeof data === 'object') {
      document.getElementById('cardId').value = data.id || '';
      document.getElementById('cardModalTitle').textContent = 'Editar Card';
      document.getElementById('cardTitle').value = data.title || '';
      document.getElementById('cardDesc').value = data.description || '';
      document.getElementById('cardStage').value = data.stage || 'briefing';
      document.getElementById('cardColor').value = data.color_tag || '';
      document.getElementById('cardAssigned').value = data.assigned_to || '';
      document.getElementById('cardDeadline').value = data.deadline || '';
    } else {
      const cid = data;
      if (cid) {
        const pid = this._currentDesignId;
        const cards = await API.get('/api/design-projects/'+pid+'/cards') || [];
        const card = cards.find(c => c.id === cid);
        if (card) {
          document.getElementById('cardId').value = card.id;
          document.getElementById('cardModalTitle').textContent = 'Editar Card';
          document.getElementById('cardTitle').value = card.title || '';
          document.getElementById('cardDesc').value = card.description || '';
          document.getElementById('cardStage').value = card.stage || 'briefing';
          document.getElementById('cardColor').value = card.color_tag || '';
          document.getElementById('cardAssigned').value = card.assigned_to || '';
          document.getElementById('cardDeadline').value = card.deadline || '';
        }
      } else {
        document.getElementById('cardId').value = '';
        document.getElementById('cardModalTitle').textContent = 'Novo Card';
        document.getElementById('cardTitle').value = '';
        document.getElementById('cardDesc').value = '';
        document.getElementById('cardStage').value = 'briefing';
        document.getElementById('cardColor').value = '';
        document.getElementById('cardAssigned').value = '';
        document.getElementById('cardDeadline').value = '';
      }
    }
    this.openModal('cardModal');
  },

  async saveCard() {
    const pid = this._currentDesignId;
    if (!pid) return;
    const id = document.getElementById('cardId').value;
    const body = {
      title: document.getElementById('cardTitle').value.trim(),
      description: document.getElementById('cardDesc').value.trim(),
      stage: document.getElementById('cardStage').value,
      color_tag: document.getElementById('cardColor').value,
      assigned_to: document.getElementById('cardAssigned').value.trim(),
      deadline: document.getElementById('cardDeadline').value
    };
    if (!body.title) { this.toast('Digite o título do card.', 'error'); return; }
    if (id) {
      await API.put('/api/design-cards/'+id, body);
    } else {
      body.stage = 'briefing';
      await API.post('/api/design-projects/'+pid+'/cards', body);
    }
    this.closeModal('cardModal');
    this.renderDesignBoard(pid);
    this.toast(id ? 'Card atualizado!' : 'Card criado!');
  },

  async deleteDesignCard(id) {
    try {
      if (!await this.confirmAsync('Excluir este card?')) return;
      const r = await API.del('/api/design-cards/'+id);
      if (!r || r.error) { this.toast(r?.error || 'Erro ao excluir card', 'error'); return; }
      this.renderDesignBoard(this._currentDesignId);
      this.toast('Card excluído.');
    } catch(e) {
      this.toast('Erro ao excluir card', 'error');
    }
  },

  // ====== TIMELINE (Linha do Tempo) ======

  initTimelineCanvas() {
    const wrapper = document.getElementById('timelineCanvasWrapper');
    if (!wrapper) return;

    this._drag = null;

    const isLocked = (el) => el && (el.hasAttribute('data-locked') || el.classList.contains('locked'));

    const savePosition = async (el) => {
      const sid = parseInt(el.dataset.stageId);
      await API.put(`/api/design-stages/${sid}/position`, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    };

    const moveItem = async (el, fromStageId, toStageEl) => {
      const container = toStageEl.querySelector('div:last-child');
      if (!container) return;
      const addBtn = container.querySelector('.btn');
      container.insertBefore(el, addBtn);
      const cnt = toStageEl.querySelectorAll('.kanban-card').length;
      await API.put('/api/design-timeline-items/reorder', { items: [{ id: parseInt(el.dataset.itemId), stage_id: parseInt(toStageEl.dataset.stageId), order: cnt - 1 }] });
      this.toast('Item movido!');
    };

    const getStageAt = (cx, cy) => {
      for (const s of wrapper.querySelectorAll('.timeline-stage')) {
        const r = s.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return s;
      }
      return null;
    };

    const isOnBtn = (t) => t.closest('button') || t.closest('select') || t.closest('input') || t.closest('textarea');

    wrapper.onmousedown = (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      if (isOnBtn(t)) return;

      // Handle resize handle
      const resizeHandle = t.closest('.resize-handle');
      if (resizeHandle) {
        const resizeType = resizeHandle.dataset.resize;
        const entityId = parseInt(resizeHandle.dataset.entityId);
        const parent = resizeHandle.parentElement;
        this._drag = {
          type: 'resize',
          resizeType,
          entityId,
          el: parent,
          startWidth: parseFloat(parent.style.width) || (resizeType === 'stage' ? 260 : 230),
          startX: e.clientX,
          zoom: this._timelineZoom / 100
        };
        return;
      }

      const stage = t.closest('.timeline-stage');
      const card = t.closest('.kanban-card');

      // handle link mode
      if (this._linkMode && stage) {
        const targetId = parseInt(stage.dataset.stageId);
        if (targetId !== this._linkMode && !isLocked(stage)) {
          this.createStageLink(this._linkMode, targetId);
        }
        this._linkMode = null;
        document.querySelectorAll('.timeline-stage').forEach(s => s.classList.remove('link-target'));
        const info = document.getElementById('linkModeInfo');
        if (info) info.remove();
        return;
      }

      if (card && stage && !isLocked(stage)) {
        const iid = card.dataset.itemId;
        if (iid) { this._drag = { type:'item', el:card, from: parseInt(stage.dataset.stageId), x:e.clientX, y:e.clientY }; }
        return;
      }

      // Handle floating item drag
      const floatCard = t.closest('.floating-item');
      if (floatCard) {
        const zoom = this._timelineZoom / 100;
        this._drag = {
          type:'floatItem',
          el:floatCard,
          startLeft:parseFloat(floatCard.style.left)||0,
          startTop:parseFloat(floatCard.style.top)||0,
          x:e.clientX,
          y:e.clientY,
          zoom,
          itemId: parseInt(floatCard.dataset.itemId)
        };
        return;
      }
      if (stage && isLocked(stage)) return;
      if (stage) {
        const zoom = this._timelineZoom / 100;
        this._drag = { type:'stage', el:stage, startLeft:parseFloat(stage.style.left)||0, startTop:parseFloat(stage.style.top)||0, x:e.clientX, y:e.clientY, zoom };
        wrapper.style.cursor = 'grabbing';
        return;
      }
      this._drag = { type:'pan', x:e.clientX, y:e.clientY };
      this._panStart = { x: e.clientX - this._panOffset.x, y: e.clientY - this._panOffset.y };
      wrapper.style.cursor = 'grabbing';
    };

    document.onmousemove = (e) => {
      if (!this._drag) return;
      if (this._drag.type === 'resize') {
        const d = this._drag;
        const dw = (e.clientX - d.startX) / d.zoom;
        const newW = Math.max(120, d.startWidth + dw);
        d.el.style.width = newW + 'px';
        if (d.resizeType === 'floatItem') this._updateDragCable(d.entityId);
      } else if (this._drag.type === 'pan') {
        this._panOffset.x = e.clientX - this._panStart.x;
        this._panOffset.y = e.clientY - this._panStart.y;
        this.applyTimelineTransform();
      } else if (this._drag.type === 'stage') {
        const d = this._drag;
        const dx = (e.clientX - d.x) / d.zoom;
        const dy = (e.clientY - d.y) / d.zoom;
        d.el.style.left = (d.startLeft + dx) + 'px';
        d.el.style.top = (d.startTop + dy) + 'px';
        d.el.classList.add('dragging');
      } else if (this._drag.type === 'floatItem') {
        const d = this._drag;
        const dx = (e.clientX - d.x) / d.zoom;
        const dy = (e.clientY - d.y) / d.zoom;
        d.el.style.left = (d.startLeft + dx) + 'px';
        d.el.style.top = (d.startTop + dy) + 'px';
        this._updateDragCable(d.itemId);
      } else {
        this._drag.el.classList.toggle('dragging', Math.hypot(e.clientX - this._drag.x, e.clientY - this._drag.y) > 5);
      }
    };

    document.onmouseup = async (e) => {
      if (!this._drag) return;
      const d = this._drag;
      this._drag = null;
      wrapper.style.cursor = 'grab';
      if (d.type === 'stage' || d.type === 'item') d.el.classList.remove('dragging');

      if (d.type === 'resize') {
        const w = parseFloat(d.el.style.width) || d.startWidth;
        if (d.resizeType === 'stage') {
          await API.put('/api/design-stages/'+d.entityId, { width: Math.round(w) });
          this.renderStageLinks();
        } else {
          await API.put('/api/design-timeline-items/'+d.entityId, { width: Math.round(w) });
        }
        return;
      }

      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) {
        if (d.type === 'floatItem') this.openTimelineItemModal(d.itemId);
        return;
      }

      if (d.type === 'stage') {
        await savePosition(d.el);
        this.renderStageLinks();
      } else if (d.type === 'item') {
        const target = getStageAt(e.clientX, e.clientY);
        if (target && !isLocked(target) && parseInt(target.dataset.stageId) !== d.from) await moveItem(d.el, d.from, target);
      } else if (d.type === 'floatItem') {
        // Check if dropped on a stage
        const target = getStageAt(e.clientX, e.clientY);
        if (target && !isLocked(target)) {
          // Re-attach floating item to this stage
          await API.post(`/api/design-timeline-items/${d.itemId}/float`, { floating: false });
          const cnt = target.querySelectorAll('.kanban-card:not(.floating-item)').length;
          await API.put('/api/design-timeline-items/reorder', { items: [{ id: d.itemId, stage_id: parseInt(target.dataset.stageId), order: cnt }] });
        } else {
          // Save new floating position
          await API.put(`/api/design-timeline-items/${d.itemId}`, {
            floating: 1,
            float_x: parseFloat(d.el.style.left) || 0,
            float_y: parseFloat(d.el.style.top) || 0
          });
        }
        this.renderTimeline();
      }
    };

    wrapper.onwheel = (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -5 : 5;
      this.setTimelineZoom(Math.max(25, Math.min(200, this._timelineZoom + delta)));
    };
  },

  setTimelineZoom(val) {
    this._timelineZoom = parseInt(val);
    document.getElementById('timelineZoom').value = this._timelineZoom;
    document.getElementById('timelineZoomPct').textContent = this._timelineZoom;
    this.applyTimelineTransform();
  },

  applyTimelineTransform() {
    const canvas = document.getElementById('timelineCanvas');
    if (!canvas) return;
    const scale = this._timelineZoom / 100;
    canvas.style.transform = `translate(${this._panOffset.x}px, ${this._panOffset.y}px) scale(${scale})`;
  },

  toggleLinkMode(stageId) {
    if (this._linkMode === stageId) {
      this._linkMode = null;
      document.querySelectorAll('.timeline-stage').forEach(s => s.classList.remove('link-target'));
      const info = document.getElementById('linkModeInfo');
      if (info) info.remove();
      return;
    }
    this._linkMode = stageId;
    document.querySelectorAll('.timeline-stage').forEach(s => s.classList.toggle('link-target', parseInt(s.dataset.stageId) !== stageId));
    // show info banner
    let info = document.getElementById('linkModeInfo');
    if (!info) {
      info = document.createElement('div');
      info.id = 'linkModeInfo';
      info.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:8px 16px;font-size:13px;z-index:10;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.2)';
      info.innerHTML = '<span>🔗 Clique na etapa de destino</span><button class="btn btn-xs" onclick="App._linkMode=null;document.querySelectorAll(\'.timeline-stage\').forEach(s=>s.classList.remove(\'link-target\'));this.parentElement.remove()">Cancelar</button>';
      document.getElementById('timelineCanvasWrapper').appendChild(info);
    }
  },

  async createStageLink(fromId, toId) {
    const pid = this._currentDesignId;
    const links = await API.get('/api/design-projects/'+pid+'/links') || [];
    const existing = links.find(l => l.from_stage_id == fromId && l.to_stage_id == toId);
    if (existing) {
      await API.del('/api/design-stage-links/'+existing.id);
      this.toast('Link removido!');
    } else {
      const res = await API.post('/api/design-projects/'+pid+'/links', { from_stage_id: fromId, to_stage_id: toId });
      if (res.error) { this.toast(res.error, 'error'); return; }
      this.toast('Link criado!');
    }
    this.renderStageLinks();
  },

  async renderStageLinks() {
    let svg = document.getElementById('timelineLinks');
    if (!svg) {
      const container = document.getElementById('timelineStages');
      if (!container) return;
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'timelineLinks';
      svg.setAttribute('style', 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible');
      container.appendChild(svg);
    }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const pid = this._currentDesignId;
    if (!pid) return;
    const NS = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(NS, 'defs');
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', 'arr'); marker.setAttribute('markerWidth','8'); marker.setAttribute('markerHeight','6');
    marker.setAttribute('refX','8'); marker.setAttribute('refY','3'); marker.setAttribute('orient','auto');
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points','0 0, 8 3, 0 6'); poly.setAttribute('fill','#888');
    marker.appendChild(poly); defs.appendChild(marker); svg.appendChild(defs);

    // Draw stage-to-stage links
    const links = await API.get('/api/design-projects/'+pid+'/links') || [];
    for (const link of links) {
      const fromEl = document.querySelector(`.timeline-stage[data-stage-id="${link.from_stage_id}"]`);
      const toEl = document.querySelector(`.timeline-stage[data-stage-id="${link.to_stage_id}"]`);
      if (!fromEl || !toEl) continue;
      const fx = parseFloat(fromEl.style.left) + fromEl.offsetWidth / 2;
      const fy = parseFloat(fromEl.style.top) + fromEl.offsetHeight / 2;
      const tx = parseFloat(toEl.style.left) + toEl.offsetWidth / 2;
      const ty = parseFloat(toEl.style.top) + toEl.offsetHeight / 2;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1',fx); line.setAttribute('y1',fy);
      line.setAttribute('x2',tx); line.setAttribute('y2',ty);
      line.setAttribute('stroke','#888'); line.setAttribute('stroke-width','2');
      line.setAttribute('marker-end','url(#arr)');
      svg.appendChild(line);
    }

    // Draw floating item wires (bezier curves to parent stage)
    const items = await API.get('/api/design-projects/'+pid+'/timeline-items') || [];
    const floatingItems = items.filter(i => i.floating == 1);
    for (const item of floatingItems) {
      const floatEl = document.querySelector(`.floating-item[data-item-id="${item.id}"]`);
      const stageEl = document.querySelector(`.timeline-stage[data-stage-id="${item.stage_id}"]`);
      if (!floatEl || !stageEl) continue;
      this._drawItemCable(svg, NS, floatEl, stageEl, item.id);
    }
  },

  _cableCoords(floatEl, stageEl) {
    const fl = parseFloat(floatEl.style.left) || 0;
    const ft = parseFloat(floatEl.style.top) || 0;
    const sl = parseFloat(stageEl.style.left) || 0;
    const st = parseFloat(stageEl.style.top) || 0;
    const itemRight = fl + floatEl.offsetWidth;
    const itemLeft = fl;
    const stageRight = sl + stageEl.offsetWidth;
    const stageLeft = sl;
    const itemCenterY = ft + floatEl.offsetHeight * 0.4;
    const stageCenterY = st + stageEl.offsetHeight * 0.5;
    let fx, fy, tx, ty;
    if (itemRight <= stageLeft) {
      fx = itemRight; fy = itemCenterY;
      tx = stageLeft; ty = stageCenterY;
    } else if (itemLeft >= stageRight) {
      fx = itemLeft; fy = itemCenterY;
      tx = stageRight; ty = stageCenterY;
    } else {
      fx = itemRight; fy = itemCenterY;
      tx = stageRight; ty = stageCenterY;
    }
    const cpx = (fx + tx) / 2;
    return { fx, fy, tx, ty, cpx };
  },

  _drawItemCable(svg, NS, floatEl, stageEl, itemId) {
    const { fx, fy, tx, ty, cpx } = this._cableCoords(floatEl, stageEl);
    const color = stageEl?.dataset?.color || '#00B0FF';
    const d = `M ${fx} ${fy} Q ${cpx} ${fy} ${tx} ${ty}`;
    const glow = document.createElementNS(NS, 'path');
    glow.setAttribute('data-cable-for', itemId); glow.setAttribute('class', 'cable-glow');
    glow.setAttribute('d', d);
    glow.setAttribute('stroke', color); glow.setAttribute('stroke-width', '6');
    glow.setAttribute('fill', 'none'); glow.setAttribute('opacity', '0.15');
    svg.appendChild(glow);
    const body = document.createElementNS(NS, 'path');
    body.setAttribute('data-cable-for', itemId); body.setAttribute('class', 'cable-body');
    body.setAttribute('d', d);
    body.setAttribute('stroke', '#555'); body.setAttribute('stroke-width', '3');
    body.setAttribute('fill', 'none');
    svg.appendChild(body);
    const core = document.createElementNS(NS, 'path');
    core.setAttribute('data-cable-for', itemId); core.setAttribute('class', 'cable-core');
    core.setAttribute('d', d);
    core.setAttribute('stroke', color); core.setAttribute('stroke-width', '1.5');
    core.setAttribute('fill', 'none');
    svg.appendChild(core);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('data-cable-for', itemId); dot.setAttribute('class', 'cable-dot-start');
    dot.setAttribute('cx', fx); dot.setAttribute('cy', fy);
    dot.setAttribute('r', '5'); dot.setAttribute('fill', color);
    dot.setAttribute('stroke', '#fff'); dot.setAttribute('stroke-width', '1.5');
    dot.setAttribute('opacity', '0.9');
    svg.appendChild(dot);
    const sdot = document.createElementNS(NS, 'circle');
    sdot.setAttribute('data-cable-for', itemId); sdot.setAttribute('class', 'cable-dot-end');
    sdot.setAttribute('cx', tx); sdot.setAttribute('cy', ty);
    sdot.setAttribute('r', '4'); sdot.setAttribute('fill', color);
    sdot.setAttribute('opacity', '0.6');
    svg.appendChild(sdot);
  },

  _updateDragCable(itemId) {
    const svg = document.getElementById('timelineLinks');
    const floatEl = document.querySelector(`.floating-item[data-item-id="${itemId}"]`);
    const stageEl = document.querySelector(`.timeline-stage[data-stage-id="${floatEl?.dataset.stageId}"]`);
    if (!svg || !floatEl || !stageEl) return;
    const color = stageEl.dataset.color || '#00B0FF';
    const { fx, fy, tx, ty, cpx } = this._cableCoords(floatEl, stageEl);
    const d = `M ${fx} ${fy} Q ${cpx} ${fy} ${tx} ${ty}`;
    svg.querySelectorAll(`[data-cable-for="${itemId}"]`).forEach(el => {
      if (el.tagName === 'path') el.setAttribute('d', d);
      else if (el.classList.contains('cable-dot-start')) { el.setAttribute('cx', fx); el.setAttribute('cy', fy); el.setAttribute('fill', color); }
      else if (el.classList.contains('cable-dot-end')) { el.setAttribute('cx', tx); el.setAttribute('cy', ty); el.setAttribute('fill', color); }
      else if (el.classList.contains('cable-glow') || el.classList.contains('cable-core')) el.setAttribute('stroke', color);
    });
  },

  async renderTimeline() {
    const pid = this._currentDesignId;
    if (!pid) return;
    const stages = await API.get('/api/design-projects/'+pid+'/stages') || [];
    const items = await API.get('/api/design-projects/'+pid+'/timeline-items') || [];

    const container = document.getElementById('timelineStages');
    if (!stages.length) {
      container.innerHTML = `
        <div style="width:100%;text-align:center;padding:60px 20px;color:var(--text-muted)">
          <i class="fas fa-layer-group" style="font-size:48px;margin-bottom:16px;opacity:0.3"></i>
          <h3 style="color:var(--text);margin-bottom:8px">Nenhuma etapa criada</h3>
          <p style="font-size:13px;margin-bottom:20px">Crie etapas para documentar o desenvolvimento do material grafico.<br>Ex: Identidade Visual, Materiais Digitais, Impressos...</p>
          <button class="btn btn-primary" onclick="App.addTimelineStage()"><i class="fas fa-plus"></i> Criar Primeira Etapa</button>
        </div>
      `;
      return;
    }

    const statusLabels = { pendente:'Pendente', em_andamento:'Em Andamento', concluido:'Concluído' };
    const statusColors = { pendente:'#FFD600', em_andamento:'#00B0FF', concluido:'#00C853' };
    const floatingItems = items.filter(i => i.floating == 1);
    const dockedItems = items.filter(i => i.floating != 1);

    // Build floating items HTML first
    let floatHtml = '';
    for (const item of floatingItems) {
      const parentStage = stages.find(s => s.id == item.stage_id);
      const stageColor = parentStage ? parentStage.color : '#6C5CE7';
      floatHtml += `
        <div class="kanban-card floating-item${item.status === 'em_andamento' ? ' status-em_andamento' : item.status === 'concluido' ? ' status-concluido' : ' status-pendente'}" data-item-id="${item.id}" data-stage-id="${item.stage_id}"
             style="position:absolute;left:${item.float_x||0}px;top:${item.float_y||0}px;width:${item.width||230}px;cursor:pointer;
                     z-index:5;background:var(--bg-card);border:1px solid ${stageColor};border-left:4px solid ${stageColor};
                     border-radius:var(--radius);padding:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);
                     ${item.color_tag ? 'border-left-color:'+item.color_tag : ''}">
          <div class="resize-handle" data-resize="floatItem" data-entity-id="${item.id}" style="position:absolute;right:0;top:0;width:8px;height:100%;cursor:col-resize;z-index:20"></div>
                ${item.status === 'em_andamento' ? '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;color:#00B0FF;border-bottom:1px solid rgba(0,176,255,0.15);margin-bottom:6px"><span style="animation:spin 1.2s linear infinite;display:inline-block;font-size:14px">⚙️</span><span>Em andamento<span class="dots-anim">...</span></span></div>' : item.status === 'concluido' ? '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;color:#00C853;border-bottom:1px solid rgba(0,200,83,0.15);margin-bottom:6px"><span style="animation:bounce 0.8s ease-in-out infinite;display:inline-block;font-size:14px">🚀</span><span>Concluído</span></div>' : '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;color:#FFD600;border-bottom:1px solid rgba(255,214,0,0.15);margin-bottom:6px"><span style="font-size:14px">⏳</span><span>Pendente</span></div>'}
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="card-title" style="font-size:13px;font-weight:600">${this.esc(item.title)}</div>
            <button class="btn btn-xs" style="background:rgba(108,92,231,0.15);color:var(--primary);border:none;padding:2px 6px;font-size:10px;border-radius:4px"
                    onclick="event.stopPropagation();App.floatItem(${item.id},false)" title="Reencaixar na etapa">
              <i class="fas fa-paperclip"></i>
            </button>
          </div>
          ${item.description ? '<div class="card-sub" style="font-size:11px;opacity:0.7;margin-top:4px">'+this.esc(item.description.substring(0,50))+'</div>' : ''}
          <div class="card-footer" style="margin-top:6px;padding-top:6px;font-size:11px;display:flex;justify-content:space-between;align-items:center">
            <span style="color:${statusColors[item.status]||'#888'}">● ${statusLabels[item.status]||item.status}</span>
            <span style="font-size:10px;color:var(--text-muted)"><i class="fas fa-link"></i> ${this.esc(parentStage ? parentStage.title : 'etapa')}</span>
          </div>
        </div>
      `;
    }

    container.innerHTML = stages.map((s, si) => {
      const stageItems = dockedItems.filter(i => i.stage_id === s.id);
      const isLocked = s.locked == 1;
      return `
        <div class="timeline-stage${isLocked ? ' locked' : ''}" data-stage-id="${s.id}" data-color="${s.color}"${isLocked ? ' data-locked="1"' : ''} style="left:${s.x||0}px;top:${s.y||0}px;width:${s.width||260}px;background:var(--bg-card);border-radius:var(--radius);border:1px solid var(--border);overflow:hidden;${isLocked ? 'opacity:0.85' : ''}">
          <div class="resize-handle" data-resize="stage" data-entity-id="${s.id}" style="position:absolute;right:0;top:0;width:8px;height:100%;cursor:col-resize;z-index:20"></div>
          <div style="background:${s.color};padding:14px 16px;color:#fff;display:flex;align-items:center;justify-content:space-between">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
              <strong style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(s.title)}</strong>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0">
              <button class="lock-btn btn btn-xs" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:2px 8px" onclick="event.stopPropagation();App.toggleStageLock(${s.id},${isLocked ? 0 : 1})" title="${isLocked ? 'Bloqueado' : 'Desbloqueado'}">
                <i class="fas ${isLocked ? 'fa-lock' : 'fa-unlock'}" style="font-size:11px"></i>
              </button>
              <button class="btn btn-xs" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:2px 8px" onclick="event.stopPropagation();App.editStage(${s.id})"><i class="fas fa-edit" style="font-size:11px"></i></button>
              <button class="btn btn-xs link-btn" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:2px 8px" onclick="event.stopPropagation();App.toggleLinkMode(${s.id})" title="Linkar etapa"><i class="fas fa-link" style="font-size:11px"></i></button>
              <button class="btn btn-xs" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:2px 8px" onclick="event.stopPropagation();App.deleteStage(${s.id})"><i class="fas fa-trash" style="font-size:11px"></i></button>
            </div>
          </div>
          ${s.description ? '<div style="padding:8px 16px;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border)">'+this.esc(s.description)+'</div>' : ''}
          <div style="padding:12px">
            ${stageItems.map((item, ii) => `
              <div class="kanban-card${item.status === 'em_andamento' ? ' status-em_andamento' : item.status === 'concluido' ? ' status-concluido' : ' status-pendente'}" data-item-id="${item.id}" onclick="App.openTimelineItemModal(${item.id})" style="margin-bottom:8px;cursor:pointer;border-left:4px solid ${s.color};${item.color_tag ? 'border-left-color:'+item.color_tag : ''}">
          ${item.status === 'em_andamento' ? '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;color:#00B0FF;border-bottom:1px solid rgba(0,176,255,0.15);margin-bottom:6px"><span style="animation:spin 1.2s linear infinite;display:inline-block;font-size:14px">⚙️</span><span>Em andamento<span class="dots-anim">...</span></span></div>' : item.status === 'concluido' ? '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;color:#00C853;border-bottom:1px solid rgba(0,200,83,0.15);margin-bottom:6px"><span style="animation:bounce 0.8s ease-in-out infinite;display:inline-block;font-size:14px">🚀</span><span>Concluído</span></div>' : '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;color:#FFD600;border-bottom:1px solid rgba(255,214,0,0.15);margin-bottom:6px"><span style="font-size:14px">⏳</span><span>Pendente</span></div>'}
                <div style="display:flex;align-items:center;justify-content:space-between;gap:4px">
                  <div class="card-title" style="font-size:13px;flex:1">${this.esc(item.title)}</div>
                  <button class="btn btn-xs" style="background:rgba(255,214,0,0.15);color:#FFD600;border:none;padding:2px 5px;font-size:9px;border-radius:3px;flex-shrink:0"
                          onclick="event.stopPropagation();App.floatItem(${item.id},true)" title="Desencaixar">
                    <i class="fas fa-bolt"></i>
                  </button>
                </div>
                ${item.description ? '<div class="card-sub" style="font-size:11px;opacity:0.7;margin-top:4px">'+this.esc(item.description.substring(0,50))+'</div>' : ''}
                <div class="card-footer" style="margin-top:6px;padding-top:6px;font-size:11px">
                  <span style="color:${statusColors[item.status]||'#888'}">● ${statusLabels[item.status]||item.status}</span>
                  ${item.assigned_to ? '<span style="margin-left:8px">👤 '+this.esc(item.assigned_to)+'</span>' : ''}
                </div>
              </div>
            `).join('') || '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11px">Nenhum item</div>'}
            <button class="btn btn-xs btn-outline" style="width:100%;margin-top:4px" onclick="App.openTimelineItemModal(null,${s.id})"><i class="fas fa-plus"></i> Add</button>
          </div>
        </div>
      `;
    }).join('') + floatHtml;

    // create SVG overlay for floating-item cables
    let svg = container.querySelector('#timelineLinks');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'timelineLinks';
      svg.setAttribute('style', 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible');
      container.appendChild(svg);
    }

    requestAnimationFrame(() => this.renderStageLinks());
  },

  async floatItem(itemId, floating) {
    const items = await API.get('/api/design-projects/'+this._currentDesignId+'/timeline-items') || [];
    const item = items.find(i => i.id == itemId);
    if (!item) return;
    if (floating) {
      const stage = document.querySelector(`.timeline-stage[data-stage-id="${item.stage_id}"]`);
      const sx = stage ? parseFloat(stage.style.left) + 280 : (item.float_x || 300);
      const sy = stage ? parseFloat(stage.style.top) + 40 : (item.float_y || 100);
      await API.post(`/api/design-timeline-items/${itemId}/float`, { floating: true, float_x: sx, float_y: sy });
    } else {
      await API.post(`/api/design-timeline-items/${itemId}/float`, { floating: false });
    }
    this.renderTimeline();
    this.toast(floating ? 'Item desencaixado!' : 'Item reencaixado na etapa!');
  },

  async addTimelineStage(data) {
    document.getElementById('stageId').value = data ? data.id : '';
    document.getElementById('stageModalTitle').textContent = data ? 'Editar Etapa' : 'Nova Etapa';
    document.getElementById('stageTitle').value = data ? data.title : '';
    document.getElementById('stageDesc').value = data ? data.description||'' : '';
    document.getElementById('stageColor').value = data ? (data.color||'#6C5CE7') : '#6C5CE7';
    this.openModal('stageModal');
    if (data) {
      this._loadItemImages('stage', data.id, 'stageImages');
    } else {
      const c = document.getElementById('stageImages');
      if (c) c.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Salve a etapa primeiro para adicionar imagens.</span>';
    }
  },

  editStage(id) {
    API.get('/api/design-projects/'+this._currentDesignId+'/stages').then(stages => {
      const s = stages.find(st => st.id === id);
      if (s) this.addTimelineStage(s);
    });
  },

  async saveStage() {
    const pid = this._currentDesignId;
    if (!pid) return;
    const id = document.getElementById('stageId').value;
    const body = {
      title: document.getElementById('stageTitle').value.trim(),
      description: document.getElementById('stageDesc').value.trim(),
      color: document.getElementById('stageColor').value
    };
    if (!body.title) { this.toast('Digite o nome da etapa.', 'error'); return; }
    if (id) {
      const stages = await API.get('/api/design-projects/'+pid+'/stages') || [];
      const cur = stages.find(s => s.id == id);
      if (cur) { body.locked = cur.locked ? 1 : 0; body.order_idx = cur.order_idx; body.x = cur.x || 0; body.y = cur.y || 0; body.width = cur.width || 260; }
      await API.put('/api/design-stages/'+id, body);
    } else {
      await API.post('/api/design-projects/'+pid+'/stages', body);
    }
    this.closeModal('stageModal');
    this.renderTimeline();
    this.toast(id ? 'Etapa atualizada!' : 'Etapa criada!');
  },

  async deleteStage(id) {
    if (!await this.confirmAsync('Excluir esta etapa e todos os itens?')) return;
    await API.del('/api/design-stages/'+id);
    this.renderTimeline();
    this.toast('Etapa excluida.');
  },

  async toggleStageLock(id, locked) {
    await API.post('/api/design-stages/'+id+'/lock', { locked });
    const stage = document.querySelector(`.timeline-stage[data-stage-id="${id}"]`);
    if (stage) {
      if (locked) {
        stage.setAttribute('data-locked','1');
        stage.classList.add('locked');
        stage.style.opacity = '0.85';
      } else {
        stage.removeAttribute('data-locked');
        stage.classList.remove('locked');
        stage.style.opacity = '';
      }
      const lockBtn = stage.querySelector('.lock-btn');
      if (lockBtn) {
        lockBtn.setAttribute('onclick', `event.stopPropagation();App.toggleStageLock(${id},${locked ? 0 : 1})`);
        lockBtn.title = locked ? 'Bloqueado' : 'Desbloqueado';
        const i = lockBtn.querySelector('i');
        if (i) i.className = 'fas ' + (locked ? 'fa-lock' : 'fa-unlock');
      }
    }
    this.toast(locked ? 'Etapa bloqueada!' : 'Etapa desbloqueada!');
  },

  // ====== NOTES ======

  _noteDirty: false,
  _currentNoteId: null,

  async loadNotes() {
    const notes = await API.get('/api/notes') || [];
    const list = document.getElementById('notesList');
    if (!list) return;
    list.innerHTML = notes.map(n => `
      <div class="note-item${n.id === this._currentNoteId ? ' active' : ''}" data-id="${n.id}"
           style="padding:10px 12px;border-radius:6px;cursor:pointer;margin-bottom:6px;background:${n.id === this._currentNoteId ? '#e8d5a0' : n.color||'#FFF8DC'};color:#3a3a1a;border:1px solid #d4c080;box-shadow:0 1px 3px rgba(0,0,0,0.08);font-family:'Segoe Print','Comic Sans MS',cursive"
           onclick="App.selectNote(${n.id})">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(n.title)}</div>
        <div style="font-size:10px;opacity:0.6;margin-top:2px">${n.updated_at ? new Date(n.updated_at+'T00:00:00').toLocaleDateString('pt-BR') : ''}</div>
      </div>
    `).join('');
    if (notes.length && !this._currentNoteId) this.selectNote(notes[0].id);
    document.getElementById('noteStatus').textContent = '';
    this._noteDirty = false;
  },

  async selectNote(id) {
    if (this._noteDirty && this._currentNoteId) await this.saveNote();
    this._currentNoteId = id;
    const row = await API.get('/api/notes/'+id);
    if (!row) return;
    const editor = document.getElementById('noteEditor');
    if (editor) {
      editor.innerHTML = row.content || '';
      editor.style.background = row.color || '#FFF8DC';
    }
    document.getElementById('noteStatus').textContent = '';
    this._noteDirty = false;
    document.querySelectorAll('.note-item').forEach(el => {
      const active = parseInt(el.dataset.id) === id;
      el.style.background = active ? '#e8d5a0' : (row.color||'#FFF8DC');
    });
  },

  async newNote() {
    if (this._noteDirty && this._currentNoteId) await this.saveNote();
    const res = await API.post('/api/notes', {});
    if (res && res.id) {
      this._currentNoteId = res.id;
      const editor = document.getElementById('noteEditor');
      if (editor) { editor.innerHTML = ''; editor.style.background = '#FFF8DC'; }
      this._noteDirty = false;
      document.getElementById('noteStatus').textContent = 'Nova nota';
      this.loadNotes();
    }
  },

  async saveNote() {
    if (!this._currentNoteId) return;
    const editor = document.getElementById('noteEditor');
    if (!editor) return;
    const content = editor.innerHTML;
    const title = content.replace(/<[^>]+>/g,'').trim().substring(0, 50) || 'Sem título';
    await API.put('/api/notes/'+this._currentNoteId, { title, content });
    this._noteDirty = false;
    document.getElementById('noteStatus').textContent = 'Salvo!';
    this.loadNotes();
  },

  async exportNotePdf() {
    if (!this._currentNoteId) return;
    if (this._noteDirty) await this.saveNote();
    const url = API.baseUrl + '/api/notes/'+this._currentNoteId+'/pdf';
    const token = API.token;
    const resp = await fetch(url, { headers: { 'Authorization': 'Bearer '+token } });
    if (!resp.ok) { this.toast('Erro ao exportar PDF', 'error'); return; }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nota_'+this._currentNoteId+'.pdf';
    a.click();
    URL.revokeObjectURL(a.href);
  },

  async _loadItemImages(entityType, entityId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!entityId) {
      container.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Salve o item primeiro para adicionar imagens.</span>';
      return;
    }
    const files = await API.get(`/api/files?entity_type=${entityType}&entity_id=${entityId}`) || [];
    for (const f of files) {
      const ext = f.filename?.split('.').pop()?.toLowerCase();
      if (!['png','jpg','jpeg','gif','webp'].includes(ext)) continue;
      const div = document.createElement('div');
      div.style.cssText = 'position:relative;display:inline-block;margin:4px;border-radius:6px;overflow:hidden;border:1px solid var(--border)';
      div.innerHTML = `
        <img src="/api/uploads/${f.filename}" style="width:100px;height:75px;object-fit:cover;display:block">
        <button class="btn btn-xs" style="position:absolute;top:2px;right:2px;background:rgba(255,0,0,0.8);color:#fff;border:none;border-radius:50%;width:20px;height:20px;padding:0;font-size:10px;line-height:20px;text-align:center;cursor:pointer"
                onclick="App._deleteImage(${f.id},'${entityType}',${entityId},'${containerId}')">&times;</button>
      `;
      container.appendChild(div);
    }
  },

  async _handleImageUpload(entityType, entityId, input) {
    const file = input.files?.[0];
    if (!file) return;
    if (!entityId) { this.toast('Salve o item primeiro.', 'error'); input.value = ''; return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('entity_type', entityType);
    fd.append('entity_id', entityId);
    await API.upload('/api/upload', fd);
    input.value = '';
    this.toast('Imagem adicionada!');
    const containerId = entityType === 'stage' ? 'stageImages' : 'timelineItemImages';
    this._loadItemImages(entityType, entityId, containerId);
  },

  async _deleteImage(fid, entityType, entityId, containerId) {
    await API.del('/api/files/'+fid);
    this._loadItemImages(entityType, entityId, containerId);
  },

  async openTimelineItemModal(id, stageId) {
    document.getElementById('timelineItemId').value = id || '';
    if (id) {
      const pid = this._currentDesignId;
      const items = await API.get('/api/design-projects/'+pid+'/timeline-items') || [];
      const item = items.find(i => i.id === id);
      if (item) {
        document.getElementById('timelineItemStageId').value = item.stage_id;
        document.getElementById('timelineItemModalTitle').textContent = 'Editar Item';
        document.getElementById('timelineItemTitle').value = item.title || '';
        document.getElementById('timelineItemDesc').value = item.description || '';
        document.getElementById('timelineItemStatus').value = item.status || 'pendente';
        this._updateStatusIndicator();
        document.getElementById('timelineItemColor').value = item.color_tag || '';
        document.getElementById('timelineItemAssigned').value = item.assigned_to || '';
        document.getElementById('timelineItemUrl').value = item.url || '';
      }
    } else {
      document.getElementById('timelineItemStageId').value = stageId || '';
      document.getElementById('timelineItemModalTitle').textContent = 'Novo Item';
      document.getElementById('timelineItemTitle').value = '';
      document.getElementById('timelineItemDesc').value = '';
      document.getElementById('timelineItemStatus').value = 'pendente';
      this._updateStatusIndicator();
      document.getElementById('timelineItemColor').value = '';
      document.getElementById('timelineItemAssigned').value = '';
      document.getElementById('timelineItemUrl').value = '';
    }
    this.openModal('timelineItemModal');
    if (id) {
      this._loadItemImages('timeline_item', id, 'timelineItemImages');
    } else {
      const c = document.getElementById('timelineItemImages');
      if (c) c.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Salve o item primeiro para adicionar imagens.</span>';
    }
  },

  _updateStatusIndicator() {
    const el = document.getElementById('statusIndicator');
    if (!el) return;
    const status = document.getElementById('timelineItemStatus')?.value;
    if (status === 'em_andamento') {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:12px"><span style="animation:spin 1.2s linear infinite;display:inline-block;font-size:30px">⏳</span><span style="animation:spin 2s linear infinite;display:inline-block;font-size:24px">⚙️</span><span style="animation:bounce 0.8s ease-in-out infinite;display:inline-block;font-size:28px">🚀</span></div><div style="font-size:11px;color:#00B0FF;margin-top:4px">Em andamento...</div>';
    } else if (status === 'concluido') {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:10px"><span style="font-size:32px">✅</span><span style="animation:confetti 0.6s ease-in-out infinite alternate;display:inline-block;font-size:28px">🎉</span><span style="font-size:32px">🏆</span></div><div style="font-size:11px;color:#00C853;margin-top:4px">Concluído!</div>';
    } else {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:10px"><span style="animation:bounce 1.2s ease-in-out infinite;display:inline-block;font-size:28px">⏳</span><span style="font-size:28px">📋</span><span style="font-size:28px">⏰</span></div><div style="font-size:11px;color:#FFD600;margin-top:4px;font-weight:600">Pendente</div>';
    }
  },

  async saveTimelineItem() {
    const pid = this._currentDesignId;
    if (!pid) return;
    const id = document.getElementById('timelineItemId').value;
    const body = {
      title: document.getElementById('timelineItemTitle').value.trim(),
      description: document.getElementById('timelineItemDesc').value.trim(),
      status: document.getElementById('timelineItemStatus').value,
      color_tag: document.getElementById('timelineItemColor').value,
      assigned_to: document.getElementById('timelineItemAssigned').value.trim(),
      url: document.getElementById('timelineItemUrl').value.trim(),
      stage_id: parseInt(document.getElementById('timelineItemStageId').value) || null
    };
    if (!body.title) { this.toast('Digite o título do item.', 'error'); return; }
    if (id) {
      const items = await API.get('/api/design-projects/'+pid+'/timeline-items') || [];
      const cur = items.find(i => i.id == id);
      if (cur) body.width = cur.width || 230;
      await API.put('/api/design-timeline-items/'+id, body);
    } else {
      await API.post('/api/design-projects/'+pid+'/timeline-items', body);
    }
    this.closeModal('timelineItemModal');
    this.renderTimeline();
    this.toast(id ? 'Item atualizado!' : 'Item criado!');
  },

  async deleteTimelineItem(id) {
    if (!await this.confirmAsync('Excluir este item?')) return;
    await API.del('/api/design-timeline-items/'+id);
    this.renderTimeline();
    this.toast('Item excluído.');
  },

  // ====== CHAMADO FESTEFE ======

  _currentFestefeTicketId: null,

  async renderFestefe() {
    const q = document.getElementById('festefeSearch').value;
    const status = document.getElementById('festefeStatusFilter').value;
    let url = '/api/festefe/tickets';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status && status !== 'todos') params.set('status', status);
    const qs = params.toString();
    if (qs) url += '?' + qs;
    const tickets = await API.get(url) || [];
    const tbody = document.getElementById('festefeTable');
    if (!tickets.length) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><i class="fas fa-ticket-alt"></i><h3>Nenhum chamado encontrado</h3></div></td></tr>';
      return;
    }
    const statusColors = { aberto:'#00B0FF', em_andamento:'#FFD600', resolvido:'#00C853', fechado:'#8888AA' };
    const priorityLabels = { baixa:'Baixa', media:'Media', alta:'Alta', urgente:'Urgente' };
    const priorityColors = { baixa:'#00C853', media:'#FFD600', alta:'#FF9800', urgente:'#FF1744' };
    tbody.innerHTML = tickets.map(t => `
      <tr style="cursor:pointer" onclick="App.openFestefeTicket(${t.id})">
        <td>#${t.id}</td>
        <td><strong>${this.esc(t.title)}</strong></td>
        <td>${this.esc(t.client_name||'-')}</td>
        <td><span style="color:${priorityColors[t.priority]||'#888'};font-weight:600">${priorityLabels[t.priority]||t.priority}</span></td>
        <td>${t.category||'-'}</td>
        <td><span class="status ${t.status === 'fechado' ? 'inactive' : t.status === 'resolvido' ? 'completed' : t.status === 'em_andamento' ? 'pending' : 'active_s'}">${t.status.replace('_',' ')}</span></td>
        <td>${this.esc(t.assigned_name||'-')}</td>
        <td style="white-space:nowrap">${t.created_at||'-'}</td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="event.stopPropagation();App.editFestefe(${t.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-xs btn-danger" onclick="event.stopPropagation();App.deleteFestefe(${t.id})"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `).join('');
  },

  async openFestefeModal(data) {
    document.getElementById('festefeId').value = data ? data.id : '';
    document.getElementById('festefeModalTitle').textContent = data ? 'Editar Chamado' : 'Novo Chamado';
    document.getElementById('festefeTitle').value = data ? data.title : '';
    document.getElementById('festefeDesc').value = data ? data.description||'' : '';
    document.getElementById('festefePriority').value = data ? data.priority : 'media';
    document.getElementById('festefeCategory').value = data ? data.category : '';
    document.getElementById('festefeClient').value = data ? data.client_name||'' : '';
    const sel = document.getElementById('festefeAssigned');
    sel.innerHTML = '<option value="">Nao definido</option>';
    const users = await API.get('/api/team') || [];
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      if (data && data.assigned_to == u.id) opt.selected = true;
      sel.appendChild(opt);
    });
    this.openModal('festefeModal');
  },

  editFestefe(id) {
    API.get('/api/festefe/tickets/'+id).then(d => { if (d) this.openFestefeModal(d); });
  },

  async saveFestefe() {
    const id = document.getElementById('festefeId').value;
    const body = {
      title: document.getElementById('festefeTitle').value.trim(),
      description: document.getElementById('festefeDesc').value.trim(),
      priority: document.getElementById('festefePriority').value,
      category: document.getElementById('festefeCategory').value,
      client_name: document.getElementById('festefeClient').value.trim(),
      assigned_to: parseInt(document.getElementById('festefeAssigned').value) || null
    };
    if (!body.title) { this.toast('Digite o título do chamado.', 'error'); return; }
    const r = id ? await API.put('/api/festefe/tickets/'+id, body) : await API.post('/api/festefe/tickets', body);
    if (!r || r.error) { this.toast(r?.error || 'Erro ao salvar', 'error'); return; }
    this.closeModal('festefeModal');
    this.renderFestefe();
    this.toast(id ? 'Chamado atualizado!' : 'Chamado criado!');
  },

  async deleteFestefe(id) {
    if (!await this.confirmAsync('Excluir este chamado?')) return;
    await API.del('/api/festefe/tickets/'+id);
    this.renderFestefe();
    this.toast('Chamado excluído.');
  },

  async openFestefeTicket(tid) {
    this._currentFestefeTicketId = tid;
    const ticket = await API.get('/api/festefe/tickets/'+tid);
    if (!ticket) return;
    document.getElementById('festefeDetailTitle').textContent = '# '+tid+' - '+ticket.title;
    document.getElementById('festefeDetailClient').textContent = ticket.client_name||'-';
    document.getElementById('festefeDetailPriority').textContent = ticket.priority||'-';
    document.getElementById('festefeDetailCategory').textContent = ticket.category||'-';
    document.getElementById('festefeDetailAssigned').textContent = ticket.assigned_name||'-';
    document.getElementById('festefeDetailDate').textContent = ticket.created_at||'-';
    document.getElementById('festefeDetailDesc').textContent = ticket.description||'Sem descricao';
    document.getElementById('festefeStatusChange').value = ticket.status;
    document.getElementById('festefe-list').style.display = 'none';
    document.getElementById('festefe-detail').style.display = 'block';
    document.getElementById('festefeDetailTab').style.display = '';
    document.getElementById('festefeDetailTab').classList.add('active');
    document.querySelector('#page-festefe .tabs .tab:first-child').classList.remove('active');
    this.renderFestefeMessages(tid);
  },

  backToFestefeList() {
    this._currentFestefeTicketId = null;
    document.getElementById('festefe-list').style.display = 'block';
    document.getElementById('festefe-detail').style.display = 'none';
    document.getElementById('festefeDetailTab').style.display = 'none';
    document.querySelector('#page-festefe .tabs .tab:first-child').classList.add('active');
  },

  async changeFestefeStatus() {
    const tid = this._currentFestefeTicketId;
    if (!tid) return;
    const status = document.getElementById('festefeStatusChange').value;
    await API.post('/api/festefe/tickets/'+tid+'/status', { status });
    this.toast('Status alterado para: '+status.replace('_',' '));
    this.renderFestefe();
  },

  async renderFestefeMessages(tid) {
    const messages = await API.get('/api/festefe/tickets/'+tid+'/messages') || [];
    const container = document.getElementById('festefeMessages');
    if (!messages.length) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)"><i class="fas fa-comments" style="font-size:32px;margin-bottom:8px;opacity:0.4"></i><p>Nenhuma mensagem ainda.</p></div>';
      return;
    }
    container.innerHTML = messages.map(m => `
      <div class="chat-msg ${m.user_id === API.userId ? 'user' : 'bot'}" style="margin-bottom:12px">
        <div class="avatar">${(m.user_name||'U')[0]}</div>
        <div>
          <div class="bubble">${this.esc(m.message)}</div>
          <div class="time">${m.user_name||'Usuario'} · ${m.created_at||''}</div>
        </div>
      </div>
    `).join('');
  },

  async sendFestefeMessage() {
    const tid = this._currentFestefeTicketId;
    if (!tid) return;
    const msg = document.getElementById('festefeNewMessage').value.trim();
    if (!msg) { this.toast('Digite uma mensagem.', 'error'); return; }
    document.getElementById('festefeNewMessage').value = '';
    await API.post('/api/festefe/tickets/'+tid+'/messages', { message: msg });
    this.renderFestefeMessages(tid);
  },

  // ── Calculator ──
  renderCalculator() {
    this._calc = this._calc || { display: '0', formula: '', history: '', operator: null, operand: null, clearNext: false };
    this._updateCalcDisplay();
    const hist = document.getElementById('calcHistory');
    if (hist) hist.textContent = this._calc.history;
  },

  _opSym(op) {
    return { '+':' + ', '-':' − ', '*':' × ', '/':' ÷ ', '%':' % ' }[op] || ' ' + op + ' ';
  },

  _updateCalcDisplay() {
    const c = this._calc;
    const el = document.getElementById('calcDisplay');
    if (!el) return;
    const text = c.formula || c.display;
    el.textContent = text;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 120);
  },

  calcInput(val) {
    if (!this._calc) this.renderCalculator();
    const c = this._calc;
    if (val === 'C') {
      c.display = '0'; c.formula = ''; c.history = ''; c.operator = null; c.operand = null; c.clearNext = false;
    } else if (val === 'CE') {
      c.display = '0'; c.clearNext = false;
      if (!c.operator) c.formula = '';
      else c.formula = c.operand + this._opSym(c.operator) + c.display;
    } else if (val === '=') {
      if (c.operator && c.operand !== null) {
        const opSym = this._opSym(c.operator).trim();
        const result = this._calcOp(c.operand, parseFloat(c.display), c.operator);
        const expr = `${c.operand} ${opSym} ${c.display}`;
        c.history = `${expr} = ${result}`;
        c.formula = `${expr} = ${result}`; c.display = String(result); c.operator = null; c.operand = null; c.clearNext = true;
      }
    } else if (['+','-','*','/','%'].includes(val)) {
      if (c.operator && c.operand !== null && !c.clearNext) {
        c.display = String(this._calcOp(c.operand, parseFloat(c.display), c.operator));
      }
      c.operator = val;
      c.operand = parseFloat(c.display);
      c.formula = c.display + this._opSym(val);
      c.clearNext = true;
    } else if (val === '.') {
      if (c.clearNext) { c.display = '0.'; c.clearNext = false; c.formula = ''; }
      else if (!c.display.includes('.')) c.display += '.';
      if (c.operator) c.formula = c.operand + this._opSym(c.operator) + c.display;
    } else {
      if (c.clearNext || c.display === '0') { c.display = val; c.clearNext = false; c.formula = ''; }
      else c.display += val;
      if (c.operator) c.formula = c.operand + this._opSym(c.operator) + c.display;
    }
    const hist = document.getElementById('calcHistory');
    if (hist) hist.textContent = c.history;
    this._updateCalcDisplay();
  },

  _calcOp(a, b, op) {
    switch(op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b !== 0 ? a / b : 'Erro';
      case '%': return a * (b / 100);
      default: return b;
    }
  },

  // ── Spotify ──
  renderSpotify() {
    API.get('/api/spotify/config').then(cfg => {
      const notCfg = document.getElementById('spotifyNotConfigured');
      const content = document.getElementById('spotifyContent');
      if (!cfg || cfg.error || !cfg.client_id) {
        if (notCfg) notCfg.style.display = 'block';
        if (content) content.style.display = 'none';
        return;
      }
      if (notCfg) notCfg.style.display = 'none';
      if (content) content.style.display = 'block';
    }).catch(() => {});
    API.get('/api/spotify/me').then(me => {
      const loggedIn = document.getElementById('spotifyLoggedIn');
      const notLoggedIn = document.getElementById('spotifyNotLoggedIn');
      if (me && !me.error) {
        if (loggedIn) loggedIn.style.display = 'block';
        if (notLoggedIn) notLoggedIn.style.display = 'none';
        if (me.display_name) document.getElementById('spotifyUserName').textContent = me.display_name;
        if (me.email) document.getElementById('spotifyUserEmail').textContent = me.email;
        if (me.images && me.images.length) {
          const av = document.getElementById('spotifyUserAvatar');
          if (av) av.innerHTML = '<img src="' + me.images[0].url + '" style="width:40px;height:40px;border-radius:50%;object-fit:cover">';
        }
        this.loadSpotifyPlaylists();
      } else {
        if (loggedIn) loggedIn.style.display = 'none';
        if (notLoggedIn) notLoggedIn.style.display = 'block';
      }
    }).catch(() => {});
  },

  spotifyLogin() {
    API.get('/api/spotify/auth-url').then(r => {
      if (r && r.url) {
        const w = window.open(r.url, 'spotify-auth', 'width=600,height=700');
        const check = setInterval(() => {
          if (w && w.closed) {
            clearInterval(check);
            this.renderSpotify();
          }
        }, 500);
      } else {
        this.toast(r?.error || 'Erro ao conectar Spotify', 'error');
      }
    });
  },

  spotifyLogout() {
    API.put('/api/spotify/config', { client_id: '', client_secret: '', redirect_uri: '' }).then(() => {
      document.getElementById('spotifyLoggedIn').style.display = 'none';
      document.getElementById('spotifyNotLoggedIn').style.display = 'none';
      document.getElementById('spotifyNotConfigured').style.display = 'block';
      this.renderSpotifyPlayer();
      this.toast('Desconectado do Spotify');
    });
  },

  loadSpotifyPlaylists() {
    API.get('/api/spotify/playlists?limit=50').then(r => {
      const grid = document.getElementById('spotifyPlaylistGrid');
      if (!grid) return;
      if (!r || r.error || !r.items) { grid.innerHTML = '<p style="color:var(--text-muted)">Erro ao carregar playlists.</p>'; return; }
      grid.innerHTML = r.items.map(p => `
        <div class="card card-hover" onclick="App.openSpotifyPlaylist('${p.id}','${this.esc(p.name)}')" style="padding:12px;cursor:pointer">
          <div style="width:100%;aspect-ratio:1;border-radius:8px;overflow:hidden;background:var(--bg);margin-bottom:8px">
            <img src="${(p.images && p.images[0]?.url) || 'https://via.placeholder.com/160/1DB954/fff?text=🎵'}" style="width:100%;height:100%;object-fit:cover" onerror="this.src='https://via.placeholder.com/160/333/1DB954?text=🎵'">
          </div>
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this.esc(p.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${p.tracks?.total || 0} musicas</div>
        </div>
      `).join('');
    });
  },

  openSpotifyPlaylist(pid, name) {
    API.get('/api/spotify/playlists/' + pid + '/tracks?limit=50').then(r => {
      const grid = document.getElementById('spotifyPlaylistGrid');
      if (!grid) return;
      if (!r || r.error || !r.items) { this.toast('Erro ao carregar musicas', 'error'); return; }
      const backBtn = '<button class="btn btn-outline btn-sm" onclick="App.loadSpotifyPlaylists()" style="margin-bottom:12px"><i class="fas fa-arrow-left"></i> Voltar</button>';
      grid.innerHTML = backBtn + '<h4 style="grid-column:1/-1">' + this.esc(name) + '</h4>' +
        r.items.map(item => {
          const t = item.track;
          if (!t) return '';
          const duration = t.duration_ms ? Math.floor(t.duration_ms / 60000) + ':' + String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2,'0') : '';
          const artists = (t.artists || []).map(a => a.name).join(', ');
          const preview = t.preview_url ? '<button class="btn btn-sm btn-outline" onclick="App.previewSpotify(\'' + t.preview_url + '\')" title="Preview 30s"><i class="fas fa-play"></i></button>' : '';
          return '<div style="display:flex;align-items:center;gap:12px;padding:8px;border-radius:8px;border:1px solid var(--border);grid-column:1/-1">' +
            '<img src="' + (t.album?.images?.[2]?.url || 'https://via.placeholder.com/40/1DB954/fff?text=🎵') + '" style="width:40px;height:40px;border-radius:4px;object-fit:cover">' +
            '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + this.esc(t.name) + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted)">' + this.esc(artists) + '</div></div>' +
            '<span style="font-size:11px;color:var(--text-muted)">' + duration + '</span>' + preview + '</div>';
        }).join('');
    });
  },

  previewSpotify(url) {
    const audio = document.getElementById('musicAudioElement');
    if (audio) { audio.src = url; audio.volume = 0.3; audio.play().catch(() => {}); }
  },

  // ── Music Player ──
  initMusicPlayer() {
    this._music = {
      source: 'local',
      audio: document.getElementById('musicAudioElement'),
      playlist: [],
      currentIndex: -1,
      ytPlayer: null,
      ytReady: false,
      ytPlayerReady: false,
      ytInterval: null,
      ytVideoMode: false,
      ytMaximized: false,
      ytDragHeight: 160,
      _loadingYT: false,
      _currentYTId: null,
      _currentYTTitle: '',
      _currentYTChannel: '',
      isLocalYT: false,
      isSpotify: false,
    };
    const audio = this._music.audio;
    audio.addEventListener('timeupdate', () => this._updateProgress());
    audio.addEventListener('loadedmetadata', () => { this._updateDuration(); });
    audio.addEventListener('ended', () => this.nextTrack());
    audio.addEventListener('play', () => { document.getElementById('musicPlayIcon').className = 'fas fa-pause'; });
    audio.addEventListener('pause', () => { document.getElementById('musicPlayIcon').className = 'fas fa-play'; });
    document.getElementById('musicVolume').value = localStorage.getItem('promake_vol') || 0.7;
    audio.volume = parseFloat(document.getElementById('musicVolume').value);
    this._initPlayerResize();
  },

  _initPlayerResize() {
    const pl = document.getElementById('musicPlayer');
    const saved = localStorage.getItem('promake_player_size');
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.w) pl.style.width = s.w + 'px';
        if (s.h) pl.style.height = s.h + 'px';
      } catch(e) {}
    }
    let drag = null;
    const onDown = (e) => {
      if (pl.classList.contains('minimized')) return;
      const h = e.target.closest('[data-rsz]');
      if (!h) return;
      e.preventDefault();
      const dir = h.dataset.rsz;
      drag = { dir, startX: e.clientX, startY: e.clientY, w: pl.offsetWidth, h: pl.offsetHeight };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let w = drag.w, h = drag.h;
      if (drag.dir.includes('e') || drag.dir.includes('w')) {
        w = Math.max(260, drag.dir.includes('e') ? drag.w + dx : drag.w - dx);
      }
      if (drag.dir.includes('s') || drag.dir.includes('n')) {
        h = Math.max(200, drag.dir.includes('s') ? drag.h + dy : drag.h - dy);
      }
      pl.style.width = w + 'px';
      pl.style.height = h + 'px';
    };
    const onUp = () => {
      if (!drag) return;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('promake_player_size', JSON.stringify({ w: pl.offsetWidth, h: pl.offsetHeight }));
      drag = null;
    };
    pl.addEventListener('mousedown', onDown);
  },

  toggleMusicPlayer() {
    const el = document.getElementById('musicPlayer');
    el.style.display = '';
    el.classList.toggle('minimized');
    if (!el.classList.contains('minimized')) {
      const navItem = document.querySelector('.nav-item[onclick*="toggleMusicPlayer"]');
      if (navItem) navItem.classList.add('active');
    } else {
      document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('onclick')?.includes('toggleMusicPlayer')) n.classList.remove('active');
      });
    }
  },

  closeMusicPlayer() {
    document.getElementById('musicPlayer').style.display = 'none';
    document.querySelectorAll('.nav-item').forEach(n => {
      if (n.getAttribute('onclick')?.includes('toggleMusicPlayer')) n.classList.remove('active');
    });
  },

  switchMusicSource(source) {
    if (this._music.source === 'youtube' && this._music.ytInterval) {
      clearInterval(this._music.ytInterval);
      this._music.ytInterval = null;
    }
    this._music.source = source;
    document.querySelectorAll('.music-source-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.source === source);
    });
    document.querySelectorAll('.music-source-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('musicSource' + source.charAt(0).toUpperCase() + source.slice(1)).classList.add('active');
    this._updateSourceLabel();

    if (source === 'youtube') {
      this.loadYTPlaylist();
      if (!this._music.ytReady) this._loadYTAPI();
      if (this._music.ytReady && this._music.ytPlayer) {
        this._startYTInterval();
      }
    }
    if (source === 'spotify') {
      document.getElementById('spotifyEmbedContainer').style.display = 'none';
      this.renderSpotifyPlayer();
    }
  },

  _updateSourceLabel() {
    const s = this._music.source;
    const labels = { local: 'Local', youtube: 'YouTube', spotify: 'Spotify' };
    document.getElementById('musicSourceLabel').textContent = labels[s] || '';
  },

  // ── Local Files ──
  loadLocalFiles(files) {
    if (!files.length) return;
    for (const file of files) {
      if (!file.type.startsWith('audio/')) continue;
      const url = URL.createObjectURL(file);
      this._music.playlist.push({ name: file.name, url, source: 'local' });
    }
    if (this._music.currentIndex === -1) {
      this._music.currentIndex = 0;
      this._playIndex(0);
    }
    this._renderLocalPlaylist();
    this.switchMusicSource('local');
  },

  _renderLocalPlaylist() {
    const el = document.getElementById('localPlaylist');
    el.innerHTML = this._music.playlist.map((t, i) =>
      `<div class="music-playlist-item${i === this._music.currentIndex ? ' active' : ''}" onclick="App._playIndex(${i})">
        <i class="fas ${i === this._music.currentIndex ? 'fa-volume-up' : 'fa-music'}"></i>
        <span>${t.name}</span>
      </div>`
    ).join('');
  },

  _playIndex(i) {
    const m = this._music;
    if (i < 0 || i >= m.playlist.length) return;
    m.currentIndex = i;
    const track = m.playlist[i];
    if (m.ytPlayer && m.ytPlayer.stopVideo) m.ytPlayer.stopVideo();
    if (m.source === 'youtube') {
      document.getElementById('musicYtActive').style.display = 'none';
      this.setYTMode('audio');
    }
    m.isLocalYT = false;
    m.isSpotify = false;
    document.getElementById('spotifyEmbedContainer').innerHTML = '';

    if (track.source === 'local') {
      m.audio.src = track.url;
      m.audio.play().catch(() => {});
      this._updateTrackInfo(track.name);
    }
    this._renderLocalPlaylist();
    document.getElementById('musicNowPlaying').textContent = track.name;
  },

  // ── YouTube ──
  _loadYTAPI() {
    if (window.YT && window.YT.Player) { this._onYTReady(); return; }
    if (this._music._loadingYT) return;
    this._music._loadingYT = true;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => { this._music._loadingYT = false; this.toast('Erro ao carregar YouTube API', 'error'); };
    const first = document.getElementsByTagName('script')[0];
    first.parentNode.insertBefore(tag, first);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      this._music._loadingYT = false;
      this._onYTReady();
      if (prev) prev();
    };
    setTimeout(() => {
      if (this._music._loadingYT) { this._music._loadingYT = false; this.toast('YouTube API timeout', 'error'); }
    }, 15000);
  },

  _onYTReady() {
    if (this._music.ytReady) return;
    this._music.ytReady = true;
    try {
      this._music.ytPlayer = new YT.Player('ytPlayerContainer', {
        height: '160', width: '100%',
        playerVars: { autoplay: 0, controls: 1, disablekb: 1, fs: 0, modestbranding: 1, rel: 0 },
        events: {
          onStateChange: (e) => this._onYTStateChange(e),
          onError: (e) => this._onYTError(e),
          onReady: () => { this._music.ytPlayerReady = true; },
        }
      });
    } catch(e) {
      this.toast('Erro ao criar player YouTube', 'error');
    }
  },

  _onYTStateChange(e) {
    const icon = document.getElementById('musicPlayIcon');
    if (e.data === YT.PlayerState.PLAYING) {
      icon.className = 'fas fa-pause';
      this._startYTInterval();
    } else {
      icon.className = 'fas fa-play';
      if (e.data === YT.PlayerState.ENDED) this.nextTrack();
      if (e.data === YT.PlayerState.CUED) {
        this._music.ytPlayer.playVideo();
      }
    }
  },

  _onYTError(e) {
    const msgs = {
      2: 'URL invalida',
      5: 'Erro ao reproduzir',
      100: 'Video nao encontrado',
      101: 'Reproducao nao permitida',
      150: 'Reproducao nao permitida',
    };
    this.toast('YouTube: ' + (msgs[e.data] || 'Erro ' + e.data), 'error');
    document.getElementById('musicPlayIcon').className = 'fas fa-play';
  },

  _startYTInterval() {
    if (this._music.ytInterval) clearInterval(this._music.ytInterval);
    this._music.ytInterval = setInterval(() => this._updateYTProgress(), 500);
  },

  _updateYTProgress() {
    if (!this._music.ytPlayer || !this._music.ytPlayer.getCurrentTime) return;
    try {
      const cur = this._music.ytPlayer.getCurrentTime();
      const dur = this._music.ytPlayer.getDuration();
      if (dur > 0) {
        document.getElementById('musicProgress').value = (cur / dur) * 100;
        this._setTimeDisplay(cur, dur);
      }
    } catch(e) {}
  },

  // ── YouTube Search + Play ──
  async searchYouTube() {
    const input = document.getElementById('ytSearchInput');
    const q = input.value.trim();
    if (!q) return;
    const id = this._parseYTId(q);
    if (id) {
      this._playYT(id, q);
      return;
    }
    document.getElementById('musicYtResults').innerHTML = '<div style="text-align:center;padding:8px;color:var(--text-muted)"><i class="fas fa-spinner fa-spin"></i> Buscando...</div>';
    try {
      const data = await API.post('/api/youtube/search', { query: q });
      if (!data || data.error) {
        document.getElementById('musicYtResults').innerHTML = '<div style="text-align:center;padding:8px;color:var(--danger)">Erro ao buscar</div>';
        return;
      }
      this._renderYTResults(data);
    } catch(e) {
      document.getElementById('musicYtResults').innerHTML = '<div style="text-align:center;padding:8px;color:var(--danger)">Erro de conexão</div>';
    }
  },

  _renderYTResults(results) {
    const el = document.getElementById('musicYtResults');
    if (!results.length) {
      el.innerHTML = '<div style="text-align:center;padding:8px;color:var(--text-muted)">Nenhum resultado</div>';
      return;
    }
    el.innerHTML = results.map(r => `
      <div class="music-yt-result" data-yt-id="${r.id}" data-yt-title="${r.title.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}">
        <img src="${r.thumbnail || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="music-yt-result-info">
          <div class="music-yt-result-title">${r.title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <div class="music-yt-result-channel">${(r.channel||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        </div>
        <div class="music-yt-result-dur">${r.duration || ''}</div>
        <button class="yt-save-btn" data-yt-id="${r.id}" data-yt-title="${r.title.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}" data-yt-channel="${(r.channel||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}" data-yt-dur="${r.duration||''}" data-yt-thumb="${r.thumbnail||''}" onclick="event.stopPropagation();App.saveToYTPlaylist(this)" title="Salvar na playlist"><i class="fas fa-plus"></i></button>
      </div>
    `).join('');
    el.querySelectorAll('.music-yt-result').forEach(div => {
      div.addEventListener('click', () => {
        this._playYT(div.dataset.ytId, div.dataset.ytTitle);
      });
    });
  },

  _playYT(id, title) {
    this._music._currentYTId = id;
    this._music._currentYTTitle = title || '';
    if (!this._music.ytReady) {
      this._loadYTAPI();
      setTimeout(() => this._playYT(id, title), 1000);
      return;
    }
    if (!this._music.ytPlayer || !this._music.ytPlayer.loadVideoById) {
      setTimeout(() => this._playYT(id, title), 500);
      return;
    }
    if (this._music.audio && !this._music.audio.paused) this._music.audio.pause();
    this.setYTMode('audio');

    this.switchMusicSource('youtube');
    document.getElementById('spotifyEmbedContainer').innerHTML = '';
    this._music.isLocalYT = true;
    this._music.isSpotify = false;

    document.getElementById('musicYtResults').innerHTML = '';
    document.getElementById('musicYtActive').style.display = 'block';
    document.getElementById('musicYtTitle').textContent = title || 'YouTube';
    document.getElementById('musicTrackInfo').textContent = title || 'YouTube';
    document.getElementById('musicNowPlaying').textContent = 'YT: ' + (title || id);

    try {
      this._music.ytPlayer.loadVideoById(id);
      this._music.ytPlayer.playVideo();
    } catch(e) {
      this.toast('Erro ao reproduzir YouTube', 'error');
    }
    if (this._ytPlaylistData) {
      this.renderYTPlaylist(this._ytPlaylistData);
    }
  },

  setYTMode(mode) {
    const viewer = document.getElementById('musicYtViewer');
    const expandBtn = document.getElementById('ytExpandBtn');
    document.querySelectorAll('.yt-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode === 'video') {
      if (this._music._currentYTId) {
        const h = this._music.ytMaximized ? Math.max(this._music.ytDragHeight, 280) : this._music.ytDragHeight;
        viewer.innerHTML = `<iframe src="https://www.youtube.com/embed/${this._music._currentYTId}?autoplay=1&controls=1&rel=0" width="100%" height="${h}" frameborder="0" allow="autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>` +
          '<div class="yt-resize-handle" id="ytResizeHandle"></div>';
        if (this._music.ytPlayer && this._music.ytPlayer.pauseVideo) {
          try { this._music.ytPlayer.pauseVideo(); } catch(e) {}
        }
      }
      viewer.style.display = 'block';
      expandBtn.style.display = 'inline-flex';
      if (this._music.ytMaximized) {
        expandBtn.classList.add('yt-maximized');
        expandBtn.title = 'Reduzir vídeo';
        expandBtn.innerHTML = '<i class="fas fa-compress"></i>';
      } else {
        expandBtn.classList.remove('yt-maximized');
        expandBtn.title = 'Maximizar vídeo';
        expandBtn.innerHTML = '<i class="fas fa-expand"></i>';
      }
      this._music.ytVideoMode = true;
      this._initYTResize();
    } else {
      viewer.style.display = 'none';
      viewer.innerHTML = '';
      expandBtn.style.display = 'none';
      expandBtn.classList.remove('yt-maximized');
      if (this._music.ytPlayer && this._music.ytPlayer.playVideo && this._music._currentYTId) {
        try {
          this._music.ytPlayer.playVideo();
        } catch(e) {}
      }
      this._music.ytVideoMode = false;
    }
  },

  toggleYTMaximize() {
    const viewer = document.getElementById('musicYtViewer');
    const expandBtn = document.getElementById('ytExpandBtn');
    this._music.ytMaximized = !this._music.ytMaximized;
    if (this._music.ytMaximized) {
      const maxH = Math.min(window.innerHeight * 0.6, 480);
      this._music.ytDragHeight = Math.max(maxH, 280);
    }
    if (this._music._currentYTId) {
      const h = this._music.ytMaximized ? Math.max(this._music.ytDragHeight, 280) : Math.min(this._music.ytDragHeight, 160);
      viewer.innerHTML = `<iframe src="https://www.youtube.com/embed/${this._music._currentYTId}?autoplay=1&controls=1&rel=0" width="100%" height="${h}" frameborder="0" allow="autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>` +
        '<div class="yt-resize-handle" id="ytResizeHandle"></div>';
    }
    if (this._music.ytMaximized) {
      expandBtn.classList.add('yt-maximized');
      expandBtn.title = 'Reduzir vídeo';
      expandBtn.innerHTML = '<i class="fas fa-compress"></i>';
    } else {
      expandBtn.classList.remove('yt-maximized');
      expandBtn.title = 'Maximizar vídeo';
      expandBtn.innerHTML = '<i class="fas fa-expand"></i>';
    }
    this._initYTResize();
  },

  _initYTResize() {
    const handle = document.getElementById('ytResizeHandle');
    if (!handle) return;
    const startResize = (e) => {
      const clientY = e.clientY || (e.touches && e.touches[0].clientY);
      if (clientY == null) return;
      e.preventDefault();
      const viewer = document.getElementById('musicYtViewer');
      const startY = clientY;
      const startH = viewer.offsetHeight;
      const iframe = viewer.querySelector('iframe');
      const onMove = (ev) => {
        const curY = ev.clientY || (ev.touches && ev.touches[0].clientY);
        if (curY == null) return;
        const diff = curY - startY;
        const newH = Math.max(80, Math.min(window.innerHeight * 0.7, startH + diff));
        viewer.style.height = newH + 'px';
        if (iframe) iframe.style.height = newH + 'px';
        this._music.ytDragHeight = newH;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    };
    handle.onmousedown = startResize;
    handle.ontouchstart = startResize;
  },

  _parseYTId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  },

  // ── YouTube Playlist ──

  async saveCurrentYTToPlaylist() {
    const id = this._music._currentYTId;
    if (!id) { this.toast('Nenhum vídeo tocando', 'error'); return; }
    const title = this._music._currentYTTitle || id;
    const channel = this._music._currentYTChannel || '';
    const thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    const r = await API.post('/api/youtube/playlist', { video_id: id, title, channel, thumbnail: thumb });
    if (r && !r.error) {
      this.toast('Adicionado à playlist!');
      this.loadYTPlaylist();
    } else {
      if (r && r.error === 'Video ja esta na playlist') {
        this.toast('Vídeo já está na playlist', 'warning');
      } else {
        this.toast(r?.error || 'Erro ao salvar', 'error');
      }
    }
  },

  async saveToYTPlaylist(btn) {
    const videoId = btn.dataset.ytId;
    const title = btn.dataset.ytTitle;
    const channel = btn.dataset.ytChannel;
    const duration = btn.dataset.ytDur;
    const thumbnail = btn.dataset.ytThumb;
    const r = await API.post('/api/youtube/playlist', { video_id: videoId, title, channel, duration, thumbnail });
    if (r && !r.error) {
      this.toast('Adicionado a playlist!');
      btn.innerHTML = '<i class="fas fa-check"></i>';
      btn.style.color = 'var(--primary)';
      setTimeout(() => { btn.innerHTML = '<i class="fas fa-plus"></i>'; btn.style.color = ''; }, 2000);
      this.loadYTPlaylist();
    } else {
      if (r && r.error === 'Video ja esta na playlist') {
        this.toast('Video ja esta na playlist', 'warning');
      } else {
        this.toast(r?.error || 'Erro ao salvar', 'error');
      }
    }
  },

  async loadYTPlaylist() {
    const data = await API.get('/api/youtube/playlist');
    if (!data || data.error) return;
    this._ytPlaylistData = data;
    this.renderYTPlaylist(data);
  },

  renderYTPlaylist(data) {
    const el = document.getElementById('musicYtPlaylist');
    const count = document.getElementById('ytPlaylistCount');
    if (!data || !data.length) {
      el.innerHTML = '<div class="music-yt-playlist-empty"><i class="fas fa-list"></i> Playlist vazia<br><span style="font-size:10px">Busque e salve videos acima</span></div>';
      if (count) count.textContent = '0';
      return;
    }
    if (count) count.textContent = data.length;
    const currentId = this._music._currentYTId;
    el.innerHTML = data.map(item => `
      <div class="music-yt-playlist-item${item.video_id === currentId ? ' active' : ''}" data-video-id="${item.video_id}" data-title="${item.title.replace(/"/g,'&quot;')}">
        <img src="${item.thumbnail || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="music-yt-playlist-item-info">
          <div class="music-yt-playlist-item-title">${item.title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <div class="music-yt-playlist-item-channel">${item.channel||''}</div>
        </div>
        <div class="music-yt-playlist-item-actions">
          <button onclick="event.stopPropagation();App.playFromYTPlaylist(this)" title="Tocar"><i class="fas fa-play"></i></button>
          <button class="del-btn" onclick="event.stopPropagation();App.removeFromYTPlaylist(${item.id})" title="Remover"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    `).join('');
  },

  async removeFromYTPlaylist(id) {
    const r = await API.del('/api/youtube/playlist/' + id);
    if (r && !r.error) {
      this.toast('Removido da playlist');
      this.loadYTPlaylist();
    } else {
      this.toast('Erro ao remover', 'error');
    }
  },

  playFromYTPlaylist(btn) {
    const item = btn.closest('.music-yt-playlist-item');
    const videoId = item.dataset.videoId;
    const title = item.dataset.title;
    this._playYT(videoId, title);
  },

  // ── Spotify Player Dashboard ──
  renderSpotifyPlayer() {
    const container = document.getElementById('spotifyPlayerDashboard');
    if (!container) return;
    container.style.display = 'block';
    document.getElementById('spotifyEmbedContainer').style.display = 'none';
    container.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px">Carregando...</div>';
    API.get('/api/spotify/config').then(cfg => {
      if (!cfg || !cfg.client_id) {
        container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px"><i class="fab fa-spotify" style="font-size:32px;color:#1DB954;display:block;margin-bottom:8px"></i>Spotify nao configurado<br><span style="font-size:11px">Va em Configuracoes > Spotify</span></div>';
        return;
      }
      API.get('/api/spotify/me').then(me => {
        if (me && !me.error) {
          const avatar = me.images && me.images.length ? `<img src="${me.images[0].url}" style="width:28px;height:28px;border-radius:50%;object-fit:cover">` : '<i class="fab fa-spotify" style="font-size:18px;color:#1DB954"></i>';
          container.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 8px;background:var(--bg-card);border-radius:6px;font-size:12px">
            ${avatar}<strong>${this.esc(me.display_name||'')}</strong>
            <button class="btn btn-outline btn-sm" onclick="App.spotifyLogout()" style="margin-left:auto;padding:2px 8px;font-size:11px">Sair</button>
          </div>
          <div id="spotifyPlayerPlaylists"><div class="cards-grid" id="spotifyPlayerGrid" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px"></div></div>`;
          this.loadSpotifyPlayerPlaylists();
        } else {
          container.innerHTML = '<div style="text-align:center;padding:16px"><button class="btn btn-success btn-sm" onclick="App.spotifyLogin()" style="font-size:12px"><i class="fab fa-spotify"></i> Entrar com Spotify</button></div>';
        }
      });
    });
  },

  loadSpotifyPlayerPlaylists() {
    API.get('/api/spotify/playlists?limit=20').then(r => {
      const grid = document.getElementById('spotifyPlayerGrid');
      if (!grid) return;
      if (!r || r.error || !r.items) { grid.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Erro ao carregar playlists</div>'; return; }
      grid.innerHTML = r.items.map(p => `
        <div class="card card-hover" onclick="App.openSpotifyPlayerPlaylist('${p.id}','${this.esc(p.name)}')" style="padding:8px;cursor:pointer;text-align:center">
          <div style="width:100%;aspect-ratio:1;border-radius:6px;overflow:hidden;background:var(--bg);margin-bottom:6px">
            <img src="${(p.images && p.images[0]?.url) || 'https://via.placeholder.com/120/1DB954/fff?text=S'}" style="width:100%;height:100%;object-fit:cover" onerror="this.src='https://via.placeholder.com/120/333/1DB954?text=S'">
          </div>
          <div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this.esc(p.name)}</div>
          <div style="font-size:10px;color:var(--text-muted)">${p.tracks?.total || 0} musicas</div>
        </div>
      `).join('');
    });
  },

  openSpotifyPlayerPlaylist(pid, name) {
    API.get('/api/spotify/playlists/' + pid + '/tracks?limit=50').then(r => {
      const grid = document.getElementById('spotifyPlayerGrid');
      if (!grid) return;
      if (!r || r.error || !r.items) { grid.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Erro ao carregar musicas</div>'; return; }
      grid.innerHTML = '<button class="btn btn-outline btn-sm" onclick="App.loadSpotifyPlayerPlaylists()" style="margin-bottom:8px;font-size:11px"><i class="fas fa-arrow-left"></i> Voltar</button>' +
        '<div style="font-weight:600;margin-bottom:6px;font-size:12px">' + this.esc(name) + '</div>' +
        r.items.map((item,i) => {
          const t = item.track;
          if (!t) return '';
          const artists = (t.artists||[]).map(a => a.name).join(', ');
          const preview = t.preview_url ? '<button class="btn btn-outline btn-xs" onclick="App.previewSpotify(\'' + t.preview_url + '\')" style="padding:2px 6px;font-size:10px"><i class="fas fa-play"></i></button>' : '<span style="font-size:10px;color:var(--text-muted)">sem preview</span>';
          return '<div style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;margin-bottom:2px;font-size:11px">' +
            '<span style="color:var(--text-muted);min-width:16px">' + (i+1) + '</span>' +
            '<div style="flex:1;overflow:hidden"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + this.esc(t.name) + '</div><div style="font-size:10px;color:var(--text-muted)">' + this.esc(artists) + '</div></div>' +
            preview +
          '</div>';
        }).join('');
    });
  },

  // ── Spotify (URL embed) ──
  loadSpotify() {
    const input = document.getElementById('spotifyUrlInput');
    const url = input.value.trim();
    if (!url) return;
    const parsed = this._parseSpotifyUrl(url);
    if (!parsed) { this.toast('URL do Spotify invalida', 'error'); return; }
    if (this._music.audio && !this._music.audio.paused) this._music.audio.pause();
    if (this._music.ytPlayer && this._music.ytPlayer.stopVideo) this._music.ytPlayer.stopVideo();
    if (this._music.ytInterval) { clearInterval(this._music.ytInterval); this._music.ytInterval = null; }
    document.getElementById('musicYtActive').style.display = 'none';
    this.setYTMode('audio');

    this.switchMusicSource('spotify');
    this._music.isLocalYT = false;
    this._music.isSpotify = true;

    document.getElementById('spotifyPlayerDashboard').style.display = 'none';
    const container = document.getElementById('spotifyEmbedContainer');
    container.style.display = 'block';
    container.innerHTML = `<iframe src="https://open.spotify.com/embed/${parsed.type}/${parsed.id}" width="100%" height="80" frameborder="0" allow="encrypted-media; clipboard-write"></iframe>`;
    document.getElementById('musicTrackInfo').textContent = 'Spotify: reproduzindo no widget';
    document.getElementById('musicNowPlaying').textContent = 'Spotify';
  },

  _parseSpotifyUrl(url) {
    const m = url.match(/(?:open\.spotify\.com\/|spotify:)(track|album|playlist|episode|artist)[:\/]([a-zA-Z0-9]+)/);
    if (m) return { type: m[1], id: m[2] };
    return null;
  },

  // ── Playback Controls ──
  togglePlay() {
    const m = this._music;
    if (m.source === 'youtube' && m.ytPlayer && m.isLocalYT) {
      const state = m.ytPlayer.getPlayerState();
      if (state === YT.PlayerState.PLAYING) m.ytPlayer.pauseVideo();
      else m.ytPlayer.playVideo();
      return;
    }
    if (m.audio.paused) {
      if (m.audio.src && m.currentIndex >= 0) m.audio.play().catch(() => {});
      else if (m.playlist.length > 0) this._playIndex(0);
    } else {
      m.audio.pause();
    }
  },

  prevTrack() {
    const m = this._music;
    if (m.isSpotify) return;
    if (m.source === 'youtube' && m.ytPlayer && m.isLocalYT) {
      if (m.playlist.length > 0 && m.currentIndex > 0) this._playIndex(m.currentIndex - 1);
      else { m.ytPlayer.seekTo(0); }
      return;
    }
    if (m.currentIndex > 0) this._playIndex(m.currentIndex - 1);
    else if (m.audio.currentTime > 3) m.audio.currentTime = 0;
  },

  nextTrack() {
    const m = this._music;
    if (m.isSpotify) return;
    if (m.source === 'youtube' && m.ytPlayer && m.isLocalYT) {
      if (m.playlist.length > 0 && m.currentIndex < m.playlist.length - 1) {
        this._playIndex(m.currentIndex + 1);
      }
      return;
    }
    if (m.currentIndex < m.playlist.length - 1) this._playIndex(m.currentIndex + 1);
    else if (m.source === 'local') { m.audio.currentTime = 0; m.audio.pause(); }
  },

  seekMusic(val) {
    const m = this._music;
    if (m.source === 'youtube' && m.ytPlayer && m.isLocalYT) {
      const dur = m.ytPlayer.getDuration();
      if (dur > 0) m.ytPlayer.seekTo((val / 100) * dur);
      return;
    }
    if (m.audio.duration) m.audio.currentTime = (val / 100) * m.audio.duration;
  },

  setVolume(val) {
    const m = this._music;
    m.audio.volume = parseFloat(val);
    if (m.ytPlayer && m.ytPlayer.setVolume) m.ytPlayer.setVolume(parseFloat(val) * 100);
    localStorage.setItem('promake_vol', val);
  },

  _updateProgress() {
    const audio = this._music.audio;
    if (audio.duration) {
      document.getElementById('musicProgress').value = (audio.currentTime / audio.duration) * 100;
      this._setTimeDisplay(audio.currentTime, audio.duration);
    }
  },

  _updateDuration() {
    const audio = this._music.audio;
    if (audio.duration) this._setTimeDisplay(audio.currentTime, audio.duration);
  },

  _setTimeDisplay(cur, dur) {
    const fmt = (s) => { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' : '') + sec; };
    document.getElementById('musicTimeCurrent').textContent = fmt(cur);
    document.getElementById('musicTimeTotal').textContent = fmt(dur);
  },

  _updateTrackInfo(name) {
    document.getElementById('musicTrackInfo').textContent = name || 'Nenhuma faixa';
  },

  // ─── MFA Challenge ───────────────────────

  _mfaToken: '',

  showMfaChallenge() {
    const html =
      '<div style="max-width:400px;margin:auto;padding:32px;text-align:center">' +
      '<i class="fas fa-shield-alt" style="font-size:48px;color:var(--primary);margin-bottom:16px"></i>' +
      '<h3>Autenticacao em Duas Etapas</h3>' +
      '<p style="color:var(--text-muted);margin-bottom:20px">Digite o codigo do seu aplicativo autenticador</p>' +
      '<div style="margin-bottom:16px">' +
      '<input id="mfaCodeInput" type="text" maxlength="6" placeholder="000000" style="font-size:28px;letter-spacing:8px;text-align:center;width:200px;padding:12px;border-radius:8px;border:2px solid var(--border);background:var(--surface);color:var(--text)"/>' +
      '</div>' +
      '<button id="mfaVerifyBtn" class="btn btn-primary" style="width:100%;padding:12px">Verificar</button>' +
      '<p id="mfaError" style="color:var(--danger);margin-top:12px;display:none"></p>' +
      '<p style="margin-top:24px;font-size:12px;color:var(--text-muted)">Use seu Google Authenticator ou similar</p>' +
      '</div>';
    this.temporaryModal(html);
    setTimeout(() => document.getElementById('mfaCodeInput')?.focus(), 100);
    document.getElementById('mfaVerifyBtn').addEventListener('click', async () => {
      const code = document.getElementById('mfaCodeInput').value.trim();
      if (!code) return;
      const data = await API.post('/api/auth/mfa/challenge', { mfa_token: this._mfaToken, code });
      if (data && !data.error) {
        document.getElementById('modalOverlay').click();
        API.token = data.access_token;
        API.refreshToken = data.refresh_token;
        this.user = data.user;
        localStorage.setItem('promake_access_token', API.token);
        localStorage.setItem('promake_refresh_token', API.refreshToken);
        await this.loadDashboardHTML();
        this.showApp();
      } else {
        document.getElementById('mfaError').textContent = data?.error || 'Codigo invalido';
        document.getElementById('mfaError').style.display = 'block';
      }
    });
    document.getElementById('mfaCodeInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('mfaVerifyBtn').click();
    });
  },

  // ─── Security Page (MFA Setup) ────────────

  async renderSecurity() {
    const content = document.querySelector('#page-security .app-content');
    if (!content) return;
    const mfaStatus = await API.get('/api/auth/mfa/status');
    const rolesData = await API.get('/api/auth/roles');
    const mfaEnabled = mfaStatus?.mfa_enabled || false;
    const backupCount = mfaStatus?.backup_codes_left || 0;
    let mfaSectionHtml = '';
    if (!mfaEnabled) {
      mfaSectionHtml =
        '<div class="card" style="padding:24px;margin-bottom:16px">' +
        '<h4><i class="fas fa-shield-alt"></i> Autenticacao em Duas Etapas (MFA)</h4>' +
        '<p style="color:var(--text-muted);margin:12px 0">Adicione uma camada extra de seguranca com Google Authenticator</p>' +
        '<button id="mfaSetupBtn" class="btn btn-primary"><i class="fas fa-qrcode"></i> Configurar MFA</button>' +
        '<div id="mfaSetupArea" style="display:none;margin-top:20px;text-align:center"></div>' +
        '</div>';
    } else {
      mfaSectionHtml =
        '<div class="card" style="padding:24px;margin-bottom:16px">' +
        '<h4><i class="fas fa-shield-alt"></i> Autenticacao em Duas Etapas</h4>' +
        '<p style="color:var(--success);margin:8px 0"><i class="fas fa-check-circle"></i> MFA esta ativo</p>' +
        '<p style="color:var(--text-muted);font-size:13px">Codigos de recuperacao restantes: ' + backupCount + '</p>' +
        '<div style="margin-top:12px;display:flex;gap:8px">' +
        '<button id="mfaDisableBtn" class="btn btn-danger"><i class="fas fa-times"></i> Desativar MFA</button>' +
        '<button id="mfaNewCodesBtn" class="btn btn-secondary"><i class="fas fa-redo"></i> Gerar novos codigos</button>' +
        '</div>' +
        '</div>';
    }
    let rolesHtml = '';
    if (rolesData) {
      rolesHtml = '<div class="card" style="padding:24px;margin-bottom:16px">' +
        '<h4><i class="fas fa-user-tag"></i> Minhas Permissoes (RBAC)</h4>' +
        '<p style="color:var(--text-muted);margin:8px 0">Role atual: <strong>' + (rolesData.current_role || 'N/A') + '</strong></p>' +
        '<table style="width:100%;margin-top:12px;border-collapse:collapse"><tr><th style="text-align:left;padding:8px;border-bottom:1px solid var(--border)">Modulo</th><th style="text-align:center;padding:8px;border-bottom:1px solid var(--border)">Permissao</th></tr>';
      const myPerms = rolesData.roles?.find(r => r.id === rolesData.current_role);
      if (myPerms && myPerms.modules) {
        const modList = typeof myPerms.modules === 'object' ? myPerms.modules : {};
        for (const [mod, perm] of Object.entries(modList)) {
          rolesHtml += '<tr><td style="padding:6px 8px;border-bottom:1px solid var(--border)">' + mod + '</td><td style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border)"><span class="badge badge-' + (perm === 'admin' ? 'primary' : 'secondary') + '">' + perm + '</span></td></tr>';
        }
      }
      rolesHtml += '</table></div>';
    }
    content.innerHTML =
      '<div style="max-width:800px;margin:auto">' +
      '<h2><i class="fas fa-shield-alt"></i> Seguranca</h2>' +
      mfaSectionHtml +
      rolesHtml +
      '</div>';
    if (!mfaEnabled) {
      document.getElementById('mfaSetupBtn')?.addEventListener('click', async () => {
        const setup = await API.post('/api/auth/mfa/setup', {});
        if (setup && !setup.error) {
          const area = document.getElementById('mfaSetupArea');
          area.style.display = 'block';
          area.innerHTML =
            '<p style="margin-bottom:12px">Escaneie o QR Code com seu Google Authenticator:</p>' +
            '<img src="data:image/png;base64,' + setup.qrcode + '" style="width:200px;height:200px;border-radius:8px;margin-bottom:16px"/>' +
            '<p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Ou digite a chave manualmente: <code style="background:var(--surface);padding:4px 8px;border-radius:4px;font-size:11px">' + setup.secret + '</code></p>' +
            '<div style="margin-bottom:12px">' +
            '<input id="mfaVerifyCode" type="text" maxlength="6" placeholder="000000" style="font-size:24px;letter-spacing:6px;text-align:center;width:160px;padding:8px;border-radius:8px;border:2px solid var(--border);background:var(--surface);color:var(--text)"/>' +
            '</div>' +
            '<button id="mfaConfirmBtn" class="btn btn-success">Confirmar e Ativar</button>' +
            '<p id="mfaSetupError" style="color:var(--danger);margin-top:8px;display:none"></p>' +
            '<div style="margin-top:16px;padding:12px;background:var(--surface);border-radius:8px">' +
            '<p style="font-size:12px;color:var(--text-muted);margin-bottom:8px"><strong>Codigos de Recuperacao:</strong></p>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">' +
            setup.recovery_codes.map(c => '<code style="background:var(--bg);padding:4px 8px;border-radius:4px;font-size:12px;text-align:center;font-family:monospace">' + c + '</code>').join('') +
            '</div>' +
            '<p style="font-size:11px;color:var(--warning);margin-top:8px"><i class="fas fa-exclamation-triangle"></i> Guarde esses codigos em local seguro. Cada codigo pode ser usado apenas uma vez.</p>' +
            '</div>';
          document.getElementById('mfaConfirmBtn')?.addEventListener('click', async () => {
            const code = document.getElementById('mfaVerifyCode').value.trim();
            if (!code) return;
            const result = await API.post('/api/auth/mfa/verify', { code });
            if (result && !result.error) {
              this.toast('MFA ativado com sucesso!', 'success');
              this.renderSecurity();
            } else {
              document.getElementById('mfaSetupError').textContent = result?.error || 'Codigo invalido';
              document.getElementById('mfaSetupError').style.display = 'block';
            }
          });
        }
      });
    } else {
      document.getElementById('mfaDisableBtn')?.addEventListener('click', async () => {
        if (!confirm('Desativar MFA?')) return;
        const result = await API.post('/api/auth/mfa/disable', {});
        if (result && !result.error) {
          this.toast('MFA desativado', 'info');
          this.renderSecurity();
        }
      });
      document.getElementById('mfaNewCodesBtn')?.addEventListener('click', async () => {
        const result = await API.post('/api/auth/mfa/recovery-codes', {});
        if (result && !result.error) {
          const codesHtml =
            '<div style="text-align:center;padding:16px">' +
            '<h4>Novos Codigos de Recuperacao</h4>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:16px 0">' +
            result.recovery_codes.map(c => '<code style="background:var(--bg);padding:4px 8px;border-radius:4px;font-size:12px">' + c + '</code>').join('') +
            '</div>' +
            '<p style="font-size:12px;color:var(--warning)">Guardar em local seguro</p>' +
            '</div>';
          this.temporaryModal(codesHtml);
        }
      });
    }
  },

  // ─── Super Admin Page ─────────────────────

  async renderSuperAdmin(isRefresh) {
    const content = document.querySelector('#page-super_admin .app-content');
    if (!content) return;

    // Se ja existe o globo e e um refresh, atualiza so os dados
    const existingCanvas = document.getElementById('saGlobeCanvas');
    if (existingCanvas && isRefresh) {
      await this._saRefreshData();
      return;
    }

    content.innerHTML = '<div style="text-align:center;padding:40px"><i class="fas fa-spinner fa-spin" style="font-size:32px"></i><p>Carregando...</p></div>';
    const summary = await API.get('/api/super-admin/security-summary');
    const auditData = await API.get('/api/super-admin/audit-log?per_page=20');
    const eventsData = await API.get('/api/super-admin/security-events');
    const sessionsData = await API.get('/api/super-admin/active-sessions');
    const usersData = await API.get('/api/super-admin/users');
    if (!summary) {
      content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger)"><i class="fas fa-exclamation-triangle" style="font-size:32px"></i><p>Sem acesso ao Super Admin</p></div>';
      return;
    }
    const attackCount = eventsData?.rows?.length || 0;
    const recentAttacks = (eventsData?.rows || []).slice(0, 8);
    let html =
      '<div style="max-width:1400px;margin:auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px">' +
      '<h2><i class="fas fa-user-shield" style="color:var(--primary)"></i> Super Admin - Monitoramento em Tempo Real</h2>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<span id="saStatusDot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--success);animation:pulseGlow 2s infinite"></span>' +
      '<span style="font-size:12px;color:var(--text-muted)">Sistema operacional</span>' +
      '<button id="saRefreshBtn" class="btn btn-sm btn-outline"><i class="fas fa-sync-alt"></i> Atualizar</button>' +
      '</div></div>' +

      '<!-- Cards animados -->' +
      '<div class="sa-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0">' +
      '<div class="card sa-card" style="padding:16px;text-align:center;border-left:3px solid var(--primary)"><div class="sa-card-value" style="font-size:28px;font-weight:700;color:var(--primary)">' + (summary.total_users||0) + '</div><div style="font-size:12px;color:var(--text-muted)"><i class="fas fa-users"></i> Usuarios</div></div>' +
      '<div class="card sa-card" style="padding:16px;text-align:center;border-left:3px solid var(--success)"><div class="sa-card-value" style="font-size:28px;font-weight:700;color:var(--success)">' + (summary.active_today||0) + '</div><div style="font-size:12px;color:var(--text-muted)"><i class="fas fa-signal"></i> Ativos Hoje</div></div>' +
      '<div class="card sa-card" style="padding:16px;text-align:center;border-left:3px solid var(--danger)"><div class="sa-card-value" style="font-size:28px;font-weight:700;color:var(--danger)">' + (summary.failed_logins_24h||0) + '</div><div style="font-size:12px;color:var(--text-muted)"><i class="fas fa-exclamation-triangle"></i> Falhas Login (24h)</div></div>' +
      '<div class="card sa-card" style="padding:16px;text-align:center;border-left:3px solid var(--warning)"><div class="sa-card-value" style="font-size:28px;font-weight:700;color:var(--warning)">' + (summary.mfa_enabled||0) + '</div><div style="font-size:12px;color:var(--text-muted)"><i class="fas fa-shield-alt"></i> MFA Ativo</div></div>' +
      '<div class="card sa-card" style="padding:16px;text-align:center;border-left:3px solid var(--info)"><div class="sa-card-value" style="font-size:28px;font-weight:700;color:var(--info)">' + (summary.active_refresh_tokens||0) + '</div><div style="font-size:12px;color:var(--text-muted)"><i class="fas fa-key"></i> Sessoes Ativas</div></div>' +
      '</div>' +

      '<!-- Globo + Stats -->' +
      '<div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px">' +

      '<!-- Globo Mapa Mundi -->' +
      '<div class="card sa-card" style="padding:16px;position:relative;overflow:hidden">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<h4 style="margin:0"><i class="fas fa-globe-americas" style="color:var(--primary)"></i> Mapa de Ameaças</h4>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
      '<span style="font-size:11px;color:var(--text-muted)">' + attackCount + ' eventos</span>' +
      '<button id="saZoomIn" class="btn btn-xs btn-outline" title="Zoom +"><i class="fas fa-plus"></i></button>' +
      '<button id="saZoomOut" class="btn btn-xs btn-outline" title="Zoom -"><i class="fas fa-minus"></i></button>' +
      '</div></div>' +
      '<canvas id="saGlobeCanvas" width="600" height="400" style="width:100%;height:400px;border-radius:8px;background:radial-gradient(ellipse at center, rgba(15,15,26,0.5) 0%, rgba(15,15,26,0.9) 100%)"></canvas>' +
      '<div id="saGlobeLegend" style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--text-muted);justify-content:center">' +
      '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--danger);margin-right:4px"></span> Ataque ativo</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warning);margin-right:4px"></span> Suspeito</span>' +
      '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--success);margin-right:4px"></span> Normal</span>' +
      '</div></div>' +

      '<!-- Block IP + Eventos recentes -->' +
      '<div style="display:flex;flex-direction:column;gap:16px">' +
      '<div class="card sa-card" style="padding:16px">' +
      '<h4 style="margin:0 0 8px"><i class="fas fa-ban" style="color:var(--danger)"></i> Bloquear IP</h4>' +
      '<div style="display:flex;gap:8px">' +
      '<input id="blockIpInput" type="text" placeholder="192.168.1.1" style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px"/>' +
      '<button id="blockIpBtn" class="btn btn-danger"><i class="fas fa-lock"></i> Bloquear</button>' +
      '</div>' +
      '<p id="blockIpStatus" style="font-size:12px;color:var(--text-muted);margin-top:6px"></p>' +
      '</div>' +

      '<!-- Security Events (ataques) -->' +
      '<div class="card sa-card sa-attack-pulse" style="padding:16px;flex:1">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<h4 style="margin:0"><i class="fas fa-exclamation-triangle" style="color:var(--danger)"></i> Ultimos Ataques</h4>' +
      '<span style="font-size:11px;color:var(--text-muted);background:rgba(255,23,68,0.1);padding:2px 8px;border-radius:10px">' + attackCount + ' total</span>' +
      '</div>' +
      '<div id="saEventsList" style="max-height:170px;overflow-y:auto">';
    if (recentAttacks.length) {
      html += recentAttacks.map((e, i) => {
        const ipShort = (e.ip_address||'').split('.').slice(0,2).join('.') + '.x.x';
        return '<div class="sa-attack-row" style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:var(--danger);flex-shrink:0;animation:glowPulse 1.5s infinite"></span>' +
          '<span style="color:var(--danger);font-weight:600;min-width:80px">' + (e.event_type||'') + '</span>' +
          '<span style="color:var(--text-muted)">' + ipShort + '</span>' +
          '<span style="color:var(--text-muted);margin-left:auto;font-size:11px">' + (e.timestamp||'').slice(0,16) + '</span>' +
          '</div>';
      }).join('');
    } else {
      html += '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px"><i class="fas fa-check-circle" style="color:var(--success);font-size:24px;display:block;margin-bottom:8px"></i>Nenhum ataque detectado</div>';
    }
    html += '</div></div></div>' +

      '</div>' +

      '<!-- Linha inferior: Usuarios / Sessoes / Auditoria / Backups -->' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:16px">' +

      '<!-- Active Users -->' +
      '<div class="card sa-card" style="padding:16px">' +
      '<h4 style="margin:0 0 8px"><i class="fas fa-users" style="color:var(--primary)"></i> Usuarios</h4>' +
      '<div id="saUsersBody" style="max-height:200px;overflow-y:auto">' +
      '<table style="width:100%;font-size:12px"><tr><th style="padding:4px 6px">Nome</th><th style="padding:4px 6px">Role</th><th style="padding:4px 6px">MFA</th><th style="padding:4px 6px">Acoes</th></tr>';
    if (usersData?.rows?.length) {
      html += usersData.rows.map(u =>
        '<tr><td style="padding:4px 6px">' + (u.name||'') + '</td><td style="padding:4px 6px"><span class="badge badge-' + (u.role === 'admin' ? 'success' : 'warning') + '" style="font-size:10px">' + (u.role||'') + '</span></td><td style="padding:4px 6px">' + (u.mfa_enabled ? '<span style="color:var(--success)"><i class="fas fa-check-circle"></i></span>' : '<span style="color:var(--text-muted)"><i class="fas fa-times-circle"></i></span>') + '</td><td style="padding:4px 6px;font-size:11px;color:var(--text-muted)">' + (u.action_count||0) + '</td></tr>'
      ).join('');
    }
    html += '</table></div></div>' +

      '<!-- Active Sessions -->' +
      '<div class="card sa-card" style="padding:16px">' +
      '<h4 style="margin:0 0 8px"><i class="fas fa-key" style="color:var(--warning)"></i> Sessoes Ativas</h4>' +
      '<div id="saSessionsBody" style="max-height:200px;overflow-y:auto">';
    if (sessionsData?.rows?.length) {
      html += '<table style="width:100%;font-size:12px"><tr><th style="padding:4px 6px">Usuario</th><th style="padding:4px 6px">Expira</th><th style="padding:4px 6px"></th></tr>';
      html += sessionsData.rows.slice(0,10).map(s =>
        '<tr><td style="padding:4px 6px">' + (s.name||'') + '</td><td style="padding:4px 6px;font-size:11px;color:var(--text-muted)">' + (s.expires_at||'').slice(0,16) + '</td><td style="padding:4px 6px"><button class="btn btn-xs btn-danger revoke-session" data-token="' + s.token + '" title="Revogar"><i class="fas fa-times"></i></button></td></tr>'
      ).join('');
      html += '</table>';
    } else {
      html += '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px">Nenhuma sessao ativa</p>';
    }
    html += '</div></div>' +

      '<!-- Audit Log -->' +
      '<div class="card sa-card" style="padding:16px">' +
      '<h4 style="margin:0 0 8px"><i class="fas fa-history" style="color:var(--info)"></i> Auditoria Recente</h4>' +
      '<div id="saAuditBody" style="max-height:200px;overflow-y:auto">';
    if (auditData?.rows?.length) {
      html += '<table style="width:100%;font-size:12px"><tr><th style="padding:4px 6px">Data</th><th style="padding:4px 6px">Usuario</th><th style="padding:4px 6px">Acao</th></tr>';
      html += auditData.rows.slice(0,8).map(a =>
        '<tr><td style="padding:4px 6px;font-size:11px;white-space:nowrap">' + (a.timestamp||'').slice(0,16) + '</td><td style="padding:4px 6px">' + (a.user_name||'') + '</td><td style="padding:4px 6px"><span style="font-size:11px;color:var(--text-muted)">' + (a.action||'') + '</span></td></tr>'
      ).join('');
      html += '</table>';
    } else {
      html += '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px">Nenhum registro</p>';
    }
    html += '</div></div>' +

      '<!-- Backups -->' +
      '<div class="card sa-card" style="padding:16px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<h4 style="margin:0"><i class="fas fa-database" style="color:var(--success)"></i> Backups</h4>' +
      '<button id="triggerBackupBtn" class="btn btn-primary btn-sm"><i class="fas fa-database"></i> Criar</button>' +
      '</div>' +
      '<div id="saBackupsBody" style="max-height:200px;overflow-y:auto">';
    const backupList = await API.get('/api/admin/backups');
    if (backupList?.rows?.length) {
      html += '<table style="width:100%;font-size:12px"><tr><th style="padding:4px 6px">Arquivo</th><th style="padding:4px 6px">Tamanho</th><th style="padding:4px 6px"></th></tr>';
      html += backupList.rows.slice(0,8).map(b =>
        '<tr><td style="padding:4px 6px;font-size:11px">' + b.filename + '</td><td style="padding:4px 6px;font-size:11px;color:var(--text-muted)">' + (b.size/1024).toFixed(1) + ' KB</td><td style="padding:4px 6px"><a class="btn btn-xs btn-outline" href="/api/admin/backup/' + b.filename + '" target="_blank" title="Download"><i class="fas fa-download"></i></a></td></tr>'
      ).join('');
      html += '</table>';
    } else {
      html += '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px">Nenhum backup</p>';
    }
    html += '</div></div></div>' +
      '</div>';
    content.innerHTML = html;

    // Iniciar globo SOMENTE na primeira vez (persistente)
    if (!this._saGlobeState || !document.getElementById('saGlobeCanvas')) {
      this.startSaGlobe(recentAttacks);
    }

    // Zoom controls
    document.getElementById('saZoomIn')?.addEventListener('click', () => {
      if (this._saGlobeState) {
        this._saGlobeState.zoomTarget = Math.min(this._saGlobeState.zoomTarget + 0.1, 1.5);
      }
    });
    document.getElementById('saZoomOut')?.addEventListener('click', () => {
      if (this._saGlobeState) {
        this._saGlobeState.zoomTarget = Math.max(this._saGlobeState.zoomTarget - 0.1, 0.4);
      }
    });

    // Auto-refresh dados a cada 10s (sem recriar o globo)
    if (this._saTimer) clearInterval(this._saTimer);
    this._saTimer = setInterval(() => this._saRefreshData(), 10000);

    document.getElementById('saRefreshBtn')?.addEventListener('click', () => {
      this._saRefreshData();
    });

    this._saBindEvents();
  },

  // ─── Atualizar dados sem recriar pagina ───

  async _saRefreshData() {
    const [summary, eventsData, sessionsData, usersData, auditData] = await Promise.all([
      API.get('/api/super-admin/security-summary'),
      API.get('/api/super-admin/security-events'),
      API.get('/api/super-admin/active-sessions'),
      API.get('/api/super-admin/users'),
      API.get('/api/super-admin/audit-log?per_page=20'),
    ]);
    if (!summary) return;
    const dot = document.getElementById('saStatusDot');
    if (dot) dot.style.background = 'var(--success)';

    // Atualizar cards
    const vals = document.querySelectorAll('.sa-card-value');
    if (vals[0]) vals[0].textContent = summary.total_users || 0;
    if (vals[1]) vals[1].textContent = summary.active_today || 0;
    if (vals[2]) vals[2].textContent = summary.failed_logins_24h || 0;
    if (vals[3]) vals[3].textContent = summary.mfa_enabled || 0;
    if (vals[4]) vals[4].textContent = summary.active_refresh_tokens || 0;

    // Atualizar lista de ataques
    const eventsList = document.getElementById('saEventsList');
    if (eventsList) {
      const attacks = (eventsData?.rows || []).slice(0, 8);
      if (attacks.length) {
        eventsList.innerHTML = attacks.map((e, i) => {
          const ipShort = (e.ip_address||'').split('.').slice(0,2).join('.') + '.x.x';
          return '<div class="sa-attack-row" style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">' +
            '<span style="width:8px;height:8px;border-radius:50%;background:var(--danger);flex-shrink:0;animation:glowPulse 1.5s infinite"></span>' +
            '<span style="color:var(--danger);font-weight:600;min-width:80px">' + (e.event_type||'') + '</span>' +
            '<span style="color:var(--text-muted)">' + ipShort + '</span>' +
            '<span style="color:var(--text-muted);margin-left:auto;font-size:11px">' + (e.timestamp||'').slice(0,16) + '</span></div>';
        }).join('');
      } else {
        eventsList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px"><i class="fas fa-check-circle" style="color:var(--success);font-size:24px;display:block;margin-bottom:8px"></i>Nenhum ataque detectado</div>';
      }
    }

    // Atualizar contagem de eventos no cabecalho do globo
    const eventCount = document.querySelector('[class*="saGlobeTitle"]') || document.querySelector('h4 i.fa-globe-americas')?.parentElement?.parentElement?.querySelector('span');
    // fallback simples
    const allSpans = document.querySelectorAll('#saGlobeLegend')?.[0]?.previousElementSibling?.querySelectorAll?.('span');
    // Atualiza via busca generica
    document.querySelectorAll('[class*="card"] h4 .fa-globe-americas').forEach(icon => {
      const parent = icon.parentElement?.parentElement;
      if (parent) {
        const span = parent.querySelector('span:last-child');
        if (span) span.textContent = (eventsData?.rows?.length || 0) + ' eventos';
      }
    });
  },

  // ─── Bind eventos que NAO sao recriados ───

  async _saBindEvents() {
    document.getElementById('blockIpBtn')?.addEventListener('click', async () => {
      const ip = document.getElementById('blockIpInput').value.trim();
      if (!ip) return;
      const result = await API.post('/api/super-admin/block-ip', { ip, hours: 24 });
      document.getElementById('blockIpStatus').textContent = result?.message || 'Erro ao bloquear';
    });
    document.querySelectorAll('.revoke-session').forEach(btn => {
      btn.addEventListener('click', async () => {
        const token = btn.dataset.token;
        await API.post('/api/admin/revoke-session', { token });
        this.toast('Sessao revogada', 'info');
      });
    });
    document.getElementById('triggerBackupBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('triggerBackupBtn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Criar...';
      const result = await API.post('/api/admin/backup');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-database"></i> Criar';
      if (result?.backup) {
        this.toast('Backup criado: ' + result.backup.filename, 'success');
      } else {
        this.toast(result?.error || 'Erro ao criar backup', 'error');
      }
    });
  },

  // ─── Globo 3D para Super Admin ────────────

  startSaGlobe(attacks) {
    const canvas = document.getElementById('saGlobeCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = canvas.width = Math.min(600, rect.width - 32);
    const h = canvas.height = 400;
    const cx = w / 2, cy = h / 2;
    const baseR = Math.min(cx, cy) * 0.52;
    this._saGlobeState = { zoomTarget: 1 };

    let t = 0;
    let attackDots = [];
    let particles = [];
    let explosions = [];
    let beams = [];

    attacks.forEach((a, i) => {
      const ip = a.ip_address || '0.0.0.0';
      const hash = ip.split('.').reduce((s, n) => s + parseInt(n || 0), 0);
      const theta = ((hash * 0.1 + i * 0.7) % 1) * Math.PI;
      const phi = ((hash * 0.3 + i * 1.3) % 1) * Math.PI * 2;
      attackDots.push({
        theta, phi,
        lat: theta / Math.PI * 180 - 90,
        lon: phi / Math.PI * 180 - 180,
        type: a.event_type || 'unknown',
        severity: a.event_type === 'SQL Injection' ? 'critical' : a.event_type === 'XSS' ? 'high' : 'medium',
        r: 2 + Math.random() * 2,
        phase: Math.random() * Math.PI * 2,
      });
    });

    if (attackDots.length < 3) {
      const dl = [
        { lat: 40.7, lon: -74, type: 'Scan', severity: 'low' },
        { lat: 51.5, lon: -0.1, type: 'BF', severity: 'medium' },
        { lat: 35.7, lon: 139.7, type: 'XSS', severity: 'high' },
        { lat: -23.5, lon: -46.6, type: 'SQLi', severity: 'critical' },
        { lat: 55.8, lon: 37.6, type: 'Scan', severity: 'low' },
        { lat: 28.6, lon: 77.2, type: 'BF', severity: 'medium' },
        { lat: 31.2, lon: 121.5, type: 'XSS', severity: 'high' },
        { lat: 48.9, lon: 2.3, type: 'Scan', severity: 'low' },
        { lat: -33.9, lon: 151.2, type: 'XSS', severity: 'high' },
        { lat: 1.3, lon: 103.8, type: 'BF', severity: 'medium' },
      ];
      dl.forEach(l => {
        const theta = (90 - l.lat) * Math.PI / 180;
        const phi = l.lon * Math.PI / 180;
        attackDots.push({ theta, phi, lat: l.lat, lon: l.lon, type: l.type, severity: l.severity, r: 2, phase: Math.random() * Math.PI * 2 });
      });
    }

    const sevColors = { critical: '#FF1744', high: '#FF9800', medium: '#FFD600', low: '#00B0FF' };

    function project3d(theta, phi, rotY, rotX, r0) {
      r0 = r0 || baseR;
      const x3 = r0 * Math.sin(theta) * Math.cos(phi);
      const y3 = r0 * Math.cos(theta);
      const z3 = r0 * Math.sin(theta) * Math.sin(phi);
      let x = x3, y = y3, z = z3;
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const x1 = x * cosY - z * sinY;
      const z1 = x * sinY + z * cosY;
      x = x1; z = z1;
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const y1 = y * cosX - z * sinX;
      const z2 = y * sinX + z * cosX;
      y = y1; z = z2;
      const scale = 90 / (90 + z);
      return { sx: cx + x * scale, sy: cy + y * scale, z };
    }

    function addExplosion(sx, sy, color) {
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const speed = 1 + Math.random() * 2;
        particles.push({
          x: sx, y: sy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1, decay: 0.02 + Math.random() * 0.03,
          size: 1.5 + Math.random() * 2,
          color,
        });
      }
      explosions.push({ x: sx, y: sy, r: 3, life: 1, color });
    }

    // Estrelas de fundo
    const stars = [];
    for (let i = 0; i < 60; i++) {
      stars.push({
        x: Math.random() * w, y: Math.random() * h,
        r: 0.3 + Math.random() * 0.7,
        twinkle: Math.random() * Math.PI * 2,
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      t += 0.018;

      const zoom = this._saGlobeState?.zoomTarget || 1;
      const currentR = baseR * zoom;
      const rotY = t * 0.35;
      const rotX = Math.sin(t * 0.12) * 0.15 + 0.05;

      // ── Estrelas ──
      stars.forEach(s => {
        const alpha = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.5 + s.twinkle));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * alpha, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,210,255,${alpha * 0.4})`;
        ctx.fill();
      });

      // ── Globo base ──
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, currentR + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(108,92,231,0.03)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, currentR, 0, Math.PI * 2);
      ctx.clip();

      // Gradiente interno
      const ig = ctx.createRadialGradient(cx - currentR * 0.3, cy - currentR * 0.3, 0, cx, cy, currentR);
      ig.addColorStop(0, 'rgba(20,15,40,0.15)');
      ig.addColorStop(0.5, 'rgba(10,8,25,0.08)');
      ig.addColorStop(1, 'rgba(0,0,10,0.02)');
      ctx.fillStyle = ig;
      ctx.fillRect(cx - currentR, cy - currentR, currentR * 2, currentR * 2);

      // ── Grade geodesica ──
      for (let ring = 0; ring < 4; ring++) {
        const phi = (ring / 4) * Math.PI;
        ctx.beginPath();
        for (let a = 0; a <= 36; a++) {
          const theta = (a / 36) * Math.PI * 2;
          const p = project3d(theta, phi, rotY, rotX, currentR);
          a === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy);
        }
        ctx.strokeStyle = `rgba(108,92,231,${0.04 + 0.04 * Math.sin(t * 0.5 + ring)})`;
        ctx.lineWidth = 0.4;
        ctx.stroke();
      }
      for (let m = 0; m < 10; m++) {
        const theta = (m / 10) * Math.PI * 2;
        ctx.beginPath();
        for (let a = 0; a <= 24; a++) {
          const phi = (a / 24) * Math.PI;
          const p = project3d(theta, phi, rotY, rotX, currentR);
          a === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy);
        }
        ctx.strokeStyle = `rgba(108,92,231,${0.04 + 0.03 * Math.sin(t * 0.3 + theta)})`;
        ctx.lineWidth = 0.4;
        ctx.stroke();
      }

      // ── Projetar dots ──
      const projected = attackDots.map(d => {
        const p = project3d(d.theta, d.phi, rotY, rotX, currentR);
        const sz = d.r * (90 / (90 + p.z));
        return { ...p, r: sz, color: sevColors[d.severity] || '#888', severity: d.severity, d, sz };
      });
      projected.sort((a, b) => a.z - b.z);

      // ── Linhas de conexao entre dots com animacao ──
      for (let i = 0; i < projected.length; i++) {
        for (let j = i + 1; j < projected.length; j++) {
          const dx = projected[i].sx - projected[j].sx;
          const dy = projected[i].sy - projected[j].sy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < currentR * 0.6 && dist > 10) {
            const avgZ = (projected[i].z + projected[j].z) / 2;
            const alpha = 0.06 + 0.12 * (1 - (avgZ + currentR) / (currentR * 2));
            const grad = ctx.createLinearGradient(projected[i].sx, projected[i].sy, projected[j].sx, projected[j].sy);
            grad.addColorStop(0, projected[i].color + Math.round(alpha * 80).toString(16).padStart(2, '0'));
            grad.addColorStop(0.5, `rgba(108,92,231,${alpha * 0.4})`);
            grad.addColorStop(1, projected[j].color + Math.round(alpha * 80).toString(16).padStart(2, '0'));
            ctx.beginPath();
            ctx.moveTo(projected[i].sx, projected[i].sy);
            ctx.lineTo(projected[j].sx, projected[j].sy);
            ctx.strokeStyle = grad;
            ctx.lineWidth = 0.6;
            ctx.stroke();

            // Pontos animados nas conexoes (data flow)
            const flowPos = (t * 0.5 + i + j) % 1;
            const fx = projected[i].sx + (projected[j].sx - projected[i].sx) * flowPos;
            const fy = projected[i].sy + (projected[j].sy - projected[i].sy) * flowPos;
            ctx.beginPath();
            ctx.arc(fx, fy, 1.2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(0,176,255,${0.3 + 0.4 * Math.sin(t * 3 + i + j)})`;
            ctx.fill();
          }
        }
      }

      // ── Explosoes e particulas ──
      explosions = explosions.filter(e => e.life > 0);
      explosions.forEach(e => {
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * (1 + (1 - e.life) * 6), 0, Math.PI * 2);
        ctx.strokeStyle = e.color + Math.round(e.life * 60).toString(16).padStart(2, '0');
        ctx.lineWidth = 1.5;
        ctx.stroke();
        e.life -= 0.04;
        e.r += 0.3;
      });

      particles = particles.filter(p => p.life > 0);
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        p.vx *= 0.98;
        p.vy *= 0.98;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.round(p.life * 200).toString(16).padStart(2, '0');
        ctx.fill();
      });

      // ── Dots no globo ──
      projected.forEach(p => {
        const pulse = 0.7 + 0.3 * Math.sin(t * 2.5 + p.d.phase);
        const alpha = 0.4 + 0.6 * (1 - (p.z + currentR) / (currentR * 2));
        const sz = p.r * pulse;

        // Glow camadas
        const g1 = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, sz * 8);
        g1.addColorStop(0, p.color + '40');
        g1.addColorStop(0.3, p.color + '15');
        g1.addColorStop(1, p.color + '00');
        ctx.fillStyle = g1;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, sz * 8, 0, Math.PI * 2);
        ctx.fill();

        // Anel expansivo (severidade critica)
        if (p.severity === 'critical') {
          const ringLife = (Math.sin(t * 0.8 + p.d.phase) + 1) / 2;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, sz * (2 + ringLife * 6), 0, Math.PI * 2);
          ctx.strokeStyle = p.color + Math.round(ringLife * 40).toString(16).padStart(2, '0');
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Dot principal
        const g2 = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, sz);
        g2.addColorStop(0, '#ffffff');
        g2.addColorStop(0.3, p.color);
        g2.addColorStop(1, p.color);
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, sz, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.restore();

      // ── Anel orbital externo ──
      const ringPulse = 0.5 + 0.5 * Math.sin(t * 1.2);
      ctx.beginPath();
      ctx.arc(cx, cy, currentR + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(108,92,231,${0.06 + 0.08 * ringPulse})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Orbits
      for (let o = 0; o < 2; o++) {
        const angle = t * (o === 0 ? 0.6 : -0.4) + o * Math.PI;
        const ox = cx + Math.cos(angle) * (currentR + 6);
        const oy = cy + Math.sin(angle) * (currentR + 6);
        ctx.beginPath();
        ctx.arc(ox, oy, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(108,92,231,${0.15 + 0.1 * Math.sin(t * 1.5 + o)})`;
        ctx.fill();
      }

      // Gerar explosoes periodicas em dots aleatorios
      if (attackDots.length > 0 && Math.random() < 0.008) {
        const idx = Math.floor(Math.random() * projected.length);
        const p = projected[idx];
        if (p && p.z > -currentR * 0.5) {
          addExplosion(p.sx, p.sy, p.color);
        }
      }

      requestAnimationFrame(draw);
    };
    draw();
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
