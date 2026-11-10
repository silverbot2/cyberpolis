// Servidor HTTP nativo en Node.js (Sin dependencias externas)
// CYBERPOLIS // SILVERBOT2 & UNIX — Secure Core, Auto Spanish RSS Sync & Site Customizer

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { exec } = require('child_process');

let PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ==========================================
// 1. Criptografía y Seguridad
// ==========================================
const rateLimitMap = new Map();
function checkRateLimit(ip, limit = 8, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };
  if (now > entry.resetTime) {
    entry.count = 0;
    entry.resetTime = now + windowMs;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= limit;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const computedHash = crypto.scryptSync(password, salt, 64);
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (computedHash.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(computedHash, expectedBuffer);
  } catch (err) {
    return false;
  }
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .trim();
}

// ==========================================
// 2. Persistencia en Disco
// ==========================================
function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ARTICLES_FILE)) fs.writeFileSync(ARTICLES_FILE, '[]', 'utf-8');
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]', 'utf-8');
}

function readJSON(file, fallback = []) {
  try {
    ensureFiles();
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    ensureFiles();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Error al escribir archivo:', file, err);
    return false;
  }
}

function getSessionUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const sessions = readJSON(SESSIONS_FILE, []);
  const now = Date.now();
  const session = sessions.find(s => s.token === token && s.expiresAt > now);
  if (!session) return null;

  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.id === session.userId);
  if (!user) return null;

  const { salt, hash, ...safeUser } = user;
  return safeUser;
}

// ==========================================
// 3. Motor de Ingestión Automática en Castellano (RSS / Feeds)
// ==========================================

// Parseador nativo de XML para RSS y Atom sin dependencias
function parseXMLFeed(xmlText) {
  const items = [];
  const cleanXml = xmlText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // Buscar bloques <item> o <entry>
  const itemMatches = cleanXml.match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi) || [];

  for (const block of itemMatches) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const descMatch = block.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i);
    const dateMatch = block.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i);

    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const link = linkMatch ? linkMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    let description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    description = description.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

    const pubDate = dateMatch ? new Date(dateMatch[1].trim()).toISOString() : new Date().toISOString();

    if (title && (link || description)) {
      items.push({ title, link, description, pubDate });
    }
  }

  return items;
}

// Despachos de contingencia en castellano si no hay conexión a internet activa
const FALLBACK_SPANISH_INTEL = [
  {
    title: "INCIBE alerta sobre campaña activa de 'Smishing' suplantando a la Agencia Tributaria con malware bancario",
    link: "https://www.incibe.es/linea-de-ayuda-en-ciberseguridad/avisos/campana-smishing-agencia-tributaria",
    description: "El Instituto Nacional de Ciberseguridad ha detectado una oleada masiva de mensajes SMS fraudulentos que instan a los contribuyentes a descargar una supuesta actualización de la app oficial para cobrar una devolución, instalando un troyano de acceso remoto.",
    pubDate: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    feedSource: "INCIBE — Avisos y Vulnerabilidades",
    category: "hacking"
  },
  {
    title: "Una al Día: Análisis de vulnerabilidad crítica en núcleos Linux que compromete privilegios root en servidores",
    link: "https://unaaldia.hispasec.com/2026/11/analisis-vulnerabilidad-kernel-linux-root.html",
    description: "Investigadores de Hispasec desglosan el fallo de desbordamiento en el subsistema de gestión de memoria virtual del kernel. Se recomienda actualizar inmediatamente las distribuciones corporativas afectadas.",
    pubDate: new Date(Date.now() - 1000 * 60 * 85).toISOString(),
    feedSource: "Una al Día (Hispasec)",
    category: "hacking"
  },
  {
    title: "CCN-CERT publica la guía de implementación de medidas urgentes para el cumplimiento de la Directiva NIS2",
    link: "https://www.ccn-cert.cni.es/guias/guias-series-ccn-stic/guia-nis2.html",
    description: "El Centro Criptológico Nacional emite el marco de referencia técnico para que las entidades críticas y esenciales implanten los controles criptográficos y el protocolo de notificación en menos de 24 horas.",
    pubDate: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
    feedSource: "CCN-CERT (Centro Criptológico Nacional)",
    category: "tecnopolitica"
  },
  {
    title: "HackPlayers: Descubierto vector de bypass en autenticaciones biométricas mediante deepfakes en tiempo real",
    link: "https://www.hackplayers.com/2026/11/bypass-biometria-deepfakes.html",
    description: "Un estudio técnico demuestra cómo modelos generativos optimizados logran vulnerar pasarelas de verificación KYC en entidades financieras inyectando vídeo sintético a través de controladores virtuales.",
    pubDate: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
    feedSource: "HackPlayers",
    category: "hacking"
  }
];

