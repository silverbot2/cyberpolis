// standalone-server.js — Servidor autónomo para ejecutar CYBERPOLIS Enviox de forma 100% independiente
// Cero dependencias externas (solo Node.js nativo http, fs, path, crypto)
// Úsalo si deseas extraer esta carpeta a otro repositorio o dominio dedicado (ej: Enviox.tuempresa.com)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_FILE = path.join(__dirname, 'Enviox-data.json');

// Cargar o inicializar base de datos local JSON
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
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
      brandName: process.env.BRAND_NAME || 'ENVIOX',
      brandSubtitle: 'Plataforma Enviox Segura'
    },
    transfers: [],
    contacts: [],
    groups: [],
    roles: [
      { name: 'Admin', description: 'Plantilla: perfil SAML ADMIN', type: 'Plantilla', permissionsCount: 12 },
      { name: 'Enviar + Recibir', description: 'Plantilla: perfil SAML ENVIAR + RECIBIR', type: 'Plantilla', permissionsCount: 2 },
      { name: 'Enviar', description: 'Plantilla: perfil SAML ENVIAR', type: 'Plantilla', permissionsCount: 1 },
      { name: 'Recibir', description: 'Plantilla: perfil SAML RECIBIR', type: 'Plantilla', permissionsCount: 1 },
      { name: 'Total', description: 'Plantilla: perfil SAML TOTAL', type: 'Plantilla', permissionsCount: 18 }
    ]
  };
}

let store = loadData();
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando Enviox-data.json:', e.message);
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;

  // Servir frontend
  if (pathname === '/' || pathname === '/Enviox' || pathname === '/Enviox/') {
    pathname = '/index.html';
  } else if (pathname.startsWith('/Enviox/')) {
    pathname = pathname.replace('/Enviox/', '/');
  }

  // APIs para el modo independiente
  if (pathname === '/api/Enviox/init' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      user: { id: 'u-admin', username: 'admin', fullName: 'Administrador Autónomo', email: 'admin@clgrupoindustrial.com', role: 'admin' },
      settings: store.settings,
      contacts: store.contacts,
      groups: store.groups,
      roles: store.roles,
      cloudStorage: {
        configured: true,
        provider: 'standalone',
        name: 'Almacenamiento Autónomo Cifrado',
        capacity: '5 TB'
      },
      mailGateway: { configured: true, mode: 'smtp', user: 'notificaciones@clgrupoindustrial.com' }
    }));
    return;
  }

  if (pathname === '/api/Enviox/records' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const records = (store.transfers || []).slice().reverse();
    res.end(JSON.stringify({
      records,
      stats: {
        total: records.length,
        sent: records.filter(r => r.type === 'enviado').length,
        received: records.filter(r => r.type === 'recibido').length,
        active: records.filter(r => r.status === 'activo').length,
        expired: records.filter(r => r.status === 'caducado').length,
        cancelled: records.filter(r => r.status === 'cancelled').length
      }
    }));
    return;
  }

  if (pathname === '/api/Enviox/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const refChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        let ref = '';
        for (let i = 0; i < 3; i++) ref += refChars.charAt(Math.floor(Math.random() * refChars.length));

        const newTx = {
          id: 'tx-' + Date.now().toString(36),
          reference: ref,
          type: 'enviado',
          sender: 'admin@clgrupoindustrial.com',
          groupName: '-',
          recipient: (payload.recipients && payload.recipients[0]) || 'destinatario@empresa.com',
          allRecipients: payload.recipients || [],
          subject: payload.subject || 'Envío confidencial',
          filesSummary: `${(payload.files || []).length} Archivo(s)`,
          createdAt: new Date().toISOString(),
          status: 'activo',
          downloadsCount: 0,
          maxDownloads: 3,
          shareUrl: `http://${req.headers.host || 'localhost:3000'}/?tx=${ref}`,
          legalAudit: [{ timestamp: new Date().toISOString(), ip: req.socket.remoteAddress, details: 'Envío registrado' }]
        };
        store.transfers.push(newTx);
        saveData();

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reference: ref, shareUrl: newTx.shareUrl, expiresAt: new Date(Date.now() + 8*86400000).toISOString() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Archivos estáticos
  const filePath = path.join(__dirname, '.' + pathname);
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('404 Recurso no encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`CYBERPOLIS Enviox (Standalone) ejecutándose en:`);
  console.log(`http://localhost:${PORT}`);
  console.log(`=======================================================`);
});

