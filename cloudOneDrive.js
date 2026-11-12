// Módulo Multi-Tenant Azure Entra ID, OneDrive (Microsoft Graph) y Notificaciones por Correo
// Soporta cifrado AES-256-GCM en reposo para secretos y archivos binarios.

const crypto = require('crypto');
const tls = require('tls');
const net = require('net');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LOGIN_BASE = 'https://login.microsoftonline.com';

const tokenCache = new Map();

function getMasterSecretKey() {
  const raw = process.env.PERSIST_SECRET || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'cyberpolis-cloud-vault-v8-key';
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function sealCloudSecret(plainText) {
  if (!plainText) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterSecretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64')
  });
}

function unsealCloudSecret(sealed) {
  if (!sealed) return '';
  const str = String(sealed);
  if (!str.startsWith('{')) return str;
  try {
    const parsed = JSON.parse(str);
    if (!parsed || !parsed.iv || !parsed.tag || !parsed.data) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterSecretKey(), Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (e) {
    return '';
  }
}

function encryptBinaryBuffer(plainBuf, transferSecret) {
  const key = crypto.createHash('sha256')
    .update(Buffer.concat([getMasterSecretKey(), Buffer.from(':' + String(transferSecret || 'default'))]))
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('CPV8', 'ascii'), iv, tag, enc]);
}

function decryptBinaryBuffer(cipherBuf, transferSecret) {
  if (!Buffer.isBuffer(cipherBuf) || cipherBuf.length < 32) {
    throw new Error('Contenedor cifrado inválido.');
  }
  if (cipherBuf.slice(0, 4).toString('ascii') !== 'CPV8') {
    throw new Error('Cabecera CPV8 no reconocida.');
  }
  const key = crypto.createHash('sha256')
    .update(Buffer.concat([getMasterSecretKey(), Buffer.from(':' + String(transferSecret || 'default'))]))
    .digest();
  const iv = cipherBuf.slice(4, 16);
  const tag = cipherBuf.slice(16, 32);
  const payload = cipherBuf.slice(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function resolveEnvPrimaryTenant() {
  const tenantId = (process.env.MS_TENANT_ID || '').trim();
  const clientId = (process.env.MS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.MS_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.MS_REFRESH_TOKEN || '').trim();
  const driveUserUpn = (process.env.ONEDRIVE_USER_UPN || '').trim();
  const driveId = (process.env.ONEDRIVE_DRIVE_ID || '').trim();
  const baseFolder = (process.env.ONEDRIVE_FOLDER || '/CYBERPOLIS_VAULT').trim();

  if (!clientId || (!clientSecret && !refreshToken)) return null;
  return {
    id: 'env-primary',
    name: process.env.ONEDRIVE_TENANT_NAME || 'Tenant Principal (Render Env)',
    companyDomain: driveUserUpn.includes('@') ? driveUserUpn.split('@')[1] : 'microsoft365',
    tenantId: tenantId || 'common',
    clientId,
    clientSecretSealed: clientSecret ? sealCloudSecret(clientSecret) : '',
    refreshTokenSealed: refreshToken ? sealCloudSecret(refreshToken) : '',
    authMode: refreshToken ? 'delegated_oauth2' : 'client_credentials',
    driveUserUpn,
    driveId,
    baseFolder,
    isDefaultForBackup: true,
    autoBackupEnabled: true,
    sendMailEnabled: true,
    fromEnv: true
  };
}

function resolveActiveTenantConfig(cloudState, requestedTenantId = '') {
  const list = Array.isArray(cloudState && cloudState.tenants) ? cloudState.tenants : [];
  const envTenant = resolveEnvPrimaryTenant();
  const combined = envTenant ? [envTenant, ...list] : list;
  if (requestedTenantId) {
    const found = combined.find(t => t && (t.id === requestedTenantId || t.tenantId === requestedTenantId));
    if (found) return found;
  }
  return combined.find(t => t && t.isDefaultForBackup) || combined[0] || null;
}

function getDriveRootPrefix(tenantCfg) {
  if (tenantCfg.driveId) {
    return `/drives/${encodeURIComponent(tenantCfg.driveId)}/root`;
  }
  if (tenantCfg.driveUserUpn && tenantCfg.authMode !== 'delegated_oauth2') {
    return `/users/${encodeURIComponent(tenantCfg.driveUserUpn)}/drive/root`;
  }
  if (tenantCfg.driveUserUpn && tenantCfg.authMode === 'delegated_oauth2') {
    return `/me/drive/root`;
  }
  return `/me/drive/root`;
}

function normalizeRemoteFolder(baseFolder, subPath) {
  const cleanBase = '/' + String(baseFolder || '/CYBERPOLIS_VAULT').replace(/^\/+|\/+$/g, '');
  const cleanSub = String(subPath || '').replace(/^\/+|\/+$/g, '');
  return cleanSub ? `${cleanBase}/${cleanSub}` : cleanBase;
}

async function getMicrosoftAccessToken(tenantCfg, fetchFn = fetch) {
  if (!tenantCfg || !tenantCfg.clientId) {
    throw new Error('Falta configurar Client ID de Azure Entra ID / OneDrive.');
  }
  const cacheKey = `${tenantCfg.id || tenantCfg.tenantId}:${tenantCfg.authMode}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return { accessToken: cached.accessToken };
  }

  const tenantSegment = encodeURIComponent(tenantCfg.tenantId || 'common');
  const tokenUrl = `${LOGIN_BASE}/${tenantSegment}/oauth2/v2.0/token`;
  const clientSecret = unsealCloudSecret(tenantCfg.clientSecretSealed || tenantCfg.clientSecret || '');
  const refreshToken = unsealCloudSecret(tenantCfg.refreshTokenSealed || tenantCfg.refreshToken || '');

  const params = new URLSearchParams();
  params.set('client_id', tenantCfg.clientId);

  if (refreshToken) {
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);
    params.set('scope', 'offline_access Files.ReadWrite.All User.Read Mail.Send');
    if (clientSecret) params.set('client_secret', clientSecret);
  } else {
    if (!clientSecret) {
      throw new Error('Falta Client Secret o Refresh Token para autenticar contra Microsoft Graph.');
    }
    params.set('grant_type', 'client_credentials');
    params.set('client_secret', clientSecret);
    params.set('scope', 'https://graph.microsoft.com/.default');
  }

  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token Graph HTTP ${res.status}`);
  }

  const ttlMs = Math.max(120, Number(data.expires_in) || 3599) * 1000;
  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + ttlMs
  });

  return {
    accessToken: data.access_token,
    rotatedRefreshToken: data.refresh_token || ''
  };
}

