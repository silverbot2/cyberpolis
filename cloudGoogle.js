// Módulo Google Drive (5 TB) + Gmail API OAuth2 + Service Account JWT + Pasarela Correo
// Cero dependencias externas: utiliza únicamente crypto + fetch nativos de Node.js.

const crypto = require('crypto');
const fs = require('fs');

const GOOGLE_OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const GDRIVE_API = 'https://www.googleapis.com/drive/v3';
const GDRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

const googleTokenCache = new Map();

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function getCryptoHelpers() {
  // Evita ciclo al requerir lazy desde cloudOneDrive solo para sellar/abrir secretos
  return require('./cloudOneDrive');
}

function resolveEnvGoogleProvider() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
  const saRaw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const impersonateEmail = (process.env.GOOGLE_IMPERSONATE_EMAIL || process.env.GOOGLE_USER_EMAIL || '').trim();
  const baseFolder = (process.env.GOOGLE_DRIVE_FOLDER || '/CYBERPOLIS_VAULT').trim();
  const rootFolderId = (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim();

  let saEmail = '';
  if (saRaw) {
    try {
      const parsed = JSON.parse(saRaw);
      saEmail = parsed.client_email || '';
    } catch (e) {}
  }

  if ((!clientId || !refreshToken) && !saRaw) return null;

  const { sealCloudSecret } = getCryptoHelpers();
  return {
    id: 'env-google-primary',
    providerType: 'google-drive',
    name: process.env.GOOGLE_DRIVE_NAME || 'Google Drive 5 TB (Render Env)',
    companyDomain: impersonateEmail.includes('@') ? impersonateEmail.split('@')[1] : 'google.com',
    clientId,
    clientSecretSealed: clientSecret ? sealCloudSecret(clientSecret) : '',
    refreshTokenSealed: refreshToken ? sealCloudSecret(refreshToken) : '',
    serviceAccountJsonSealed: saRaw ? sealCloudSecret(saRaw) : '',
    serviceAccountEmail: saEmail,
    authMode: saRaw ? 'service_account' : 'google_oauth2',
    driveUserUpn: impersonateEmail,
    driveId: rootFolderId,
    baseFolder,
    isDefaultForBackup: process.env.CLOUD_BACKUP_PRIMARY === 'google' || (!process.env.MS_CLIENT_ID),
    autoBackupEnabled: true,
    sendMailEnabled: true,
    fromEnv: true
  };
}

function resolveEnvMailGateway() {
  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailAppPass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '').trim();
  const smtpHost = (process.env.SMTP_HOST || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();

  const { sealCloudSecret } = getCryptoHelpers();
  if (gmailUser && gmailAppPass) {
    return {
      mode: 'gmail_app_password',
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: gmailUser,
      passSealed: sealCloudSecret(gmailAppPass),
      fromEmail: (process.env.SMTP_FROM || gmailUser).trim(),
      fromName: process.env.SMTP_FROM_NAME || 'CYBERPOLIS Transfer',
      fromEnv: true
    };
  }
  if (smtpHost && smtpUser && smtpPass) {
    const port = parseInt(process.env.SMTP_PORT, 10) || 465;
    return {
      mode: 'custom_smtp',
      host: smtpHost,
      port,
      secure: port === 465 || process.env.SMTP_SECURE === 'true',
      user: smtpUser,
      passSealed: sealCloudSecret(smtpPass),
      fromEmail: (process.env.SMTP_FROM || smtpUser).trim(),
      fromName: process.env.SMTP_FROM_NAME || 'CYBERPOLIS Transfer',
      fromEnv: true
    };
  }
  return null;
}

function resolveActiveMailGateway(cloudState) {
  const saved = cloudState && cloudState.mailGateway && typeof cloudState.mailGateway === 'object'
    ? cloudState.mailGateway
    : null;
  if (saved && saved.mode && saved.mode !== 'none') {
    return saved;
  }
  return resolveEnvMailGateway();
}