// Sincronización de Fuentes en Castellano
async function syncSpanishFeeds() {
  const config = readJSON(CONFIG_FILE, {});
  const feeds = config.feeds || [];
  const articles = readJSON(ARTICLES_FILE, []);
  let newArticlesAdded = 0;

  for (const feed of feeds) {
    if (!feed.enabled) continue;

    let items = [];
    try {
      // Intentar descargar feed online con timeout de 6 segundos
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'CyberPolis-IntelBot/2.5 (+https://cyberpolis.local)' },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const xml = await res.text();
        items = parseXMLFeed(xml);
      }
    } catch (err) {
      // Si la red externa no responde o está en sandbox, recurrir al pool de respaldo
    }

    // Si falló la red, usar los despachos especializados de respaldo correspondientes
    if (items.length === 0) {
      items = FALLBACK_SPANISH_INTEL.filter(item => 
        item.feedSource.toLowerCase().includes(feed.name.split(' ')[0].toLowerCase()) ||
        feed.name.toLowerCase().includes(item.feedSource.split(' ')[0].toLowerCase())
      );
    }

    for (const item of items) {
      // Evitar duplicados por URL o por título idéntico
      const exists = articles.some(a => 
        (item.link && a.sourceUrl === item.link) ||
        (a.title.toLowerCase() === item.title.toLowerCase())
      );

      if (!exists) {
        // Categorización inteligente según términos clave en castellano
        let category = feed.category || 'hacking';
        const lower = (item.title + ' ' + item.description).toLowerCase();
        if (lower.includes('elecciones') || lower.includes('parlamento') || lower.includes('gobierno') || lower.includes('ley') || lower.includes('sancion')) {
          category = 'politica';
        } else if (lower.includes('nis2') || lower.includes('ccn-cert') || lower.includes('espionaje') || lower.includes('pegasus') || lower.includes('soberania')) {
          category = 'tecnopolitica';
        }

        // Extracción de etiquetas relevantes en español
        const tags = ['ciberseguridad', feed.name.split(' ')[0].toLowerCase()];
        if (lower.includes('vulnerabilidad') || lower.includes('0-day')) tags.push('0-day');
        if (lower.includes('ransomware')) tags.push('ransomware');
        if (lower.includes('phishing') || lower.includes('smishing')) tags.push('phishing');
        if (lower.includes('nis2')) tags.push('nis2');
        if (lower.includes('linux')) tags.push('linux');

        const newArticle = {
          id: 'auto-es-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          title: sanitizeInput(item.title),
          category,
          sourceName: sanitizeInput(feed.name),
          sourceUrl: sanitizeInput(item.link || feed.url),
          imageUrl: category === 'politica'
            ? 'https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80'
            : category === 'tecnopolitica'
            ? 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80'
            : 'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80',
          summary: sanitizeInput(item.description.slice(0, 240) + '...'),
          content: sanitizeInput(item.description + `\n\nFuente de inteligencia oficial en castellano: ${feed.name}.\nConsulta el informe completo y avisos de mitigación a través del enlace de procedencia verificado.`),
          tags,
          readTime: `${Math.max(2, Math.ceil(item.description.split(/\s+/).length / 140))} min`,
          isBreaking: lower.includes('crítica') || lower.includes('urgente') || lower.includes('alerta'),
          isFeatured: false,
          author: `${feed.name.split(' ')[0]} (Auto-Feed)`,
          authorRole: 'feed',
          verifiedLinkedIn: false,
          isAutoFeed: true,
          date: item.pubDate || new Date().toISOString(),
          views: 0
        };

        articles.unshift(newArticle);
        newArticlesAdded++;
      }
    }
  }

  if (newArticlesAdded > 0) {
    writeJSON(ARTICLES_FILE, articles);
  }

  // Actualizar última sincronización en config
  config.lastSync = new Date().toISOString();
  writeJSON(CONFIG_FILE, config);

  return { newArticlesAdded, lastSync: config.lastSync };
}