async function ensureOneDriveFolder(tenantCfg, folderPath, accessToken, fetchFn = fetch) {
  const parts = String(folderPath || '/CYBERPOLIS_VAULT').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const drivePrefix = getDriveRootPrefix(tenantCfg);
  let builtPath = '';
  for (const part of parts) {
    const parentUrl = builtPath
      ? `${GRAPH_BASE}${drivePrefix}:/${builtPath.split('/').map(encodeURIComponent).join('/')}:/children`
      : `${GRAPH_BASE}${drivePrefix}/children`;
    builtPath = builtPath ? `${builtPath}/${part}` : part;
    const checkUrl = `${GRAPH_BASE}${drivePrefix}:/${builtPath.split('/').map(encodeURIComponent).join('/')}:`;
    const checkRes = await fetchFn(checkUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (checkRes.status === 404) {
      const createRes = await fetchFn(parentUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: part,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'replace'
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!createRes.ok && createRes.status !== 409) {
        const errBody = await createRes.text().catch(() => '');
        throw new Error(`No se pudo crear carpeta "${builtPath}" en OneDrive: HTTP ${createRes.status} ${errBody.slice(0, 120)}`);
      }
    }
  }
}

async function testOneDriveConnection(tenantCfg, fetchFn = fetch) {
  const { accessToken } = await getMicrosoftAccessToken(tenantCfg, fetchFn);
  const driveUrl = tenantCfg.driveId
    ? `${GRAPH_BASE}/drives/${encodeURIComponent(tenantCfg.driveId)}`
    : (tenantCfg.driveUserUpn && tenantCfg.authMode !== 'delegated_oauth2'
        ? `${GRAPH_BASE}/users/${encodeURIComponent(tenantCfg.driveUserUpn)}/drive`
        : `${GRAPH_BASE}/me/drive`);

  const res = await fetchFn(driveUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Graph Drive HTTP ${res.status}`);
  }

  await ensureOneDriveFolder(tenantCfg, tenantCfg.baseFolder || '/CYBERPOLIS_VAULT', accessToken, fetchFn);

  return {
    connected: true,
    driveId: data.id || '',
    driveType: data.driveType || 'business',
    ownerDisplayName: (data.owner && data.owner.user && data.owner.user.displayName) || tenantCfg.driveUserUpn || tenantCfg.name,
    quotaTotalBytes: data.quota ? Number(data.quota.total) || 0 : 0,
    quotaUsedBytes: data.quota ? Number(data.quota.used) || 0 : 0,
    quotaRemainingBytes: data.quota ? Number(data.quota.remaining) || 0 : 0
  };
}

async function uploadBufferToOneDrive(tenantCfg, relativeSubPath, buffer, contentType = 'application/octet-stream', fetchFn = fetch) {
  const { accessToken } = await getMicrosoftAccessToken(tenantCfg, fetchFn);
  const fullPath = normalizeRemoteFolder(tenantCfg.baseFolder, relativeSubPath);
  const lastSlash = fullPath.lastIndexOf('/');
  const parentFolder = lastSlash > 0 ? fullPath.slice(0, lastSlash) : '/CYBERPOLIS_VAULT';
  await ensureOneDriveFolder(tenantCfg, parentFolder, accessToken, fetchFn);

  const drivePrefix = getDriveRootPrefix(tenantCfg);
  const encodedItemPath = fullPath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

  if (buffer.length <= 3800 * 1024) {
    const putUrl = `${GRAPH_BASE}${drivePrefix}:/${encodedItemPath}:/content`;
    const res = await fetchFn(putUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': contentType
      },
      body: buffer,
      signal: AbortSignal.timeout(30000)
    });
    const item = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((item.error && item.error.message) || `OneDrive upload HTTP ${res.status}`);
    }
    return { itemId: item.id, webUrl: item.webUrl || '', remotePath: fullPath, size: item.size || buffer.length };
  }

  const sessionRes = await fetchFn(`${GRAPH_BASE}${drivePrefix}:/${encodedItemPath}:/createUploadSession`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace' }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const sessionData = await sessionRes.json().catch(() => ({}));
  if (!sessionRes.ok || !sessionData.uploadUrl) {
    throw new Error((sessionData.error && sessionData.error.message) || `UploadSession HTTP ${sessionRes.status}`);
  }

  const chunkSize = 327680 * 10; // ~3.2 MB (múltiplo exacto de 320 KiB requerido por Graph)
  let finalItem = null;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, buffer.length);
    const slice = buffer.slice(offset, end);
    const chunkRes = await fetchFn(sessionData.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${buffer.length}`
      },
      body: slice,
      signal: AbortSignal.timeout(45000)
    });
    const chunkBody = await chunkRes.json().catch(() => ({}));
    if (!chunkRes.ok && chunkRes.status !== 202) {
      throw new Error((chunkBody.error && chunkBody.error.message) || `Chunk upload HTTP ${chunkRes.status}`);
    }
    if (chunkBody && chunkBody.id) finalItem = chunkBody;
  }
  return {
    itemId: (finalItem && finalItem.id) || '',
    webUrl: (finalItem && finalItem.webUrl) || '',
    remotePath: fullPath,
    size: buffer.length
  };
}