async function getGoogleAccessToken(googleCfg, fetchFn = fetch) {
  if (!googleCfg) throw new Error('Proveedor Google Drive no configurado.');
  const cacheKey = `${googleCfg.id}:${googleCfg.authMode}:${googleCfg.driveUserUpn || ''}`;
  const cached = googleTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return { accessToken: cached.accessToken };
  }

  const { unsealCloudSecret } = getCryptoHelpers();
  const saJsonStr = unsealCloudSecret(googleCfg.serviceAccountJsonSealed);

  if (googleCfg.authMode === 'service_account' || saJsonStr) {
    let sa;
    try {
      sa = JSON.parse(saJsonStr);
    } catch (e) {
      throw new Error('JSON de Service Account de Google inválido.');
    }
    if (!sa.client_email || !sa.private_key) {
      throw new Error('Service Account JSON debe contener client_email y private_key.');
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.send',
      aud: sa.token_uri || GOOGLE_OAUTH_TOKEN,
      iat: now,
      exp: now + 3600
    };
    if (googleCfg.driveUserUpn && googleCfg.driveUserUpn.includes('@')) {
      claims.sub = googleCfg.driveUserUpn.trim();
    }
    const claimSet = base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${header}.${claimSet}`;
    const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
    const jwt = `${signingInput}.${base64UrlEncode(signature)}`;

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    });
    const res = await fetchFn(sa.token_uri || GOOGLE_OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || `Token Google Service Account HTTP ${res.status}`);
    }
    googleTokenCache.set(cacheKey, {
      accessToken: data.access_token,
      expiresAt: Date.now() + Math.max(120, Number(data.expires_in) || 3500) * 1000
    });
    return { accessToken: data.access_token };
  }

  const refreshToken = unsealCloudSecret(googleCfg.refreshTokenSealed);
  const clientId = String(googleCfg.clientId || '').trim();
  const clientSecret = unsealCloudSecret(googleCfg.clientSecretSealed);
  if (!clientId || !refreshToken) {
    throw new Error('Falta conectar Google OAuth2 (pulsa "Conectar Google 1-Clic") o indicar Service Account JSON.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  if (clientSecret) params.set('client_secret', clientSecret);

  const res = await fetchFn(GOOGLE_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token Google OAuth2 HTTP ${res.status}`);
  }
  googleTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(120, Number(data.expires_in) || 3500) * 1000
  });
  return { accessToken: data.access_token };
}

function escapeDriveQueryValue(val) {
  return String(val || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getDriveItemById(id, accessToken, fetchFn = fetch) {
  if (!id || id === 'root') return null;
  if (/[\s\/\\:*?"<>|]/.test(id)) return null;
  try {
    const res = await fetchFn(`${GDRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,webViewLink&supportsAllDrives=true`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data && data.id && data.trashed !== true) return data;
    return null;
  } catch (e) {
    return null;
  }
}

async function ensureGoogleDriveFolderPath(googleCfg, folderPath, accessToken, fetchFn = fetch) {
  const parts = String(folderPath || 'CYBERPOLIS_VAULT').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let parentId = String(googleCfg.driveId || 'root').trim() || 'root';

  // Si googleCfg.folderId o googleCfg.baseFolder es un ID de carpeta existente en Drive, usarlo directamente
  const candidateId = String(googleCfg.folderId || googleCfg.baseFolder || '').trim();
  if (candidateId && candidateId !== 'root') {
    const existingFolder = await getDriveItemById(candidateId, accessToken, fetchFn);
    if (existingFolder && existingFolder.mimeType === 'application/vnd.google-apps.folder') {
      parentId = candidateId;
      if (parts.length > 0 && (parts[0] === candidateId || parts[0] === existingFolder.name)) {
        parts.shift();
      }
    }
  }

  for (const part of parts) {
    const q = `name = '${escapeDriveQueryValue(part)}' and mimeType = 'application/vnd.google-apps.folder' and '${escapeDriveQueryValue(parentId)}' in parents and trashed = false`;
    const searchUrl = `${GDRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const searchRes = await fetchFn(searchUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12000)
    });
    if (!searchRes.ok) {
      const errTxt = await searchRes.text().catch(() => '');
      throw new Error(`Error buscando carpeta Google Drive "${part}": HTTP ${searchRes.status} ${errTxt.slice(0, 120)}`);
    }
    const searchData = await searchRes.json().catch(() => ({}));
    if (Array.isArray(searchData.files) && searchData.files.length > 0) {
      parentId = searchData.files[0].id;
      continue;
    }

    const createRes = await fetchFn(`${GDRIVE_API}/files?supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: part,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      }),
      signal: AbortSignal.timeout(12000)
    });
    const createData = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !createData.id) {
      throw new Error(`No se pudo crear carpeta "${part}" en Google Drive: HTTP ${createRes.status}`);
    }
    parentId = createData.id;
  }

  return parentId;
}