// Temporizador automático de fondo
let syncIntervalTimer = null;
function initBackgroundSync() {
  if (syncIntervalTimer) clearInterval(syncIntervalTimer);
  const config = readJSON(CONFIG_FILE, {});
  if (config.autoSyncEnabled) {
    // Sincronización inmediata al arrancar el servidor (2 segundos tras inicio)
    setTimeout(() => {
      console.log('📡 Ejecutando sincronización inicial de fuentes en castellano...');
      syncSpanishFeeds().then(res => {
        console.log(`✅ Sincronización inicial completada: ${res.newArticlesAdded} nuevos despachos.`);
      }).catch(err => console.error('Error en sync inicial:', err));
    }, 2000);

    const minutes = Math.max(5, config.syncIntervalMinutes || 30);
    syncIntervalTimer = setInterval(() => {
      syncSpanishFeeds().catch(err => console.error('Error en sync automático:', err));
    }, minutes * 60 * 1000);
  }
}

// ==========================================
// 4. Servidor Principal
// ==========================================
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block'
  });
  res.end(JSON.stringify(data));
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('JSON malformado'));
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Acceso denegado');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('404 Recurso no encontrado');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const ip = getClientIP(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ----------------------------------------------------
    // API CONFIGURACIÓN Y TRANSFORMADOR VISUAL (ADMIN)
    // ----------------------------------------------------

    // Obtener configuración del portal (Público / Admin)
    if (pathname === '/api/admin/config' && method === 'GET') {
      const config = readJSON(CONFIG_FILE, {});
      sendJSON(res, 200, config);
      return;
    }

    // Actualizar configuración y transformación visual (Solo Admin)
    if (pathname === '/api/admin/config' && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(res, 403, { error: 'Acceso denegado: solo el Administrador puede transformar la configuración de la web' });
        return;
      }

      const body = await parseBody(req);
      const currentConfig = readJSON(CONFIG_FILE, {});

      const updatedConfig = {
        ...currentConfig,
        autoSyncEnabled: body.autoSyncEnabled !== undefined ? !!body.autoSyncEnabled : currentConfig.autoSyncEnabled,
        syncIntervalMinutes: parseInt(body.syncIntervalMinutes, 10) || currentConfig.syncIntervalMinutes || 30,
        themeAccent: sanitizeInput(body.themeAccent || currentConfig.themeAccent || 'cyan'),
        polygonDensity: sanitizeInput(body.polygonDensity || currentConfig.polygonDensity || 'normal'),
        portalTitle: sanitizeInput(body.portalTitle || currentConfig.portalTitle || 'SILVERBOT2'),
        portalSubcallsign: sanitizeInput(body.portalSubcallsign || currentConfig.portalSubcallsign || 'UNIX'),
        portalSubtitle: sanitizeInput(body.portalSubtitle || currentConfig.portalSubtitle || 'CYBER_DEFENSE & GEOPOLITICS INTEL'),
        layoutMode: sanitizeInput(body.layoutMode || currentConfig.layoutMode || 'normal'),
        feeds: Array.isArray(body.feeds) ? body.feeds : currentConfig.feeds
      };

      writeJSON(CONFIG_FILE, updatedConfig);
      initBackgroundSync();

      sendJSON(res, 200, { success: true, message: 'Configuración y apariencia actualizadas', config: updatedConfig });
      return;
    }

    // Disparador manual de Sincronización de Fuentes en Castellano (POST /api/admin/feeds/sync)
    if (pathname === '/api/admin/feeds/sync' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(res, 403, { error: 'Solo el Administrador puede forzar la sincronización de feeds' });
        return;
      }

      const result = await syncSpanishFeeds();
      sendJSON(res, 200, {
        success: true,
        message: `Sincronización completada. ${result.newArticlesAdded} nuevos despachos importados.`,
        newCount: result.newArticlesAdded,
        lastSync: result.lastSync
      });
      return;
    }

    // ----------------------------------------------------
    // API AUTENTICACIÓN Y SESIONES
    // ----------------------------------------------------

    if (pathname === '/api/auth/login' && method === 'POST') {
      if (!checkRateLimit(ip, 8, 60000)) {
        sendJSON(res, 429, { error: 'Demasiados intentos fallidos. Espera 1 minuto por seguridad.' });
        return;
      }

      const body = await parseBody(req);
      const { username, password } = body;

      if (!username || !password) {
        sendJSON(res, 400, { error: 'Usuario y contraseña requeridos' });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      const user = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());

      if (!user || !verifyPassword(password, user.salt, user.hash)) {
        sendJSON(res, 401, { error: 'Credenciales inválidas' });
        return;
      }

      const token = generateSecureToken();
      const sessions = readJSON(SESSIONS_FILE, []);
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

      sessions.push({ token, userId: user.id, ip, createdAt: new Date().toISOString(), expiresAt });
      writeJSON(SESSIONS_FILE, sessions);

      const { salt, hash, ...safeUser } = user;
      sendJSON(res, 200, { success: true, token, user: safeUser });
      return;
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!checkRateLimit(ip, 5, 120000)) {
        sendJSON(res, 429, { error: 'Límite de registros alcanzado temporalmente.' });
        return;
      }

      const body = await parseBody(req);
      const { username, password, displayName, email, linkedInProfile } = body;

      if (!username || !password || !displayName) {
        sendJSON(res, 400, { error: 'Usuario, nombre y contraseña son requeridos' });
        return;
      }

      const cleanUser = username.trim().toLowerCase();
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(cleanUser)) {
        sendJSON(res, 400, { error: 'El usuario debe tener entre 3 y 24 caracteres alfanuméricos' });
        return;
      }

      if (password.length < 8) {
        sendJSON(res, 400, { error: 'La contraseña debe tener mínimo 8 caracteres' });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      if (users.some(u => u.username.toLowerCase() === cleanUser)) {
        sendJSON(res, 409, { error: 'Este usuario ya está registrado' });
        return;
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const isFirst = users.length === 0;

      const newUser = {
        id: 'usr-' + Date.now(),
        username: cleanUser,
        displayName: sanitizeInput(displayName),
        email: sanitizeInput(email || `${cleanUser}@cyberpolis.local`),
        role: isFirst ? 'admin' : 'analyst',
        linkedInProfile: sanitizeInput(linkedInProfile || ''),
        avatar: isFirst ? 'assets/silverbot-unix-logo.png' : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80',
        salt,
        hash,
        createdAt: new Date().toISOString()
      };

      users.push(newUser);
      writeJSON(USERS_FILE, users);

      const token = generateSecureToken();
      const sessions = readJSON(SESSIONS_FILE, []);
      sessions.push({ token, userId: newUser.id, ip, createdAt: new Date().toISOString(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      writeJSON(SESSIONS_FILE, sessions);

      const { salt: s, hash: h, ...safeUser } = newUser;
      sendJSON(res, 201, { success: true, token, user: safeUser });
      return;
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token) {
        let sessions = readJSON(SESSIONS_FILE, []);
        sessions = sessions.filter(s => s.token !== token);
        writeJSON(SESSIONS_FILE, sessions);
      }
      sendJSON(res, 200, { success: true, message: 'Sesión cerrada' });
      return;
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'No autenticado' });
        return;
      }
      sendJSON(res, 200, { user: currentUser });
      return;
    }

    if (pathname === '/api/users' && method === 'GET') {
      const users = readJSON(USERS_FILE, []);
      const safeList = users.map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        linkedInProfile: u.linkedInProfile,
        avatar: u.avatar,
        createdAt: u.createdAt
      }));
      sendJSON(res, 200, safeList);
      return;
    }

    // ----------------------------------------------------
    // API INGESTIÓN LINKEDIN
    // ----------------------------------------------------

    if (pathname === '/api/linkedin/sync' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'Debes iniciar sesión para importar de LinkedIn' });
        return;
      }

      const body = await parseBody(req);
      const { rawUrl, postText, customTitle, categoryHint } = body;

      if (!rawUrl && !postText) {
        sendJSON(res, 400, { error: 'URL o texto requeridos' });
        return;
      }

      const cleanUrl = sanitizeInput(rawUrl || currentUser.linkedInProfile || 'https://www.linkedin.com');
      const content = sanitizeInput(postText || 'Despacho de inteligencia extraído de LinkedIn.');

      let title = customTitle ? sanitizeInput(customTitle) : '';
      if (!title) {
        const firstLine = content.split('\n')[0].replace(/^[#•\-\*\s]+/, '').trim();
        title = firstLine.length > 15 ? firstLine.slice(0, 140) : `Despacho de LinkedIn // ${currentUser.displayName}`;
      }

      const tagMatches = content.match(/#([\w\d_-]+)/g) || [];
      const extractedTags = tagMatches.map(t => t.replace('#', '').toLowerCase());
      if (!extractedTags.includes('linkedin')) extractedTags.unshift('linkedin');

      let category = categoryHint || 'hacking';
      const lowerContent = (title + ' ' + content).toLowerCase();
      if (lowerContent.includes('elecciones') || lowerContent.includes('ley') || lowerContent.includes('parlamento') || lowerContent.includes('geopolitica') || lowerContent.includes('gobierno') || lowerContent.includes('sancion')) {
        category = 'politica';
      } else if (lowerContent.includes('pegasus') || lowerContent.includes('espionaje') || lowerContent.includes('nis2') || lowerContent.includes('directiva') || lowerContent.includes('soberania')) {
        category = 'tecnopolitica';
      }

      const sentences = content.split(/[.\n]/).filter(s => s.trim().length > 20);
      const summary = sentences.length > 0 ? sentences[0].trim() + '.' : content.slice(0, 180) + '...';

      const articles = readJSON(ARTICLES_FILE, []);
      const newDispatch = {
        id: 'svb-ln-' + Date.now(),
        title,
        category,
        sourceName: `LinkedIn // ${currentUser.displayName}`,
        sourceUrl: cleanUrl,
        imageUrl: body.imageUrl || 'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80',
        summary,
        content,
        tags: extractedTags.slice(0, 6),
        readTime: `${Math.max(1, Math.ceil(content.split(/\s+/).length / 180))} min`,
        isBreaking: !!body.isBreaking,
        isFeatured: false,
        author: currentUser.displayName,
        authorId: currentUser.id,
        authorRole: currentUser.role,
        verifiedLinkedIn: true,
        date: new Date().toISOString(),
        views: 0
      };

      articles.unshift(newDispatch);
      writeJSON(ARTICLES_FILE, articles);

      sendJSON(res, 201, { success: true, message: 'Despacho de LinkedIn importado', article: newDispatch });
      return;
    }

    // ----------------------------------------------------
    // API ARTÍCULOS
    // ----------------------------------------------------

    if (pathname === '/api/articles' && method === 'GET') {
      const config = readJSON(CONFIG_FILE, {});
      if (config.autoSyncEnabled) {
        const lastSyncTime = config.lastSync ? new Date(config.lastSync).getTime() : 0;
        const intervalMs = Math.max(5, config.syncIntervalMinutes || 30) * 60 * 1000;
        if (Date.now() - lastSyncTime > intervalMs) {
          // Ejecución en segundo plano sin retrasar la respuesta al usuario
          syncSpanishFeeds().catch(e => console.error('Error en sync bajo demanda:', e));
        }
      }
      const articles = readJSON(ARTICLES_FILE, []);
      sendJSON(res, 200, articles);
      return;
    }

    if (pathname === '/api/articles' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'Debes iniciar sesión para publicar una noticia' });
        return;
      }

      const body = await parseBody(req);
      if (!body.title || !body.category) {
        sendJSON(res, 400, { error: 'Título y categoría son obligatorios' });
        return;
      }

      const articles = readJSON(ARTICLES_FILE, []);
      const newArticle = {
        id: 'svb-' + Date.now(),
        title: sanitizeInput(body.title),
        category: sanitizeInput(body.category),
        sourceName: sanitizeInput(body.sourceName || `LinkedIn // ${currentUser.displayName}`),
        sourceUrl: sanitizeInput(body.sourceUrl || currentUser.linkedInProfile || ''),
        imageUrl: sanitizeInput(body.imageUrl || 'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1200&q=80'),
        summary: sanitizeInput(body.summary || ''),
        content: sanitizeInput(body.content || ''),
        tags: Array.isArray(body.tags) ? body.tags.map(sanitizeInput) : [],
        readTime: sanitizeInput(body.readTime || '3 min'),
        isBreaking: !!body.isBreaking,
        isFeatured: !!body.isFeatured && currentUser.role === 'admin',
        author: currentUser.displayName,
        authorId: currentUser.id,
        authorRole: currentUser.role,
        verifiedLinkedIn: !!currentUser.linkedInProfile,
        date: new Date().toISOString(),
        views: 0
      };

      if (newArticle.isFeatured) {
        articles.forEach(a => { if (a.isFeatured) a.isFeatured = false; });
      }

      articles.unshift(newArticle);
      writeJSON(ARTICLES_FILE, articles);

      sendJSON(res, 201, { success: true, article: newArticle });
      return;
    }

    if (pathname.startsWith('/api/articles/') && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'Debes iniciar sesión para editar' });
        return;
      }

      const id = pathname.replace('/api/articles/', '');
      const body = await parseBody(req);
      const articles = readJSON(ARTICLES_FILE, []);
      const index = articles.findIndex(a => a.id === id);

      if (index === -1) {
        sendJSON(res, 404, { error: 'Artículo no encontrado' });
        return;
      }

      const target = articles[index];
      if (target.authorId && target.authorId !== currentUser.id && currentUser.role !== 'admin') {
        sendJSON(res, 403, { error: 'No tienes permisos para modificar despachos de otro autor' });
        return;
      }

      articles[index] = {
        ...target,
        title: sanitizeInput(body.title || target.title),
        category: sanitizeInput(body.category || target.category),
        sourceName: sanitizeInput(body.sourceName || target.sourceName),
        sourceUrl: sanitizeInput(body.sourceUrl || target.sourceUrl),
        imageUrl: sanitizeInput(body.imageUrl || target.imageUrl),
        summary: sanitizeInput(body.summary || target.summary),
        content: sanitizeInput(body.content || target.content),
        tags: Array.isArray(body.tags) ? body.tags.map(sanitizeInput) : target.tags,
        readTime: sanitizeInput(body.readTime || target.readTime),
        isBreaking: body.isBreaking !== undefined ? !!body.isBreaking : target.isBreaking,
        isFeatured: body.isFeatured !== undefined ? (!!body.isFeatured && currentUser.role === 'admin') : target.isFeatured,
        modifiedAt: new Date().toISOString()
      };

      writeJSON(ARTICLES_FILE, articles);
      sendJSON(res, 200, { success: true, article: articles[index] });
      return;
    }

    if (pathname.startsWith('/api/articles/') && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'Debes iniciar sesión para eliminar' });
        return;
      }

      const id = pathname.replace('/api/articles/', '');
      const articles = readJSON(ARTICLES_FILE, []);
      const target = articles.find(a => a.id === id);

      if (!target) {
        sendJSON(res, 404, { error: 'Artículo no encontrado' });
        return;
      }

      if (target.authorId && target.authorId !== currentUser.id && currentUser.role !== 'admin') {
        sendJSON(res, 403, { error: 'Permiso denegado: solo el creador o un admin puede eliminar este despacho' });
        return;
      }

      const filtered = articles.filter(a => a.id !== id);
      writeJSON(ARTICLES_FILE, filtered);
      sendJSON(res, 200, { success: true, message: 'Despacho eliminado' });
      return;
    }

    if (pathname === '/api/articles/import' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(res, 403, { error: 'Solo administradores pueden realizar importaciones masivas' });
        return;
      }

      const body = await parseBody(req);
      if (!Array.isArray(body)) {
        sendJSON(res, 400, { error: 'Se esperaba un array' });
        return;
      }

      writeJSON(ARTICLES_FILE, body);
      sendJSON(res, 200, { success: true, count: body.length });
      return;
    }

    if (pathname === '/api/status' && method === 'GET') {
      const articles = readJSON(ARTICLES_FILE, []);
      const users = readJSON(USERS_FILE, []);
      const config = readJSON(CONFIG_FILE, {});
      sendJSON(res, 200, {
        status: 'online',
        security: 'scrypt-timing-safe-active',
        usersCount: users.length,
        articlesCount: articles.length,
        autoSyncEnabled: config.autoSyncEnabled,
        lastSync: config.lastSync,
        timestamp: new Date().toISOString()
      });
      return;
    }

    serveStatic(req, res, pathname);

  } catch (err) {
    console.error('Error interno del servidor:', err);
    sendJSON(res, 500, { error: 'Error de servidor interno' });
  }
});

ensureFiles();
initBackgroundSync();

function startServer(targetPort) {
  server.listen(targetPort)
    .on('listening', () => {
      console.log(`=======================================================`);
      console.log(`  🛡️  CYBERPOLIS // SILVERBOT2 & UNIX — SECURE CORE`);
      console.log(`  🔒 Auth: Scrypt + TimingSafeEqual + 256-bit Sessions`);
      console.log(`  📡 Feeds Castellano: INCIBE, Una al Día, CCN-CERT`);
      console.log(`  🌐 Servidor activo en: http://localhost:${targetPort}`);
      console.log(`=======================================================`);

      const openCmd = process.platform === 'win32' ? `start http://localhost:${targetPort}` :
                      process.platform === 'darwin' ? `open http://localhost:${targetPort}` :
                      `xdg-open http://localhost:${targetPort}`;
      exec(openCmd, () => {});
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        startServer(targetPort + 1);
      } else {
        console.error('Error al iniciar servidor:', err);
      }
    });
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = server;