async function downloadBufferFromOneDrive(tenantCfg, relativeOrFullPath, fetchFn = fetch) {
  const { accessToken } = await getMicrosoftAccessToken(tenantCfg, fetchFn);
  const fullPath = String(relativeOrFullPath || '').startsWith('/')
    ? relativeOrFullPath
    : normalizeRemoteFolder(tenantCfg.baseFolder, relativeOrFullPath);
  const drivePrefix = getDriveRootPrefix(tenantCfg);
  const encodedItemPath = fullPath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const res = await fetchFn(`${GRAPH_BASE}${drivePrefix}:/${encodedItemPath}:/content`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(45000)
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OneDrive download HTTP ${res.status}: ${txt.slice(0, 120)}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function deleteItemFromOneDrive(tenantCfg, relativeOrFullPath, fetchFn = fetch) {
  try {
    const { accessToken } = await getMicrosoftAccessToken(tenantCfg, fetchFn);
    const fullPath = String(relativeOrFullPath || '').startsWith('/')
      ? relativeOrFullPath
      : normalizeRemoteFolder(tenantCfg.baseFolder, relativeOrFullPath);
    const drivePrefix = getDriveRootPrefix(tenantCfg);
    const encodedItemPath = fullPath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    await fetchFn(`${GRAPH_BASE}${drivePrefix}:/${encodedItemPath}:`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {}
}

async function sendGraphMail(tenantCfg, { to, subject, htmlBody }, fetchFn = fetch) {
  const { accessToken } = await getMicrosoftAccessToken(tenantCfg, fetchFn);
  const endpoint = tenantCfg.driveUserUpn && tenantCfg.authMode !== 'delegated_oauth2'
    ? `${GRAPH_BASE}/users/${encodeURIComponent(tenantCfg.driveUserUpn)}/sendMail`
    : `${GRAPH_BASE}/me/sendMail`;
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        subject: String(subject || 'Notificación CYBERPOLIS Transfer').slice(0, 180),
        body: { contentType: 'HTML', content: String(htmlBody || '') },
        toRecipients: [{ emailAddress: { address: to } }]
      },
      saveToSentItems: true
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`Graph sendMail HTTP ${res.status}: ${errTxt.slice(0, 140)}`);
  }
  return { sent: true, provider: 'microsoft-graph' };
}

function sendRawSmtpMail({ to, subject, textBody }) {
  return new Promise((resolve, reject) => {
    const host = (process.env.SMTP_HOST || '').trim();
    const port = parseInt(process.env.SMTP_PORT, 10) || 465;
    const user = (process.env.SMTP_USER || '').trim();
    const pass = (process.env.SMTP_PASS || '').trim();
    const from = (process.env.SMTP_FROM || user || 'noreply@cyberpolis.local').trim();
    if (!host || !user || !pass) {
      return reject(new Error('SMTP no configurado'));
    }

    const useDirectTls = port === 465 || process.env.SMTP_SECURE === 'true';
    const socket = useDirectTls
      ? tls.connect({ host, port, rejectUnauthorized: true })
      : net.connect({ host, port });

    let step = 0;
    let buf = '';
    const cleanup = err => {
      try { socket.destroy(); } catch (e) {}
      if (err) reject(err);
    };

    socket.setTimeout(12000, () => cleanup(new Error('SMTP timeout')));
    socket.on('error', cleanup);
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (!/\r\n$/.test(buf)) return;
      const lines = buf.trim().split('\r\n');
      const last = lines[lines.length - 1];
      if (/^\d{3}-/.test(last)) return;
      const code = parseInt(last.slice(0, 3), 10);
      buf = '';

      if (code >= 400) {
        return cleanup(new Error(`SMTP ${last}`));
      }

      if (step === 0) {
        step = 1;
        socket.write(`EHLO cyberpolis.onrender.com\r\n`);
      } else if (step === 1) {
        step = 2;
        socket.write(`AUTH LOGIN\r\n`);
      } else if (step === 2) {
        step = 3;
        socket.write(Buffer.from(user).toString('base64') + '\r\n');
      } else if (step === 3) {
        step = 4;
        socket.write(Buffer.from(pass).toString('base64') + '\r\n');
      } else if (step === 4) {
        step = 5;
        socket.write(`MAIL FROM:<${from}>\r\n`);
      } else if (step === 5) {
        step = 6;
        socket.write(`RCPT TO:<${to}>\r\n`);
      } else if (step === 6) {
        step = 7;
        socket.write(`DATA\r\n`);
      } else if (step === 7) {
        step = 8;
        const msg = [
          `From: CYBERPOLIS Transfer <${from}>`,
          `To: <${to}>`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          '',
          String(textBody || '').replace(/\n\./g, '\n..'),
          '.'
        ].join('\r\n');
        socket.write(msg + '\r\n');
      } else if (step === 8) {
        step = 9;
        socket.write('QUIT\r\n');
        socket.end();
        resolve({ sent: true, provider: 'smtp' });
      }
    });
  });
}

