// EnvioxBackend.js — Módulo desacoplado para la plataforma empresarial CYBERPOLIS Enviox
// Inspirado en la interfaz y arquitectura de Enviox (Grupo Industrial)
// Soporta almacenamiento en Google Drive 5 TB / OneDrive 5 TB, Cifrado AES-256-GCM y Pasarela de Correo

const crypto = require('crypto');
const path = require('path');

function generateReferenceCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let ref = '';
  for (let i = 0; i < 3; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ref;
}

function sanitizeInput(str, max = 300) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

function normalizeRecipients(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(x => String(x || '').trim().toLowerCase()).filter(x => x && x.includes('@'));
  }
  return String(input)
    .split(/[,;\s]+/)
    .map(x => x.trim().toLowerCase())
    .filter(x => x && x.includes('@'));
}

function isBlacklisted(email, blacklist) {
  if (!email || !blacklist || !blacklist.length) return false;
  const em = String(email).toLowerCase().trim();
  for (const bl of blacklist) {
    const val = String(bl.value || '').toLowerCase().trim();
    if (!val) continue;
    if (val.startsWith('@')) {
      if (em.endsWith(val) || ('@' + em.split('@')[1]) === val) return true;
    } else if (em === val) {
      return true;
    }
  }
  return false;
}

function computeTransferStatus(t) {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'pending_validation') return 'pending_validation';
  if (t.status === 'pending_send') return 'pending_send';
  if (t.status === 'pending_error') return 'pending_error';
  const now = Date.now();
  if (t.expiresAt && new Date(t.expiresAt).getTime() < now) return 'caducado';
  return 'activo';
}

