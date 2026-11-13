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
    cloudOneDrive,
    cloudGoogle,
    storeEncryptedTransferFile,
    loadDecryptedTransferFile,
    sendTransferNotificationEmail,
    sendJSON,
    isSecureRequest,
    getClientIp
  } = ctx;

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
  if (pathname === '/api/enviox/init' && method === 'GET') {
    const cloud = readCloudStore ? readCloudStore() : { tenants: [] };
    const tenantCfg = cloudOneDrive ? cloudOneDrive.resolveActiveTenantConfig(cloud) : null;
    const mailGw = cloud.mailGateway || null;

    sendJSON(req, res, 200, {
      user: currentUser ? {
        id: currentUser.id,
        username: currentUser.username,
        email: currentUser.email || `${currentUser.username}@clgrupoindustrial.com`,
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
  if (pathname === '/api/enviox/records' && method === 'GET') {
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
  if (pathname === '/api/enviox/send' && method === 'POST') {
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
      senderEmail: currentUser.email || `${currentUser.username}@clgrupoindustrial.com`,
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
  if (pathname === '/api/enviox/receive-request' && method === 'POST') {
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
      senderEmail: currentUser.email || `${currentUser.username}@clgrupoindustrial.com`,
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
  if (pathname === '/api/enviox/cancel' && method === 'POST') {
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
  if (pathname === '/api/enviox/settings' && method === 'POST') {
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
  if (pathname === '/api/enviox/contacts') {
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

  if (pathname.startsWith('/api/enviox/contacts/') && method === 'DELETE') {
    if (!currentUser) {
      sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
      return true;
    }
    const cId = decodeURIComponent(pathname.replace('/api/enviox/contacts/', ''));
    EnvioxState.contacts = (EnvioxState.contacts || []).filter(c => c.id !== cId && c.email !== cId);
    db.write('enviox', EnvioxState);
    sendJSON(req, res, 200, { ok: true }, {}, { noStore: true });
    return true;
  }

  // 8. GET /api/enviox/roles — Roles corporativos SAML
  if (pathname === '/api/enviox/roles' && method === 'GET') {
    sendJSON(req, res, 200, { roles: EnvioxState.roles || [] }, {}, { noStore: true });
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