async function findGoogleDriveFileInFolder(parentId, fileName, accessToken, fetchFn = fetch) {
  const q = `name = '${escapeDriveQueryValue(fileName)}' and '${escapeDriveQueryValue(parentId)}' in parents and trashed = false`;
  const url = `${GDRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetchFn(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.files) && data.files.length > 0 ? data.files[0] : null;
}

async function testGoogleDriveConnection(googleCfg, fetchFn = fetch) {
  const { accessToken } = await getGoogleAccessToken(googleCfg, fetchFn);
  const res = await fetchFn(`${GDRIVE_API}/about?fields=user(displayName,emailAddress),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Google Drive /about HTTP ${res.status}`);
  }

  const baseFolder = String(googleCfg.baseFolder || googleCfg.folderId || 'CYBERPOLIS_VAULT').replace(/^\/+|\/+$/g, '') || 'CYBERPOLIS_VAULT';
  const rootFolderId = await ensureGoogleDriveFolderPath(googleCfg, baseFolder, accessToken, fetchFn);

  const quota = data.storageQuota || {};
  const totalBytes = Number(quota.limit || 0);
  const usedBytes = Number(quota.usage || quota.usageInDrive || 0);
  return {
    connected: true,
    providerType: 'google-drive',
    driveId: rootFolderId,
    driveType: 'Google Drive API v3',
    ownerDisplayName: (data.user && (data.user.displayName || data.user.emailAddress)) || googleCfg.driveUserUpn || 'Google Drive',
    ownerEmail: (data.user && data.user.emailAddress) || googleCfg.driveUserUpn || '',
    quotaTotalBytes: totalBytes,
    quotaUsedBytes: usedBytes,
    quotaRemainingBytes: totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0,
    folderId: rootFolderId,
    folderUrl: `https://drive.google.com/drive/folders/${rootFolderId}`
  };
}

async function uploadToGoogleDriveCore({ googleCfg, relativePath, buffer, filePath, contentType = 'application/octet-stream', fetchFn = fetch }) {
  const { accessToken } = await getGoogleAccessToken(googleCfg, fetchFn);
  const baseFolder = String(googleCfg.baseFolder || googleCfg.folderId || 'CYBERPOLIS_VAULT').replace(/^\/+|\/+$/g, '') || 'CYBERPOLIS_VAULT';
  const relClean = String(relativePath || 'archivo.bin').replace(/^\/+/, '');
  const parts = relClean.split('/').filter(Boolean);
  const fileName = parts.pop() || 'archivo.bin';
  const folderPath = [baseFolder, ...parts].join('/');

  const parentId = await ensureGoogleDriveFolderPath(googleCfg, folderPath, accessToken, fetchFn);
  const existing = await findGoogleDriveFileInFolder(parentId, fileName, accessToken, fetchFn);

  let totalSize = 0;
  if (Buffer.isBuffer(buffer)) {
    totalSize = buffer.length;
  } else if (filePath && fs.existsSync(filePath)) {
    totalSize = fs.statSync(filePath).size;
  } else {
    throw new Error('No se proporcionó buffer ni archivo válido para subir a Google Drive.');
  }

  // Google Drive Resumable Upload con chunks estándar de 8 MB (múltiplo de 256 KB)
  const initUrl = existing
    ? `${GDRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&supportsAllDrives=true`
    : `${GDRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true`;

  const metadata = existing
    ? { name: fileName }
    : { name: fileName, parents: parentId === 'root' ? ['root'] : [parentId] };

  const initRes = await fetchFn(initUrl, {
    method: existing ? 'PATCH' : 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(totalSize)
    },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(30000)
  });

  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '');
    throw new Error(`Google Drive Resumable Init HTTP ${initRes.status}: ${errText.slice(0, 200)}`);
  }

  const sessionUri = initRes.headers.get('location');
  if (!sessionUri) {
    throw new Error(`Google Drive no devolvió URI de sesión reanudable (HTTP ${initRes.status})`);
  }

  const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
  let start = 0;
  let finalFileObj = null;

  while (start < totalSize || (totalSize === 0 && start === 0)) {
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunkLength = end - start;
    let chunkBuffer;

    if (Buffer.isBuffer(buffer)) {
      chunkBuffer = buffer.subarray(start, end);
    } else {
      chunkBuffer = Buffer.alloc(chunkLength);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, chunkBuffer, 0, chunkLength, start);
      fs.closeSync(fd);
    }

    let chunkSuccess = false;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const rangeHeader = totalSize === 0 ? 'bytes */0' : `bytes ${start}-${end - 1}/${totalSize}`;
        const chunkRes = await fetchFn(sessionUri, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunkLength),
            'Content-Range': rangeHeader,
            'Content-Type': contentType
          },
          body: chunkBuffer,
          signal: AbortSignal.timeout(90000)
        });

        if (chunkRes.status === 308) {
          // Chunk intermedio recibido correctamente por Google Drive
          chunkSuccess = true;
          break;
        } else if (chunkRes.status === 200 || chunkRes.status === 201) {
          // Último chunk completado, archivo finalizado
          finalFileObj = await chunkRes.json().catch(() => ({}));
          chunkSuccess = true;
          break;
        } else {
          const txt = await chunkRes.text().catch(() => '');
          throw new Error(`HTTP ${chunkRes.status}: ${txt.slice(0, 160)}`);
        }
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }

    if (!chunkSuccess) {
      throw new Error(`Error subiendo chunk (${start}-${end}/${totalSize}) a Google Drive: ${lastErr?.message || 'Error de red'}`);
    }

    start = end;
    if (totalSize === 0) break;
  }

  const finalId = finalFileObj?.id || (existing?.id || '');
  return {
    itemId: finalId,
    remotePath: `/${folderPath}/${fileName}`,
    folderId: parentId,
    size: totalSize,
    webViewLink: finalFileObj?.webViewLink || `https://drive.google.com/file/d/${finalId}/view`,
    folderUrl: `https://drive.google.com/drive/folders/${parentId}`
  };
}

