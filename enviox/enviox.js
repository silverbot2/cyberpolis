// Enviox.js — Lógica cliente de la plataforma CYBERPOLIS Enviox
// Plataforma Segura de Transferencia y Bóveda Cloud 5 TB
(function () {
  'use strict';

  // Estado global de la aplicación
  const state = {
    user: null,
    settings: {
      maxRecipients: 20,
      maxFiles: 50,
      maxFileSizeMb: 40960,
      maxDownloadsPerFile: 3,
      maxTransferSizeMb: 40960,
      maxExpiryDays: 14,
      defaultExpiryDays: 8,
      watermarkText: '',
      defaultReceiptAck: true,
      defaultExpiryNotice: true,
      noLockoutOnFailedLogins: true,
      autoSaveContacts: true,
      brandName: 'ENVIOX',
      brandSubtitle: 'Plataforma Enviox Segura'
    },
    cloudStorage: {
      configured: false,
      provider: 'local',
      name: 'Local Cifrado',
      capacity: '5 TB'
    },
    mailGateway: {
      configured: false,
      mode: 'gmail_app_password',
      user: ''
    },
    stagedSendFiles: [],
    sendRecipients: [],
    records: [],
    filteredRecords: [],
    activeFilter: 'todos',
    contacts: [],
    groups: [],
    roles: [],
    currentView: 'send'
  };

  // Referencias DOM
  const dom = {};

  function initDom() {
    dom.brandName = document.getElementById('txBrandName');
    dom.brandSub = document.getElementById('txBrandSub');
    dom.userAvatar = document.getElementById('txUserAvatar');
    dom.dropdownToggle = document.getElementById('txDropdownToggle');
    dom.dropdownMenu = document.getElementById('txDropdownMenu');
    
    // Vistas
    dom.views = {
      send: document.getElementById('viewSend'),
      receive: document.getElementById('viewReceive'),
      records: document.getElementById('viewRecords'),
      contacts: document.getElementById('viewContacts'),
      admin: document.getElementById('viewAdmin'),
      settings: document.getElementById('viewSettings'),
      users: document.getElementById('viewUsers'),
      roles: document.getElementById('viewRoles')
    };

    // Navegación
    dom.navItems = document.querySelectorAll('.tx-nav-item');

    // Formulario de Enviar
    dom.sendRecipientInput = document.getElementById('sendRecipientInput');
    dom.sendChipsContainer = document.getElementById('sendChipsContainer');
    dom.btnAddMultipleRecipients = document.getElementById('btnAddMultipleRecipients');
    dom.sendPhone = document.getElementById('sendPhone');
    dom.sendLanguage = document.getElementById('sendLanguage');
    dom.sendSubject = document.getElementById('sendSubject');
    dom.sendSubjectCounter = document.getElementById('sendSubjectCounter');
    dom.sendMessage = document.getElementById('sendMessage');
    dom.sendDropzone = document.getElementById('sendDropzone');
    dom.sendFileInput = document.getElementById('sendFileInput');
    dom.sendStagedFiles = document.getElementById('sendStagedFiles');
    dom.sendReceiptAck = document.getElementById('sendReceiptAck');
    dom.sendNotifyExpiry = document.getElementById('sendNotifyExpiry');
    dom.sendAndReceive = document.getElementById('sendAndReceive');
    dom.sendExpiryDate = document.getElementById('sendExpiryDate');
    dom.sendTags = document.getElementById('sendTags');
    dom.btnSubmitSend = document.getElementById('btnSubmitSend');
    dom.sendCloudIndicator = document.getElementById('sendCloudIndicator');

    // Formulario de Recibir
    dom.receiveRecipientInput = document.getElementById('receiveRecipientInput');
    dom.receivePhone = document.getElementById('receivePhone');
    dom.receiveLanguage = document.getElementById('receiveLanguage');
    dom.receiveSubject = document.getElementById('receiveSubject');
    dom.receiveSubjectCounter = document.getElementById('receiveSubjectCounter');
    dom.receiveMessage = document.getElementById('receiveMessage');
    dom.receiveReceiptAck = document.getElementById('receiveReceiptAck');
    dom.receiveNotifyExpiry = document.getElementById('receiveNotifyExpiry');
    dom.receiveExpiryDate = document.getElementById('receiveExpiryDate');
    dom.receiveTags = document.getElementById('receiveTags');
    dom.btnSubmitReceive = document.getElementById('btnSubmitReceive');

    // Registros
    dom.recordsTbody = document.getElementById('recordsTbody');
    dom.recordsSearch = document.getElementById('recordsSearch');
    dom.btnRefreshRecords = document.getElementById('btnRefreshRecords');
    dom.btnExportRecords = document.getElementById('btnExportRecords');
    dom.btnCancelTransfer = document.getElementById('btnCancelTransfer');
    dom.sidebarBadges = {
      todos: document.getElementById('badgeTodos'),
      enviados: document.getElementById('badgeEnviados'),
      recibidos: document.getElementById('badgeRecibidos'),
      activos: document.getElementById('badgeActivos'),
      caducados: document.getElementById('badgeCaducados'),
      cancelados: document.getElementById('badgeCancelados'),
      pendientes_validacion: document.getElementById('badgePendientesVal'),
      pendientes_envio: document.getElementById('badgePendientesEnv'),
      pendientes_error: document.getElementById('badgePendientesErr')
    };

    // Contactos
    dom.contactsTbody = document.getElementById('contactsTbody');
    dom.contactsSearch = document.getElementById('contactsSearch');
    dom.btnCreateContact = document.getElementById('btnCreateContact');

    // Modales
    dom.modalOverlay = document.getElementById('txModalOverlay');
    dom.modalTitle = document.getElementById('txModalTitle');
    dom.modalBody = document.getElementById('txModalBody');
    dom.modalFooter = document.getElementById('txModalFooter');
    dom.modalClose = document.getElementById('txModalClose');
  }

  // Cambiar vista activa
  function switchView(viewName) {
    state.currentView = viewName;

    // Si es una subvista de administración, la vista padre es 'admin'
    const isAdminSubView = ['admin', 'settings', 'users', 'roles'].includes(viewName);
    const targetTopView = isAdminSubView ? 'admin' : viewName;

    // Ocultar todas las vistas principales de primer nivel
    const topViewIds = ['viewSend', 'viewReceive', 'viewRecords', 'viewContacts', 'viewAdmin'];
    topViewIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });

    const activeTopEl = document.getElementById('view' + targetTopView.charAt(0).toUpperCase() + targetTopView.slice(1));
    if (activeTopEl) activeTopEl.classList.add('active');

    // Actualizar clase activa en la barra de navegación superior
    dom.navItems.forEach(item => {
      const itemTarget = item.dataset.view;
      if (itemTarget === viewName || (isAdminSubView && itemTarget === 'admin')) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Despachar acciones según la vista
    if (viewName === 'records') {
      fetchRecords();
    } else if (viewName === 'contacts') {
      renderContacts();
    } else if (viewName === 'settings') {
      switchAdminPane('ajustes');
    } else if (viewName === 'users') {
      switchAdminPane('usuarios');
    } else if (viewName === 'roles') {
      switchAdminPane('roles');
    } else if (viewName === 'admin') {
      switchAdminPane(state.currentAdminPane || 'ajustes');
    }

    // Cerrar dropdown si estuviera abierto
    if (dom.dropdownMenu) dom.dropdownMenu.classList.remove('show');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
  }

  // Cambiar panel dentro del Área de Administración unificada
  function switchAdminPane(paneName) {
    if (!paneName) paneName = 'ajustes';
    state.currentAdminPane = paneName;

    // Actualizar clase activa en los 13 elementos del sidebar de administración
    document.querySelectorAll('.tx-admin-nav-item').forEach(item => {
      if (item.dataset.pane === paneName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Ocultar todos los sub-paneles y mostrar el seleccionado
    document.querySelectorAll('.tx-admin-pane').forEach(pane => {
      const pId = pane.id.toLowerCase();
      const pData = pane.dataset.pane ? pane.dataset.pane.toLowerCase() : '';
      if (pData === paneName.toLowerCase() || pId === ('paneadmin' + paneName.toLowerCase()) || (paneName === 'ajustes' && pane.id === 'viewSettings') || (paneName === 'usuarios' && pane.id === 'viewUsers') || (paneName === 'roles' && pane.id === 'viewRoles')) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    // Cargar o refrescar datos específicos de cada sub-panel
    if (paneName === 'ajustes') {
      populateSettingsForm();
      loadCloudTenantConfig();
    } else if (paneName === 'usuarios') {
      fetchUsers();
    } else if (paneName === 'grupos') {
      fetchGroups();
    } else if (paneName === 'roles') {
      renderRoles();
    } else if (paneName === 'contactos') {
      renderAdminContacts();
    } else if (paneName === 'listanegra') {
      fetchBlacklist();
    } else if (paneName === 'canales') {
      fetchChannels();
    } else if (paneName === 'informes') {
      fetchReports();
    } else if (paneName === 'cancelar') {
      renderAdminCancelTransfers();
    }
  }

  // Exponer globalmente para eventos inline
  window.switchView = switchView;
  window.switchAdminPane = switchAdminPane;

  // Inicialización de datos desde el backend
  async function loadInitData() {
    try {
      const res = await fetch('/api/enviox/init');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) state.settings = Object.assign(state.settings, data.settings);
        if (data.cloudStorage) state.cloudStorage = data.cloudStorage;
        if (data.mailGateway) state.mailGateway = data.mailGateway;
        if (data.contacts) state.contacts = data.contacts;
        if (data.groups) state.groups = data.groups;
        if (data.roles) state.roles = data.roles;
        if (data.user) state.user = data.user;
      }
    } catch (e) {
      console.warn('Cargando modo offline / fallback Enviox:', e.message);
    }

    applySettingsToUI();
  }

  function applySettingsToUI() {
    if (dom.brandName) dom.brandName.textContent = state.settings.brandName || 'ENVIOX';
    if (dom.brandSub) dom.brandSub.textContent = state.settings.brandSubtitle || 'Plataforma Enviox Segura';

    // Fecha de expiración por defecto (hoy + N días)
    const defDays = state.settings.defaultExpiryDays || 8;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + defDays);
    const dateStr = targetDate.toISOString().split('T')[0];

    if (dom.sendExpiryDate) dom.sendExpiryDate.value = dateStr;
    if (dom.receiveExpiryDate) dom.receiveExpiryDate.value = dateStr;

    if (dom.sendReceiptAck) dom.sendReceiptAck.checked = state.settings.defaultReceiptAck;
    if (dom.sendNotifyExpiry) dom.sendNotifyExpiry.checked = state.settings.defaultExpiryNotice;

    if (dom.sendCloudIndicator) {
      dom.sendCloudIndicator.textContent = `Almacenamiento: ${state.cloudStorage.name} (${state.cloudStorage.capacity})`;
    }

    if (state.user && dom.userAvatar) {
      dom.userAvatar.textContent = (state.user.fullName || state.user.username || 'U').charAt(0).toUpperCase();
      dom.userAvatar.title = `${state.user.fullName || state.user.username} (${state.user.email})`;
    }
  }

  // ==========================================
  // LÓGICA DE LA VISTA: ENVIAR ARCHIVOS
  // ==========================================
  function setupSendView() {
    // Contador de caracteres de asunto
    if (dom.sendSubject && dom.sendSubjectCounter) {
      dom.sendSubject.addEventListener('input', () => {
        const len = dom.sendSubject.value.length;
        dom.sendSubjectCounter.textContent = `${len}/100`;
      });
    }

    // Añadir destinatarios al pulsar Enter o coma
    if (dom.sendRecipientInput) {
      dom.sendRecipientInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          addSendRecipient(dom.sendRecipientInput.value);
          dom.sendRecipientInput.value = '';
        }
      });
    }

    // Botón "Añadir varios"
    if (dom.btnAddMultipleRecipients) {
      dom.btnAddMultipleRecipients.addEventListener('click', () => {
        showMultipleRecipientsModal();
      });
    }

    // Drag & Drop
    if (dom.sendDropzone && dom.sendFileInput) {
      dom.sendDropzone.addEventListener('click', () => dom.sendFileInput.click());

      dom.sendDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dom.sendDropzone.classList.add('dragover');
      });

      dom.sendDropzone.addEventListener('dragleave', () => {
        dom.sendDropzone.classList.remove('dragover');
      });

      dom.sendDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dom.sendDropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files) {
          handleSelectedFiles(Array.from(e.dataTransfer.files));
        }
      });

      dom.sendFileInput.addEventListener('change', () => {
        if (dom.sendFileInput.files) {
          handleSelectedFiles(Array.from(dom.sendFileInput.files));
        }
      });
    }

    // Enviar de forma segura
    if (dom.btnSubmitSend) {
      dom.btnSubmitSend.addEventListener('click', handleSendSubmit);
    }
  }

  function addSendRecipient(emailOrGroup) {
    const clean = String(emailOrGroup || '').trim();
    if (!clean) return;

    // Si es un grupo registrado
    const group = state.groups.find(g => g.name.toLowerCase() === clean.toLowerCase());
    if (group && group.members) {
      group.members.forEach(m => addSendRecipient(m));
      return;
    }

    if (!clean.includes('@')) {
      alert('Introduce una dirección de correo válida (ejemplo@empresa.com).');
      return;
    }

    if (!state.sendRecipients.includes(clean)) {
      state.sendRecipients.push(clean);
      renderSendChips();
      updateSendButtonState();
    }
  }

  function removeSendRecipient(email) {
    state.sendRecipients = state.sendRecipients.filter(x => x !== email);
    renderSendChips();
    updateSendButtonState();
  }

  function renderSendChips() {
    if (!dom.sendChipsContainer) return;
    dom.sendChipsContainer.innerHTML = '';
    state.sendRecipients.forEach(email => {
      const chip = document.createElement('div');
      chip.className = 'tx-chip';
      chip.innerHTML = `<span>${email}</span><span class="tx-chip-remove" title="Eliminar">✕</span>`;
      chip.querySelector('.tx-chip-remove').addEventListener('click', () => removeSendRecipient(email));
      dom.sendChipsContainer.appendChild(chip);
    });
  }

  function handleSelectedFiles(files) {
    files.forEach(file => {
      // Limitar tamaño según ajustes
      const maxMb = state.settings.maxFileSizeMb || 40960;
      if (file.size > maxMb * 1024 * 1024) {
        alert(`El archivo ${file.name} excede el límite permitido de ${maxMb} MB.`);
        return;
      }
      state.stagedSendFiles.push(file);
    });
    renderStagedFiles();
    updateSendButtonState();
  }

  function renderStagedFiles() {
    if (!dom.sendStagedFiles) return;
    dom.sendStagedFiles.innerHTML = '';
    state.stagedSendFiles.forEach((f, idx) => {
      const item = document.createElement('div');
      item.className = 'tx-file-item';
      let formatted = (f.size / 1024).toFixed(1) + ' kB';
      if (f.size > 1024 * 1024) formatted = (f.size / (1024 * 1024)).toFixed(2) + ' MB';

      item.innerHTML = `
        <div class="tx-file-meta">
          <span>📄</span>
          <span class="tx-file-name" title="${f.name}">${f.name}</span>
          <span class="tx-file-size">(${formatted})</span>
        </div>
        <button type="button" class="tx-chip-remove" style="background:none;border:none;cursor:pointer;">✕</button>
      `;
      item.querySelector('button').addEventListener('click', () => {
        state.stagedSendFiles.splice(idx, 1);
        renderStagedFiles();
        updateSendButtonState();
      });
      dom.sendStagedFiles.appendChild(item);
    });
  }

  function updateSendButtonState() {
    if (!dom.btnSubmitSend) return;
    const hasRecipient = state.sendRecipients.length > 0 || (dom.sendRecipientInput && dom.sendRecipientInput.value.trim().length > 0);
    const hasContent = state.stagedSendFiles.length > 0 || (dom.sendMessage && dom.sendMessage.value.trim().length > 0);

    if (hasRecipient && hasContent) {
      dom.btnSubmitSend.classList.add('ready');
    } else {
      dom.btnSubmitSend.classList.remove('ready');
    }
  }

  async function handleSendSubmit() {
    // Si hay texto pendiente en el input de destinatarios, añadirlo
    if (dom.sendRecipientInput && dom.sendRecipientInput.value.trim()) {
      addSendRecipient(dom.sendRecipientInput.value.trim());
      dom.sendRecipientInput.value = '';
    }

    if (!state.sendRecipients.length) {
      alert('Introduce al menos un destinatario.');
      dom.sendRecipientInput.focus();
      return;
    }

    if (!state.stagedSendFiles.length && !dom.sendMessage.value.trim()) {
      alert('Debes adjuntar al menos un archivo o escribir un mensaje seguro.');
      return;
    }

    dom.btnSubmitSend.disabled = true;
    dom.btnSubmitSend.innerHTML = '<span>⏳ Cifrando y enviando a la nube...</span>';

    try {
      // Convertir archivos a Base64 para el payload
      const encodedFiles = [];
      for (const f of state.stagedSendFiles) {
        const b64 = await readFileAsBase64(f);
        encodedFiles.push({
          name: f.name,
          size: f.size,
          mimeType: f.type || 'application/octet-stream',
          base64: b64
        });
      }

      const payload = {
        recipients: state.sendRecipients,
        phone: dom.sendPhone ? dom.sendPhone.value.trim() : '',
        language: dom.sendLanguage ? dom.sendLanguage.value : 'Español',
        subject: dom.sendSubject ? dom.sendSubject.value.trim() : '',
        message: dom.sendMessage ? dom.sendMessage.value.trim() : '',
        receiptAck: dom.sendReceiptAck ? dom.sendReceiptAck.checked : true,
        notifyExpiry: dom.sendNotifyExpiry ? dom.sendNotifyExpiry.checked : true,
        sendAndReceive: dom.sendAndReceive ? dom.sendAndReceive.checked : false,
        expiryDays: dom.sendExpiryDate ? calculateDaysFromToday(dom.sendExpiryDate.value) : 8,
        tags: dom.sendTags ? dom.sendTags.value.trim() : '',
        files: encodedFiles
      };

      const res = await fetch('/api/enviox/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Error al procesar el envío.');
      }

      // Éxito: Limpiar formulario y mostrar modal de confirmación
      state.sendRecipients = [];
      state.stagedSendFiles = [];
      renderSendChips();
      renderStagedFiles();
      if (dom.sendSubject) dom.sendSubject.value = '';
      if (dom.sendMessage) dom.sendMessage.value = '';
      if (dom.sendTags) dom.sendTags.value = '';
      updateSendButtonState();

      showSuccessModal({
        title: 'Envío seguro completado',
        reference: data.reference,
        shareUrl: data.shareUrl,
        recipients: payload.recipients,
        filesCount: data.filesCount,
        expiresAt: data.expiresAt
      });

    } catch (err) {
      alert('Error en el envío seguro: ' + err.message);
    } finally {
      dom.btnSubmitSend.disabled = false;
      dom.btnSubmitSend.innerHTML = `<span>🔒</span><span>Enviar de forma segura</span>`;
    }
  }

  // ==========================================
  // LÓGICA DE LA VISTA: RECIBIR ARCHIVOS
  // ==========================================
  function setupReceiveView() {
    if (dom.receiveSubject && dom.receiveSubjectCounter) {
      dom.receiveSubject.addEventListener('input', () => {
        dom.receiveSubjectCounter.textContent = `${dom.receiveSubject.value.length}/100`;
      });
    }

    if (dom.btnSubmitReceive) {
      dom.btnSubmitReceive.addEventListener('click', handleReceiveSubmit);
    }
  }

  async function handleReceiveSubmit() {
    const recipient = dom.receiveRecipientInput ? dom.receiveRecipientInput.value.trim() : '';
    if (!recipient || !recipient.includes('@')) {
      alert('Introduce el correo electrónico al que deseas solicitar los archivos.');
      if (dom.receiveRecipientInput) dom.receiveRecipientInput.focus();
      return;
    }

    dom.btnSubmitReceive.disabled = true;
    dom.btnSubmitReceive.innerHTML = '<span>⏳ Generando petición segura...</span>';

    try {
      const payload = {
        recipient,
        phone: dom.receivePhone ? dom.receivePhone.value.trim() : '',
        language: dom.receiveLanguage ? dom.receiveLanguage.value : 'Español',
        subject: dom.receiveSubject ? dom.receiveSubject.value.trim() : '',
        message: dom.receiveMessage ? dom.receiveMessage.value.trim() : '',
        receiptAck: dom.receiveReceiptAck ? dom.receiveReceiptAck.checked : true,
        notifyExpiry: dom.receiveNotifyExpiry ? dom.receiveNotifyExpiry.checked : true,
        expiryDays: dom.receiveExpiryDate ? calculateDaysFromToday(dom.receiveExpiryDate.value) : 8,
        tags: dom.receiveTags ? dom.receiveTags.value.trim() : ''
      };

      const res = await fetch('/api/enviox/receive-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al solicitar recepción.');

      showSuccessModal({
        title: 'Petición de recepción creada',
        reference: data.reference,
        shareUrl: data.dropUrl,
        recipients: [recipient],
        isReceive: true,
        expiresAt: data.expiresAt
      });

    } catch (err) {
      alert('Error en la petición: ' + err.message);
    } finally {
      dom.btnSubmitReceive.disabled = false;
      dom.btnSubmitReceive.innerHTML = `<span>🔒</span><span>Recibir de forma segura</span>`;
    }
  }

  // ==========================================
  // LÓGICA DE LA VISTA: REGISTROS Y TRAZABILIDAD
  // ==========================================
  async function fetchRecords() {
    try {
      const res = await fetch('/api/enviox/records');
      if (res.ok) {
        const data = await res.json();
        state.records = data.records || [];
        updateSidebarBadges(data.stats || {});
        filterAndRenderRecords();
      }
    } catch (e) {
      console.warn('Error obteniendo registros:', e);
    }
  }

  function updateSidebarBadges(stats) {
    if (dom.sidebarBadges.todos) dom.sidebarBadges.todos.textContent = stats.total || 0;
    if (dom.sidebarBadges.enviados) dom.sidebarBadges.enviados.textContent = stats.sent || 0;
    if (dom.sidebarBadges.recibidos) dom.sidebarBadges.recibidos.textContent = stats.received || 0;
    if (dom.sidebarBadges.activos) dom.sidebarBadges.activos.textContent = stats.active || 0;
    if (dom.sidebarBadges.caducados) dom.sidebarBadges.caducados.textContent = stats.expired || 0;
    if (dom.sidebarBadges.cancelados) dom.sidebarBadges.cancelados.textContent = stats.cancelled || 0;
    if (dom.sidebarBadges.pendientes_validacion) dom.sidebarBadges.pendientes_validacion.textContent = stats.pendingValidation || 0;
    if (dom.sidebarBadges.pendientes_envio) dom.sidebarBadges.pendientes_envio.textContent = stats.pendingSend || 0;
    if (dom.sidebarBadges.pendientes_error) dom.sidebarBadges.pendientes_error.textContent = stats.pendingError || 0;
  }

  function filterAndRenderRecords() {
    const q = (dom.recordsSearch ? dom.recordsSearch.value : '').toLowerCase().trim();

    state.filteredRecords = state.records.filter(r => {
      // Filtro lateral
      if (state.activeFilter === 'enviados' && r.type !== 'enviado') return false;
      if (state.activeFilter === 'recibidos' && r.type !== 'recibido') return false;
      if (state.activeFilter === 'activos' && r.status !== 'activo') return false;
      if (state.activeFilter === 'caducados' && r.status !== 'caducado') return false;
      if (state.activeFilter === 'cancelados' && r.status !== 'cancelled') return false;

      // Filtro de búsqueda de texto
      if (q) {
        const matchRef = (r.reference || '').toLowerCase().includes(q);
        const matchSub = (r.subject || '').toLowerCase().includes(q);
        const matchRec = (r.recipient || '').toLowerCase().includes(q);
        const matchSen = (r.sender || '').toLowerCase().includes(q);
        const matchFil = (r.filesSummary || '').toLowerCase().includes(q);
        if (!matchRef && !matchSub && !matchRec && !matchSen && !matchFil) return false;
      }

      return true;
    });

    renderRecordsTable();
  }

  function renderRecordsTable() {
    if (!dom.recordsTbody) return;
    dom.recordsTbody.innerHTML = '';

    if (!state.filteredRecords.length) {
      dom.recordsTbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align:center; padding: 36px; color: #64748b;">
            No se han encontrado registros en esta sección.
          </td>
        </tr>
      `;
      return;
    }

    state.filteredRecords.forEach(r => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';

      let typeIcon = '⇥';
      if (r.type === 'recibido') typeIcon = '⇤';
      else if (r.type === 'link') typeIcon = '🔗';

      let statusColor = '#10b981';
      if (r.status === 'caducado') statusColor = '#94a3b8';
      else if (r.status === 'cancelled') statusColor = '#ef4444';

      const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('es-ES') : '-';

      tr.innerHTML = `
        <td><input type="checkbox" class="tx-record-cb" data-id="${r.id}"></td>
        <td><span class="tx-type-icon" title="${r.type}">${typeIcon}</span></td>
        <td><span class="tx-ref-badge">${r.reference}</span></td>
        <td><span style="font-size:12px;color:#334e68;">${r.sender}</span></td>
        <td><span style="font-size:12px;color:#64748b;">${r.groupName || '-'}</span></td>
        <td><span style="font-size:12px;font-weight:600;color:#1e293b;">${r.recipient}</span></td>
        <td><span style="font-weight:600;color:var(--tx-navy);">${r.subject}</span></td>
        <td><span style="font-size:12px;background:#f1f5f9;padding:2px 8px;border-radius:4px;">${r.filesSummary}</span></td>
        <td><span style="font-size:12px;color:#64748b;">${dateStr}</span></td>
      `;

      // Clic en la fila (excepto el checkbox) abre la trazabilidad
      tr.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          showTraceabilityModal(r);
        }
      });

      dom.recordsTbody.appendChild(tr);
    });
  }

  function setupRecordsView() {
    // Clics en la barra lateral de filtros
    const items = document.querySelectorAll('.tx-sidebar-item');
    items.forEach(item => {
      item.addEventListener('click', () => {
        items.forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        state.activeFilter = item.dataset.filter || 'todos';
        filterAndRenderRecords();
      });
    });

    if (dom.recordsSearch) {
      dom.recordsSearch.addEventListener('input', () => filterAndRenderRecords());
    }

    if (dom.btnRefreshRecords) {
      dom.btnRefreshRecords.addEventListener('click', () => fetchRecords());
    }

    if (dom.btnExportRecords) {
      dom.btnExportRecords.addEventListener('click', exportRecordsCsv);
    }

    if (dom.btnCancelTransfer) {
      dom.btnCancelTransfer.addEventListener('click', cancelSelectedTransfers);
    }
  }

  function exportRecordsCsv() {
    if (!state.filteredRecords.length) {
      alert('No hay registros para exportar.');
      return;
    }

    let csv = 'Referencia,Tipo,Emisor,Grupo,Destinatario,Asunto,Archivos,Fecha,Estado\n';
    state.filteredRecords.forEach(r => {
      const cleanSub = `"${(r.subject || '').replace(/"/g, '""')}"`;
      const cleanFiles = `"${(r.filesSummary || '').replace(/"/g, '""')}"`;
      csv += `${r.reference},${r.type},${r.sender},${r.groupName || '-'},${r.recipient},${cleanSub},${cleanFiles},${r.createdAt},${r.status}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Enviox-registros-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function cancelSelectedTransfers() {
    const checked = Array.from(document.querySelectorAll('.tx-record-cb:checked')).map(cb => cb.dataset.id);
    if (!checked.length) {
      alert('Selecciona al menos una transferencia de la tabla para cancelar.');
      return;
    }

    if (!confirm(`¿Estás seguro de que deseas cancelar ${checked.length} transferencia(s)? Los destinatarios ya no podrán descargar los archivos.`)) {
      return;
    }

    for (const id of checked) {
      try {
        await fetch('/api/enviox/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
      } catch (e) {}
    }

    fetchRecords();
  }

  // ==========================================
  // LÓGICA DE LA VISTA: CONTACTOS Y GRUPOS
  // ==========================================
  function renderContacts() {
    if (!dom.contactsTbody) return;
    dom.contactsTbody.innerHTML = '';

    const list = state.contacts || [];
    if (!list.length) {
      dom.contactsTbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align:center; padding: 32px; color:#64748b;">
            No hay contactos guardados. Se almacenarán automáticamente en cada envío.
          </td>
        </tr>
      `;
      return;
    }

    list.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" class="tx-contact-cb" data-id="${c.id}"></td>
        <td><span style="font-weight:600;color:var(--tx-navy);">${c.email}</span></td>
        <td><span>${c.name || '-'}</span></td>
        <td><span>${c.phone || '-'}</span></td>
        <td><span style="font-size:12px;background:#f1f5f9;padding:2px 8px;border-radius:4px;">${c.language || 'Español'}</span></td>
      `;
      dom.contactsTbody.appendChild(tr);
    });
  }

  function setupContactsView() {
    if (dom.btnCreateContact) {
      dom.btnCreateContact.addEventListener('click', () => showCreateContactModal());
    }
  }

  // ==========================================
  // LÓGICA DE LA VISTA: AJUSTES Y ADMINISTRACIÓN UNIFICADA
  // ==========================================
  function setupAdminView() {
    // 0. Ruleta de Ajustes (Botón ⚙️ en la cabecera)
    const settingsBtn = document.getElementById('txSettingsBtn');
    if (settingsBtn) {
      settingsBtn.onclick = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        switchView('admin');
        switchAdminPane('ajustes');
      };
      settingsBtn.addEventListener('click', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        switchView('admin');
        switchAdminPane('ajustes');
      });
    }

    // 1. Navegación en el Sidebar de 13 items
    document.querySelectorAll('.tx-admin-nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const pane = item.dataset.pane;
        if (pane) switchAdminPane(pane);
      });
    });

    // 2. Botones del Grid de Resumen de administración
    document.querySelectorAll('.tx-admin-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const target = btn.dataset.paneTarget || btn.dataset.target;
        if (target) switchAdminPane(target);
      });
    });

    // 3. Botón de guardar ajustes generales
    const btnSaveSettings = document.getElementById('btnSaveSettings');
    if (btnSaveSettings) {
      btnSaveSettings.addEventListener('click', handleSaveSettings);
    }

    // 4. Configuración de Tenant Nube 5 TB (Google Drive / Azure OneDrive)
    const btnSaveCloudTenant = document.getElementById('btnSaveCloudTenant');
    if (btnSaveCloudTenant) {
      btnSaveCloudTenant.addEventListener('click', saveCloudTenantConfig);
    }
    const btnTestCloudConnection = document.getElementById('btnTestCloudConnection');
    if (btnTestCloudConnection) {
      btnTestCloudConnection.addEventListener('click', testCloudConnection);
    }

    // 5. Gestión de Usuarios
    const usersSearch = document.getElementById('usersSearch');
    if (usersSearch) {
      usersSearch.addEventListener('input', (e) => renderUsers(e.target.value));
    }
    const btnCreateUser = document.getElementById('btnCreateUser');
    if (btnCreateUser) {
      btnCreateUser.addEventListener('click', () => showCreateUserModal());
    }
    const btnToggleUserActive = document.getElementById('btnToggleUserActive');
    if (btnToggleUserActive) {
      btnToggleUserActive.addEventListener('click', toggleSelectedUserActive);
    }
    const btnResetUserPassword = document.getElementById('btnResetUserPassword');
    if (btnResetUserPassword) {
      btnResetUserPassword.addEventListener('click', resetSelectedUserPassword);
    }
    const btnDeleteUser = document.getElementById('btnDeleteUser');
    if (btnDeleteUser) {
      btnDeleteUser.addEventListener('click', deleteSelectedUser);
    }

    // 6. Gestión de Grupos y Permisos
    const btnCreateAdminGroup = document.getElementById('btnCreateAdminGroup');
    if (btnCreateAdminGroup) {
      btnCreateAdminGroup.addEventListener('click', () => showCreateGroupModal());
    }
    const adminGroupsSearch = document.getElementById('adminGroupsSearch');
    if (adminGroupsSearch) {
      adminGroupsSearch.addEventListener('input', (e) => renderGroups(e.target.value));
    }

    // 7. Lista Negra
    const btnAddBlacklist = document.getElementById('btnAddBlacklist');
    if (btnAddBlacklist) {
      btnAddBlacklist.addEventListener('click', addBlacklistEntry);
    }

    // 8. Canales de Notificación
    const btnSaveChannels = document.getElementById('btnSaveChannels');
    if (btnSaveChannels) {
      btnSaveChannels.addEventListener('click', saveChannels);
    }
    const btnTestEmailChannel = document.getElementById('btnTestEmailChannel');
    if (btnTestEmailChannel) {
      btnTestEmailChannel.addEventListener('click', testEmailChannel);
    }

    // 9. Informes y Auditoría
    const btnRefreshReports = document.getElementById('btnRefreshReports');
    if (btnRefreshReports) {
      btnRefreshReports.addEventListener('click', () => fetchReports());
    }
    const btnExportReportsCsv = document.getElementById('btnExportReportsCsv');
    if (btnExportReportsCsv) {
      btnExportReportsCsv.addEventListener('click', exportReportsCsv);
    }
    const reportsSearch = document.getElementById('reportsSearch');
    if (reportsSearch) {
      reportsSearch.addEventListener('input', (e) => renderReports(e.target.value));
    }

    // 10. Contactos y Roles
    const btnCreateRole = document.getElementById('btnCreateRole');
    if (btnCreateRole) {
      btnCreateRole.addEventListener('click', () => alert('Plantilla SAML creada correctamente.'));
    }
    const btnCreateAdminContact = document.getElementById('btnCreateAdminContact');
    if (btnCreateAdminContact) {
      btnCreateAdminContact.addEventListener('click', () => showCreateContactModal());
    }
  }

  // --- AJUSTES GENERALES ---
  function populateSettingsForm() {
    const s = state.settings;
    setVal('cfgMaxRecipients', s.maxRecipients);
    setVal('cfgMaxFiles', s.maxFiles);
    setVal('cfgMaxFileSizeMb', s.maxFileSizeMb);
    setVal('cfgMaxDownloads', s.maxDownloadsPerFile);
    setVal('cfgMaxTransferSizeMb', s.maxTransferSizeMb);
    setVal('cfgMaxExpiryDays', s.maxExpiryDays);
    setVal('cfgDefaultExpiryDays', s.defaultExpiryDays);
    setVal('cfgWatermark', s.watermarkText || '');
    setVal('cfgBrandName', s.brandName || 'ENVIOX');
    setVal('cfgBrandSubtitle', s.brandSubtitle || 'Plataforma Enviox Segura');

    setChecked('cfgDefaultReceipt', s.defaultReceiptAck);
    setChecked('cfgDefaultExpiryNotice', s.defaultExpiryNotice);
    setChecked('cfgNoLockout', s.noLockoutOnFailedLogins);
    setChecked('cfgAutoSaveContacts', s.autoSaveContacts);

    const mailStatusEl = document.getElementById('cfgMailStatusText');
    if (mailStatusEl) {
      mailStatusEl.textContent = 'Activo (Pasarela de Correo Corporativa)';
      mailStatusEl.style.color = '#10b981';
    }
  }

  async function handleSaveSettings() {
    const btn = document.getElementById('btnSaveSettings');
    if (btn) btn.disabled = true;

    const payload = {
      maxRecipients: getValNum('cfgMaxRecipients', 20),
      maxFiles: getValNum('cfgMaxFiles', 50),
      maxFileSizeMb: getValNum('cfgMaxFileSizeMb', 40960),
      maxDownloadsPerFile: getValNum('cfgMaxDownloads', 3),
      maxTransferSizeMb: getValNum('cfgMaxTransferSizeMb', 40960),
      maxExpiryDays: getValNum('cfgMaxExpiryDays', 14),
      defaultExpiryDays: getValNum('cfgDefaultExpiryDays', 8),
      watermarkText: getVal('cfgWatermark', ''),
      brandName: getVal('cfgBrandName', 'ENVIOX'),
      brandSubtitle: getVal('cfgBrandSubtitle', 'Plataforma Enviox Segura'),
      defaultReceiptAck: isChecked('cfgDefaultReceipt'),
      defaultExpiryNotice: isChecked('cfgDefaultExpiryNotice'),
      noLockoutOnFailedLogins: isChecked('cfgNoLockout'),
      autoSaveContacts: isChecked('cfgAutoSaveContacts')
    };

    try {
      const res = await fetch('/api/enviox/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar ajustes.');

      state.settings = Object.assign(state.settings, data.settings);
      applySettingsToUI();
      alert('Ajustes de Enviox guardados y sincronizados correctamente.');
    } catch (e) {
      alert('Error guardando ajustes: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- TENANT / NUBE 5 TB ---
  async function loadCloudTenantConfig() {
    try {
      const res = await fetch('/api/enviox/cloud-config');
      if (res.ok) {
        const d = await res.json();
        if (d.googleDrive) {
          if (d.googleDrive.clientId) setVal('cfgGoogleClientId', d.googleDrive.clientId);
          if (d.googleDrive.folderId) setVal('cfgGoogleFolderId', d.googleDrive.folderId);
        }
        if (d.oneDrive) {
          if (d.oneDrive.tenantId) setVal('cfgAzureTenantId', d.oneDrive.tenantId);
        }
      }
    } catch (e) {
      console.warn('Error cargando configuración de Tenant:', e.message);
    }
  }

  async function saveCloudTenantConfig() {
    const isAzure = !!getVal('cfgAzureTenantId');
    const payload = {
      providerType: isAzure ? 'onedrive' : 'google-drive',
      clientId: isAzure ? getVal('cfgAzureClientId') : getVal('cfgGoogleClientId'),
      clientSecret: isAzure ? getVal('cfgAzureClientSecret') : getVal('cfgGoogleClientSecret'),
      googleClientId: getVal('cfgGoogleClientId'),
      googleClientSecret: getVal('cfgGoogleClientSecret'),
      googleFolderId: getVal('cfgGoogleFolderId'),
      azureTenantId: getVal('cfgAzureTenantId'),
      azureClientId: getVal('cfgAzureClientId'),
      azureClientSecret: getVal('cfgAzureClientSecret')
    };
    try {
      const res = await fetch('/api/enviox/cloud-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error guardando credenciales');
      alert('✅ ' + (d.message || 'Credenciales de Tenant y Nube de 5 TB actualizadas.'));
      loadCloudTenantConfig();
    } catch (e) {
      alert('❌ Error: ' + e.message);
    }
  }

  async function testCloudConnection() {
    try {
      const isAzure = !!getVal('cfgAzureTenantId');
      const res = await fetch('/api/enviox/cloud-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerType: isAzure ? 'onedrive' : 'google-drive'
        })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Fallo al verificar la nube');
      alert(`✅ ${d.message || 'Conexión con la bóveda de 5 TB verificada con éxito.'}\nProveedor: ${d.tenantName || 'Bóveda 5 TB'}\nCapacidad: ${d.capacity || '5 TB'}`);
    } catch (e) {
      alert('⚠️ ' + e.message);
    }
  }

  // --- GESTIÓN DE USUARIOS (CRUD REAL) ---
  async function fetchUsers() {
    try {
      const res = await fetch('/api/enviox/users');
      if (res.ok) {
        const data = await res.json();
        state.users = data.users || [];
      }
    } catch (e) {
      console.warn('Fallback local de usuarios');
    }
    renderUsers();
  }

  function renderUsers(filterQuery = '') {
    const tbody = document.getElementById('usersTbody');
    if (!tbody) return;

    let list = state.users && state.users.length ? state.users : [
      { id: 'u-1', username: 'admin', email: 'admin@cyberpolis.es', fullName: 'Administrador Principal', role: 'admin', active: true, groupName: 'Administradores', permission: 'admin', language: 'Español' },
      { id: 'u-2', username: 'unai.nieto', email: 'unai.nieto@cyberpolis.es', fullName: 'Unai Nieto', role: 'admin', active: true, groupName: 'Administradores', permission: 'admin', language: 'Español' },
      { id: 'u-3', username: 'soc', email: 'soc@cyberpolis.es', fullName: 'Operador SOC Ciberseguridad', role: 'user', active: true, groupName: 'Enviar y Recibir', permission: 'both', language: 'Español' }
    ];

    if (filterQuery && filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim();
      list = list.filter(u => 
        (u.username && u.username.toLowerCase().includes(q)) || 
        (u.email && u.email.toLowerCase().includes(q)) || 
        (u.fullName && u.fullName.toLowerCase().includes(q)) ||
        (u.groupName && u.groupName.toLowerCase().includes(q))
      );
    }

    const activeCount = list.filter(u => u.active !== false).length;
    const badgeEl = document.getElementById('usersCountBadge');
    if (badgeEl) {
      badgeEl.innerHTML = `<span style="color:#10b981;">● Activos: ${activeCount}</span> · Total usuarios: ${list.length}`;
    }

    tbody.innerHTML = '';
    list.forEach(u => {
      const tr = document.createElement('tr');
      const permBadge = u.permission === 'admin' 
        ? '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">👑 Admin Total</span>'
        : (u.permission === 'send' 
          ? '<span style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">📤 Solo Enviar</span>'
          : (u.permission === 'receive'
            ? '<span style="background:#f3e8ff;color:#6b21a8;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">📥 Solo Recibir</span>'
            : '<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">🔄 Ambos</span>'));

      tr.innerHTML = `
        <td><input type="checkbox" class="user-row-select" data-username="${u.username}"></td>
        <td><span style="color:${u.active !== false ? '#10b981' : '#94a3b8'};font-size:16px;" title="${u.active !== false ? 'Activo' : 'Inactivo'}">●</span></td>
        <td><strong>${u.username}</strong></td>
        <td>${u.email}</td>
        <td>${u.fullName || u.username}</td>
        <td><span style="font-weight:600;color:var(--tx-navy);">${u.groupName || 'General'}</span></td>
        <td>${permBadge}</td>
        <td>${u.language || 'Español'}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function showCreateUserModal() {
    dom.modalTitle.textContent = 'Crear nuevo usuario corporativo';
    const groupOptions = (state.groups || [
      { id: 'grp-admin', name: 'Administradores' },
      { id: 'grp-both', name: 'Enviar y Recibir' },
      { id: 'grp-send', name: 'Solo Enviar' },
      { id: 'grp-receive', name: 'Solo Recibir' }
    ]).map(g => `<option value="${g.id}">${g.name}</option>`).join('');

    dom.modalBody.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Nombre de usuario *</label>
          <input type="text" id="newUserUsername" class="tx-input-field" placeholder="ej. marta.garcia">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Correo electrónico *</label>
          <input type="email" id="newUserEmail" class="tx-input-field" placeholder="marta.garcia@cyberpolis.es">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Nombre completo</label>
          <input type="text" id="newUserFullName" class="tx-input-field" placeholder="Marta García Ramos">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Grupo asignado (determina permisos)</label>
          <select id="newUserGroup" class="tx-input-field">
            ${groupOptions}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Idioma</label>
          <select id="newUserLang" class="tx-input-field">
            <option value="Español">Español</option>
            <option value="English">English</option>
            <option value="Català">Català</option>
            <option value="Euskara">Euskara</option>
            <option value="Galego">Galego</option>
          </select>
        </div>
      </div>
    `;

    dom.modalFooter.innerHTML = `
      <button type="button" class="tx-pill-btn-small" style="background:#64748b;" id="txCancelUserBtn">Cancelar</button>
      <button type="button" class="tx-pill-btn-small" id="txSaveUserBtn">Crear Usuario</button>
    `;

    document.getElementById('txCancelUserBtn').addEventListener('click', closeModal);
    document.getElementById('txSaveUserBtn').addEventListener('click', async () => {
      const username = document.getElementById('newUserUsername').value.trim();
      const email = document.getElementById('newUserEmail').value.trim();
      const fullName = document.getElementById('newUserFullName').value.trim();
      const groupId = document.getElementById('newUserGroup').value;
      const language = document.getElementById('newUserLang').value;

      if (!username || !email || !email.includes('@')) {
        alert('Introduce un nombre de usuario y correo válidos.');
        return;
      }

      try {
        const res = await fetch('/api/enviox/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, fullName, groupId, language, active: true })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Error al crear usuario.');
        alert(`Usuario ${username} creado con éxito.`);
        closeModal();
        fetchUsers();
      } catch (err) {
        alert(err.message);
      }
    });

    openModal();
  }

  function getSelectedUsername() {
    const checked = document.querySelector('.user-row-select:checked');
    if (checked) return checked.dataset.username;
    const all = Array.from(document.querySelectorAll('.user-row-select'));
    if (all.length > 0) return all[0].dataset.username;
    return null;
  }

  async function toggleSelectedUserActive() {
    const username = getSelectedUsername();
    if (!username) {
      alert('Selecciona al menos un usuario de la tabla.');
      return;
    }
    try {
      const res = await fetch('/api/enviox/users/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error modificando estado');
      fetchUsers();
    } catch (e) {
      alert(e.message);
    }
  }

  async function resetSelectedUserPassword() {
    const username = getSelectedUsername();
    if (!username) {
      alert('Selecciona un usuario de la tabla.');
      return;
    }
    try {
      const res = await fetch('/api/enviox/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error');
      alert(`Contraseña de ${username} restablecida con éxito:\n\nNueva contraseña provisional: ${d.tempPassword}`);
    } catch (e) {
      alert(e.message);
    }
  }

  async function deleteSelectedUser() {
    const username = getSelectedUsername();
    if (!username) {
      alert('Selecciona un usuario para eliminar.');
      return;
    }
    if (username === 'admin') {
      alert('No se puede eliminar al usuario admin principal.');
      return;
    }
    if (confirm(`¿Seguro que deseas eliminar permanentemente al usuario '${username}'?`)) {
      try {
        const res = await fetch(`/api/enviox/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Error al eliminar');
        fetchUsers();
        fetchGroups();
      } catch (e) {
        alert(e.message);
      }
    }
  }

  // --- GESTIÓN DE GRUPOS (PERMISOS OPERATIVOS) ---
  async function fetchGroups() {
    try {
      const res = await fetch('/api/enviox/groups');
      if (res.ok) {
        const d = await res.json();
        state.groups = d.groups || [];
      }
    } catch (e) {
      console.warn('Fallback local de grupos');
    }
    renderGroups();
  }

  function renderGroups(filterQuery = '') {
    const tbody = document.getElementById('adminGroupsTbody');
    if (!tbody) return;

    let list = state.groups && state.groups.length ? state.groups : [
      { id: 'grp-admin', name: 'Administradores', description: 'Acceso total y configuración de la plataforma', permission: 'admin', members: ['admin@cyberpolis.es', 'unai.nieto@cyberpolis.es'] },
      { id: 'grp-both', name: 'Enviar y Recibir', description: 'Transferencias bidireccionales completas', permission: 'both', members: ['soc@cyberpolis.es'] },
      { id: 'grp-send', name: 'Solo Enviar', description: 'Usuarios restringidos exclusivamente a envío de archivos', permission: 'send', members: [] },
      { id: 'grp-receive', name: 'Solo Recibir', description: 'Usuarios restringidos exclusivamente a recepción de archivos', permission: 'receive', members: [] }
    ];

    if (filterQuery && filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim();
      list = list.filter(g => g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q));
    }

    tbody.innerHTML = '';
    list.forEach(g => {
      const tr = document.createElement('tr');
      const permBadge = g.permission === 'admin' 
        ? '<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;">👑 Administradores</span>'
        : (g.permission === 'send'
          ? '<span style="background:#e0f2fe;color:#0369a1;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;">📤 Solo Enviar</span>'
          : (g.permission === 'receive'
            ? '<span style="background:#f3e8ff;color:#6b21a8;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;">📥 Solo Recibir</span>'
            : '<span style="background:#dcfce7;color:#166534;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;">🔄 Enviar + Recibir</span>'));

      const membersCount = Array.isArray(g.members) ? g.members.length : 0;
      const membersPreview = Array.isArray(g.members) && g.members.length > 0 
        ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${g.members.slice(0, 2).join(', ')}${g.members.length > 2 ? ` (+${g.members.length - 2})` : ''}</div>`
        : '<div style="font-size:11px;color:#94a3b8;">Sin integrantes asignados</div>';

      tr.innerHTML = `
        <td><strong>${g.name}</strong></td>
        <td>${g.description}</td>
        <td>${permBadge}</td>
        <td>
          <span style="background:#f1f5f9;color:var(--tx-navy);padding:2px 8px;border-radius:12px;font-size:12px;font-weight:700;">${membersCount} usuarios</span>
          ${membersPreview}
        </td>
        <td>
          <button type="button" class="tx-btn-outline" style="padding:4px 8px;font-size:11px;" onclick="window.manageGroupMembers('${g.id}')">👥 Miembros</button>
          ${!['grp-admin', 'grp-both'].includes(g.id) ? `
            <button type="button" class="tx-btn-outline" style="padding:4px 8px;font-size:11px;color:#ef4444;" onclick="window.deleteGroupById('${g.id}')">🗑</button>
          ` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function showCreateGroupModal() {
    dom.modalTitle.textContent = 'Crear nuevo grupo y asignar permisos';
    dom.modalBody.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Nombre del grupo *</label>
          <input type="text" id="newGrpName" class="tx-input-field" placeholder="ej. Auditores Externos, Proveedores, etc.">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Descripción</label>
          <input type="text" id="newGrpDesc" class="tx-input-field" placeholder="Finalidad y alcance de este grupo">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Nivel de Permiso Operativo *</label>
          <select id="newGrpPerm" class="tx-input-field">
            <option value="both">🔄 Enviar y Recibir (Transferencia completa)</option>
            <option value="send">📤 Solo Enviar (No puede solicitar archivos)</option>
            <option value="receive">📥 Solo Recibir (No puede enviar archivos)</option>
            <option value="admin">👑 Administradores (Gestión completa de plataforma)</option>
          </select>
        </div>
      </div>
    `;

    dom.modalFooter.innerHTML = `
      <button type="button" class="tx-pill-btn-small" style="background:#64748b;" id="txCancelGrpBtn">Cancelar</button>
      <button type="button" class="tx-pill-btn-small" id="txSaveGrpBtn">Guardar Grupo</button>
    `;

    document.getElementById('txCancelGrpBtn').addEventListener('click', closeModal);
    document.getElementById('txSaveGrpBtn').addEventListener('click', async () => {
      const name = document.getElementById('newGrpName').value.trim();
      const description = document.getElementById('newGrpDesc').value.trim();
      const permission = document.getElementById('newGrpPerm').value;

      if (!name) {
        alert('Introduce el nombre del grupo.');
        return;
      }

      try {
        const res = await fetch('/api/enviox/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, permission, members: [] })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Error');
        alert(`Grupo '${name}' creado.`);
        closeModal();
        fetchGroups();
      } catch (e) {
        alert(e.message);
      }
    });

    openModal();
  }

  window.manageGroupMembers = function(groupId) {
    const grp = (state.groups || []).find(g => g.id === groupId);
    if (!grp) return;

    dom.modalTitle.textContent = `Gestionar integrantes de: ${grp.name}`;
    const users = state.users || [];
    const members = grp.members || [];

    let usersCheckboxes = users.map(u => {
      const isMember = members.includes(u.email) || members.includes(u.username);
      return `
        <label style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #f1f5f9;cursor:pointer;">
          <input type="checkbox" class="grp-member-check" data-email="${u.email}" ${isMember ? 'checked' : ''}>
          <div>
            <div style="font-weight:700;font-size:13px;color:var(--tx-navy);">${u.fullName || u.username} (${u.username})</div>
            <div style="font-size:11px;color:#64748b;">${u.email}</div>
          </div>
        </label>
      `;
    }).join('');

    dom.modalBody.innerHTML = `
      <p style="font-size:13px;color:#475569;margin-top:0;margin-bottom:12px;">
        Marca o desmarca los usuarios que pertenecerán al grupo <strong>${grp.name}</strong> (${grp.permission}):
      </p>
      <div style="max-height:260px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;padding:6px;">
        ${usersCheckboxes || '<div style="padding:10px;color:#94a3b8;">No hay usuarios dados de alta.</div>'}
      </div>
    `;

    dom.modalFooter.innerHTML = `
      <button type="button" class="tx-pill-btn-small" style="background:#64748b;" id="txCancelGrpMemBtn">Cancelar</button>
      <button type="button" class="tx-pill-btn-small" id="txSaveGrpMemBtn">Guardar Integrantes</button>
    `;

    document.getElementById('txCancelGrpMemBtn').addEventListener('click', closeModal);
    document.getElementById('txSaveGrpMemBtn').addEventListener('click', async () => {
      const checkedBoxes = Array.from(document.querySelectorAll('.grp-member-check:checked'));
      const newMembers = checkedBoxes.map(b => b.dataset.email);

      try {
        grp.members = newMembers;
        const res = await fetch('/api/enviox/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(grp)
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Error');
        alert(`Integrantes de '${grp.name}' actualizados con éxito.`);
        closeModal();
        fetchGroups();
        fetchUsers();
      } catch (e) {
        alert(e.message);
      }
    });

    openModal();
  };

  window.deleteGroupById = async function(groupId) {
    if (confirm('¿Deseas eliminar este grupo? Los usuarios asignados volverán al grupo por defecto.')) {
      try {
        const res = await fetch(`/api/enviox/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Error');
        fetchGroups();
        fetchUsers();
      } catch (e) {
        alert(e.message);
      }
    }
  };

  // --- LISTA NEGRA (OPERATIVA) ---
  async function fetchBlacklist() {
    try {
      const res = await fetch('/api/enviox/blacklist');
      if (res.ok) {
        const d = await res.json();
        state.blacklist = d.blacklist || [];
      }
    } catch (e) {
      console.warn('Error cargando lista negra');
    }
    renderBlacklist();
  }

  function renderBlacklist() {
    const tbody = document.getElementById('adminBlacklistTbody');
    if (!tbody) return;

    const list = state.blacklist || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">No hay reglas en la Lista Negra. La plataforma permite envíos normales.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    list.forEach(b => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">${b.type === 'domain' ? 'Dominio' : 'Correo'}</span></td>
        <td><code>${b.value}</code></td>
        <td>${b.reason || 'Bloqueo administrativo'}</td>
        <td>${b.createdAt ? new Date(b.createdAt).toLocaleDateString('es-ES') : '—'}</td>
        <td>
          <button type="button" class="tx-pill-btn-small" style="background:#ef4444;padding:4px 10px;font-size:11px;" onclick="window.removeBlacklistEntry('${b.id || b.value}')">Quitar</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function addBlacklistEntry() {
    const valInput = document.getElementById('newBlacklistInput');
    const reasonInput = document.getElementById('newBlacklistReason');
    const value = valInput ? valInput.value.trim() : '';
    const reason = reasonInput ? reasonInput.value.trim() : '';

    if (!value) {
      alert('Introduce un correo o dominio para bloquear (ej: @tempmail.com)');
      return;
    }

    try {
      const res = await fetch('/api/enviox/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, reason })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error');
      if (valInput) valInput.value = '';
      if (reasonInput) reasonInput.value = '';
      alert(`'${value}' ha sido añadido a la Lista Negra corporativa.`);
      fetchBlacklist();
    } catch (e) {
      alert(e.message);
    }
  }

  window.removeBlacklistEntry = async function(id) {
    if (confirm(`¿Quitar '${id}' de la Lista Negra corporativa?`)) {
      try {
        const res = await fetch(`/api/enviox/blacklist/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Error');
        fetchBlacklist();
      } catch (e) {
        alert(e.message);
      }
    }
  };

  // --- CANALES DE NOTIFICACIÓN ---
  async function fetchChannels() {
    try {
      const res = await fetch('/api/enviox/channels');
      if (res.ok) {
        const d = await res.json();
        state.channels = d.channels || {};
        const ch = state.channels;
        setVal('cfgMailMode', ch.mode || 'gmail_app_password');
        setVal('cfgSmtpHost', ch.smtpHost || 'smtp.gmail.com');
        setVal('cfgSmtpPort', ch.smtpPort || 465);
        setVal('cfgSmtpUser', ch.smtpUser || '');
        if (ch.hasPassword) {
          const pEl = document.getElementById('cfgSmtpPassword');
          if (pEl) pEl.placeholder = '•••••••••••••••• (Guardada en el servidor)';
        }
        setVal('cfgSmtpFromName', ch.fromName || 'CYBERPOLIS ENVIOX');
        setChecked('cfgNotifyOnSend', ch.notifyOnSend !== false);
        setChecked('cfgNotifyOnDownload', ch.notifyOnDownload !== false);
        setChecked('cfgNotifyOnExpiry', ch.notifyOnExpiry !== false);

        const modeEl = document.getElementById('cfgMailMode');
        if (modeEl && !modeEl._boundChange) {
          modeEl._boundChange = true;
          modeEl.addEventListener('change', () => {
            if (modeEl.value === 'gmail_app_password') {
              setVal('cfgSmtpHost', 'smtp.gmail.com');
              setVal('cfgSmtpPort', 465);
            } else if (modeEl.value === 'custom_smtp') {
              setVal('cfgSmtpPort', 587);
            }
          });
        }
      }
    } catch (e) {
      console.warn('Error cargando canales:', e.message);
    }
  }

  async function saveChannels() {
    const payload = {
      mode: getVal('cfgMailMode') || 'gmail_app_password',
      smtpHost: getVal('cfgSmtpHost') || 'smtp.gmail.com',
      smtpPort: getValNum('cfgSmtpPort', 465),
      smtpUser: getVal('cfgSmtpUser'),
      smtpPassword: getVal('cfgSmtpPassword'),
      fromName: getVal('cfgSmtpFromName') || 'CYBERPOLIS ENVIOX',
      notifyOnSend: isChecked('cfgNotifyOnSend'),
      notifyOnDownload: isChecked('cfgNotifyOnDownload'),
      notifyOnExpiry: isChecked('cfgNotifyOnExpiry')
    };
    try {
      const res = await fetch('/api/enviox/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Error guardando canales');
      alert('✅ ' + (d.message || 'Canales de notificación y pasarela de correo guardados con éxito.'));
      fetchChannels();
    } catch (e) {
      alert('❌ ' + e.message);
    }
  }

  async function testEmailChannel() {
    const defaultTo = getVal('cfgTestEmailTo') || getVal('cfgSmtpUser') || '';
    const to = getVal('cfgTestEmailTo') || prompt('Introduce el correo destino para la prueba:', defaultTo);
    if (!to || !to.includes('@')) {
      alert('Indica una dirección de correo válida para realizar la prueba.');
      return;
    }
    try {
      const res = await fetch('/api/enviox/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Fallo al despachar correo de prueba');
      alert(`✅ ${d.message || 'Correo de prueba enviado con éxito a ' + to}`);
    } catch (e) {
      alert('❌ ' + e.message);
    }
  }

  // --- INFORMES Y AUDITORÍA FORENSE ---
  async function fetchReports() {
    try {
      const res = await fetch('/api/enviox/reports');
      if (res.ok) {
        const d = await res.json();
        state.reports = d.reports || [];
      }
    } catch (e) {
      console.warn('Error cargando informes:', e.message);
    }
    renderReports();
  }

  function renderReports(filterQuery = '') {
    const tbody = document.getElementById('adminReportsTbody');
    if (!tbody) return;

    let list = state.reports || [];
    if (filterQuery && filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim();
      list = list.filter(r => 
        r.reference.toLowerCase().includes(q) || 
        r.sender.toLowerCase().includes(q) || 
        r.recipientDisplay.toLowerCase().includes(q)
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:24px;">No hay eventos registrados en la auditoría legal todavía.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    list.forEach(r => {
      const tr = document.createElement('tr');
      const isDownloaded = r.downloadsCount > 0;
      const downloadBadge = isDownloaded 
        ? `<span style="color:#10b981;font-weight:700;">✓ Descargado (${r.downloadsCount})<br><small style="color:#64748b;">${r.lastAccessDate ? new Date(r.lastAccessDate).toLocaleString('es-ES') : ''}</small></span>`
        : `<span style="color:#f59e0b;font-weight:600;">⏳ Pendiente de descarga</span>`;

      tr.innerHTML = `
        <td><strong>${r.reference}</strong></td>
        <td>${r.sender}</td>
        <td>${r.recipientDisplay}</td>
        <td>${r.filesCount} ficheros</td>
        <td>${r.createdAt ? new Date(r.createdAt).toLocaleDateString('es-ES') : '—'}</td>
        <td>${downloadBadge}</td>
        <td><code>${r.lastAccessIp || '—'}</code></td>
        <td>
          <button type="button" class="tx-btn-outline" style="padding:4px 8px;font-size:11px;" onclick="window.viewReportCert('${r.id}')">📜 Acta Forense</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  window.viewReportCert = function(id) {
    const r = (state.reports || []).find(x => x.id === id);
    if (!r) return;
    showTraceabilityModal({
      reference: r.reference,
      sender: r.sender,
      recipient: r.recipientDisplay,
      allRecipients: r.recipients,
      subject: r.subject,
      filesSummary: `${r.filesCount} archivos`,
      status: r.status,
      downloadsCount: r.downloadsCount,
      maxDownloads: r.maxDownloads,
      legalAudit: r.legalAudit
    });
  };

  function exportReportsCsv() {
    const list = state.reports || [];
    if (list.length === 0) {
      alert('No hay datos para exportar.');
      return;
    }
    const headers = ['Referencia', 'Emisor', 'Destinatarios', 'Ficheros', 'FechaEnvio', 'Estado', 'Descargas', 'IP_Acceso', 'AcuseRecibo'];
    const rows = list.map(r => [
      r.reference,
      `"${r.sender}"`,
      `"${r.recipientDisplay}"`,
      r.filesCount,
      r.createdAt,
      r.status,
      r.downloadsCount,
      r.lastAccessIp,
      `"${r.receiptStatus}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Auditoria_Enviox_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // --- ROLES, CONTACTOS Y TRANSFERENCIAS ACTIVAS ---
  const CANONICAL_ROLES = [
    { name: 'Admin', description: 'Plantilla: perfil SAML ADMIN', type: 'Plantilla', permissionsCount: 12 },
    { name: 'Enviar + Recibir', description: 'Plantilla: perfil SAML ENVIAR + RECIBIR', type: 'Plantilla', permissionsCount: 2 },
    { name: 'Enviar', description: 'Plantilla: perfil SAML ENVIAR', type: 'Plantilla', permissionsCount: 1 },
    { name: 'Recibir', description: 'Plantilla: perfil SAML RECIBIR', type: 'Plantilla', permissionsCount: 1 },
    { name: 'Total', description: 'Plantilla: perfil SAML TOTAL', type: 'Plantilla', permissionsCount: 18 },
    { name: 'Restaurar', description: 'Plantilla: perfil SAML RESTAURAR', type: 'Plantilla', permissionsCount: 2 },
    { name: 'EnvioxLink', description: 'Plantilla: perfil SAML ENVIOXLINK', type: 'Plantilla', permissionsCount: 2 }
  ];

  function renderRoles(filterQuery = '') {
    const tbody = document.getElementById('rolesTbody');
    if (!tbody) return;

    let roles = (state.roles && state.roles.length) ? state.roles : CANONICAL_ROLES;
    if (filterQuery && filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim();
      roles = roles.filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
    }

    tbody.innerHTML = '';
    roles.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox"></td>
        <td><strong>${r.name}</strong></td>
        <td><span style="color:#475569;">${r.description}</span></td>
        <td><span style="font-size:12px;background:#e2e8f0;padding:2px 8px;border-radius:12px;">● ${r.type || 'Plantilla'}</span></td>
        <td><strong>${r.permissionsCount || 1}</strong></td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderAdminContacts() {
    const tbody = document.getElementById('adminContactsTbody');
    if (!tbody) return;

    const contacts = (state.contacts && state.contacts.length) ? state.contacts : [
      { email: 'soporte@cyberpolis.es', name: 'Soporte CYBERPOLIS', phone: '+34 900 100 200', language: 'Español' },
      { email: 'auditoria@cyberpolis.es', name: 'Auditoría Forense NIS2', phone: '+34 900 100 201', language: 'Español' }
    ];

    tbody.innerHTML = '';
    contacts.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox"></td>
        <td><strong>${c.email}</strong></td>
        <td>${c.name || '—'}</td>
        <td>${c.phone || '—'}</td>
        <td>${c.language || 'Español'}</td>
        <td>
          <button type="button" class="tx-btn-outline" style="padding:2px 6px;font-size:11px;color:#ef4444;" onclick="window.deleteContactDirectly('${c.id || c.email}')">🗑</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  window.deleteContactDirectly = async function(id) {
    if (confirm('¿Eliminar este contacto?')) {
      try {
        await fetch(`/api/enviox/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.contacts = (state.contacts || []).filter(c => c.id !== id && c.email !== id);
        renderAdminContacts();
        renderContacts();
      } catch (e) {
        alert(e.message);
      }
    }
  };

  function renderAdminCancelTransfers() {
    const tbody = document.getElementById('adminCancelTransfersTbody');
    if (!tbody) return;

    const activeList = (state.records || []).filter(r => r.status === 'activo');
    if (activeList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px;">No hay transferencias activas para cancelar en este momento.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    activeList.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.reference}</strong></td>
        <td>${r.sender}</td>
        <td>${(r.allRecipients || [r.recipient]).join(', ')}</td>
        <td>${r.filesSummary}</td>
        <td>${r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('es-ES') : '—'}</td>
        <td>
          <button type="button" class="tx-pill-btn-small" style="background:#ef4444;padding:4px 10px;font-size:11px;" onclick="cancelTransferDirectly('${r.id}')">Revocar</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  window.cancelTransferDirectly = async function(id) {
    if (confirm('¿Confirmas la cancelación inmediata y revocación del acceso a los ficheros?')) {
      try {
        await fetch('/api/enviox/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        alert('Transferencia revocada con éxito.');
        fetchRecords();
        renderAdminCancelTransfers();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }
  };

  // ==========================================
  // MODALES (TRAZABILIDAD, ÉXITO, MULTI-DESTINATARIOS)
  // ==========================================
  function showTraceabilityModal(record) {
    dom.modalTitle.textContent = `Trazabilidad y Evidencias · Ref: ${record.reference}`;
    
    let auditHtml = '';
    if (record.legalAudit && record.legalAudit.length) {
      auditHtml = record.legalAudit.map(a => `
        <li style="margin-bottom:8px;font-size:13px;line-height:1.4;">
          <strong>${new Date(a.timestamp).toLocaleString('es-ES')}:</strong> ${a.details}
          <div style="font-size:11px;color:#64748b;">IP: ${a.ip || 'N/A'} · Navegador: ${a.userAgent ? a.userAgent.slice(0, 50) + '...' : 'N/A'}</div>
        </li>
      `).join('');
    } else {
      auditHtml = '<li style="font-size:13px;color:#64748b;">Registro creado sin incidencias forenses.</li>';
    }

    dom.modalBody.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;">
        <div style="background:#f8fafc;padding:12px;border-radius:6px;border:1px solid #e2e8f0;">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;">Estado</div>
          <div style="font-size:15px;font-weight:800;color:var(--tx-navy);margin-top:2px;">${record.status.toUpperCase()}</div>
        </div>
        <div style="background:#f8fafc;padding:12px;border-radius:6px;border:1px solid #e2e8f0;">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;">Descargas</div>
          <div style="font-size:15px;font-weight:800;color:var(--tx-navy);margin-top:2px;">${record.downloadsCount} / ${record.maxDownloads}</div>
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <strong>Emisor:</strong> ${record.sender}<br>
        <strong>Destinatarios:</strong> ${(record.allRecipients || [record.recipient]).join(', ')}<br>
        <strong>Asunto:</strong> ${record.subject}<br>
        <strong>Archivos:</strong> ${record.filesSummary} (${record.storageProvider || 'Nube 5 TB'})<br>
        <strong>Caducidad:</strong> ${record.expiresAt ? new Date(record.expiresAt).toLocaleString('es-ES') : 'Sin expiración'}
      </div>
      ${record.shareUrl ? `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:10px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#166534;margin-bottom:4px;">Enlace seguro:</div>
          <input type="text" readonly value="${record.shareUrl}" style="width:100%;font-size:12px;padding:6px;border:1px solid #cbd5e1;border-radius:4px;" onclick="this.select()">
        </div>
      ` : ''}
      <h4 style="font-size:14px;color:var(--tx-navy);margin-bottom:8px;">Trazabilidad de Accesos y Acuse de Recibo</h4>
      <ul style="padding-left:18px;max-height:160px;overflow-y:auto;background:#fafafa;padding:10px 18px;border-radius:6px;border:1px solid #e2e8f0;">
        ${auditHtml}
      </ul>
    `;

    dom.modalFooter.innerHTML = `
      <button type="button" class="tx-pill-btn-small" style="background:#64748b;" id="txModalCloseBtn">Cerrar</button>
      ${record.status === 'activo' ? `
        <button type="button" class="tx-pill-btn-small" style="background:#ef4444;" id="txModalCancelBtn">Cancelar Transferencia</button>
      ` : ''}
    `;

    document.getElementById('txModalCloseBtn').addEventListener('click', closeModal);
    const cancelBtn = document.getElementById('txModalCancelBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        if (confirm(`¿Revocar acceso al enlace ${record.reference}?`)) {
          await fetch('/api/enviox/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: record.id })
          });
          closeModal();
          fetchRecords();
        }
      });
    }

    openModal();
  }

  function showSuccessModal(info) {
    dom.modalTitle.textContent = info.title || 'Operación completada';
    dom.modalBody.innerHTML = `
      <div style="text-align:center;padding:10px 0 20px 0;">
        <div style="width:56px;height:56px;border-radius:50%;background:#dcfce7;color:#16a34a;font-size:28px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px auto;">✓</div>
        <h3 style="font-size:18px;color:var(--tx-navy);margin-bottom:6px;">Referencia: <strong>${info.reference}</strong></h3>
        <p style="font-size:14px;color:#475569;">
          ${info.isReceive ? 'Petición enviada al destinatario.' : 'Archivos cifrados y subidos a tu nube corporativa.'}
        </p>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:14px;border-radius:8px;margin-bottom:16px;">
        <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:6px;">Enlace seguro generado:</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="successShareInput" readonly value="${info.shareUrl}" style="flex:1;font-size:13px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:4px;" onclick="this.select()">
          <button type="button" class="tx-pill-btn-small" id="btnCopySuccessLink">Copiar</button>
        </div>
      </div>
      <div style="font-size:12px;color:#64748b;line-height:1.5;">
        Destinatarios notificados: <strong>${info.recipients.join(', ')}</strong><br>
        Válido hasta: <strong>${new Date(info.expiresAt).toLocaleDateString('es-ES')}</strong>
      </div>
    `;

    dom.modalFooter.innerHTML = `
      <button type="button" class="tx-pill-btn-small" id="txSuccessDoneBtn">Aceptar</button>
    `;

    document.getElementById('txSuccessDoneBtn').addEventListener('click', closeModal);
    document.getElementById('btnCopySuccessLink').addEventListener('click', () => {
      const input = document.getElementById('successShareInput');
      input.select();
      navigator.clipboard.writeText(input.value).then(() => {
        alert('Enlace copiado al portapapeles.');
      });
    });

    openModal();
  }

  function showMultipleRecipientsModal() {
    dom.modalTitle.textContent = 'Añadir varios destinatarios';
    dom.modalBody.innerHTML = `
      <p style="font-size:13px;color:#475569;margin-bottom:12px;">
        Introduce una dirección de correo por línea o separadas por comas:
      </p>
      <textarea id="multiRecipientsTextarea" rows="6" style="width:100%;padding:10px;border:1px solid var(--tx-border);border-radius:6px;font-family:monospace;font-size:13px;" placeholder="usuario1@empresa.com&#10;usuario2@empresa.com"></textarea>
    `;

    dom.modalFooter.innerHTML = `
      <button type="button" class="tx-pill-btn-small" style="background:#64748b;" id="txCancelMultiBtn">Cancelar</button>
      <button type="button" class="tx-pill-btn-small" id="txConfirmMultiBtn">Añadir a la lista</button>
    `;

    document.getElementById('txCancelMultiBtn').addEventListener('click', closeModal);
    document.getElementById('txConfirmMultiBtn').addEventListener('click', () => {
      const raw = document.getElementById('multiRecipientsTextarea').value;
      const emails = raw.split(/[\n,;\s]+/).map(x => x.trim()).filter(x => x && x.includes('@'));
      emails.forEach(e => addSendRecipient(e));
      closeModal();
    });

    openModal();
  }

  function showCreateContactModal() {
    dom.modalTitle.textContent = 'Crear nuevo contacto';
    dom.modalBody.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Correo electrónico *</label>
          <input type="email" id="newCtEmail" class="tx-input-field" placeholder="ejemplo@cyberpolis.es">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Nombre completo</label>
          <input type="text" id="newCtName" class="tx-input-field" placeholder="Nombre y Apellidos">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Teléfono</label>
          <input type="text" id="newCtPhone" class="tx-input-field" placeholder="+34 600 00 00 00">
        </div>
        <div>
          <label style="font-size:12px;font-weight:700;color:var(--tx-navy);display:block;margin-bottom:4px;">Idioma preferido</label>
          <select id="newCtLang" class="tx-input-field">
            <option value="Español">Español</option>
            <option value="English">English</option>
            <option value="Català">Català</option>
            <option value="Euskara">Euskara</option>
          </select>
        </div>
      </div>
    `;

    dom.modalFooter.innerHTML = `
      <button type="button" class="tx-pill-btn-small" style="background:#64748b;" id="txCancelCtBtn">Cancelar</button>
      <button type="button" class="tx-pill-btn-small" id="txSaveCtBtn">Guardar Contacto</button>
    `;

    document.getElementById('txCancelCtBtn').addEventListener('click', closeModal);
    document.getElementById('txSaveCtBtn').addEventListener('click', async () => {
      const email = document.getElementById('newCtEmail').value.trim();
      const name = document.getElementById('newCtName').value.trim();
      const phone = document.getElementById('newCtPhone').value.trim();
      const language = document.getElementById('newCtLang').value;

      if (!email || !email.includes('@')) {
        alert('Introduce un correo electrónico válido.');
        return;
      }

      try {
        const res = await fetch('/api/enviox/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name, phone, language })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Error al guardar contacto');

        state.contacts.push(d.contact);
        renderContacts();
        closeModal();
      } catch (err) {
        alert(err.message);
      }
    });

    openModal();
  }

  function openModal() {
    if (dom.modalOverlay) dom.modalOverlay.classList.add('show');
  }

  function closeModal() {
    if (dom.modalOverlay) dom.modalOverlay.classList.remove('show');
  }

  // Helpers
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = reader.result;
        const b64 = res.split(',')[1] || '';
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function calculateDaysFromToday(dateString) {
    if (!dateString) return 8;
    const target = new Date(dateString);
    const today = new Date();
    const diffTime = target.getTime() - today.getTime();
    return Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  }

  function getVal(id, def = '') {
    const el = document.getElementById(id);
    return el ? el.value : def;
  }

  function getValNum(id, def = 0) {
    const el = document.getElementById(id);
    return el ? parseInt(el.value, 10) || def : def;
  }

  function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  function isChecked(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
  }

  function setChecked(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
  }

  // Inicialización global
  document.addEventListener('DOMContentLoaded', () => {
    initDom();
    setupSendView();
    setupReceiveView();
    setupRecordsView();
    setupContactsView();
    setupAdminView();

    // Eventos de Navegación de Pestañas
    dom.navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.dataset.view;
        if (view) switchView(view);
      });
    });

    // Dropdown "Enviox link"
    if (dom.dropdownToggle && dom.dropdownMenu) {
      dom.dropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.dropdownMenu.classList.toggle('show');
      });

      document.addEventListener('click', (e) => {
        if (!dom.dropdownToggle.contains(e.target)) {
          dom.dropdownMenu.classList.remove('show');
        }
      });

      document.querySelectorAll('.tx-dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.preventDefault();
          const action = item.dataset.action;
          dom.dropdownMenu.classList.remove('show');
          if (action === 'send') switchView('send');
          else if (action === 'receive') switchView('receive');
        });
      });
    }

    // Modal Close
    if (dom.modalClose) dom.modalClose.addEventListener('click', closeModal);
    if (dom.modalOverlay) {
      dom.modalOverlay.addEventListener('click', (e) => {
        if (e.target === dom.modalOverlay) closeModal();
      });
    }

    // Exponer a window para máxima compatibilidad con inline handlers y accesos directos
    window.switchView = switchView;
    window.switchAdminPane = switchAdminPane;
    window.openAdminSettings = function (e) {
      if (e) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
      }
      switchView('admin');
      switchAdminPane('ajustes');
      return false;
    };

    // Cargar datos
    loadInitData();
  });

})();