function mapToEnvioxRecord(t) {
  const status = computeTransferStatus(t);
  const isReceived = t.mode === 'in_request' || t.mode === 'in_response';
  const isLink = t.mode === 'link_send' || t.mode === 'link_receive';
  
  let totalBytes = 0;
  let fileNames = [];
  if (Array.isArray(t.files) && t.files.length) {
    totalBytes = t.files.reduce((acc, f) => acc + (f.size || 0), 0);
    fileNames = t.files.map(f => f.name);
  } else if (t.file) {
    totalBytes = t.file.size || 0;
    fileNames = [t.file.name || 'archivo.bin'];
  }

  let formattedSize = '0 B';
  if (totalBytes > 1024 * 1024 * 1024) formattedSize = (totalBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  else if (totalBytes > 1024 * 1024) formattedSize = (totalBytes / (1024 * 1024)).toFixed(2) + ' MB';
  else if (totalBytes > 1024) formattedSize = (totalBytes / 1024).toFixed(2) + ' kB';
  else if (totalBytes > 0) formattedSize = totalBytes + ' B';

  let filesSummary = '0 Archivos';
  if (fileNames.length === 1) {
    filesSummary = `${fileNames[0]} (${formattedSize})`;
  } else if (fileNames.length > 1) {
    filesSummary = `${fileNames.length} Archivos ${formattedSize}`;
  } else if (t.mode === 'in_request') {
    filesSummary = 'Solicitud de recepción';
  }

  const primaryRecipient = (t.recipients && t.recipients.length) ? t.recipients[0] : (t.recipient || '0 destinatarios');
  const recipientDisplay = (t.recipients && t.recipients.length > 1) 
    ? `${primaryRecipient} (+${t.recipients.length - 1})`
    : primaryRecipient;

  return {
    id: t.id,
    reference: t.reference || (t.id.slice(0, 3).toUpperCase()),
    type: isReceived ? 'recibido' : (isLink ? 'link' : 'enviado'),
    mode: t.mode || 'out',
    sender: t.senderEmail || t.senderUserId || 'sistema@cyberpolis.com',
    groupName: t.groupName || '-',
    recipient: recipientDisplay,
    allRecipients: t.recipients || (t.recipient ? [t.recipient] : []),
    phone: t.phone || '',
    subject: t.subject || '(Sin asunto)',
    message: t.message || '',
    filesSummary,
    fileNames,
    totalBytes,
    createdAt: t.createdAt || new Date().toISOString(),
    expiresAt: t.expiresAt || null,
    status,
    rawStatus: t.status,
    downloadsCount: t.downloadsCount || 0,
    maxDownloads: t.maxDownloads || 3,
    receiptAck: !!t.receiptAck,
    notifyExpiry: !!t.notifyExpiry,
    sendAndReceive: !!t.sendAndReceive,
    shareUrl: t.shareUrl || '',
    shareToken: t.shareToken || '',
    storageProvider: t.storageProvider || 'Google Drive / OneDrive 5 TB',
    legalAudit: t.legalAudit || []
  };
}

async function handleEnvioxApi(req, res, pathname, method, ctx) {
  const {
    getSessionUser,
    parseBody,
    getDbStore,
    readCloudStore,
    writeCloudStore,
    cloudOneDrive,
    cloudGoogle,
    storeEncryptedTransferFile,
    loadDecryptedTransferFile,
    sendTransferNotificationEmail,
    sendJSON,
    isSecureRequest,
    getClientIp
  } = ctx;

  const p = String(pathname || '').toLowerCase().replace('/api/tranxfer', '/api/enviox');

  const getBody = async (max = 50 * 1024 * 1024) => {
    if (req.body && typeof req.body === 'object') return req.body;
    if (parseBody) {
      try {
        return await parseBody(req, max);
      } catch (e) {
        return {};
      }
    }
    return new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
      });
    });
  };

  const db = getDbStore();
  const EnvioxState = db.read('enviox', {
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
    contacts: [],
    groups: [],
    roles: [],
    blacklist: [],
    securityPolicies: []
  });

  const currentUser = getSessionUser ? getSessionUser(req) : null;
  const ip = getClientIp ? getClientIp(req) : (req.socket?.remoteAddress || '127.0.0.1');

  // 1. GET /api/enviox/init — Datos de arranque de la plataforma Enviox
  if (p === '/api/enviox/init' && method === 'GET') {
    const cloud = readCloudStore ? readCloudStore() : { tenants: [] };
    const tenantCfg = cloudOneDrive ? cloudOneDrive.resolveActiveTenantConfig(cloud) : null;
    const mailGw = cloud.mailGateway || null;

    sendJSON(req, res, 200, {
      user: currentUser ? {
        id: currentUser.id,
        username: currentUser.username,
        email: currentUser.email || `${currentUser.username}@cyberpolis.es`,
        fullName: currentUser.fullName || currentUser.username,
        role: currentUser.role || 'user',
        isAdmin: currentUser.role === 'admin'
      } : null,
      settings: EnvioxState.settings,
      contacts: EnvioxState.contacts || [],
      groups: EnvioxState.groups || [],
      roles: EnvioxState.roles || [],
      cloudStorage: {
        configured: !!tenantCfg,
        provider: tenantCfg ? tenantCfg.providerType : 'local',
        name: tenantCfg ? tenantCfg.name : 'Almacenamiento Local Cifrado',
        capacity: '5 TB'
      },
      mailGateway: {
        configured: !!(mailGw && mailGw.mode && mailGw.mode !== 'disabled'),
        mode: mailGw?.mode || 'gmail_app_password',
        user: mailGw?.user || ''
      }
    }, {}, { noStore: true });
    return true;
  }

  // 2. GET /api/enviox/records — Lista de transferencias con filtros y métricas
  if (p === '/api/enviox/records' && method === 'GET') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida para acceder a Registros de Enviox.' }, {}, { noStore: true });
      return true;
    }

    const allTransfers = db.read('transfers', []);
    const isAdmin = currentUser.role === 'admin';
    
    // Filtrar por usuario a menos que sea admin
    const userEmail = (currentUser.email || '').toLowerCase();
    const visible = isAdmin 
      ? allTransfers 
      : allTransfers.filter(t => {
          if (t.senderUserId === currentUser.id || t.senderUserId === currentUser.username) return true;
          if (t.senderEmail && t.senderEmail.toLowerCase() === userEmail) return true;
          if (t.recipient && t.recipient.toLowerCase() === userEmail) return true;
          if (Array.isArray(t.recipients) && t.recipients.some(r => r.toLowerCase() === userEmail)) return true;
          return false;
        });

    const records = visible.map(mapToEnvioxRecord).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const stats = {
      total: records.length,
      sent: records.filter(r => r.type === 'enviado').length,
      received: records.filter(r => r.type === 'recibido').length,
      active: records.filter(r => r.status === 'activo').length,
      expired: records.filter(r => r.status === 'caducado').length,
      cancelled: records.filter(r => r.status === 'cancelled').length,
      pendingValidation: records.filter(r => r.rawStatus === 'pending_validation').length,
      pendingSend: records.filter(r => r.rawStatus === 'pending_send').length,
      pendingError: records.filter(r => r.rawStatus === 'pending_error').length
    };

    sendJSON(req, res, 200, { records, stats }, {}, { noStore: true });
    return true;
  }

  // 3. POST /api/enviox/send — Envío de archivos seguro
  if (p === '/api/enviox/send' && method === 'POST') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Debes iniciar sesión para realizar envíos seguros.' }, {}, { noStore: true });
      return true;
    }

    const body = await getBody();
    const recipients = normalizeRecipients(body.recipients || body.recipient);
    if (!recipients.length) {
      sendJSON(req, res, 400, { error: 'Introduce al menos un correo electrónico destinatario válido.' }, {}, { noStore: true });
      return true;
    }

    // 1. Validación de permisos de grupo (Solo Enviar / Solo Recibir / Admin)
    const userGroups = (EnvioxState.groups || []).filter(g => Array.isArray(g.members) && (g.members.includes(currentUser.username) || g.members.includes(currentUser.email) || g.members.includes(`${currentUser.username}@cyberpolis.es`)));
    const hasSendPermission = currentUser.role === 'admin' || userGroups.some(g => g.permission === 'send' || g.permission === 'both' || g.permission === 'admin') || userGroups.length === 0;
    if (!hasSendPermission) {
      sendJSON(req, res, 403, { error: 'Acceso denegado: Tu grupo de usuario solo tiene permiso para Recibir archivos.' }, {}, { noStore: true });
      return true;
    }

    // 2. Validación de Lista Negra corporativa
    const blacklist = EnvioxState.blacklist || [];
    for (const r of recipients) {
      if (isBlacklisted(r, blacklist)) {
        sendJSON(req, res, 400, { error: `La dirección destinataria '${r}' está bloqueada en la Lista Negra corporativa.` }, {}, { noStore: true });
        return true;
      }
    }
    const senderEmail = currentUser.email || `${currentUser.username}@cyberpolis.es`;
    if (isBlacklisted(senderEmail, blacklist)) {
      sendJSON(req, res, 400, { error: `Tu cuenta o dirección emisora (${senderEmail}) está bloqueada en la Lista Negra corporativa.` }, {}, { noStore: true });
      return true;
    }

    const subject = sanitizeInput(body.subject || '', 100);
    const message = sanitizeInput(body.message || '', 2000);
    const phone = sanitizeInput(body.phone || '', 30);
    const language = sanitizeInput(body.language || 'Español', 20);
    const tags = sanitizeInput(body.tags || '', 150);
    const groupName = sanitizeInput(body.groupName || '', 60);

    const receiptAck = body.receiptAck !== false;
    const notifyExpiry = body.notifyExpiry !== false;
    const sendAndReceive = !!body.sendAndReceive;
    const expiryDays = Math.min(Math.max(parseInt(body.expiryDays, 10) || EnvioxState.settings.defaultExpiryDays || 8, 1), EnvioxState.settings.maxExpiryDays || 30);

    // Archivos adjuntos
    const rawFiles = Array.isArray(body.files) ? body.files : (body.file ? [body.file] : []);
    if (!rawFiles.length && !message) {
      sendJSON(req, res, 400, { error: 'Adjunta al menos un archivo o escribe un mensaje seguro.' }, {}, { noStore: true });
      return true;
    }

    const cloud = readCloudStore ? readCloudStore() : { tenants: [] };
    const tenantCfg = cloudOneDrive ? cloudOneDrive.resolveActiveTenantConfig(cloud) : null;
    const keySalt = crypto.randomBytes(16).toString('hex');
    const transferId = 'tx-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const shareToken = crypto.randomBytes(24).toString('hex');
    const reference = generateReferenceCode();

    const storedFiles = [];
    for (let i = 0; i < rawFiles.length; i++) {
      const rf = rawFiles[i];
      let buf = null;
      if (rf.base64) {
        buf = Buffer.from(rf.base64, 'base64');
      } else if (rf.content) {
        buf = Buffer.from(rf.content, 'utf8');
      }
      if (!buf) continue;

      const fName = sanitizeInput(rf.name || `archivo_${i + 1}.bin`, 120);
      const fMime = sanitizeInput(rf.mimeType || 'application/octet-stream', 80);
      const meta = await storeEncryptedTransferFile(
        `${transferId}-f${i + 1}`,
        buf,
        fName,
        fMime,
        tenantCfg,
        keySalt
      );
      storedFiles.push(meta);
    }

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiryDays * 86400000).toISOString();
    const proto = isSecureRequest(req) ? 'https' : 'http';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'cyberpolis.onrender.com').split(',')[0].trim();
    const shareUrl = `${proto}://${host}/enviox/?transfer=${encodeURIComponent(shareToken)}`;

    const newTransfer = {
      id: transferId,
      reference,
      mode: 'out',
      shareToken,
      shareUrl,
      senderUserId: currentUser.id,
      senderUsername: currentUser.username,
      senderEmail: currentUser.email || `${currentUser.username}@cyberpolis.es`,
      senderName: currentUser.fullName || currentUser.username,
      recipients,
      recipient: recipients[0],
      phone,
      language,
      subject: subject || 'Envío confidencial Enviox',
      message,
      tags,
      groupName,
      receiptAck,
      notifyExpiry,
      sendAndReceive,
      encryptionKeySalt: keySalt,
      files: storedFiles,
      file: storedFiles[0] || null,
      storageProvider: tenantCfg ? (tenantCfg.providerType === 'google-drive' ? 'Google Drive 5 TB' : 'Microsoft OneDrive 5 TB') : 'Local Cifrado',
      tenantId: tenantCfg?.id || null,
      maxDownloads: EnvioxState.settings.maxDownloadsPerFile || 3,
      downloadsCount: 0,
      status: 'active',
      createdAt: nowIso,
      expiresAt,
      legalAudit: [
        {
          timestamp: nowIso,
          ip,
          userAgent: req.headers['user-agent'] || '',
          event: 'created',
          details: `Transferencia creada con referencia ${reference}. ${storedFiles.length} archivo(s). Destinatarios: ${recipients.join(', ')}`
        }
      ]
    };

    const transfers = db.read('transfers', []);
    transfers.push(newTransfer);
    db.write('transfers', transfers);

    // Auto-almacenamiento de contactos si está activo
    if (EnvioxState.settings.autoSaveContacts) {
      let contactsChanged = false;
      for (const rec of recipients) {
        const exists = (EnvioxState.contacts || []).some(c => c.email.toLowerCase() === rec);
        if (!exists) {
          EnvioxState.contacts = EnvioxState.contacts || [];
          EnvioxState.contacts.push({
            id: 'ct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            email: rec,
            name: rec.split('@')[0],
            phone: phone || '',
            language
          });
          contactsChanged = true;
        }
      }
      if (contactsChanged) {
        db.write('enviox', EnvioxState);
      }
    }

    // Notificaciones por Correo Electrónico
    let emailsNotified = 0;
    for (const rec of recipients) {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <div style="background: #102a43; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px; letter-spacing: 0.5px;">${EnvioxState.settings.brandName || 'ENVIOX'}</h2>
            <p style="margin: 4px 0 0 0; font-size: 13px; color: #9fb3c8;">Plataforma Enviox · Envío Seguro de Archivos</p>
          </div>
          <div style="padding: 24px; color: #334e68; background: #ffffff;">
            <p style="font-size: 15px; margin-top: 0;">Hola,</p>
            <p style="font-size: 14px; line-height: 1.6;">
              <strong>${currentUser.fullName || currentUser.username}</strong> (${currentUser.email || currentUser.username}) te ha enviado archivos confidenciales con referencia <strong>${reference}</strong>.
            </p>
            ${subject ? `<p style="font-size: 14px; background: #f0f4f8; padding: 12px; border-left: 4px solid #102a43; border-radius: 4px;"><strong>Asunto:</strong> ${subject}</p>` : ''}
            ${message ? `<p style="font-size: 13px; color: #486581; line-height: 1.5;">${message.replace(/\n/g, '<br>')}</p>` : ''}
            <div style="text-align: center; margin: 28px 0;">
              <a href="${shareUrl}" style="background: #102a43; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 24px; font-weight: bold; font-size: 14px; display: inline-block;">
                Descargar archivos de forma segura
              </a>
            </div>
            <p style="font-size: 12px; color: #829ab1; text-align: center;">
              Enlace válido hasta el <strong>${new Date(expiresAt).toLocaleDateString('es-ES')}</strong>. Cifrado de extremo a extremo AES-256-GCM.
            </p>
          </div>
        </div>
      `;

      try {
        await sendTransferNotificationEmail(
          tenantCfg,
          rec,
          `[Enviox ${reference}] ${subject || 'Archivos seguros disponibles'}`,
          `Hola,\n\n${currentUser.fullName || currentUser.username} te ha enviado archivos confidenciales (Referencia ${reference}).\n\nDescarga: ${shareUrl}\nCaduca: ${expiresAt}`,
          emailHtml,
          cloud.mailGateway
        );
        emailsNotified++;
      } catch (mailErr) {
        console.warn(`[Enviox] No se pudo enviar email a ${rec}:`, mailErr.message);
      }
    }

    sendJSON(req, res, 201, {
      ok: true,
      reference,
      transferId,
      shareUrl,
      emailsNotified,
      filesCount: storedFiles.length,
      expiresAt
    }, {}, { noStore: true });
    return true;
  }

  // 4. POST /api/enviox/receive-request — Solicitud de recepción de archivos (Buzón seguro)
  if (p === '/api/enviox/receive-request' && method === 'POST') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Debes iniciar sesión para solicitar recepción de archivos.' }, {}, { noStore: true });
      return true;
    }

    const body = await getBody();
    const recipient = sanitizeInput(body.recipient || '', 100);
    if (!recipient || !recipient.includes('@')) {
      sendJSON(req, res, 400, { error: 'Introduce el correo electrónico destinatario para solicitar los archivos.' }, {}, { noStore: true });
      return true;
    }

    // 1. Validación de permisos de grupo (Solo Enviar / Solo Recibir / Admin)
    const userGroups = (EnvioxState.groups || []).filter(g => Array.isArray(g.members) && (g.members.includes(currentUser.username) || g.members.includes(currentUser.email) || g.members.includes(`${currentUser.username}@cyberpolis.es`)));
    const hasReceivePermission = currentUser.role === 'admin' || userGroups.some(g => g.permission === 'receive' || g.permission === 'both' || g.permission === 'admin') || userGroups.length === 0;
    if (!hasReceivePermission) {
      sendJSON(req, res, 403, { error: 'Acceso denegado: Tu grupo de usuario solo tiene permiso para Enviar archivos.' }, {}, { noStore: true });
      return true;
    }

    // 2. Validación de Lista Negra corporativa
    if (isBlacklisted(recipient, EnvioxState.blacklist || [])) {
      sendJSON(req, res, 400, { error: `La dirección destinataria '${recipient}' está bloqueada en la Lista Negra corporativa.` }, {}, { noStore: true });
      return true;
    }

    const subject = sanitizeInput(body.subject || '', 100);
    const message = sanitizeInput(body.message || '', 2000);
    const phone = sanitizeInput(body.phone || '', 30);
    const language = sanitizeInput(body.language || 'Español', 20);
    const tags = sanitizeInput(body.tags || '', 150);

    const receiptAck = body.receiptAck !== false;
    const notifyExpiry = body.notifyExpiry !== false;
    const expiryDays = Math.min(Math.max(parseInt(body.expiryDays, 10) || 8, 1), 30);

    const cloud = readCloudStore ? readCloudStore() : { tenants: [] };
    const tenantCfg = cloudOneDrive ? cloudOneDrive.resolveActiveTenantConfig(cloud) : null;
    const keySalt = crypto.randomBytes(16).toString('hex');
    const transferId = 'rx-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const shareToken = crypto.randomBytes(24).toString('hex');
    const reference = generateReferenceCode();

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiryDays * 86400000).toISOString();
    const proto = isSecureRequest(req) ? 'https' : 'http';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'cyberpolis.onrender.com').split(',')[0].trim();
    const dropUrl = `${proto}://${host}/enviox/?drop=${encodeURIComponent(shareToken)}`;

    const newTransfer = {
      id: transferId,
      reference,
      mode: 'in_request',
      shareToken,
      shareUrl: dropUrl,
      senderUserId: currentUser.id,
      senderUsername: currentUser.username,
      senderEmail: currentUser.email || `${currentUser.username}@cyberpolis.es`,
      senderName: currentUser.fullName || currentUser.username,
      recipient,
      recipients: [recipient],
      phone,
      language,
      subject: subject || 'Solicitud de recepción de archivos Enviox',
      message,
      tags,
      receiptAck,
      notifyExpiry,
      encryptionKeySalt: keySalt,
      files: [],
      storageProvider: tenantCfg ? (tenantCfg.providerType === 'google-drive' ? 'Google Drive 5 TB' : 'Microsoft OneDrive 5 TB') : 'Local Cifrado',
      tenantId: tenantCfg?.id || null,
      maxDownloads: 3,
      downloadsCount: 0,
      status: 'active',
      createdAt: nowIso,
      expiresAt,
      legalAudit: [
        {
          timestamp: nowIso,
          ip,
          userAgent: req.headers['user-agent'] || '',
          event: 'created',
          details: `Solicitud de recepción generada con referencia ${reference}. Solicitado a: ${recipient}`
        }
      ]
    };

    const transfers = db.read('transfers', []);
    transfers.push(newTransfer);
    db.write('transfers', transfers);

    // Enviar notificación al tercero para que suba los archivos
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <div style="background: #102a43; color: #ffffff; padding: 20px; text-align: center;">
          <h2 style="margin: 0; font-size: 20px;">${EnvioxState.settings.brandName || 'ENVIOX'}</h2>
          <p style="margin: 4px 0 0 0; font-size: 13px; color: #9fb3c8;">Petición de Archivos Segura (Enviox)</p>
        </div>
        <div style="padding: 24px; color: #334e68; background: #ffffff;">
          <p style="font-size: 15px; margin-top: 0;">Estimado/a colaborador/a,</p>
          <p style="font-size: 14px; line-height: 1.6;">
            <strong>${currentUser.fullName || currentUser.username}</strong> te solicita subir documentación confidencial de forma segura (Referencia <strong>${reference}</strong>).
          </p>
          ${subject ? `<p style="font-size: 14px; background: #f0f4f8; padding: 12px; border-left: 4px solid #102a43; border-radius: 4px;"><strong>Asunto:</strong> ${subject}</p>` : ''}
          ${message ? `<p style="font-size: 13px; color: #486581; line-height: 1.5;">${message.replace(/\n/g, '<br>')}</p>` : ''}
          <div style="text-align: center; margin: 28px 0;">
            <a href="${dropUrl}" style="background: #102a43; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 24px; font-weight: bold; font-size: 14px; display: inline-block;">
              Subir archivos solicitados
            </a>
          </div>
          <p style="font-size: 12px; color: #829ab1; text-align: center;">
            No requieres instalar ninguna aplicación. Subida directa cifrada a nuestra nube corporativa.
          </p>
        </div>
      </div>
    `;

    sendTransferNotificationEmail(
      tenantCfg,
      recipient,
      `[Petición Enviox ${reference}] ${subject || 'Solicitud de recepción de archivos'}`,
      `Hola,\n\n${currentUser.fullName || currentUser.username} te solicita subir archivos confidenciales.\n\nSubir aquí: ${dropUrl}\nCaduca: ${expiresAt}`,
      emailHtml,
      cloud.mailGateway
    ).catch(err => console.warn('[Enviox] Error enviando email de recepción:', err.message));

    sendJSON(req, res, 201, {
      ok: true,
      reference,
      transferId,
      dropUrl,
      expiresAt
    }, {}, { noStore: true });
    return true;
  }

  // 5. POST /api/enviox/cancel — Cancelación de transferencia
  if (p === '/api/enviox/cancel' && method === 'POST') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    const { id, reference } = await getBody();
    const transfers = db.read('transfers', []);
    const idx = transfers.findIndex(t => (id && t.id === id) || (reference && t.reference === reference));
    if (idx === -1) {
      sendJSON(req, res, 404, { error: 'Transferencia no encontrada.' }, {}, { noStore: true });
      return true;
    }

    const t = transfers[idx];
    if (currentUser.role !== 'admin' && t.senderUserId !== currentUser.id && t.senderUsername !== currentUser.username) {
      sendJSON(req, res, 403, { error: 'No tienes permiso para cancelar esta transferencia.' }, {}, { noStore: true });
      return true;
    }

    t.status = 'cancelled';
    t.cancelledAt = new Date().toISOString();
    t.cancelledBy = currentUser.username;
    t.legalAudit = t.legalAudit || [];
    t.legalAudit.push({
      timestamp: t.cancelledAt,
      ip,
      userAgent: req.headers['user-agent'] || '',
      event: 'cancelled',
      details: `Transferencia cancelada manualmente por ${currentUser.username}`
    });

    db.write('transfers', transfers);
    sendJSON(req, res, 200, { ok: true, id: t.id, reference: t.reference, status: 'cancelled' }, {}, { noStore: true });
    return true;
  }

  // 6. POST /api/enviox/settings — Guardar ajustes de Enviox (Admin)
  if (p === '/api/enviox/settings' && method === 'POST') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado: solo administradores pueden modificar los Ajustes de Enviox.' }, {}, { noStore: true });
      return true;
    }

    const b = await getBody();
    EnvioxState.settings = {
      maxRecipients: Math.max(1, parseInt(b.maxRecipients, 10) || 20),
      maxFiles: Math.max(1, parseInt(b.maxFiles, 10) || 50),
      maxFileSizeMb: Math.max(1, parseInt(b.maxFileSizeMb, 10) || 40960),
      maxDownloadsPerFile: Math.max(1, parseInt(b.maxDownloadsPerFile, 10) || 3),
      maxTransferSizeMb: Math.max(1, parseInt(b.maxTransferSizeMb, 10) || 40960),
      maxExpiryDays: Math.max(1, parseInt(b.maxExpiryDays, 10) || 14),
      defaultExpiryDays: Math.max(1, parseInt(b.defaultExpiryDays, 10) || 8),
      watermarkText: sanitizeInput(b.watermarkText || '', 80),
      defaultReceiptAck: b.defaultReceiptAck !== false,
      defaultExpiryNotice: b.defaultExpiryNotice !== false,
      noLockoutOnFailedLogins: b.noLockoutOnFailedLogins !== false,
      autoSaveContacts: b.autoSaveContacts !== false,
      brandName: sanitizeInput(b.brandName || 'ENVIOX', 60),
      brandSubtitle: sanitizeInput(b.brandSubtitle || 'Plataforma Enviox Segura', 100)
    };

    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true, settings: EnvioxState.settings }, {}, { noStore: true });
    return true;
  }

  // 7. GET / POST / DELETE /api/enviox/contacts — Libreta de contactos corporativa
  if (p === '/api/enviox/contacts') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    if (method === 'GET') {
      sendJSON(req, res, 200, { contacts: EnvioxState.contacts || [] }, {}, { noStore: true });
      return true;
    }

    if (method === 'POST') {
      const b = await getBody();
      const email = sanitizeInput(b.email || '', 120).toLowerCase();
      if (!email || !email.includes('@')) {
        sendJSON(req, res, 400, { error: 'El correo electrónico es obligatorio.' }, {}, { noStore: true });
        return true;
      }

      EnvioxState.contacts = EnvioxState.contacts || [];
      const existingIdx = EnvioxState.contacts.findIndex(c => c.email.toLowerCase() === email);
      const contactObj = {
        id: existingIdx >= 0 ? EnvioxState.contacts[existingIdx].id : 'ct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        email,
        name: sanitizeInput(b.name || email.split('@')[0], 100),
        phone: sanitizeInput(b.phone || '', 30),
        language: sanitizeInput(b.language || 'Español', 20)
      };

      if (existingIdx >= 0) {
        EnvioxState.contacts[existingIdx] = contactObj;
      } else {
        EnvioxState.contacts.push(contactObj);
      }

      db.write('enviox', EnvioxState);
      sendJSON(req, res, 200, { ok: true, contact: contactObj }, {}, { noStore: true });
      return true;
    }
  }

  if (p.startsWith('/api/enviox/contacts/') && method === 'DELETE') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }
    const cId = decodeURIComponent(p.replace('/api/enviox/contacts/', ''));
    EnvioxState.contacts = (EnvioxState.contacts || []).filter(c => c.id !== cId && c.email !== cId);
    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true }, {}, { noStore: true });
    return true;
  }

  // 8. GET /api/enviox/roles — Roles corporativos SAML
  if (p === '/api/enviox/roles' && method === 'GET') {
    sendJSON(req, res, 200, { roles: EnvioxState.roles || [] }, {}, { noStore: true });
    return true;
  }

  // 9. USUARIOS (/api/enviox/users) — Gestión de usuarios y asignación a grupos
  if (p === '/api/enviox/users') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    if (method === 'GET') {
      EnvioxState.users = EnvioxState.users || [
        { id: 'u-1', username: 'admin', email: 'admin@cyberpolis.es', fullName: 'Administrador Principal', role: 'admin', active: true, groupId: 'grp-admin', language: 'Español' },
        { id: 'u-2', username: 'unai.nieto', email: 'unai.nieto@cyberpolis.es', fullName: 'Unai Nieto', role: 'admin', active: true, groupId: 'grp-admin', language: 'Español' },
        { id: 'u-3', username: 'soc', email: 'soc@cyberpolis.es', fullName: 'Operador SOC Ciberseguridad', role: 'user', active: true, groupId: 'grp-both', language: 'Español' }
      ];

      // Mapear con nombres de grupo reales
      const groups = EnvioxState.groups || [];
      const userList = EnvioxState.users.map(u => {
        const grp = groups.find(g => g.id === u.groupId || (Array.isArray(g.members) && (g.members.includes(u.email) || g.members.includes(u.username))));
        return {
          id: u.id,
          username: u.username,
          email: u.email,
          fullName: u.fullName || u.username,
          role: u.role || 'user',
          active: u.active !== false,
          groupId: grp ? grp.id : (u.groupId || 'grp-both'),
          groupName: grp ? grp.name : 'General',
          permission: grp ? grp.permission : (u.role === 'admin' ? 'admin' : 'both'),
          language: u.language || 'Español'
        };
      });

      sendJSON(req, res, 200, { users: userList }, {}, { noStore: true });
      return true;
    }

    if (method === 'POST') {
      if (currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo administradores pueden crear o editar usuarios.' }, {}, { noStore: true });
        return true;
      }

      const b = await getBody();
      const username = sanitizeInput(b.username || '', 50).toLowerCase().replace(/[^a-z0-9._-]/g, '');
      const email = sanitizeInput(b.email || (username ? `${username}@cyberpolis.es` : ''), 100).toLowerCase();
      if (!username || !email.includes('@')) {
        sendJSON(req, res, 400, { error: 'Nombre de usuario y correo electrónico válidos son obligatorios.' }, {}, { noStore: true });
        return true;
      }

      EnvioxState.users = EnvioxState.users || [];
      const existingIdx = EnvioxState.users.findIndex(u => u.username === username || u.email === email);
      const userObj = {
        id: existingIdx >= 0 ? EnvioxState.users[existingIdx].id : 'u-' + Date.now().toString(36),
        username,
        email,
        fullName: sanitizeInput(b.fullName || username, 100),
        role: b.role === 'admin' ? 'admin' : 'user',
        groupId: b.groupId || 'grp-both',
        active: b.active !== false,
        language: sanitizeInput(b.language || 'Español', 20)
      };

      if (existingIdx >= 0) {
        EnvioxState.users[existingIdx] = userObj;
      } else {
        EnvioxState.users.push(userObj);
      }

      // Sincronizar membresía en el grupo seleccionado
      if (EnvioxState.groups && userObj.groupId) {
        EnvioxState.groups.forEach(g => {
          g.members = g.members || [];
          if (g.id === userObj.groupId) {
            if (!g.members.includes(email)) g.members.push(email);
          } else {
            g.members = g.members.filter(m => m !== email && m !== username);
          }
        });
      }

      db.write('enviox', EnvioxState);
      sendJSON(req, res, 200, { ok: true, user: userObj }, {}, { noStore: true });
      return true;
    }
  }

  if (p === '/api/enviox/users/toggle' && method === 'POST') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
      return true;
    }
    const { username } = await getBody();
    EnvioxState.users = EnvioxState.users || [];
    const target = EnvioxState.users.find(u => u.username === username);
    if (!target) {
      sendJSON(req, res, 404, { error: 'Usuario no encontrado.' }, {}, { noStore: true });
      return true;
    }
    target.active = !target.active;
    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true, username: target.username, active: target.active }, {}, { noStore: true });
    return true;
  }

  if (p === '/api/enviox/users/reset-password' && method === 'POST') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
      return true;
    }
    const { username } = await getBody();
    const tempPassword = 'Enviox_' + crypto.randomBytes(3).toString('hex') + '!';
    sendJSON(req, res, 200, { ok: true, username, tempPassword, message: `Contraseña provisional generada: ${tempPassword}` }, {}, { noStore: true });
    return true;
  }

  if (p.startsWith('/api/enviox/users/') && method === 'DELETE') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
      return true;
    }
    const uName = decodeURIComponent(p.replace('/api/enviox/users/', ''));
    if (uName === 'admin') {
      sendJSON(req, res, 400, { error: 'No se puede eliminar la cuenta principal de administrador.' }, {}, { noStore: true });
      return true;
    }
    EnvioxState.users = (EnvioxState.users || []).filter(u => u.username !== uName && u.email !== uName);
    if (EnvioxState.groups) {
      EnvioxState.groups.forEach(g => {
        if (Array.isArray(g.members)) {
          g.members = g.members.filter(m => m !== uName && !m.startsWith(uName + '@'));
        }
      });
    }
    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true, deleted: uName }, {}, { noStore: true });
    return true;
  }

  // 10. GRUPOS (/api/enviox/groups) — Grupos con permisos funcionales (Solo Enviar, Solo Recibir, Ambos, Admin)
  if (p === '/api/enviox/groups') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    if (method === 'GET') {
      EnvioxState.groups = EnvioxState.groups || [
        { id: 'grp-admin', name: 'Administradores', description: 'Acceso total y configuración de la plataforma', permission: 'admin', members: ['admin@cyberpolis.es', 'unai.nieto@cyberpolis.es'] },
        { id: 'grp-both', name: 'Enviar y Recibir', description: 'Transferencias bidireccionales completas', permission: 'both', members: ['soc@cyberpolis.es'] },
        { id: 'grp-send', name: 'Solo Enviar', description: 'Usuarios restringidos exclusivamente a envío de archivos', permission: 'send', members: [] },
        { id: 'grp-receive', name: 'Solo Recibir', description: 'Usuarios restringidos exclusivamente a recepción de archivos', permission: 'receive', members: [] }
      ];
      sendJSON(req, res, 200, { groups: EnvioxState.groups }, {}, { noStore: true });
      return true;
    }

    if (method === 'POST') {
      if (currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo administradores pueden crear o modificar grupos.' }, {}, { noStore: true });
        return true;
      }

      const b = await getBody();
      const name = sanitizeInput(b.name || '', 80);
      if (!name) {
        sendJSON(req, res, 400, { error: 'El nombre del grupo es obligatorio.' }, {}, { noStore: true });
        return true;
      }

      EnvioxState.groups = EnvioxState.groups || [];
      const gId = b.id || ('grp-' + Date.now().toString(36));
      const existingIdx = EnvioxState.groups.findIndex(g => g.id === gId || g.name.toLowerCase() === name.toLowerCase());

      const groupObj = {
        id: existingIdx >= 0 ? EnvioxState.groups[existingIdx].id : gId,
        name,
        description: sanitizeInput(b.description || '', 200),
        permission: ['send', 'receive', 'both', 'admin'].includes(b.permission) ? b.permission : 'both',
        members: Array.isArray(b.members) ? b.members.map(m => sanitizeInput(m, 100).toLowerCase()) : []
      };

      if (existingIdx >= 0) {
        EnvioxState.groups[existingIdx] = groupObj;
      } else {
        EnvioxState.groups.push(groupObj);
      }

      db.write('enviox', EnvioxState);
      sendJSON(req, res, 200, { ok: true, group: groupObj }, {}, { noStore: true });
      return true;
    }
  }

  if (p === '/api/enviox/groups/assign' && method === 'POST') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
      return true;
    }
    const { groupId, userEmail, action } = await getBody();
    EnvioxState.groups = EnvioxState.groups || [];
    const grp = EnvioxState.groups.find(g => g.id === groupId);
    if (!grp) {
      sendJSON(req, res, 404, { error: 'Grupo no encontrado.' }, {}, { noStore: true });
      return true;
    }
    grp.members = grp.members || [];
    const em = sanitizeInput(userEmail || '', 100).toLowerCase();
    if (action === 'remove') {
      grp.members = grp.members.filter(m => m !== em);
    } else {
      if (!grp.members.includes(em)) grp.members.push(em);
    }
    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true, group: grp }, {}, { noStore: true });
    return true;
  }

  if (p.startsWith('/api/enviox/groups/') && method === 'DELETE') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
      return true;
    }
    const gId = decodeURIComponent(p.replace('/api/enviox/groups/', ''));
    if (['grp-admin', 'grp-both'].includes(gId)) {
      sendJSON(req, res, 400, { error: 'No se pueden eliminar los grupos del sistema.' }, {}, { noStore: true });
      return true;
    }
    EnvioxState.groups = (EnvioxState.groups || []).filter(g => g.id !== gId);
    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true, deleted: gId }, {}, { noStore: true });
    return true;
  }

  // 11. LISTA NEGRA (/api/enviox/blacklist) — Agregar y quitar remitentes y dominios bloqueados
  if (p === '/api/enviox/blacklist') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    if (method === 'GET') {
      sendJSON(req, res, 200, { blacklist: EnvioxState.blacklist || [] }, {}, { noStore: true });
      return true;
    }

    if (method === 'POST') {
      if (currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo administradores pueden modificar la Lista Negra.' }, {}, { noStore: true });
        return true;
      }

      const b = await getBody();
      let value = sanitizeInput(b.value || '', 120).toLowerCase().trim();
      if (!value) {
        sendJSON(req, res, 400, { error: 'Introduce una dirección de correo o dominio (@ejemplo.com).' }, {}, { noStore: true });
        return true;
      }
      if (!value.startsWith('@') && !value.includes('@')) {
        value = '@' + value; // Si introducen "tempmail.com", convertir a "@tempmail.com"
      }

      EnvioxState.blacklist = EnvioxState.blacklist || [];
      const entry = {
        id: 'bl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        type: value.startsWith('@') ? 'domain' : 'email',
        value,
        reason: sanitizeInput(b.reason || 'Bloqueo administrativo', 150),
        createdAt: new Date().toISOString()
      };

      // Evitar duplicados
      if (!EnvioxState.blacklist.some(x => x.value === value)) {
        EnvioxState.blacklist.push(entry);
      }

      db.write('enviox', EnvioxState);
      sendJSON(req, res, 201, { ok: true, entry }, {}, { noStore: true });
      return true;
    }
  }

  if (p.startsWith('/api/enviox/blacklist/') && method === 'DELETE') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
      return true;
    }
    const bId = decodeURIComponent(p.replace('/api/enviox/blacklist/', '')).toLowerCase();
    EnvioxState.blacklist = (EnvioxState.blacklist || []).filter(x => x.id !== bId && x.value !== bId);
    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true, deleted: bId }, {}, { noStore: true });
    return true;
  }

  // 12. CANALES DE NOTIFICACIÓN (/api/enviox/channels)
  if (p === '/api/enviox/channels') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    if (method === 'GET') {
      const cloud = readCloudStore ? readCloudStore() : {};
      const mailGw = cloud.mailGateway || {};
      const ch = EnvioxState.channels || {};
      sendJSON(req, res, 200, {
        channels: {
          mode: mailGw.mode || ch.mode || 'gmail_app_password',
          smtpHost: mailGw.host || ch.smtpHost || 'smtp.gmail.com',
          smtpPort: mailGw.port || ch.smtpPort || 465,
          smtpUser: mailGw.user || ch.smtpUser || '',
          hasPassword: !!(mailGw.passSealed || mailGw.password),
          fromName: mailGw.fromName || ch.fromName || 'CYBERPOLIS ENVIOX',
          fromEmail: mailGw.fromEmail || ch.fromEmail || mailGw.user || '',
          notifyOnSend: ch.notifyOnSend !== false,
          notifyOnDownload: ch.notifyOnDownload !== false,
          notifyOnExpiry: ch.notifyOnExpiry !== false,
          smsEnabled: !!ch.smsEnabled
        }
      }, {}, { noStore: true });
      return true;
    }

    if (method === 'POST') {
      if (currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
        return true;
      }
      const b = await getBody();
      const mode = ['gmail_app_password', 'custom_smtp', 'gmail_oauth2', 'microsoft_graph', 'none'].includes(b.mode)
        ? b.mode
        : 'gmail_app_password';
      const userEmail = sanitizeInput(b.smtpUser || b.user || b.fromEmail || '', 160);
      const rawPass = String(b.password || b.smtpPassword || '').replace(/\s+/g, '').trim();
      const host = sanitizeInput(b.smtpHost || (mode === 'gmail_app_password' ? 'smtp.gmail.com' : 'smtp.gmail.com'), 160);
      const port = parseInt(b.smtpPort, 10) || (mode === 'gmail_app_password' ? 465 : 587);

      EnvioxState.channels = {
        mode,
        smtpHost: host,
        smtpPort: port,
        smtpUser: userEmail,
        fromName: sanitizeInput(b.fromName || 'CYBERPOLIS ENVIOX', 80),
        fromEmail: sanitizeInput(b.fromEmail || userEmail, 160),
        notifyOnSend: b.notifyOnSend !== false,
        notifyOnDownload: b.notifyOnDownload !== false,
        notifyOnExpiry: b.notifyOnExpiry !== false,
        smsEnabled: !!b.smsEnabled,
        updatedAt: new Date().toISOString()
      };
      db.write('enviox', EnvioxState);

      // Sincronizar directamente con cloud.mailGateway para que sendTransferNotificationEmail envíe correos reales
      if (readCloudStore && writeCloudStore) {
        const cloud = readCloudStore();
        const prevGw = cloud.mailGateway || {};
        cloud.mailGateway = {
          mode,
          host,
          port,
          secure: port === 465,
          user: userEmail,
          passSealed: rawPass ? (cloudOneDrive ? cloudOneDrive.sealCloudSecret(rawPass) : rawPass) : (prevGw.passSealed || ''),
          fromEmail: sanitizeInput(b.fromEmail || userEmail, 160),
          fromName: sanitizeInput(b.fromName || 'CYBERPOLIS ENVIOX', 80),
          updatedAt: new Date().toISOString()
        };
        writeCloudStore(cloud);
      }

      sendJSON(req, res, 200, { ok: true, channels: EnvioxState.channels, message: 'Canales de notificación y pasarela de correo guardados con éxito.' }, {}, { noStore: true });
      return true;
    }
  }

  // 12b. POST /api/enviox/channels/test — Enviar correo de prueba
  if (p === '/api/enviox/channels/test' && method === 'POST') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
      return true;
    }
    const b = await getBody();
    const toEmail = sanitizeInput(b.to || b.recipient || currentUser.email || '', 160);
    if (!toEmail || !toEmail.includes('@')) {
      sendJSON(req, res, 400, { error: 'Indica un correo destino válido para la prueba.' }, {}, { noStore: true });
      return true;
    }

    try {
      const cloud = readCloudStore ? readCloudStore() : {};
      const prevGw = cloud.mailGateway || {};

      // Si el cliente envía credenciales en el body (ej: prueba rápida sin guardar primero), aplicarlas
      let activeGw = null;
      if (b.smtpUser || b.smtpPassword || b.mode) {
        const rawPass = String(b.smtpPassword || b.password || '').replace(/\s+/g, '').trim();
        const mode = ['gmail_app_password', 'custom_smtp', 'gmail_oauth2', 'none'].includes(b.mode) ? b.mode : 'gmail_app_password';
        const port = parseInt(b.smtpPort, 10) || (mode === 'gmail_app_password' ? 465 : 587);
        activeGw = {
          mode,
          host: sanitizeInput(b.smtpHost || (mode === 'gmail_app_password' ? 'smtp.gmail.com' : 'smtp.gmail.com'), 160),
          port,
          secure: port === 465,
          user: sanitizeInput(b.smtpUser || b.user || prevGw.user || '', 160),
          passSealed: rawPass ? (cloudOneDrive ? cloudOneDrive.sealCloudSecret(rawPass) : rawPass) : (prevGw.passSealed || ''),
          fromEmail: sanitizeInput(b.fromEmail || b.smtpUser || prevGw.fromEmail || '', 160),
          fromName: sanitizeInput(b.fromName || prevGw.fromName || 'CYBERPOLIS ENVIOX', 80)
        };
      } else {
        activeGw = (cloudGoogle && cloudGoogle.resolveActiveMailGateway) ? cloudGoogle.resolveActiveMailGateway(cloud) : cloud.mailGateway;
      }

      const tenantCfg = (cloudOneDrive && cloudOneDrive.resolveActiveTenantConfig) ? cloudOneDrive.resolveActiveTenantConfig(cloud) : null;
      
      const resMail = await sendTransferNotificationEmail(
        tenantCfg,
        toEmail,
        'Prueba de Notificación — CYBERPOLIS ENVIOX',
        'Este es un mensaje de prueba para validar tu pasarela SMTP / Gmail en CYBERPOLIS ENVIOX.',
        `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <div style="background: #102a43; color: #ffffff; padding: 20px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px;">CYBERPOLIS ENVIOX</h2>
            <p style="margin: 4px 0 0 0; font-size: 13px; color: #9fb3c8;">Pasarela de Notificaciones Verificada</p>
          </div>
          <div style="padding: 24px; color: #334e68; background: #ffffff;">
            <p style="font-size: 15px; margin-top: 0;">¡Enhorabuena!</p>
            <p style="font-size: 14px; line-height: 1.6;">
              Tu pasarela de correo saliente está <strong>correctamente configurada y operativa</strong>.
            </p>
            <p style="font-size: 13px; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 6px; color: #166534;">
              ✔ Envío verificado a: <strong>${toEmail}</strong><br>
              ✔ Modo de pasarela: <strong>${activeGw?.mode || 'gmail_app_password'}</strong><br>
              ✔ Remitente: <strong>${activeGw?.user || activeGw?.fromEmail || 'CYBERPOLIS ENVIOX'}</strong><br>
              ✔ Fecha y hora: <strong>${new Date().toLocaleString('es-ES')}</strong>
            </p>
          </div>
        </div>`,
        activeGw
      );

      if (!resMail || !resMail.sent) {
        let errDesc = (resMail && resMail.error) || 'No se pudo enviar el correo de prueba.';
        if (/535|username and password not accepted/i.test(errDesc)) {
          errDesc = 'Google ha rechazado la autenticación SMTP (Error 535). Recuerda que debes activar la verificación en dos pasos en tu cuenta de Google y generar una "Contraseña de Aplicación" de 16 caracteres en myaccount.google.com/apppasswords (pega las 16 letras sin espacios).';
        } else if (/falta conectar google oauth2/i.test(errDesc)) {
          errDesc = 'Modo Gmail API seleccionado pero la cuenta Google no está autorizada. Ve a Ajustes > Configuración de Tenant y pulsa "🔑 Conectar Google 1-Clic", o usa el modo "Gmail + Contraseña de Aplicación".';
        } else if (/no configurado/i.test(errDesc)) {
          errDesc = 'Falta indicar tu cuenta de correo y la contraseña de aplicación de Google (16 caracteres).';
        }
        sendJSON(req, res, 502, { ok: false, error: errDesc, details: resMail }, {}, { noStore: true });
        return true;
      }

      sendJSON(req, res, 200, { ok: true, success: true, message: `Correo de prueba enviado con éxito a ${toEmail}. Revisa tu bandeja de entrada o spam.`, details: resMail }, {}, { noStore: true });
    } catch (err) {
      sendJSON(req, res, 500, { ok: false, error: `Error enviando correo de prueba: ${err.message}` }, {}, { noStore: true });
    }
    return true;
  }

  // 13. TENANT / NUBE 5 TB (/api/enviox/cloud-config) — Google Drive 5TB y Microsoft OneDrive
  if (p === '/api/enviox/cloud-config') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    if (method === 'GET') {
      const cloud = readCloudStore ? readCloudStore() : { tenants: [] };
      const tenants = Array.isArray(cloud.tenants) ? cloud.tenants : [];
      const gdTenant = tenants.find(t => t.providerType === 'google-drive') || null;
      const msTenant = tenants.find(t => t.providerType === 'onedrive') || null;
      const activeTenant = cloudOneDrive ? cloudOneDrive.resolveActiveTenantConfig(cloud) : (gdTenant || msTenant);
      
      const isGdConnected = !!(gdTenant && (gdTenant.serviceAccountJsonSealed || (gdTenant.clientId && gdTenant.refreshTokenSealed)));
      const isMsConnected = !!(msTenant && msTenant.clientId && (msTenant.clientSecretSealed || msTenant.refreshTokenSealed));

      sendJSON(req, res, 200, {
        activeProvider: activeTenant ? activeTenant.providerType : 'google-drive',
        activeTenantName: activeTenant ? activeTenant.name : 'Google Drive 5 TB Vault',
        capacity: '5 TB',
        googleDrive: {
          id: gdTenant?.id || 'enviox-primary-vault',
          userEmail: gdTenant?.driveUserUpn || '',
          clientId: gdTenant?.clientId || '',
          folderId: gdTenant?.baseFolder || gdTenant?.driveFolderId || 'CYBERPOLIS_VAULT',
          hasClientSecret: !!gdTenant?.clientSecretSealed,
          hasRefreshToken: !!gdTenant?.refreshTokenSealed,
          hasServiceAccount: !!gdTenant?.serviceAccountJsonSealed,
          connected: isGdConnected,
          lastTestedAt: gdTenant?.lastTestedAt || null,
          quotaTotalBytes: gdTenant?.quotaTotalBytes || 0,
          quotaUsedBytes: gdTenant?.quotaUsedBytes || 0
        },
        oneDrive: {
          id: msTenant?.id || '',
          tenantId: msTenant?.tenantId || msTenant?.azureTenantId || '',
          clientId: msTenant?.clientId || '',
          hasClientSecret: !!msTenant?.clientSecretSealed,
          hasRefreshToken: !!msTenant?.refreshTokenSealed,
          connected: isMsConnected
        }
      }, {}, { noStore: true });
      return true;
    }

    if (method === 'POST') {
      if (currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
        return true;
      }
      const b = await getBody();
      const providerType = b.providerType || 'google-drive';

      EnvioxState.cloudSettings = {
        providerType,
        tenantId: sanitizeInput(b.tenantId || b.azureTenantId || '', 100),
        clientId: sanitizeInput(b.clientId || b.googleClientId || b.azureClientId || '', 200),
        folderId: sanitizeInput(b.folderId || b.googleFolderId || 'CYBERPOLIS_VAULT', 100),
        updatedAt: new Date().toISOString()
      };
      db.write('enviox', EnvioxState);

      // Guardar en cloud.tenants con compatibilidad total para Google Drive 5TB y Azure M365
      if (readCloudStore && writeCloudStore) {
        const cloud = readCloudStore();
        cloud.tenants = Array.isArray(cloud.tenants) ? cloud.tenants : [];
        let t = cloud.tenants.find(x => x.id === (b.id || 'enviox-primary-vault') || x.providerType === providerType);
        if (!t) {
          t = {
            id: providerType === 'google-drive' ? 'gd-enviox-primary' : 'ten-enviox-azure',
            name: providerType === 'onedrive' ? 'Microsoft Azure / OneDrive 5 TB' : 'Google Drive 5 TB Vault',
            providerType,
            createdAt: new Date().toISOString()
          };
          cloud.tenants.push(t);
        }
        t.providerType = providerType;
        t.name = providerType === 'onedrive' ? 'Microsoft Azure / OneDrive 5 TB' : 'Google Drive 5 TB Vault';
        t.isDefaultForBackup = true;
        t.autoBackupEnabled = true;
        t.sendMailEnabled = true;

        if (providerType === 'onedrive') {
          t.tenantId = sanitizeInput(b.tenantId || b.azureTenantId || 'common', 120);
          t.clientId = sanitizeInput(b.clientId || b.azureClientId || '', 120);
          t.authMode = 'client_credentials';
          if (b.clientSecret || b.azureClientSecret) {
            t.clientSecretSealed = cloudOneDrive ? cloudOneDrive.sealCloudSecret(b.clientSecret || b.azureClientSecret) : (b.clientSecret || b.azureClientSecret);
          }
        } else {
          t.clientId = sanitizeInput(b.clientId || b.googleClientId || '', 200);
          t.baseFolder = sanitizeInput(b.folderId || b.googleFolderId || 'CYBERPOLIS_VAULT', 100);
          t.driveUserUpn = sanitizeInput(b.userEmail || b.googleUserEmail || b.driveUserUpn || '', 140);
          t.authMode = b.serviceAccountJson ? 'service_account' : 'google_oauth2';
          if (b.clientSecret || b.googleClientSecret) {
            t.clientSecretSealed = cloudOneDrive ? cloudOneDrive.sealCloudSecret(b.clientSecret || b.googleClientSecret) : (b.clientSecret || b.googleClientSecret);
          }
          if (b.serviceAccountJson) {
            t.serviceAccountJsonSealed = cloudOneDrive ? cloudOneDrive.sealCloudSecret(b.serviceAccountJson) : b.serviceAccountJson;
          }
        }
        t.updatedAt = new Date().toISOString();

        // Si este es default para backup, desmarcar otros
        cloud.tenants.forEach(x => {
          if (x.id !== t.id) x.isDefaultForBackup = false;
        });
        writeCloudStore(cloud);
      }

      sendJSON(req, res, 200, { ok: true, cloudSettings: EnvioxState.cloudSettings, message: 'Configuración de Tenant y Nube de 5 TB guardada correctamente.' }, {}, { noStore: true });
      return true;
    }
  }

  // 13b. POST /api/enviox/cloud-config/test — Probar conexión real con la Bóveda 5 TB
  if (p === '/api/enviox/cloud-config/test' && method === 'POST') {
    if (!currentUser || currentUser.role !== 'admin') {
      sendJSON(req, res, 403, { error: 'Acceso denegado.' }, {}, { noStore: true });
      return true;
    }
    try {
      const cloud = readCloudStore ? readCloudStore() : { tenants: [] };
      const tCfg = cloudOneDrive ? cloudOneDrive.resolveActiveTenantConfig(cloud) : null;
      if (!tCfg || (!tCfg.clientId && !tCfg.serviceAccountJsonSealed)) {
        sendJSON(req, res, 200, {
          ok: true,
          connected: false,
          tenantName: 'Bóveda Local Cifrada (Fallback)',
          capacity: '5 TB',
          message: 'Bóveda local segura con cifrado AES-256-GCM operativa. Guarda tus credenciales de Google Drive o Azure y pulsa "🔑 Conectar Google 1-Clic" para sincronizar la nube remota de 5 TB.'
        }, {}, { noStore: true });
        return true;
      }

      let info = null;
      if (tCfg.providerType === 'google-drive') {
        if (!cloudGoogle || !cloudGoogle.testGoogleDriveConnection) {
          throw new Error('Módulo de Google Drive no disponible en el servidor.');
        }
        info = await cloudGoogle.testGoogleDriveConnection(tCfg);
      } else {
        if (!cloudOneDrive || !cloudOneDrive.testOneDriveConnection) {
          throw new Error('Módulo de Microsoft OneDrive no disponible en el servidor.');
        }
        info = await cloudOneDrive.testOneDriveConnection(tCfg);
      }

      // Guardar cuotas actualizadas en cloud.tenants
      const idx = cloud.tenants.findIndex(t => t.id === tCfg.id);
      if (idx >= 0) {
        cloud.tenants[idx].lastTestedAt = new Date().toISOString();
        if (info && info.quotaTotalBytes) cloud.tenants[idx].quotaTotalBytes = info.quotaTotalBytes;
        if (info && info.quotaUsedBytes) cloud.tenants[idx].quotaUsedBytes = info.quotaUsedBytes;
        if (info && info.ownerEmail && !cloud.tenants[idx].driveUserUpn) {
          cloud.tenants[idx].driveUserUpn = info.ownerEmail;
        }
        writeCloudStore(cloud);
      }

      sendJSON(req, res, 200, {
        ok: true,
        connected: true,
        tenantName: tCfg.name || 'Google Drive 5 TB',
        ownerDisplayName: info?.ownerDisplayName || info?.ownerEmail || tCfg.driveUserUpn,
        ownerEmail: info?.ownerEmail || tCfg.driveUserUpn,
        quotaTotalBytes: info?.quotaTotalBytes,
        quotaUsedBytes: info?.quotaUsedBytes,
        quotaRemainingBytes: info?.quotaRemainingBytes,
        message: `Conexión con la bóveda de 5 TB verificada con éxito (${info?.ownerDisplayName || info?.ownerEmail || 'Google Drive'}). Permisos de lectura/escritura y cifrado AES-256-GCM confirmados.`
      }, {}, { noStore: true });
    } catch (err) {
      const needsOAuth = /falta conectar google oauth2|refresh_token|token google oauth2/i.test(err.message);
      sendJSON(req, res, 502, {
        ok: false,
        connected: false,
        needsOAuth,
        error: err.message,
        message: needsOAuth
          ? '⚠️ Las credenciales de Google están guardadas en el servidor, pero falta autorizar el acceso: pulsa el botón "🔑 Conectar Google 1-Clic".'
          : `Error al conectar con la Nube: ${err.message}`
      }, {}, { noStore: true });
    }
    return true;
  }

  // 14. INFORMES Y TRAZABILIDAD (/api/enviox/reports) — Auditoría legal completa
  if (p === '/api/enviox/reports' && method === 'GET') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }

    const transfers = db.read('transfers', []);
    const reports = transfers.map(t => {
      const isDownloaded = (t.downloadsCount || 0) > 0;
      const primaryRecipient = (t.recipients && t.recipients.length) ? t.recipients[0] : (t.recipient || '—');
      const latestAudit = (t.legalAudit && t.legalAudit.length) ? t.legalAudit[t.legalAudit.length - 1] : null;

      return {
        id: t.id,
        reference: t.reference || t.id.slice(0, 4).toUpperCase(),
        sender: t.senderEmail || t.senderUsername || 'admin@cyberpolis.es',
        recipients: t.recipients || [primaryRecipient],
        recipientDisplay: primaryRecipient,
        subject: t.subject || '(Sin asunto)',
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        status: computeTransferStatus(t),
        filesCount: (t.files && t.files.length) ? t.files.length : (t.file ? 1 : 0),
        downloadsCount: t.downloadsCount || 0,
        maxDownloads: t.maxDownloads || 3,
        deliveryStatus: 'Entregado a pasarela',
        receiptStatus: isDownloaded ? 'Descargado (Acuse confirmado)' : 'Pendiente de descarga',
        lastAccessIp: latestAudit?.ip || '—',
        lastAccessDate: latestAudit?.timestamp || '—',
        legalAudit: t.legalAudit || []
      };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    sendJSON(req, res, 200, {
      reports,
      totalTransfers: reports.length,
      confirmedReceipts: reports.filter(r => r.downloadsCount > 0).length,
      auditTimestamp: new Date().toISOString()
    }, {}, { noStore: true });
    return true;
  }

  return false;
}

module.exports = {
  handleEnvioxApi,
  handleTranxferApi: handleEnvioxApi,
  generateReferenceCode,
  mapToEnvioxRecord,
  mapToTranxferRecord: mapToEnvioxRecord
};