async function uploadBufferToGoogleDrive(googleCfg, relativePath, buffer, contentType = 'application/octet-stream', fetchFn = fetch) {
  return uploadToGoogleDriveCore({ googleCfg, relativePath, buffer, contentType, fetchFn });
}

async function uploadFileToGoogleDrive(googleCfg, relativePath, filePath, contentType = 'application/octet-stream', fetchFn = fetch) {
  return uploadToGoogleDriveCore({ googleCfg, relativePath, filePath, contentType, fetchFn });
}

async function downloadBufferFromGoogleDrive(googleCfg, relativePath, fetchFn = fetch) {
  const { accessToken } = await getGoogleAccessToken(googleCfg, fetchFn);

  // 1. Si relativePath es directamente un ID de Google Drive (sin barras ni extensiones, largo)
  if (typeof relativePath === 'string' && !relativePath.includes('/') && !relativePath.includes('.') && relativePath.length >= 20) {
    try {
      const directRes = await fetchFn(`${GDRIVE_API}/files/${encodeURIComponent(relativePath)}?alt=media&supportsAllDrives=true`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(60000)
      });
      if (directRes.ok) {
        const arr = await directRes.arrayBuffer();
        return Buffer.from(arr);
      }
    } catch (e) {}
  }

  const cleanRel = String(relativePath || '').replace(/^\/+/, '');
  const parts = cleanRel.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return null;

  // 2. Búsqueda directa y ultra rápida por nombre de archivo cifrado en todo Google Drive
  try {
    const qName = `name = '${escapeDriveQueryValue(fileName)}' and trashed = false`;
    const searchRes = await fetchFn(`${GDRIVE_API}/files?q=${encodeURIComponent(qName)}&fields=files(id,name,size)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000)
    });
    if (searchRes.ok) {
      const searchData = await searchRes.json().catch(() => ({}));
      if (Array.isArray(searchData.files) && searchData.files.length > 0 && searchData.files[0].id) {
        const fileId = searchData.files[0].id;
        const dlRes = await fetchFn(`${GDRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(60000)
        });
        if (dlRes.ok) {
          const arr = await dlRes.arrayBuffer();
          return Buffer.from(arr);
        }
      }
    }
  } catch (errSearch) {
    console.warn('[Enviox GDrive direct name search warning]', errSearch.message);
  }

  // 3. Fallback con recorrido por árbol de carpetas
  const baseFolder = String(googleCfg.baseFolder || googleCfg.folderId || 'CYBERPOLIS_VAULT').replace(/^\/+|\/+$/g, '') || 'CYBERPOLIS_VAULT';
  const fullParts = cleanRel.startsWith(`${baseFolder}/`)
    ? cleanRel.split('/').filter(Boolean)
    : [baseFolder, ...cleanRel.split('/').filter(Boolean)];
  fullParts.pop(); // Remove filename

  let parentId = String(googleCfg.driveId || 'root').trim() || 'root';
  for (const part of fullParts) {
    const q = `name = '${escapeDriveQueryValue(part)}' and mimeType = 'application/vnd.google-apps.folder' and '${escapeDriveQueryValue(parentId)}' in parents and trashed = false`;
    const sr = await fetchFn(`${GDRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12000)
    });
    if (!sr.ok) return null;
    const sd = await sr.json().catch(() => ({}));
    if (!Array.isArray(sd.files) || sd.files.length === 0) return null;
    parentId = sd.files[0].id;
  }

  const fileRec = await findGoogleDriveFileInFolder(parentId, fileName, accessToken, fetchFn);
  if (!fileRec || !fileRec.id) return null;

  const dlRes = await fetchFn(`${GDRIVE_API}/files/${encodeURIComponent(fileRec.id)}?alt=media&supportsAllDrives=true`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(45000)
  });
  if (dlRes.status === 404) return null;
  if (!dlRes.ok) {
    throw new Error(`Google Drive download HTTP ${dlRes.status}`);
  }
  const arr = await dlRes.arrayBuffer();
  return Buffer.from(arr);
}

async function deleteItemFromGoogleDrive(googleCfg, itemIdOrPath, fetchFn = fetch) {
  try {
    if (!itemIdOrPath) return;
    const { accessToken } = await getGoogleAccessToken(googleCfg, fetchFn);
    if (!String(itemIdOrPath).includes('/')) {
      await fetchFn(`${GDRIVE_API}/files/${encodeURIComponent(itemIdOrPath)}?supportsAllDrives=true`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000)
      });
    }
  } catch (e) {}
}

async function sendGmailApiMail(googleCfg, { fromEmail, to, subject, htmlBody, textBody }, fetchFn = fetch) {
  const { accessToken } = await getGoogleAccessToken(googleCfg, fetchFn);
  const sender = fromEmail || googleCfg.driveUserUpn || 'me';
  const encodedSub = `=?UTF-8?B?${Buffer.from(String(subject || 'Notificación CYBERPOLIS'), 'utf8').toString('base64')}?=`;
  const mime = [
    sender && sender !== 'me' ? `From: CYBERPOLIS Transfer <${sender}>` : 'From: CYBERPOLIS Transfer <me>',
    `To: <${to}>`,
    `Subject: ${encodedSub}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    String(htmlBody || textBody || '')
  ].join('\r\n');

  const raw = base64UrlEncode(Buffer.from(mime, 'utf8'));
  const res = await fetchFn(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Gmail API HTTP ${res.status}`);
  }
  return { sent: true, provider: 'gmail-api', messageId: data.id || '' };
}

function buildGoogleOAuthAuthorizeUrl({ clientId, redirectUri, state, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GOOGLE_SCOPES,
    state
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${GOOGLE_OAUTH_AUTH}?${params.toString()}`;
}

async function exchangeGoogleOAuthCode({ clientId, clientSecret, code, redirectUri, fetchFn = fetch }) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret || '',
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  const res = await fetchFn(GOOGLE_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || 'Google no devolvió refresh_token (asegura prompt=consent + access_type=offline).');
  }
  return data;
}

module.exports = {
  GOOGLE_SCOPES,
  resolveEnvGoogleProvider,
  resolveEnvMailGateway,
  resolveActiveMailGateway,
  getGoogleAccessToken,
  testGoogleDriveConnection,
  uploadBufferToGoogleDrive,
  uploadFileToGoogleDrive,
  downloadBufferFromGoogleDrive,
  deleteItemFromGoogleDrive,
  sendGmailApiMail,
  buildGoogleOAuthAuthorizeUrl,
  exchangeGoogleOAuthCode
};