async function sendTransferNotificationEmail(tenantCfg, { to, subject, htmlBody, textBody }, fetchFn = fetch) {
  const targetEmail = String(to || '').trim();
  if (!targetEmail || !targetEmail.includes('@')) {
    return { sent: false, provider: 'none', status: 'invalid_email', to: targetEmail };
  }
  if (tenantCfg && tenantCfg.sendMailEnabled !== false && tenantCfg.clientId) {
    try {
      const r = await sendGraphMail(tenantCfg, { to: targetEmail, subject, htmlBody }, fetchFn);
      return { ...r, status: 'sent', to: targetEmail, ts: new Date().toISOString() };
    } catch (graphErr) {
      if (process.env.SMTP_HOST) {
        try {
          const s = await sendRawSmtpMail({ to: targetEmail, subject, textBody });
          return { ...s, status: 'sent', to: targetEmail, ts: new Date().toISOString() };
        } catch (smtpErr) {
          return { sent: false, provider: 'graph+smtp', status: 'error', to: targetEmail, error: graphErr.message, ts: new Date().toISOString() };
        }
      }
      return { sent: false, provider: 'microsoft-graph', status: 'error', to: targetEmail, error: graphErr.message, ts: new Date().toISOString() };
    }
  }
  if (process.env.SMTP_HOST) {
    try {
      const s = await sendRawSmtpMail({ to: targetEmail, subject, textBody });
      return { ...s, status: 'sent', to: targetEmail, ts: new Date().toISOString() };
    } catch (smtpErr) {
      return { sent: false, provider: 'smtp', status: 'error', to: targetEmail, error: smtpErr.message, ts: new Date().toISOString() };
    }
  }
  return {
    sent: false,
    provider: 'audit-only',
    status: 'queued_no_mailer',
    to: targetEmail,
    error: 'Sin Microsoft Graph Mail.Send ni SMTP configurado',
    ts: new Date().toISOString()
  };
}

module.exports = {
  sealCloudSecret,
  unsealCloudSecret,
  encryptBinaryBuffer,
  decryptBinaryBuffer,
  resolveEnvPrimaryTenant,
  resolveActiveTenantConfig,
  getMicrosoftAccessToken,
  testOneDriveConnection,
  uploadBufferToOneDrive,
  downloadBufferFromOneDrive,
  deleteItemFromOneDrive,
  sendTransferNotificationEmail
};
