// Servidor HTTP nativo en Node.js (CYBERPOLIS — Hardened Core & Persistent Store)
// Persistencia unificada (PostgreSQL / Disco / GitHub Gist Privado / Caché Local),
// Auth con cookies HttpOnly, protección SSRF, CSRF, XSS, CSP y rate limiting por contexto.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { exec } = require('child_process');
const { CyberpolisStore } = require('./dbStore');
const cloudOneDrive = require('./cloudOneDrive');
const cloudGoogle = require('./cloudGoogle');
const envioxBackend = require('./envioxBackend');
const tranxferBackend = envioxBackend;

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const FORUM_FILE = path.join(DATA_DIR, 'forum.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const TRANSFERS_FILE = path.join(DATA_DIR, 'transfers.json');
const CLOUD_FILE = path.join(DATA_DIR, 'cloud.json');
const ENVIOX_FILE = path.join(DATA_DIR, 'enviox.json');
const VAULT_DIR = path.join(DATA_DIR, 'vault');

const FILE_TO_STORE_KEY = new Map([
  [ARTICLES_FILE, 'articles'],
  [USERS_FILE, 'users'],
  [SESSIONS_FILE, 'sessions'],
  [CONFIG_FILE, 'config'],
  [FORUM_FILE, 'forum'],
  [ANALYTICS_FILE, 'analytics'],
  [CHAT_FILE, 'chat'],
  [AUDIT_FILE, 'audit'],
  [TRANSFERS_FILE, 'transfers'],
  [CLOUD_FILE, 'cloud'],
  [ENVIOX_FILE, 'enviox']
]);

const store = new CyberpolisStore();

const SESSION_COOKIE_NAME = 'cyberpolis_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROXY_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ==========================================
// 1. Criptografía, Sesiones y Seguridad
// ==========================================
const rateLimitMap = new Map();
const failedLoginMap = new Map();

// Sal y hash ficticios para evitar enumeración de usuarios por tiempo de respuesta
const DUMMY_SALT = 'cyberpolis_timing_guard_salt_2026';
const DUMMY_HASH = crypto.scryptSync('CYBERPOLIS_DUMMY_PASS_NEVER_MATCH', DUMMY_SALT, 64).toString('hex');

const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password123',
  'admin1234', 'admin12345', 'cyberpolis', 'cyberpolis2026', 'qwerty1234',
  'qwertyuiop', 'letmein123', 'welcome123', 'scaceres2$'
]);

function checkRateLimit(bucketKey, limit = 8, windowMs = 60000) {
  const now = Date.now();
  if (rateLimitMap.size > 3000) {
    for (const [k, v] of rateLimitMap.entries()) {
      if (now > v.resetTime) rateLimitMap.delete(k);
    }
  }
  const entry = rateLimitMap.get(bucketKey) || { count: 0, resetTime: now + windowMs };
  if (now > entry.resetTime) {
    entry.count = 0;
    entry.resetTime = now + windowMs;
  }
  entry.count++;
  rateLimitMap.set(bucketKey, entry);
  return entry.count <= limit;
}

function getAccountLockStatus(usernameKey) {
  const now = Date.now();
  if (failedLoginMap.size > 1500) {
    for (const [k, v] of failedLoginMap.entries()) {
      if (v.lockedUntil && now > v.lockedUntil) failedLoginMap.delete(k);
    }
  }
  const rec = failedLoginMap.get(usernameKey);
  if (rec && rec.lockedUntil && now < rec.lockedUntil) {
    return { locked: true, remainingSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { locked: false, remainingSec: 0 };
}

function recordFailedLogin(usernameKey) {
  const now = Date.now();
  const rec = failedLoginMap.get(usernameKey) || { count: 0, lockedUntil: 0 };
  if (rec.lockedUntil && now >= rec.lockedUntil) {
    rec.count = 0;
    rec.lockedUntil = 0;
  }
  rec.count += 1;
  if (rec.count >= 6) {
    rec.lockedUntil = now + 10 * 60 * 1000;
  }
  failedLoginMap.set(usernameKey, rec);
}

function clearFailedLogin(usernameKey) {
  failedLoginMap.delete(usernameKey);
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

function validatePasswordStrength(password) {
  if (typeof password !== 'string') {
    return { ok: false, error: 'La contraseña debe ser texto válido.' };
  }
  if (password.length < 10) {
    return { ok: false, error: 'La contraseña debe tener mínimo 10 caracteres.' };
  }
  if (password.length > 128) {
    return { ok: false, error: 'La contraseña no puede superar 128 caracteres.' };
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigitOrSymbol = /[0-9]|[^a-zA-Z0-9\s]/.test(password);
  if (!hasLetter || !hasDigitOrSymbol) {
    return { ok: false, error: 'La contraseña debe combinar letras y números o símbolos.' };
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, error: 'Esa contraseña es demasiado común o ha sido comprometida. Elige otra.' };
  }
  return { ok: true };
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function sanitizeInput(str, maxLen = 20000) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\u0000/g, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/(?:javascript|vbscript):/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim()
    .slice(0, maxLen);
}

function sanitizeExternalUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1000);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  } catch (e) {
    return '';
  }
}

function isSafeSvgDataUrl(dataUrl) {
  if (!/^data:image\/svg\+xml;charset=utf-8,/i.test(dataUrl) || dataUrl.length > 150000) return false;
  try {
    const decoded = decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml;charset=utf-8,/i, ''));
    const lower = decoded.toLowerCase();
    if (
      lower.includes('<script') ||
      lower.includes('<foreignobject') ||
      lower.includes('<iframe') ||
      lower.includes('<object') ||
      lower.includes('<embed') ||
      lower.includes('javascript:') ||
      /on[a-z]+\s*=/.test(lower)
    ) {
      return false;
    }
    return lower.includes('<svg');
  } catch (e) {
    return false;
  }
}

function sanitizeImageUrl(raw, fallback = '') {
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!trimmed) return fallback;
  if (/^assets\/[a-zA-Z0-9._\-\/]+$/.test(trimmed) && !trimmed.includes('..')) {
    return trimmed;
  }
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length <= 600000) {
    return trimmed;
  }
  if (isSafeSvgDataUrl(trimmed)) {
    return trimmed;
  }
  const safeExt = sanitizeExternalUrl(trimmed);
  if (safeExt && isValidArticleImageUrl(safeExt)) {
    return safeExt;
  }
  return fallback;
}

function sanitizeLogoUrl(raw) {
  return sanitizeImageUrl(raw, 'assets/silverbot-unix-logo.png');
}

function sanitizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim().slice(0, 120);
  if (!trimmed) return '';
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(trimmed) ? trimmed : '';
}

// ==========================================
// Protección SSRF para peticiones salientes
// ==========================================
function isPrivateOrReservedIpv4(ip) {
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true; // Loopback 127.0.0.0/8
  if (a === 169 && b === 254) return true; // Link-local / Cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

function isPrivateOrReservedIp(ipRaw) {
  const ip = String(ipRaw || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('::ffff:')) {
      const mapped = ip.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateOrReservedIpv4(mapped);
      return true;
    }
    if (/^(fc|fd)/i.test(ip)) return true; // Unique Local fc00::/7
    if (/^fe[89ab]/i.test(ip)) return true; // Link-local fe80::/10
    if (ip.startsWith('ff')) return true; // Multicast ff00::/8
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa')
  ) {
    return true;
  }
  return false;
}

async function validateSafeExternalUrl(rawUrl, options = {}) {
  const safeHref = sanitizeExternalUrl(rawUrl);
  if (!safeHref) return { ok: false, error: 'URL inválida o protocolo no permitido.' };

  let parsed;
  try {
    parsed = new URL(safeHref);
  } catch (e) {
    return { ok: false, error: 'URL malformada.' };
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { ok: false, error: 'Puerto de destino no permitido.' };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) {
    return { ok: false, error: 'Host local o interno bloqueado.' };
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      return { ok: false, error: 'Dirección IP privada o reservada bloqueada.' };
    }
    return { ok: true, url: parsed.href };
  }

  if (options.skipDns) {
    return { ok: true, url: parsed.href };
  }

  try {
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) {
      return { ok: false, error: 'No se pudo resolver el host.' };
    }
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return { ok: false, error: 'El dominio resuelve hacia una IP interna o reservada.' };
      }
    }
    return { ok: true, url: parsed.href };
  } catch (e) {
    return { ok: false, error: 'Fallo al verificar la resolución DNS del destino.' };
  }
}

async function safeFetchExternal(rawUrl, fetchOptions = {}, maxRedirects = 3) {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await validateSafeExternalUrl(currentUrl);
    if (!check.ok) {
      throw new Error(check.error || 'Destino bloqueado por seguridad');
    }
    const res = await fetch(check.url, {
      ...fetchOptions,
      redirect: 'manual'
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location || hop === maxRedirects) {
        throw new Error('Redirección rechazada');
      }
      currentUrl = new URL(location, check.url).href;
      continue;
    }
    return res;
  }
  throw new Error('Demasiadas redirecciones');
}

// ==========================================
// 2. Persistencia Unificada & Sesiones
// ==========================================
function ensureFiles() {
  store.ensureLocalDirectoriesAndSeedFiles();
}

function readJSON(file, fallback = []) {
  const key = FILE_TO_STORE_KEY.get(file);
  if (key) return store.read(key, fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return fallback;
  }
}

function writeJSON(file, data, opts = {}) {
  const key = FILE_TO_STORE_KEY.get(file);
  if (key) return store.write(key, data, opts);
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Error al escribir archivo:', file, err);
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch (e) {
        out[k] = v;
      }
    }
  }
  return out;
}

function extractAuthTokenFromRequest(req) {
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME].trim();
  }
  const authHeader = req.headers['authorization'] || '';
  if (/^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

function isSecureRequest(req) {
  if (req && req.socket && req.socket.encrypted) return true;
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function buildSessionCookie(req, token, maxAgeSeconds) {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isSecureRequest(req)) {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

function pruneAndSaveSessions(sessions) {
  const now = Date.now();
  const active = Array.isArray(sessions) ? sessions.filter(s => s && s.expiresAt > now) : [];
  if (active.length !== (sessions ? sessions.length : 0)) {
    writeJSON(SESSIONS_FILE, active);
  }
  return active;
}

function createSessionRecord(rawToken, userId, ip) {
  return {
    tokenHash: hashSessionToken(rawToken),
    userId,
    ip,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
}

function getSessionUser(req) {
  const token = extractAuthTokenFromRequest(req);
  if (!token || token.length < 16) return null;

  const tokenHash = hashSessionToken(token);
  const rawSessions = readJSON(SESSIONS_FILE, []);
  const now = Date.now();

  let session = null;
  let expiredCount = 0;
  for (const s of rawSessions) {
    if (!s || s.expiresAt <= now) {
      expiredCount++;
      continue;
    }
    if (s.tokenHash === tokenHash || (s.token && s.token === token)) {
      session = s;
    }
  }
  if (expiredCount > 0) {
    pruneAndSaveSessions(rawSessions);
  }
  if (!session) return null;

  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.id === session.userId);
  if (!user || user.status === 'suspended') return null;

  const { salt, hash, registrationIp, lastLoginIp, registrationUa, ...safeUser } = user;
  return {
    ...safeUser,
    tokens: Math.max(0, Number(user.tokens) || 0),
    approvedPosts: Math.max(0, Number(user.approvedPosts) || 0),
    trustedPublisher: !!user.trustedPublisher
  };
}

const DEFAULT_MODERATION_POLICY = {
  requireModeration: true,
  minAccountAgeDays: 7,
  minTrustTokens: 20,
  minApprovedPosts: 3,
  tokensPerApprovedArticle: 10,
  tokensPerApprovedThread: 5,
  tokensPerApprovedReply: 2
};

function sanitizeModerationPolicy(raw, fallback = DEFAULT_MODERATION_POLICY) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : DEFAULT_MODERATION_POLICY;
  const clampNum = (v, min, max, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
  };
  return {
    requireModeration: src.requireModeration !== undefined ? !!src.requireModeration : fb.requireModeration !== false,
    minAccountAgeDays: clampNum(src.minAccountAgeDays, 0, 3650, fb.minAccountAgeDays),
    minTrustTokens: clampNum(src.minTrustTokens, 0, 10000, fb.minTrustTokens),
    minApprovedPosts: clampNum(src.minApprovedPosts, 0, 1000, fb.minApprovedPosts),
    tokensPerApprovedArticle: clampNum(src.tokensPerApprovedArticle, 0, 500, fb.tokensPerApprovedArticle),
    tokensPerApprovedThread: clampNum(src.tokensPerApprovedThread, 0, 500, fb.tokensPerApprovedThread),
    tokensPerApprovedReply: clampNum(src.tokensPerApprovedReply, 0, 200, fb.tokensPerApprovedReply)
  };
}

function getModerationPolicy() {
  const config = readJSON(CONFIG_FILE, {});
  return sanitizeModerationPolicy(config.moderationPolicy, DEFAULT_MODERATION_POLICY);
}

function computeContentHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

function createLegalTrace(req, ip, currentUser, payload, legalAccepted = true) {
  const submittedAt = new Date().toISOString();
  const ua = sanitizeInput((req && req.headers && req.headers['user-agent']) || '', 240);
  const forwardedChain = sanitizeInput((req && req.headers && req.headers['x-forwarded-for']) || ip || '127.0.0.1', 160);
  return {
    userId: currentUser ? currentUser.id : 'system',
    username: currentUser ? currentUser.username : 'system',
    displayName: currentUser ? currentUser.displayName : 'Sistema',
    ip: sanitizeInput(ip || '127.0.0.1', 64),
    forwardedChain,
    userAgent: ua,
    legalAccepted: !!legalAccepted,
    legalAcceptedAt: submittedAt,
    legalVersion: 'CYBERPOLIS-LEGAL-v1',
    contentHash: computeContentHash({
      ...(payload || {}),
      authorId: currentUser ? currentUser.id : 'system',
      submittedAt
    }),
    submittedAt
  };
}

function recordLegalAudit(entry) {
  const current = Array.isArray(readJSON(AUDIT_FILE, [])) ? readJSON(AUDIT_FILE, []) : [];
  const item = {
    id: 'aud-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
    timestamp: new Date().toISOString(),
    action: sanitizeInput(entry.action || 'event', 48),
    targetType: sanitizeInput(entry.targetType || 'system', 32),
    targetId: sanitizeInput(entry.targetId || '', 80),
    summary: sanitizeInput(entry.summary || '', 220),
    userId: sanitizeInput(entry.userId || '', 64),
    username: sanitizeInput(entry.username || '', 48),
    displayName: sanitizeInput(entry.displayName || '', 80),
    ip: sanitizeInput(entry.ip || '', 64),
    userAgent: sanitizeInput(entry.userAgent || '', 240),
    contentHash: sanitizeInput(entry.contentHash || '', 64),
    moderationStatus: sanitizeInput(entry.moderationStatus || '', 24),
    meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {}
  };
  current.unshift(item);
  if (current.length > 1000) current.length = 1000;
  writeJSON(AUDIT_FILE, current, { critical: true });
  return item;
}

function countUserApprovedPosts(userId, articlesList = null, forumList = null) {
  if (!userId) return 0;
  const articles = Array.isArray(articlesList) ? articlesList : readJSON(ARTICLES_FILE, []);
  const forumThreads = Array.isArray(forumList) ? forumList : readJSON(FORUM_FILE, []);
  let total = 0;
  for (const a of articles) {
    if (a && a.authorId === userId && (!a.moderationStatus || a.moderationStatus === 'approved')) total++;
  }
  for (const t of forumThreads) {
    if (!t) continue;
    if (t.authorId === userId && (!t.moderationStatus || t.moderationStatus === 'approved')) total++;
    if (Array.isArray(t.replies)) {
      for (const r of t.replies) {
        if (r && r.authorId === userId && (!r.moderationStatus || r.moderationStatus === 'approved')) total++;
      }
    }
  }
  return total;
}

function evaluateUserPublishTrust(user, policy = null, articlesList = null, forumList = null) {
  const activePolicy = policy || getModerationPolicy();
  if (!user) {
    return {
      autoApprove: false,
      reason: 'unauthenticated',
      accountAgeDays: 0,
      tokens: 0,
      approvedPosts: 0,
      trustedPublisher: false
    };
  }
  const createdMs = user.createdAt ? new Date(user.createdAt).getTime() : Date.now();
  const accountAgeDays = Number.isNaN(createdMs) ? 0 : Math.max(0, Math.floor((Date.now() - createdMs) / 86400000));
  const tokens = Math.max(0, Number(user.tokens) || 0);
  const storedApproved = Math.max(0, Number(user.approvedPosts) || 0);
  const countedApproved = countUserApprovedPosts(user.id, articlesList, forumList);
  const approvedPosts = Math.max(storedApproved, countedApproved);
  const trustedPublisher = !!user.trustedPublisher;

  if (!activePolicy.requireModeration) {
    return { autoApprove: true, reason: 'policy_disabled', accountAgeDays, tokens, approvedPosts, trustedPublisher };
  }
  if (user.role === 'admin') {
    return { autoApprove: true, reason: 'admin', accountAgeDays, tokens, approvedPosts, trustedPublisher: true };
  }
  if (trustedPublisher) {
    return { autoApprove: true, reason: 'trusted_publisher', accountAgeDays, tokens, approvedPosts, trustedPublisher };
  }
  const meetsThreshold =
    accountAgeDays >= activePolicy.minAccountAgeDays &&
    tokens >= activePolicy.minTrustTokens &&
    approvedPosts >= activePolicy.minApprovedPosts;

  return {
    autoApprove: meetsThreshold,
    reason: meetsThreshold ? 'trust_threshold_met' : 'requires_moderation',
    accountAgeDays,
    tokens,
    approvedPosts,
    trustedPublisher
  };
}

function stripPrivateArticleFields(article) {
  if (!article || typeof article !== 'object') return article;
  const { legalTrace, ...publicArticle } = article;
  return {
    ...publicArticle,
    moderationStatus: publicArticle.moderationStatus || 'approved'
  };
}

function awardTokensToUser(userId, deltaTokens, incrementApproved = true) {
  if (!userId) return null;
  const users = readJSON(USERS_FILE, []);
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return null;
  users[idx].tokens = Math.max(0, (Number(users[idx].tokens) || 0) + Math.max(0, Number(deltaTokens) || 0));
  if (incrementApproved) {
    users[idx].approvedPosts = Math.max(0, (Number(users[idx].approvedPosts) || 0) + 1);
  }
  users[idx].updatedAt = new Date().toISOString();
  writeJSON(USERS_FILE, users, { critical: true });
  return {
    id: users[idx].id,
    username: users[idx].username,
    displayName: users[idx].displayName,
    tokens: users[idx].tokens,
    approvedPosts: users[idx].approvedPosts,
    trustedPublisher: !!users[idx].trustedPublisher
  };
}

const recentVisitDedup = new Map();

function extractClientIp(req) {
  const raw = String((req && req.headers && req.headers['x-forwarded-for']) || (req && req.socket && req.socket.remoteAddress) || '127.0.0.1');
  return raw.split(',')[0].trim().replace(/^::ffff:/, '').slice(0, 64) || '127.0.0.1';
}

function parseUserAgentInfo(uaRaw = '') {
  const ua = String(uaRaw || '');
  const isBot = /bot|crawl|spider|slurp|bingpreview|lighthouse|headless|curl|wget|python-requests|go-http-client|node-fetch/i.test(ua);
  let deviceType = 'Escritorio';
  if (isBot) deviceType = 'Bot / Rastreador';
  else if (/mobile|android|iphone|ipod|iemobile|opera mini/i.test(ua)) deviceType = 'Móvil';
  else if (/ipad|tablet|playbook|silk/i.test(ua)) deviceType = 'Tablet';

  let browser = 'Otro';
  if (isBot) browser = 'Bot / Crawler';
  else if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';

  let os = 'Otro';
  if (isBot) os = 'Crawler';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod|ios/i.test(ua)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return { browser, os, deviceType, isBot };
}

function extractReferrerDomain(refRaw = '') {
  const ref = String(refRaw || '').trim();
  if (!ref) return 'Directo';
  try {
    const parsed = new URL(ref);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!host || host.includes('cyberpolis.onrender.com') || host === 'localhost' || host === '127.0.0.1') {
      return 'Directo';
    }
    if (host.includes('google.')) return 'Google';
    if (host.includes('bing.')) return 'Bing';
    if (host.includes('linkedin.')) return 'LinkedIn';
    if (host === 't.co' || host.includes('twitter.') || host.includes('x.com')) return 'X / Twitter';
    return host;
  } catch (e) {
    return 'Directo';
  }
}

function recordVisitEvent(req, opts = {}) {
  try {
    const ip = extractClientIp(req);
    const ua = String(req.headers['user-agent'] || '');
    const uaInfo = parseUserAgentInfo(ua);
    const visitorId = crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 12);
    const page = sanitizeInput(opts.page || '/', 120) || '/';
    const articleTitle = sanitizeInput(opts.articleTitle || '', 140);
    const dedupKey = `${visitorId}|${page}|${articleTitle}`;
    const nowMs = Date.now();

    const lastSeen = recentVisitDedup.get(dedupKey);
    if (lastSeen && (nowMs - lastSeen) < 120000) {
      return;
    }
    recentVisitDedup.set(dedupKey, nowMs);
    if (recentVisitDedup.size > 2000) {
      for (const [k, ts] of recentVisitDedup.entries()) {
        if (nowMs - ts > 300000) recentVisitDedup.delete(k);
      }
    }

    const sessionUser = getSessionUser(req);
    const referrer = extractReferrerDomain(opts.referrer || req.headers.referer || req.headers.referrer || '');
    const country = sanitizeInput(String(req.headers['cf-ipcountry'] || req.headers['x-country-code'] || ''), 8);
    const dateKey = new Date().toISOString().slice(0, 10);

    const analytics = readJSON(ANALYTICS_FILE, { totalViews: 0, dailyStats: {}, visitors: [] });
    if (typeof analytics.totalViews !== 'number') analytics.totalViews = 0;
    if (!analytics.dailyStats || typeof analytics.dailyStats !== 'object') analytics.dailyStats = {};
    if (!Array.isArray(analytics.visitors)) analytics.visitors = [];

    if (!analytics.dailyStats[dateKey]) {
      analytics.dailyStats[dateKey] = { views: 0, botViews: 0, uniqueVisitors: [] };
    }
    const dayBucket = analytics.dailyStats[dateKey];
    if (uaInfo.isBot) {
      dayBucket.botViews = (dayBucket.botViews || 0) + 1;
    } else {
      dayBucket.views = (dayBucket.views || 0) + 1;
      analytics.totalViews += 1;
      if (!Array.isArray(dayBucket.uniqueVisitors)) dayBucket.uniqueVisitors = [];
      if (!dayBucket.uniqueVisitors.includes(visitorId) && dayBucket.uniqueVisitors.length < 5000) {
        dayBucket.uniqueVisitors.push(visitorId);
      }
    }

    const dayKeys = Object.keys(analytics.dailyStats).sort();
    while (dayKeys.length > 30) {
      const oldest = dayKeys.shift();
      delete analytics.dailyStats[oldest];
    }

    analytics.visitors.unshift({
      id: 'vis-' + nowMs + '-' + crypto.randomBytes(2).toString('hex'),
      timestamp: new Date(nowMs).toISOString(),
      ip,
      visitorId,
      country,
      browser: uaInfo.browser,
      os: uaInfo.os,
      deviceType: uaInfo.deviceType,
      isBot: uaInfo.isBot,
      referrer,
      page,
      articleTitle,
      username: sessionUser ? sessionUser.username : '',
      displayName: sessionUser ? sessionUser.displayName : ''
    });

    if (analytics.visitors.length > 250) {
      analytics.visitors.length = 250;
    }

    writeJSON(ANALYTICS_FILE, analytics);
  } catch (err) {
    console.error('Error registrando analítica:', err.message);
  }
}

function buildAnalyticsDashboard() {
  const analytics = readJSON(ANALYTICS_FILE, { totalViews: 0, dailyStats: {}, visitors: [] });
  const users = readJSON(USERS_FILE, []);
  const sessions = readJSON(SESSIONS_FILE, []);
  const articles = readJSON(ARTICLES_FILE, []);
  const forumThreads = readJSON(FORUM_FILE, []);

  const now = Date.now();
  const activeSessionsCount = sessions.filter(s => s && s.expiresAt > now).length;
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const dailyStats = analytics.dailyStats || {};
  const todayStats = dailyStats[todayKey] || { views: 0, botViews: 0, uniqueVisitors: [] };

  const dailySeries = [];
  const last7UniqueSet = new Set();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const bucket = dailyStats[key] || { views: 0, botViews: 0, uniqueVisitors: [] };
    (bucket.uniqueVisitors || []).forEach(v => last7UniqueSet.add(v));
    dailySeries.push({
      date: key,
      label: d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }),
      views: bucket.views || 0,
      botViews: bucket.botViews || 0,
      unique: Array.isArray(bucket.uniqueVisitors) ? bucket.uniqueVisitors.length : 0
    });
  }

  const visitors = Array.isArray(analytics.visitors) ? analytics.visitors : [];
  const countBy = (arr, selector) => {
    const map = new Map();
    for (const item of arr) {
      const k = selector(item) || 'Desconocido';
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({ name, count }));
  };

  const humanVisitors = visitors.filter(v => !v.isBot);
  const topBrowsers = countBy(humanVisitors.length ? humanVisitors : visitors, v => v.browser);
  const topDevices = countBy(visitors, v => v.deviceType);
  const topReferrers = countBy(humanVisitors.length ? humanVisitors : visitors, v => v.referrer);
  const topArticles = [...articles]
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, 6)
    .map(a => ({ id: a.id, title: a.title, sourceName: a.sourceName || 'Redacción', views: a.views || 0 }));

  return {
    totalViews: analytics.totalViews || 0,
    todayViews: todayStats.views || 0,
    todayBotViews: todayStats.botViews || 0,
    uniqueToday: Array.isArray(todayStats.uniqueVisitors) ? todayStats.uniqueVisitors.length : 0,
    uniqueLast7Days: last7UniqueSet.size,
    registeredUsersCount: users.length,
    activeSessionsCount,
    articlesCount: articles.length,
    forumThreadsCount: forumThreads.length,
    dailySeries,
    topBrowsers,
    topDevices,
    topReferrers,
    topArticles,
    recentVisitors: visitors.slice(0, 60)
  };
}

function isValidArticleImageUrl(imgUrl) {
  if (!imgUrl || typeof imgUrl !== 'string') return false;
  const trimmed = imgUrl.trim();
  if (!trimmed || trimmed.startsWith('data:')) return false;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  const blacklist = [
    'unsplash.com',
    's.w.org/images/core/emoji',
    'gravatar.com',
    'feedburner.com',
    'doubleclick.net',
    'pixel.',
    '1x1.',
    'spacer.',
    'blank.gif',
    'favicon.',
    'apple-touch-icon'
  ];
  if (blacklist.some(b => lower.includes(b))) return false;
  if (lower.endsWith('.ico')) return false;
  return true;
}

function upgradeImageUrl(imgUrl) {
  if (!imgUrl || typeof imgUrl !== 'string') return '';
  let upgraded = imgUrl.trim().replace(/&amp;/g, '&');
  if (upgraded.includes('blogger.googleusercontent.com') || upgraded.includes('bp.blogspot.com') || upgraded.includes('ggpht.com')) {
    upgraded = upgraded
      .replace(/\/(?:s(?:72|[1-8]\d\d)|w\d+-h\d+)(?:-[a-z0-9]+)*\//i, '/s1200/')
      .replace(/=(?:s(?:72|[1-8]\d\d)|w\d+-h\d+)(?:-[a-z0-9]+)*$/i, '=s1200');
  }
  if (upgraded.includes('img.youtube.com/vi/')) {
    upgraded = upgraded.replace(/\/(?:default|mqdefault)\.jpg(\?.*)?$/i, '/hqdefault.jpg');
  }
  return upgraded;
}

function sanitizeArticleRecord(raw, currentUser = null, existing = null) {
  const validCategories = new Set(['hacking', 'politica', 'tecnopolitica']);
  const rawCategory = String((raw && raw.category) || (existing && existing.category) || 'hacking').trim().toLowerCase();
  const category = validCategories.has(rawCategory) ? rawCategory : 'hacking';
  const title = sanitizeInput((raw && raw.title) || (existing && existing.title) || 'Sin título', 240);
  const sourceName = sanitizeInput((raw && raw.sourceName) || (existing && existing.sourceName) || 'CYBERPOLIS', 120);
  const fallbackSvg = createIntelSVG(sourceName, category, title);

  const rawSourceUrl = raw && raw.sourceUrl !== undefined ? raw.sourceUrl : (existing && existing.sourceUrl);
  const rawImageUrl = raw && raw.imageUrl !== undefined ? raw.imageUrl : (existing && existing.imageUrl);

  const sourceUrl = sanitizeExternalUrl(rawSourceUrl || '');
  const imageUrl = sanitizeImageUrl(rawImageUrl || '', fallbackSvg);
  const tagsRaw = Array.isArray(raw && raw.tags) ? raw.tags : (existing && Array.isArray(existing.tags) ? existing.tags : []);
  const tags = tagsRaw.map(t => sanitizeInput(String(t || ''), 32).toLowerCase()).filter(Boolean).slice(0, 8);

  return {
    id: existing ? existing.id : (sanitizeInput(String((raw && raw.id) || ''), 64) || ('svb-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'))),
    title,
    category,
    sourceName,
    sourceUrl,
    imageUrl,
    summary: sanitizeInput((raw && raw.summary) || (existing && existing.summary) || '', 600),
    content: sanitizeInput((raw && raw.content) || (existing && existing.content) || '', 16000),
    tags,
    readTime: sanitizeInput((raw && raw.readTime) || (existing && existing.readTime) || '3 min', 24),
    isBreaking: raw && raw.isBreaking !== undefined ? !!raw.isBreaking : !!(existing && existing.isBreaking),
    isFeatured: existing
      ? (raw && raw.isFeatured !== undefined ? (!!raw.isFeatured && currentUser && currentUser.role === 'admin') : !!existing.isFeatured)
      : (!!(raw && raw.isFeatured) && currentUser && currentUser.role === 'admin'),
    author: existing ? existing.author : (currentUser ? currentUser.displayName : sanitizeInput((raw && raw.author) || sourceName, 80)),
    authorId: existing ? existing.authorId : (currentUser ? currentUser.id : sanitizeInput((raw && raw.authorId) || '', 64)),
    authorRole: existing ? existing.authorRole : (currentUser ? currentUser.role : 'feed'),
    verifiedLinkedIn: existing ? !!existing.verifiedLinkedIn : !!(raw && raw.verifiedLinkedIn),
    isAutoFeed: existing ? !!existing.isAutoFeed : !!(raw && raw.isAutoFeed),
    moderationStatus: ['approved', 'pending', 'rejected'].includes(raw && raw.moderationStatus)
      ? raw.moderationStatus
      : ((existing && existing.moderationStatus) || 'approved'),
    moderatedBy: (raw && raw.moderatedBy) || (existing && existing.moderatedBy) || null,
    moderatedById: (raw && raw.moderatedById) || (existing && existing.moderatedById) || null,
    moderatedAt: (raw && raw.moderatedAt) || (existing && existing.moderatedAt) || null,
    moderationReason: (raw && raw.moderationReason) ? sanitizeInput(raw.moderationReason, 240) : ((existing && existing.moderationReason) || ''),
    legalTrace: (raw && raw.legalTrace && typeof raw.legalTrace === 'object')
      ? raw.legalTrace
      : ((existing && existing.legalTrace) || null),
    date: (existing && existing.date) || ((raw && raw.date && !Number.isNaN(new Date(raw.date).getTime())) ? new Date(raw.date).toISOString() : new Date().toISOString()),
    views: existing ? (existing.views || 0) : Math.max(0, parseInt(raw && raw.views, 10) || 0)
  };
}

// ==========================================
// 3. Motor de Ingestión Automática en Castellano (RSS / Feeds)
// ==========================================
const ENTITY_MAP = {
  '&quot;': '"', '&#039;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&',
  '&nbsp;': ' ', '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó',
  '&uacute;': 'ú', '&ntilde;': 'ñ', '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í',
  '&Oacute;': 'Ó', '&Uacute;': 'Ú', '&Ntilde;': 'Ñ', '&laquo;': '«', '&raquo;': '»',
  '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'", '&mdash;': '—',
  '&ndash;': '–', '&hellip;': '...'
};

function cleanHtmlContent(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let str = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  for (let i = 0; i < 2; i++) {
    str = str.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
    str = str.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    str = str.replace(/&[a-zA-Z0-9#]+;/g, m => ENTITY_MAP[m] || m);
  }

  str = str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  return str.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function createIntelSVG(sourceName, category, title = '') {
  const isPol = category === 'politica' || category === 'tecnopolitica';
  const accent = isPol ? '#d97706' : '#0284c7';
  const softTint = isPol ? '#fef3c7' : '#e0f2fe';
  const badge = String(sourceName || 'CYBERPOLIS').split('—')[0].trim().toUpperCase().replace(/[<>"'&]/g, '');
  const subCategory = isPol ? 'GEOPOLITICA // NORMATIVA DIGITAL' : 'ACTUALIDAD // CIBERSEGURIDAD';
  const rawTitle = String(title || 'INFORME DE ACTUALIDAD Y SEGURIDAD').toUpperCase().replace(/[<>"'&]/g, '');
  const line1 = rawTitle.slice(0, 34);
  const line2 = rawTitle.length > 34 ? rawTitle.slice(34, 68) : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">
    <defs>
      <linearGradient id="paperBg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f8fafc"/>
        <stop offset="100%" stop-color="#e2e8f0"/>
      </linearGradient>
    </defs>
    <rect width="800" height="450" fill="url(#paperBg)"/>
    <rect x="0" y="0" width="800" height="8" fill="${accent}"/>
    <circle cx="710" cy="90" r="140" fill="${softTint}" opacity="0.65"/>
    <circle cx="110" cy="390" r="110" fill="${softTint}" opacity="0.5"/>
    <rect x="48" y="48" width="704" height="354" rx="14" fill="#ffffff" fill-opacity="0.88" stroke="#cbd5e1" stroke-width="1.5"/>
    <rect x="82" y="84" width="12" height="12" rx="3" fill="${accent}"/>
    <text x="106" y="95" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="${accent}" letter-spacing="1.5">${badge}</text>
    <text x="716" y="95" text-anchor="end" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="#64748b" letter-spacing="1">${subCategory}</text>
    <line x1="82" y1="120" x2="718" y2="120" stroke="#e2e8f0" stroke-width="1"/>
    <text x="82" y="210" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="25" font-weight="800" fill="#0f172a" letter-spacing="-0.3">${line1}</text>
    ${line2 ? `<text x="82" y="248" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="25" font-weight="800" fill="#0f172a" letter-spacing="-0.3">${line2}</text>` : ''}
    <line x1="82" y1="322" x2="718" y2="322" stroke="#e2e8f0" stroke-width="1"/>
    <text x="82" y="362" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#475569" letter-spacing="0.5">CYBERPOLIS — TU HACKNOTICIERO</text>
    <text x="718" y="362" text-anchor="end" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="${accent}">BOLETÍN VERIFICADO</text>
  </svg>`;

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

async function fetchOgImage(articleUrl) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return '';
  try {
    const res = await safeFetchExternal(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(4500)
    });
    if (!res.ok) return '';
    const html = (await res.text()).slice(0, 120000);
    const headChunk = html.slice(0, 60000);

    const patterns = [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
    ];

    let candidate = '';
    for (const pat of patterns) {
      const m = headChunk.match(pat);
      if (m && m[1]) {
        candidate = m[1].trim();
        break;
      }
    }

    if (!candidate) {
      const articleArea = html.match(/<(?:article|main)[\s\S]*?<\/(?:article|main)>/i);
      const areaHtml = articleArea ? articleArea[0] : html;
      const imgMatches = [...areaHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
      for (const im of imgMatches) {
        const tag = im[0].toLowerCase();
        const src = im[1].trim();
        if (tag.includes('logo') || tag.includes('avatar') || tag.includes('icon')) continue;
        try {
          const abs = new URL(src, articleUrl).href;
          if (isValidArticleImageUrl(abs)) {
            candidate = abs;
            break;
          }
        } catch (e) {}
      }
    }

    if (!candidate) return '';
    const resolved = upgradeImageUrl(new URL(candidate, articleUrl).href);
    return isValidArticleImageUrl(resolved) ? resolved : '';
  } catch (e) {
    return '';
  }
}

function sanitizeStoredArticles() {
  try {
    const articles = readJSON(ARTICLES_FILE, []);
    let modified = false;
    const hasFreshFeeds = articles.length > 7;

    for (const a of articles) {
      const cleanSum = cleanHtmlContent(a.summary);
      const cleanCnt = cleanHtmlContent(a.content);
      const cleanTit = cleanHtmlContent(a.title);
      if (cleanSum !== a.summary || cleanCnt !== a.content || cleanTit !== a.title) {
        a.summary = cleanSum;
        a.content = cleanCnt;
        a.title = cleanTit;
        modified = true;
      }

      if (a.sourceUrl) {
        const safeSrc = sanitizeExternalUrl(a.sourceUrl);
        if (safeSrc !== a.sourceUrl) {
          a.sourceUrl = safeSrc;
          modified = true;
        }
      }

      if (hasFreshFeeds && a.isFeatured && /^(art-00\d|svb-00\d)$/.test(String(a.id || ''))) {
        a.isFeatured = false;
        modified = true;
      }

      if (!a.imageUrl || a.imageUrl.includes('unsplash.com')) {
        a.imageUrl = createIntelSVG(a.sourceName, a.category, a.title);
        modified = true;
      } else if (a.imageUrl.startsWith('data:image/svg+xml')) {
        const decoded = decodeURIComponent(a.imageUrl.replace('data:image/svg+xml;charset=utf-8,', ''));
        if (!isSafeSvgDataUrl(a.imageUrl) || decoded.includes('#04070d') || decoded.includes('POLÍTICA DIGITAL')) {
          a.imageUrl = createIntelSVG(a.sourceName, a.category, a.title);
          modified = true;
        }
      } else if (/^https?:\/\//i.test(a.imageUrl)) {
        const upgraded = upgradeImageUrl(a.imageUrl);
        if (upgraded !== a.imageUrl) {
          a.imageUrl = upgraded;
          modified = true;
        }
      }
    }
    if (modified) writeJSON(ARTICLES_FILE, articles);
  } catch (e) {
    console.error('Error al sanitizar artículos almacenados:', e);
  }
}

async function enrichStoredArticlesImages() {
  try {
    const articles = readJSON(ARTICLES_FILE, []);
    const candidates = articles
      .filter(a =>
        !/^(art-00\d|svb-00\d)$/.test(String(a.id || '')) &&
        (!a.imageUrl || a.imageUrl.startsWith('data:image/svg+xml')) &&
        a.sourceUrl &&
        /^https?:\/\/[^/]+\/.+/i.test(a.sourceUrl)
      )
      .slice(0, 16);

    if (candidates.length === 0) return;

    let updated = 0;
    const batchSize = 4;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      await Promise.all(batch.map(async (art) => {
        const og = await fetchOgImage(art.sourceUrl);
        if (og) {
          art.imageUrl = og;
          updated++;
        }
      }));
    }

    if (updated > 0) {
      writeJSON(ARTICLES_FILE, articles);
      console.log(`🖼️ Enriquecidas ${updated} noticias con imágenes reales de sus fuentes.`);
    }
  } catch (e) {
    console.error('Error enriqueciendo imágenes:', e);
  }
}

function parseXMLFeed(xmlText, feedUrl = '') {
  const items = [];
  const cleanXml = xmlText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const itemMatches = cleanXml.match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi) || [];

  for (const block of itemMatches) {
    const summaryMatch = block.match(/<(?:description|summary)[^>]*>([\s\S]*?)<\/(?:description|summary)>/i);
    const contentEncMatch = block.match(/<(?:content:encoded|content)[^>]*>([\s\S]*?)<\/(?:content:encoded|content)>/i);
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const dateMatch = block.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i);

    const title = cleanHtmlContent(titleMatch ? titleMatch[1] : '');
    const link = sanitizeExternalUrl(linkMatch ? linkMatch[1].replace(/<[^>]+>/g, '').trim() : '');
    const rawBestBody = (contentEncMatch && contentEncMatch[1]) || (summaryMatch && summaryMatch[1]) || '';
    const rawShortSummary = (summaryMatch && summaryMatch[1]) || rawBestBody;
    const summaryClean = cleanHtmlContent(rawShortSummary);
    const description = cleanHtmlContent(rawBestBody) || summaryClean;

    let pubDate = new Date().toISOString();
    if (dateMatch && dateMatch[1]) {
      const parsed = new Date(dateMatch[1].trim());
      if (!Number.isNaN(parsed.getTime())) pubDate = parsed.toISOString();
    }

    const searchableBlock = block
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/&amp;/g, '&');

    const mediaMatches = [...searchableBlock.matchAll(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["'][^>]*>/gi)];
    const encMatch = searchableBlock.match(/<enclosure[^>]+type=["']image\/[^"']+["'][^>]+url=["']([^"']+)["']/i) || searchableBlock.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\//i);
    const imgMatches = [...searchableBlock.matchAll(/<img[^>]+(?:data-lazy-src|data-src|src)=["']([^"']+)["'][^>]*>/gi)];

    let imageUrl = '';
    const rawCandidates = [];
    for (const mm of mediaMatches) {
      if (mm[1]) rawCandidates.push(mm[1]);
    }
    if (encMatch && encMatch[1]) rawCandidates.push(encMatch[1]);
    for (const im of imgMatches) {
      const fullTag = im[0].toLowerCase();
      if (fullTag.includes('avatar') || fullTag.includes('emoji') || fullTag.includes('width="1"') || fullTag.includes("width='1'")) continue;
      if (im[1]) rawCandidates.push(im[1]);
    }

    for (const cand of rawCandidates) {
      try {
        const baseRef = link || feedUrl || 'https://cyberpolis.onrender.com';
        const resolved = upgradeImageUrl(new URL(cand.trim(), baseRef).href);
        if (isValidArticleImageUrl(resolved)) {
          imageUrl = resolved;
          break;
        }
      } catch (e) {}
    }

    if (title && (link || description)) {
      items.push({ title, link, description, summaryClean, pubDate, imageUrl });
    }
  }

  return items;
}

const FALLBACK_SPANISH_INTEL = [
  {
    title: "INCIBE alerta sobre campaña activa de 'Smishing' suplantando a la Agencia Tributaria con malware bancario",
    link: "https://www.incibe.es/linea-de-ayuda-en-ciberseguridad/avisos/campana-smishing-agencia-tributaria",
    description: "El Instituto Nacional de Ciberseguridad ha detectado una oleada masiva de mensajes SMS fraudulentos que instan a los contribuyentes a descargar una supuesta actualización de la app oficial para cobrar una devolución, instalando un troyano de acceso remoto.",
    pubDate: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    feedSource: "INCIBE — Avisos y Vulnerabilidades",
    category: "hacking",
    imageUrl: createIntelSVG('INCIBE — Avisos y Vulnerabilidades', 'hacking', 'ALERTA SMISHING AGENCIA TRIBUTARIA')
  },
  {
    title: "Una al Día: Análisis de vulnerabilidad crítica en núcleos Linux que compromete privilegios root en servidores",
    link: "https://unaaldia.hispasec.com/2026/11/analisis-vulnerabilidad-kernel-linux-root.html",
    description: "Investigadores de Hispasec desglosan el fallo de desbordamiento en el subsistema de gestión de memoria virtual del kernel. Se recomienda actualizar inmediatamente las distribuciones corporativas afectadas.",
    pubDate: new Date(Date.now() - 1000 * 60 * 85).toISOString(),
    feedSource: "Una al Día (Hispasec)",
    category: "hacking",
    imageUrl: createIntelSVG('Una al Día (Hispasec)', 'hacking', 'VULNERABILIDAD KERNEL ROOT')
  },
  {
    title: "CCN-CERT publica la guía de implementación de medidas urgentes para el cumplimiento de la Directiva NIS2",
    link: "https://www.ccn-cert.cni.es/guias/guias-series-ccn-stic/guia-nis2.html",
    description: "El Centro Criptológico Nacional emite el marco de referencia técnico para que las entidades críticas y esenciales implanten los controles criptográficos y el protocolo de notificación en menos de 24 horas.",
    pubDate: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
    feedSource: "CCN-CERT (Centro Criptológico Nacional)",
    category: "tecnopolitica",
    imageUrl: createIntelSVG('CCN-CERT (Centro Criptológico)', 'tecnopolitica', 'DIRECTIVA NIS2 — MEDIDAS URGENTES')
  },
  {
    title: "HackPlayers: Descubierto vector de bypass en autenticaciones biométricas mediante deepfakes en tiempo real",
    link: "https://www.hackplayers.com/2026/11/bypass-biometria-deepfakes.html",
    description: "Un estudio técnico demuestra cómo modelos generativos optimizados logran vulnerar pasarelas de verificación KYC en entidades financieras inyectando vídeo sintético a través de controladores virtuales.",
    pubDate: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
    feedSource: "HackPlayers",
    category: "hacking",
    imageUrl: createIntelSVG('HackPlayers // Red Team', 'hacking', 'BYPASS BIOMETRÍA DEEPFAKES')
  }
];

async function syncSpanishFeeds() {
  const config = readJSON(CONFIG_FILE, {});
  const feeds = config.feeds || [];
  let articles = readJSON(ARTICLES_FILE, []);
  let newArticlesAdded = 0;

  for (const feed of feeds) {
    if (!feed || !feed.enabled || !feed.url) continue;

    let items = [];
    try {
      const res = await safeFetchExternal(feed.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const xml = await res.text();
        items = parseXMLFeed(xml, feed.url).slice(0, 6);
      }
    } catch (err) {
      // Silenciar fallo puntual de un feed para continuar con el resto
    }

    for (const item of items) {
      const exists = articles.some(a =>
        (item.link && a.sourceUrl === item.link) ||
        (a.title.toLowerCase() === item.title.toLowerCase())
      );

      if (!exists) {
        let category = feed.category || 'hacking';
        const lower = (item.title + ' ' + item.description).toLowerCase();
        if (lower.includes('elecciones') || lower.includes('parlamento') || lower.includes('gobierno') || lower.includes('ley') || lower.includes('sancion')) {
          category = 'politica';
        } else if (lower.includes('nis2') || lower.includes('ccn-cert') || lower.includes('espionaje') || lower.includes('pegasus') || lower.includes('soberania')) {
          category = 'tecnopolitica';
        }

        const tags = ['ciberseguridad', feed.name.split(' ')[0].toLowerCase()];
        if (lower.includes('vulnerabilidad') || lower.includes('0-day')) tags.push('0-day');
        if (lower.includes('ransomware')) tags.push('ransomware');
        if (lower.includes('phishing') || lower.includes('smishing')) tags.push('phishing');
        if (lower.includes('nis2')) tags.push('nis2');
        if (lower.includes('linux')) tags.push('linux');

        let resolvedImg = (item.imageUrl && isValidArticleImageUrl(item.imageUrl)) ? item.imageUrl.trim() : '';
        if (!resolvedImg && item.link && /^https?:\/\//i.test(item.link)) {
          resolvedImg = await fetchOgImage(item.link);
        }
        const articleImg = sanitizeImageUrl(resolvedImg, createIntelSVG(feed.name, category, item.title));

        const cleanTitle = cleanHtmlContent(item.title);
        const cleanDesc = cleanHtmlContent(item.description);
        const cleanSum = cleanHtmlContent(item.summaryClean || cleanDesc);

        const newArticle = {
          id: 'auto-es-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
          title: sanitizeInput(cleanTitle, 240),
          category,
          sourceName: sanitizeInput(feed.name, 120),
          sourceUrl: sanitizeExternalUrl(item.link || feed.url),
          imageUrl: articleImg,
          summary: sanitizeInput(cleanSum.slice(0, 260) + (cleanSum.length > 260 ? '...' : ''), 320),
          content: sanitizeInput(cleanDesc + `\n\nFuente oficial en castellano: ${feed.name}.\nConsulta el artículo íntegro y detalles técnicos en el enlace de procedencia original.`, 16000),
          tags,
          readTime: `${Math.max(2, Math.ceil(cleanDesc.split(/\s+/).length / 140))} min`,
          isBreaking: lower.includes('crítica') || lower.includes('urgente') || lower.includes('alerta') || lower.includes('0-day'),
          isFeatured: false,
          author: `${feed.name.split('—')[0].trim()}`,
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

  if (articles.length === 0 && newArticlesAdded === 0) {
    for (const item of FALLBACK_SPANISH_INTEL) {
      articles.push({
        id: 'auto-es-fallback-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
        title: sanitizeInput(item.title, 240),
        category: item.category || 'hacking',
        sourceName: sanitizeInput(item.feedSource, 120),
        sourceUrl: sanitizeExternalUrl(item.link),
        imageUrl: item.imageUrl,
        summary: sanitizeInput(item.description, 400),
        content: sanitizeInput(item.description, 4000),
        tags: ['ciberseguridad'],
        readTime: '3 min',
        isBreaking: false,
        isFeatured: false,
        author: sanitizeInput(item.feedSource, 80),
        authorRole: 'feed',
        verifiedLinkedIn: false,
        isAutoFeed: true,
        date: item.pubDate,
        views: 0
      });
      newArticlesAdded++;
    }
  }

  if (newArticlesAdded > 0) {
    articles.sort((a, b) => new Date(b.date) - new Date(a.date));
    const perSourceCount = new Map();
    const balanced = [];
    const autoCount = articles.filter(a => a.isAutoFeed).length;

    for (const art of articles) {
      if (autoCount >= 6 && /^(art-00\d|svb-00\d)$/.test(String(art.id || ''))) {
        continue;
      }
      const key = String(art.sourceName || art.author || 'manual').split('—')[0].trim().toLowerCase();
      const count = perSourceCount.get(key) || 0;
      if (art.isAutoFeed && count >= 8) continue;
      perSourceCount.set(key, count + 1);
      balanced.push(art);
      if (balanced.length >= 40) break;
    }

    articles = balanced;
    writeJSON(ARTICLES_FILE, articles);
  }

  config.lastSync = new Date().toISOString();
  writeJSON(CONFIG_FILE, config);

  return { newArticlesAdded, lastSync: config.lastSync };
}

let syncIntervalTimer = null;
function initBackgroundSync() {
  if (syncIntervalTimer) clearInterval(syncIntervalTimer);
  const config = readJSON(CONFIG_FILE, {});
  if (config.autoSyncEnabled) {
    setTimeout(async () => {
      console.log('📡 Ejecutando sincronización inicial de fuentes en castellano...');
      try {
        const res = await syncSpanishFeeds();
        console.log(`✅ Sincronización inicial completada: ${res.newArticlesAdded} nuevos despachos.`);
        await enrichStoredArticlesImages();
      } catch (err) {
        console.error('Error en sync inicial:', err);
      }
    }, 2000);

    const minutes = Math.max(5, config.syncIntervalMinutes || 30);
    syncIntervalTimer = setInterval(async () => {
      try {
        await syncSpanishFeeds();
        await enrichStoredArticlesImages();
      } catch (err) {
        console.error('Error en sync automático:', err);
      }
    }, minutes * 60 * 1000);
  }
}

// ==========================================
// 4. Servidor HTTP Endurecido
// ==========================================
function buildSecurityHeaders(req, { isHtml = false, contentType = 'application/json; charset=UTF-8', cacheControl = '' } = {}) {
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
  if (isSecureRequest(req)) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  if (isHtml) {
    headers['Content-Security-Policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join('; ');
  }
  return headers;
}

function sendJSON(req, res, status, data, extraHeaders = {}, options = {}) {
  const noStore = options.noStore ? 'no-store, no-cache, must-revalidate, private' : '';
  const headers = buildSecurityHeaders(req, {
    isHtml: false,
    contentType: 'application/json; charset=UTF-8',
    cacheControl: noStore
  });
  Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function applySameOriginCorsAndCheckCsrf(req, res, pathname, method) {
  const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  const origin = req.headers.origin;
  let originMatches = false;

  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      originMatches = !!reqHost && originHost === reqHost;
      if (originMatches) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      }
    } catch (e) {
      originMatches = false;
    }
  }

  if (method === 'OPTIONS') {
    res.writeHead(originMatches ? 204 : 403);
    res.end();
    return false;
  }

  // Defensa CSRF en mutaciones sobre la API
  if (pathname.startsWith('/api/') && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (secFetchSite === 'cross-site' && pathname !== '/api/analytics/visit') {
      sendJSON(req, res, 403, { error: 'Petición cross-site bloqueada (protección CSRF).' }, {}, { noStore: true });
      return false;
    }
    if (origin && !originMatches) {
      sendJSON(req, res, 403, { error: 'Origen no autorizado (protección CSRF).' }, {}, { noStore: true });
      return false;
    }
  }
  return true;
}

function parseBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) {
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

function escapeHtmlSsr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSsrIndexHtml(req, rawHtml, query = {}) {
  try {
    const config = readJSON(CONFIG_FILE, {});
    const articles = [...readJSON(ARTICLES_FILE, [])]
      .filter(a => a && a.title && (!a.moderationStatus || a.moderationStatus === 'approved'))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    const brandTitle = sanitizeInput(config.portalTitle || 'CYBERPOLIS', 60) || 'CYBERPOLIS';
    const brandSubtitle = sanitizeInput(config.portalSubtitle || 'TU HACKNOTICIERO', 80) || 'TU HACKNOTICIERO';
    const proto = isSecureRequest(req) ? 'https' : 'http';
    const host = String((req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'cyberpolis.onrender.com').split(',')[0].trim().replace(/[^a-zA-Z0-9.\-:]/g, '');
    const baseUrl = `${proto}://${host}`;

    const articleId = query && typeof query.article === 'string' ? query.article.trim() : '';
    const activeArticle = articleId ? articles.find(a => String(a.id) === articleId) : null;

    let html = rawHtml;
    if (activeArticle) {
      const pageTitle = `${activeArticle.title} — ${brandTitle}`;
      const pageDesc = (activeArticle.summary || activeArticle.content || '').slice(0, 165).replace(/\s+/g, ' ').trim();
      const canonicalUrl = `${baseUrl}/?article=${encodeURIComponent(activeArticle.id)}`;
      html = html
        .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtmlSsr(pageTitle)}</title>`)
        .replace(/<meta name="description" content="[^"]*">/i, () => `<meta name="description" content="${escapeHtmlSsr(pageDesc)}">`)
        .replace(/<meta property="og:title" content="[^"]*">/i, () => `<meta property="og:title" content="${escapeHtmlSsr(pageTitle)}">`)
        .replace(/<meta property="og:description" content="[^"]*">/i, () => `<meta property="og:description" content="${escapeHtmlSsr(pageDesc)}">`)
        .replace(/<meta property="og:url" content="[^"]*">/i, () => `<meta property="og:url" content="${escapeHtmlSsr(canonicalUrl)}">`)
        .replace(/<link rel="canonical" id="canonicalLink" href="[^"]*">/i, () => `<link rel="canonical" id="canonicalLink" href="${escapeHtmlSsr(canonicalUrl)}">`);
    }

    const topHero = articles.find(a => a.isFeatured) || articles[0];
    const gridList = articles.filter(a => !topHero || a.id !== topHero.id).slice(0, 7);

    if (topHero) {
      const heroHtml = `
        <article class="hero-dispatch-card" data-id="${escapeHtmlSsr(topHero.id)}">
          <div class="hero-content-chamber" style="grid-column: 1 / -1;">
            <span class="hero-source-eyebrow">${escapeHtmlSsr(topHero.sourceName || brandTitle)}</span>
            <h1 class="hero-headline"><a href="/?article=${encodeURIComponent(topHero.id)}" style="color:inherit;text-decoration:none;">${escapeHtmlSsr(topHero.title)}</a></h1>
            <p class="hero-summary">${escapeHtmlSsr(topHero.summary || '')}</p>
          </div>
        </article>`;
      html = html.replace(
        '<section class="hero-dispatch-section" id="featuredSection"></section>',
        () => `<section class="hero-dispatch-section" id="featuredSection">${heroHtml}</section>`
      );
    }

    if (gridList.length > 0) {
      const cardsHtml = gridList.map(a => `
        <article class="dispatch-card" data-id="${escapeHtmlSsr(a.id)}">
          <div class="dispatch-content-box">
            <div class="dispatch-meta-top">
              <span class="dispatch-source">${escapeHtmlSsr(a.sourceName || brandTitle)}</span>
            </div>
            <h3 class="dispatch-title"><a href="/?article=${encodeURIComponent(a.id)}" style="color:inherit;text-decoration:none;">${escapeHtmlSsr(a.title)}</a></h3>
            <p class="dispatch-excerpt">${escapeHtmlSsr(a.summary || '')}</p>
          </div>
        </article>`).join('');
      html = html.replace(
        '<div class="dispatches-grid" id="articlesGrid"></div>',
        () => `<div class="dispatches-grid" id="articlesGrid"><div class="dispatches-grid-standard">${cardsHtml}</div></div>`
      );
    }

    return html
      .replace('<span class="callsign" id="uiPortalTitle">CYBERPOLIS</span>', () => `<span class="callsign" id="uiPortalTitle">${escapeHtmlSsr(brandTitle)}</span>`)
      .replace('<div class="identity-role" id="uiPortalSubtitle">TU HACKNOTICIERO</div>', () => `<div class="identity-role" id="uiPortalSubtitle">${escapeHtmlSsr(brandSubtitle)}</div>`);
  } catch (e) {
    return rawHtml;
  }
}

function serveStatic(req, res, pathname, query = {}) {
  let decodedPath = pathname;
  try {
    decodedPath = decodeURIComponent(pathname || '/');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=UTF-8' });
    res.end('Ruta inválida');
    return;
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\') || decodedPath.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
    res.end('Acceso denegado');
    return;
  }

  let cleanPath = decodedPath;
  if (cleanPath === '/enviox' || cleanPath === '/tranxfer') {
    res.writeHead(301, { 'Location': '/enviox/' });
    res.end();
    return;
  }
  if (cleanPath === '/tranxfer/') {
    res.writeHead(301, { 'Location': '/enviox/' });
    res.end();
    return;
  }
  if (cleanPath === '/enviox/') {
    cleanPath = '/enviox/index.html';
  }

  const normalized = path.posix.normalize(cleanPath === '/' ? '/index.html' : cleanPath);
  const allowedExact =
    normalized === '/index.html' ||
    normalized === '/favicon.ico' ||
    normalized === '/googlef43c9fcec7c53a25.html' ||
    normalized === '/enviox/index.html';
  const allowedDir = normalized.startsWith('/assets/') || normalized.startsWith('/css/') || normalized.startsWith('/js/') || normalized.startsWith('/enviox/');

  const isBlockedServerFile = normalized === '/enviox/standalone-server.js' || normalized.endsWith('.json') || normalized.endsWith('.map');

  // Bloqueo estricto de /data/, /.git/, código fuente del servidor, dotfiles y JSON internos
  if ((!allowedExact && !allowedDir) || isBlockedServerFile || /\/\./.test(normalized)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Acceso denegado');
    return;
  }

  const publicRoot = path.resolve(__dirname);
  const filePath = path.resolve(__dirname, '.' + normalized);
  const rel = path.relative(publicRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
    res.end('Acceso denegado');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8', 'X-Content-Type-Options': 'nosniff' });
      res.end('404 Recurso no encontrado');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isMainIndex = normalized === '/index.html' || normalized === '/enviox/index.html';
    const isVerificationFile = normalized === '/googlef43c9fcec7c53a25.html';
    const isEnvioxFile = normalized.startsWith('/enviox/');

    const headers = buildSecurityHeaders(req, {
      isHtml: isMainIndex || isVerificationFile,
      contentType,
      cacheControl: (isMainIndex || isVerificationFile || isEnvioxFile) ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
    });

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    if (isMainIndex) {
      recordVisitEvent(req, { page: req.url || '/' });
      fs.readFile(filePath, 'utf-8', (readErr, rawHtml) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
          res.end('Error cargando portada');
          return;
        }
        const ssrHtml = renderSsrIndexHtml(req, rawHtml, query);
        res.writeHead(200, headers);
        res.end(ssrHtml);
      });
      return;
    }

    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

const DEFAULT_AD_BANNER = {
  enabled: true,
  title: '¿Quién manda hoy en The Prison?',
  description: 'Bandas, Alcatraz y clasificaciones en directo.',
  ctaText: 'Ver Cárceles ↗',
  targetUrl: 'https://theprison.com/carceles',
  imageUrl: 'assets/ads/theprison-alcatraz.webp',
  logoUrl: 'assets/ads/theprison-marca.webp',
  delaySeconds: 2,
  durationSeconds: 15,
  position: 'bottom-right',
  size: 'compact'
};

function sanitizeAdBannerConfig(raw, existing = null) {
  const base = (existing && typeof existing === 'object') ? { ...DEFAULT_AD_BANNER, ...existing } : { ...DEFAULT_AD_BANNER };
  if (!raw || typeof raw !== 'object') return base;

  const parseClampedInt = (val, min, max, fallback) => {
    if (val === undefined || val === null || val === '') return fallback;
    const n = parseInt(val, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  return {
    enabled: raw.enabled !== undefined ? !!raw.enabled : !!base.enabled,
    title: sanitizeInput(raw.title !== undefined ? raw.title : base.title, 90) || DEFAULT_AD_BANNER.title,
    description: sanitizeInput(raw.description !== undefined ? raw.description : base.description, 180),
    ctaText: sanitizeInput(raw.ctaText !== undefined ? raw.ctaText : base.ctaText, 40) || 'Abrir ↗',
    targetUrl: sanitizeExternalUrl(raw.targetUrl !== undefined ? raw.targetUrl : base.targetUrl) || DEFAULT_AD_BANNER.targetUrl,
    imageUrl: raw.imageUrl === '' ? '' : sanitizeImageUrl(raw.imageUrl !== undefined ? raw.imageUrl : base.imageUrl, DEFAULT_AD_BANNER.imageUrl),
    logoUrl: raw.logoUrl === '' ? '' : sanitizeImageUrl(raw.logoUrl !== undefined ? raw.logoUrl : base.logoUrl, ''),
    delaySeconds: parseClampedInt(raw.delaySeconds, 0, 60, base.delaySeconds),
    durationSeconds: parseClampedInt(raw.durationSeconds, 0, 300, base.durationSeconds),
    position: raw.position === 'bottom-left' ? 'bottom-left' : (raw.position === 'bottom-right' ? 'bottom-right' : base.position),
    size: raw.size === 'mini' ? 'mini' : (raw.size === 'compact' ? 'compact' : base.size)
  };
}

// ==========================================
// Chat IRC Lateral en Vivo (Estilo mIRC32)
// ==========================================
const DEFAULT_BOT_CONFIG = {
  enabled: true,
  nick: 'CyberBot',
  antiFloodMaxMsgs: 5,
  antiFloodWindowSec: 8,
  antiSpamLinks: true,
  badWords: ['spam', 'scam', 'phishing', 'carding', 'ddos4hire', 'exploit4sale', 'gilipollas', 'idiota'],
  badWordAction: 'mute',
  welcomeRules: 'Reglas CYBERPOLIS: 1) Respeto y ética 2) Cero spam/phishing 3) Usa !comandos o /join #canal para abrir salas'
};

const DEFAULT_CHAT_STATE = {
  channel: '#cyberpolis',
  topic: 'Bienvenidos a #cyberpolis — Hacknoticiero & Debate IRC en vivo',
  enabled: true,
  allowGuests: true,
  moderatedMode: false,
  theme: 'mirc-classic',
  botConfig: { ...DEFAULT_BOT_CONFIG },
  messages: [
    {
      id: 'irc-welcome-1',
      type: 'system',
      nick: 'ChanServ',
      prefix: '@',
      role: 'system',
      text: '*** Now talking in #cyberpolis (+nt) — Canal oficial de CYBERPOLIS · Bot @CyberBot activo (!help)',
      ts: '2026-11-12T09:00:00.000Z'
    }
  ],
  opNicks: [],
  voiceNicks: [],
  mutedNicks: [],
  bannedEntries: [],
  channels: {}
};

const chatSseClients = new Map();
const chatBotFloodMap = new Map();

const chatHeartbeatTimer = setInterval(() => {
  if (chatSseClients.size === 0) return;
  for (const [cid, client] of chatSseClients.entries()) {
    try {
      client.res.write(': heartbeat\n\n');
    } catch (e) {
      chatSseClients.delete(cid);
    }
  }
}, 20000);
if (typeof chatHeartbeatTimer.unref === 'function') chatHeartbeatTimer.unref();

function sanitizeIrcChannel(raw) {
  const cleaned = sanitizeInput(String(raw || ''), 32).replace(/\s+/g, '').replace(/[^#&a-zA-Z0-9_-]/g, '');
  if (!cleaned) return '#cyberpolis';
  return cleaned.startsWith('#') || cleaned.startsWith('&') ? cleaned : '#' + cleaned;
}

function sanitizeIrcNick(raw, fallback = 'invitado') {
  const cleaned = String(raw || '')
    .replace(/^[@+%~&\s]+/, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 18);
  return cleaned.length >= 2 ? cleaned : fallback;
}

function hashChannelKey(rawKey) {
  const trimmed = String(rawKey || '').trim();
  if (!trimmed) return '';
  return crypto.createHash('sha256').update('cp-irc-key:' + trimmed).digest('hex');
}

function sanitizeBotConfig(raw, fallback = DEFAULT_BOT_CONFIG) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = fallback || DEFAULT_BOT_CONFIG;
  const maxMsgs = Number(src.antiFloodMaxMsgs !== undefined ? src.antiFloodMaxMsgs : base.antiFloodMaxMsgs);
  const winSec = Number(src.antiFloodWindowSec !== undefined ? src.antiFloodWindowSec : base.antiFloodWindowSec);
  const badWordsRaw = Array.isArray(src.badWords)
    ? src.badWords
    : (typeof src.badWords === 'string' ? src.badWords.split(/[\n,]+/) : base.badWords);
  const badWords = badWordsRaw
    .map(w => sanitizeInput(String(w || '').trim().toLowerCase(), 40))
    .filter(Boolean)
    .slice(0, 80);
  const action = ['warn', 'delete', 'mute'].includes(src.badWordAction)
    ? src.badWordAction
    : (base.badWordAction || 'mute');
  return {
    enabled: src.enabled !== undefined ? !!src.enabled : !!base.enabled,
    nick: sanitizeIrcNick(src.nick || base.nick || 'CyberBot', 'CyberBot'),
    antiFloodMaxMsgs: Number.isFinite(maxMsgs) ? Math.min(20, Math.max(2, Math.round(maxMsgs))) : 5,
    antiFloodWindowSec: Number.isFinite(winSec) ? Math.min(60, Math.max(3, Math.round(winSec))) : 8,
    antiSpamLinks: src.antiSpamLinks !== undefined ? !!src.antiSpamLinks : !!base.antiSpamLinks,
    badWords,
    badWordAction: action,
    welcomeRules: sanitizeInput(src.welcomeRules !== undefined ? src.welcomeRules : base.welcomeRules, 320) || DEFAULT_BOT_CONFIG.welcomeRules
  };
}

function normalizeNickRoleList(arr, defaultReason) {
  return Array.isArray(arr)
    ? arr
        .filter(x => x && typeof x.nick === 'string')
        .slice(-100)
        .map(x => ({
          nick: sanitizeIrcNick(x.nick, ''),
          reason: sanitizeInput(x.reason || defaultReason, 140),
          createdAt: x.createdAt || new Date().toISOString(),
          createdBy: sanitizeIrcNick(x.createdBy || 'admin', 'admin')
        }))
        .filter(x => !!x.nick)
    : [];
}

function normalizeSingleChannel(name, rawCh, fallbackMessages = null) {
  const chName = sanitizeIrcChannel(name || '#cyberpolis');
  const isMain = chName.toLowerCase() === '#cyberpolis';
  const src = rawCh && typeof rawCh === 'object' ? rawCh : {};
  const defaultMsgs = fallbackMessages || (isMain
    ? [...DEFAULT_CHAT_STATE.messages]
    : [{
        id: 'irc-ch-' + Date.now(),
        type: 'system',
        nick: 'ChanServ',
        prefix: '@',
        role: 'system',
        text: `*** Now talking in ${chName} ${src.isPrivate || src.keyHash ? '(+p/+k privado)' : '(+nt)'}`,
        ts: new Date().toISOString()
      }]);

  const messages = Array.isArray(src.messages)
    ? src.messages
        .filter(m => m && typeof m === 'object' && typeof m.text === 'string')
        .slice(-1000)
        .map(m => ({
          id: sanitizeInput(String(m.id || ('irc-' + Date.now())), 64),
          type: ['msg', 'action', 'system'].includes(m.type) ? m.type : 'msg',
          nick: sanitizeIrcNick(m.nick || 'anon', 'anon'),
          prefix: m.prefix === '@' ? '@' : (m.prefix === '+' ? '+' : ''),
          role: m.role === 'admin' ? 'admin' : (m.role === 'analyst' ? 'analyst' : (m.role === 'bot' ? 'bot' : (m.role === 'system' ? 'system' : 'guest'))),
          text: sanitizeInput(m.text, 480),
          ts: typeof m.ts === 'string' ? m.ts : new Date().toISOString()
        }))
    : defaultMsgs;

  const bannedEntries = Array.isArray(src.bannedEntries)
    ? src.bannedEntries
        .filter(x => x && (typeof x.nick === 'string' || typeof x.ip === 'string'))
        .slice(-150)
        .map(x => ({
          id: sanitizeInput(String(x.id || ('ban-' + Date.now())), 64),
          nick: x.nick ? sanitizeIrcNick(x.nick, '') : '',
          ip: sanitizeInput(String(x.ip || ''), 64),
          reason: sanitizeInput(x.reason || 'Baneado del canal por @op', 140),
          createdAt: x.createdAt || new Date().toISOString(),
          createdBy: sanitizeIrcNick(x.createdBy || 'admin', 'admin')
        }))
        .filter(x => !!(x.nick || x.ip))
    : [];

  const lowerList = arr => Array.isArray(arr)
    ? [...new Set(arr.map(n => sanitizeIrcNick(n, '').toLowerCase()).filter(Boolean))].slice(-200)
    : [];

  return {
    name: chName,
    topic: sanitizeInput(src.topic !== undefined ? src.topic : (isMain ? DEFAULT_CHAT_STATE.topic : `Canal ${chName} en CYBERPOLIS`), 180),
    owner: sanitizeIrcNick(src.owner || 'admin', 'admin'),
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : new Date().toISOString(),
    isPrivate: isMain ? false : !!src.isPrivate,
    secret: isMain ? false : !!src.secret,
    inviteOnly: isMain ? false : !!src.inviteOnly,
    keyHash: !isMain && typeof src.keyHash === 'string' && /^[a-f0-9]{64}$/i.test(src.keyHash) ? src.keyHash.toLowerCase() : '',
    allowGuests: src.allowGuests !== undefined ? !!src.allowGuests : !src.isPrivate,
    moderatedMode: !!src.moderatedMode,
    invitedNicks: lowerList(src.invitedNicks),
    unlockedNicks: lowerList(src.unlockedNicks),
    messages,
    opNicks: normalizeNickRoleList(src.opNicks, 'Operador de canal (+o)'),
    voiceNicks: normalizeNickRoleList(src.voiceNicks, 'Voz de canal (+v)'),
    mutedNicks: normalizeNickRoleList(src.mutedNicks, 'Silenciado por @op'),
    bannedEntries
  };
}

function syncPrimaryChannelBackToRoot(chat) {
  if (!chat || !chat.channels) return chat;
  const mainKey = sanitizeIrcChannel(chat.channel || '#cyberpolis').toLowerCase();
  const mainCh = chat.channels[mainKey] || chat.channels['#cyberpolis'];
  if (!mainCh) return chat;
  chat.channel = mainCh.name;
  chat.topic = mainCh.topic;
  chat.allowGuests = mainCh.allowGuests;
  chat.moderatedMode = mainCh.moderatedMode;
  chat.messages = mainCh.messages;
  chat.opNicks = mainCh.opNicks;
  chat.voiceNicks = mainCh.voiceNicks;
  chat.mutedNicks = mainCh.mutedNicks;
  chat.bannedEntries = mainCh.bannedEntries;
  return chat;
}

function normalizeChatStore(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const primaryName = sanitizeIrcChannel(src.channel || DEFAULT_CHAT_STATE.channel);
  const primaryKey = primaryName.toLowerCase();
  const channels = {};

  if (src.channels && typeof src.channels === 'object') {
    for (const [k, v] of Object.entries(src.channels)) {
      if (!v || typeof v !== 'object') continue;
      const norm = normalizeSingleChannel(v.name || k, v);
      channels[norm.name.toLowerCase()] = norm;
    }
  }

  if (!channels[primaryKey]) {
    channels[primaryKey] = normalizeSingleChannel(primaryName, {
      name: primaryName,
      topic: src.topic,
      allowGuests: src.allowGuests,
      moderatedMode: src.moderatedMode,
      messages: src.messages,
      opNicks: src.opNicks,
      voiceNicks: src.voiceNicks,
      mutedNicks: src.mutedNicks,
      bannedEntries: src.bannedEntries
    });
  } else if (Array.isArray(src.messages) && (!Array.isArray(channels[primaryKey].messages) || channels[primaryKey].messages.length === 0)) {
    channels[primaryKey].messages = normalizeSingleChannel(primaryName, src).messages;
  }

  const normalized = {
    channel: primaryName,
    topic: channels[primaryKey].topic,
    enabled: src.enabled !== undefined ? !!src.enabled : true,
    allowGuests: channels[primaryKey].allowGuests,
    moderatedMode: channels[primaryKey].moderatedMode,
    theme: src.theme === 'mirc-dark' ? 'mirc-dark' : 'mirc-classic',
    botConfig: sanitizeBotConfig(src.botConfig, DEFAULT_BOT_CONFIG),
    messages: channels[primaryKey].messages,
    opNicks: channels[primaryKey].opNicks,
    voiceNicks: channels[primaryKey].voiceNicks,
    mutedNicks: channels[primaryKey].mutedNicks,
    bannedEntries: channels[primaryKey].bannedEntries,
    channels
  };
  return syncPrimaryChannelBackToRoot(normalized);
}

function readChatState() {
  return normalizeChatStore(readJSON(CHAT_FILE, DEFAULT_CHAT_STATE));
}

function writeChatState(nextState) {
  const normalized = normalizeChatStore(nextState);
  writeJSON(CHAT_FILE, normalized, { critical: true });
  return normalized;
}

function getChannelObject(chat, channelName = '') {
  if (!chat) return null;
  const channels = chat.channels || {};
  const target = sanitizeIrcChannel(channelName || chat.channel || '#cyberpolis').toLowerCase();
  if (channelName && !channels[target]) return null;
  if (channels[target]) return channels[target];
  const primary = sanitizeIrcChannel(chat.channel || '#cyberpolis').toLowerCase();
  return channels[primary] || Object.values(channels)[0] || null;
}

function isNickChannelOp(chOrChat, nick) {
  const lower = String(nick || '').toLowerCase();
  return !!(lower && chOrChat && (chOrChat.opNicks || []).some(x => x.nick && x.nick.toLowerCase() === lower));
}

function isNickChannelVoice(chOrChat, nick) {
  const lower = String(nick || '').toLowerCase();
  return !!(lower && chOrChat && (chOrChat.voiceNicks || []).some(x => x.nick && x.nick.toLowerCase() === lower));
}

function canUserAccessChannel(chObj, identity = null, suppliedKey = '') {
  if (!chObj) return false;
  if (chObj.name.toLowerCase() === '#cyberpolis') return true;
  if (!chObj.isPrivate && !chObj.secret && !chObj.inviteOnly && !chObj.keyHash) return true;
  if (!identity || !identity.ok) return false;
  if (identity.isSiteAdmin) return true;
  const lowerNick = String(identity.nick || '').toLowerCase();
  if (chObj.owner && chObj.owner.toLowerCase() === lowerNick) return true;
  if (isNickChannelOp(chObj, identity.nick)) return true;
  if (!chObj.allowGuests && identity.role === 'guest') return false;
  if (Array.isArray(chObj.invitedNicks) && chObj.invitedNicks.includes(lowerNick)) return true;
  if (chObj.inviteOnly) return false;
  if (chObj.keyHash) {
    if (Array.isArray(chObj.unlockedNicks) && chObj.unlockedNicks.includes(lowerNick)) return true;
    if (suppliedKey && hashChannelKey(suppliedKey) === chObj.keyHash) return true;
    return false;
  }
  return !chObj.isPrivate && !chObj.secret;
}

function isRegisteredAdminNick(nick) {
  const lower = String(nick || '').toLowerCase();
  if (!lower) return false;
  const users = readJSON(USERS_FILE, []);
  return users.some(u =>
    u && u.role === 'admin' && (
      String(u.username || '').toLowerCase() === lower ||
      String(u.displayName || '').toLowerCase() === lower
    )
  );
}

function resolveChatIdentity(req, requestedNick = '', chatOverride = null, channelName = '') {
  const chat = chatOverride || readChatState();
  const chObj = getChannelObject(chat, channelName) || getChannelObject(chat) || chat;
  const user = getSessionUser(req);
  if (user) {
    const cleanNick = sanitizeIrcNick(user.username || user.displayName, 'usuario');
    const isSiteAdmin = user.role === 'admin';
    const isOwner = !!(chObj && chObj.owner && chObj.owner.toLowerCase() === cleanNick.toLowerCase());
    const isChannelOp = isSiteAdmin || isOwner || isNickChannelOp(chObj, cleanNick);
    const prefix = isChannelOp ? '@' : '+';
    return {
      ok: true,
      authenticated: true,
      nick: cleanNick,
      prefix,
      role: isSiteAdmin ? 'admin' : 'analyst',
      isSiteAdmin,
      isChannelOp,
      user
    };
  }

  const cleanGuest = sanitizeIrcNick(requestedNick, 'invitado_' + Math.floor(100 + Math.random() * 900));
  const users = readJSON(USERS_FILE, []);
  const clashesRegistered = users.some(u =>
    u && (
      String(u.username || '').toLowerCase() === cleanGuest.toLowerCase() ||
      String(u.displayName || '').toLowerCase() === cleanGuest.toLowerCase()
    )
  );
  if (clashesRegistered) {
    return {
      ok: false,
      status: 403,
      error: `El nick "${cleanGuest}" está reservado a una cuenta registrada. Inicia sesión o usa otro nick.`
    };
  }
  const isChannelOp = isNickChannelOp(chObj, cleanGuest);
  const isVoice = !isChannelOp && isNickChannelVoice(chObj, cleanGuest);
  return {
    ok: true,
    authenticated: false,
    nick: cleanGuest,
    prefix: isChannelOp ? '@' : (isVoice ? '+' : ''),
    role: 'guest',
    isSiteAdmin: false,
    isChannelOp,
    user: null
  };
}

function findChatBan(chOrChat, nick, ip) {
  const lowerNick = String(nick || '').toLowerCase();
  return ((chOrChat && chOrChat.bannedEntries) || []).find(b =>
    (b.nick && lowerNick && b.nick.toLowerCase() === lowerNick) ||
    (b.ip && ip && b.ip === ip)
  ) || null;
}

function findChatMute(chOrChat, nick) {
  const lowerNick = String(nick || '').toLowerCase();
  return ((chOrChat && chOrChat.mutedNicks) || []).find(m => m.nick && m.nick.toLowerCase() === lowerNick) || null;
}

function getOnlineChatNicks(channelName = '#cyberpolis', chat = null) {
  const chLower = sanitizeIrcChannel(channelName || '#cyberpolis').toLowerCase();
  const byNick = new Map();
  const bot = (chat && chat.botConfig) || DEFAULT_BOT_CONFIG;
  if (bot && bot.enabled) {
    const botNick = bot.nick || 'CyberBot';
    byNick.set(botNick.toLowerCase(), {
      nick: botNick,
      prefix: '@',
      role: 'bot',
      rank: 4
    });
  }
  for (const client of chatSseClients.values()) {
    const cCh = (client.channel || '#cyberpolis').toLowerCase();
    if (cCh !== chLower) continue;
    const key = client.nick.toLowerCase();
    const existing = byNick.get(key);
    const rank = client.prefix === '@' ? 3 : (client.prefix === '+' ? 2 : 1);
    if (!existing || rank > existing.rank) {
      byNick.set(key, {
        nick: client.nick,
        prefix: client.prefix,
        role: client.role,
        rank
      });
    }
  }
  return [...byNick.values()]
    .sort((a, b) => (b.rank - a.rank) || a.nick.localeCompare(b.nick, 'es'))
    .map(({ nick, prefix, role }) => ({ nick, prefix, role }));
}

function listAccessibleChannels(chat, identity = null) {
  const all = Object.values((chat && chat.channels) || {});
  return all
    .filter(ch => !ch.secret || canUserAccessChannel(ch, identity))
    .map(ch => {
      const canAccess = canUserAccessChannel(ch, identity);
      const modes = [];
      if (ch.moderatedMode) modes.push('+m');
      if (ch.isPrivate) modes.push('+p');
      if (ch.secret) modes.push('+s');
      if (ch.inviteOnly) modes.push('+i');
      if (ch.keyHash) modes.push('+k');
      return {
        name: ch.name,
        topic: canAccess ? ch.topic : 'Canal privado — introduce clave (+k) o solicita invitación (+i)',
        owner: ch.owner || 'admin',
        isMain: ch.name.toLowerCase() === '#cyberpolis',
        isPrivate: !!ch.isPrivate,
        secret: !!ch.secret,
        inviteOnly: !!ch.inviteOnly,
        hasKey: !!ch.keyHash,
        allowGuests: !!ch.allowGuests,
        moderatedMode: !!ch.moderatedMode,
        modes: modes.join('') || '+nt',
        canAccess,
        onlineCount: getOnlineChatNicks(ch.name, chat).length,
        msgCount: Array.isArray(ch.messages) ? ch.messages.length : 0
      };
    })
    .sort((a, b) => (a.isMain ? -1 : b.isMain ? 1 : a.name.localeCompare(b.name, 'es')));
}

function buildPublicChatPayload(chat, identity = null, ip = '', channelName = '') {
  const chObj = getChannelObject(chat, channelName) || getChannelObject(chat);
  const nick = identity && identity.ok ? identity.nick : '';
  const ban = identity && identity.ok ? findChatBan(chObj, nick, ip) : findChatBan(chObj, '', ip);
  const mute = identity && identity.ok ? findChatMute(chObj, nick) : null;
  const scopedIdentity = identity && identity.ok
    ? {
        nick: identity.nick,
        prefix: (identity.isSiteAdmin || (chObj.owner && chObj.owner.toLowerCase() === identity.nick.toLowerCase()) || isNickChannelOp(chObj, identity.nick))
          ? '@'
          : (identity.authenticated || isNickChannelVoice(chObj, identity.nick) ? '+' : ''),
        role: identity.role,
        authenticated: identity.authenticated,
        isChannelOp: !!(identity.isSiteAdmin || (chObj.owner && chObj.owner.toLowerCase() === identity.nick.toLowerCase()) || isNickChannelOp(chObj, identity.nick)),
        isSiteAdmin: !!identity.isSiteAdmin
      }
    : null;
  const bot = chat.botConfig || DEFAULT_BOT_CONFIG;
  return {
    channel: chObj.name,
    topic: chObj.topic,
    owner: chObj.owner || 'admin',
    enabled: chat.enabled,
    allowGuests: chObj.allowGuests,
    moderatedMode: chObj.moderatedMode,
    isPrivate: !!chObj.isPrivate,
    secret: !!chObj.secret,
    inviteOnly: !!chObj.inviteOnly,
    hasKey: !!chObj.keyHash,
    theme: chat.theme,
    messages: (chObj.messages || []).slice(-250),
    onlineUsers: getOnlineChatNicks(chObj.name, chat),
    mutedNickNames: (chObj.mutedNicks || []).map(x => x.nick),
    opNickNames: (chObj.opNicks || []).map(x => x.nick),
    voiceNickNames: (chObj.voiceNicks || []).map(x => x.nick),
    isBanned: !!ban,
    isMuted: !!mute,
    identity: scopedIdentity,
    channels: listAccessibleChannels(chat, identity),
    bot: {
      enabled: !!bot.enabled,
      nick: bot.nick || 'CyberBot'
    }
  };
}

function syncOnlineClientPrefixes(chat, chObjOverride = null) {
  const chObj = chObjOverride || getChannelObject(chat);
  if (!chObj) return;
  const chLower = chObj.name.toLowerCase();
  let changed = false;
  for (const client of chatSseClients.values()) {
    if ((client.channel || '#cyberpolis').toLowerCase() !== chLower) continue;
    const isSiteAdmin = client.role === 'admin';
    const isOwner = !!(chObj.owner && chObj.owner.toLowerCase() === client.nick.toLowerCase());
    const isOp = isSiteAdmin || isOwner || isNickChannelOp(chObj, client.nick);
    const isVoice = !isOp && (client.role === 'analyst' || isNickChannelVoice(chObj, client.nick));
    const nextPrefix = isOp ? '@' : (isVoice ? '+' : '');
    if (client.prefix !== nextPrefix) {
      client.prefix = nextPrefix;
      changed = true;
      try {
        client.res.write(`event: self_mode\ndata: ${JSON.stringify({
          channel: chObj.name,
          nick: client.nick,
          prefix: nextPrefix,
          isChannelOp: isOp
        })}\n\n`);
      } catch (e) {}
    }
  }
  broadcastChatEvent('config', {
    channel: chObj.name,
    topic: chObj.topic,
    enabled: chat.enabled,
    allowGuests: chObj.allowGuests,
    moderatedMode: chObj.moderatedMode,
    isPrivate: !!chObj.isPrivate,
    secret: !!chObj.secret,
    inviteOnly: !!chObj.inviteOnly,
    hasKey: !!chObj.keyHash,
    theme: chat.theme,
    mutedNickNames: (chObj.mutedNicks || []).map(x => x.nick),
    opNickNames: (chObj.opNicks || []).map(x => x.nick),
    voiceNickNames: (chObj.voiceNicks || []).map(x => x.nick)
  }, chObj.name);
  if (changed) {
    broadcastChatEvent('presence', {
      channel: chObj.name,
      onlineUsers: getOnlineChatNicks(chObj.name, chat)
    }, chObj.name);
  }
}

function executeIrcModAction(chat, actorIdentity, { action, nick = '', reason = 'Moderación @op', text = '', id = '', channel = '' }) {
  const chObj = getChannelObject(chat, channel) || getChannelObject(chat);
  if (!chObj) return { ok: false, status: 404, error: 'Canal no encontrado.' };
  const act = String(action || '').toLowerCase();
  const opNick = sanitizeIrcNick((actorIdentity && actorIdentity.nick) || 'admin', 'admin');
  const targetNick = nick ? sanitizeIrcNick(nick, '') : '';
  const cleanReason = sanitizeInput(reason || 'Moderación @op', 140) || 'Moderación @op';

  if (act === 'clear') {
    chObj.messages = [{
      id: 'irc-' + Date.now(),
      type: 'system',
      nick: opNick,
      prefix: '@',
      role: 'system',
      text: `* @${opNick} ha limpiado el historial de ${chObj.name}`,
      ts: new Date().toISOString()
    }];
    writeChatState(chat);
    broadcastChatEvent('clear', { channel: chObj.name, messages: chObj.messages }, chObj.name);
    return { ok: true, status: 200, chatPayload: buildPublicChatPayload(chat, actorIdentity, '', chObj.name) };
  }

  if (act === 'notice') {
    const cleanText = sanitizeInput(text || '', 380);
    if (!cleanText) return { ok: false, status: 400, error: 'Escribe el texto del aviso.' };
    const msg = appendChatMessage(chat, {
      type: 'system',
      nick: opNick,
      prefix: '@',
      role: 'system',
      text: `[AVISO @${opNick}] ${cleanText}`
    }, chObj);
    return { ok: true, status: 201, message: msg };
  }

  if (act === 'toggle_moderated') {
    chObj.moderatedMode = !chObj.moderatedMode;
    appendChatMessage(chat, {
      type: 'system',
      nick: opNick,
      prefix: '@',
      role: 'system',
      text: `* @${opNick} sets mode ${chObj.moderatedMode ? '+m (canal moderado)' : '-m (canal abierto)'}`
    }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
    return { ok: true, status: 200, chatPayload: buildPublicChatPayload(chat, actorIdentity, '', chObj.name) };
  }

  if (act === 'toggle_guests') {
    chObj.allowGuests = !chObj.allowGuests;
    appendChatMessage(chat, {
      type: 'system',
      nick: opNick,
      prefix: '@',
      role: 'system',
      text: `* @${opNick} ${chObj.allowGuests ? 'habilita' : 'restringe'} el chat para invitados en ${chObj.name}`
    }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
    return { ok: true, status: 200, chatPayload: buildPublicChatPayload(chat, actorIdentity, '', chObj.name) };
  }

  if (!targetNick && act !== 'unban') {
    return { ok: false, status: 400, error: 'Debes indicar un nick válido.' };
  }

  const protectedAdmin = targetNick && (
    targetNick.toLowerCase() === opNick.toLowerCase() ||
    isRegisteredAdminNick(targetNick)
  );
  if (protectedAdmin && ['mute', 'ban', 'kick', 'kickban', 'deop'].includes(act)) {
    return { ok: false, status: 403, error: 'No se puede sancionar ni degradar a un Administrador del portal.' };
  }

  if (act === 'invite') {
    const nl = targetNick.toLowerCase();
    if (!chObj.invitedNicks.includes(nl)) chObj.invitedNicks.push(nl);
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} invited ${targetNick} into ${chObj.name}` }, chObj);
  } else if (act === 'op') {
    if (!isNickChannelOp(chObj, targetNick)) {
      chObj.opNicks.push({ nick: targetNick, reason: 'Elevado a @op', createdAt: new Date().toISOString(), createdBy: opNick });
    }
    chObj.mutedNicks = chObj.mutedNicks.filter(m => m.nick.toLowerCase() !== targetNick.toLowerCase());
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} gives channel operator status (@) to ${targetNick}` }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
  } else if (act === 'deop') {
    chObj.opNicks = chObj.opNicks.filter(x => x.nick.toLowerCase() !== targetNick.toLowerCase());
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} removes channel operator status (@) from ${targetNick}` }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
  } else if (act === 'voice') {
    if (!isNickChannelVoice(chObj, targetNick)) {
      chObj.voiceNicks.push({ nick: targetNick, reason: 'Voz en canal (+v)', createdAt: new Date().toISOString(), createdBy: opNick });
    }
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} gives voice (+v) to ${targetNick}` }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
  } else if (act === 'devoice') {
    chObj.voiceNicks = chObj.voiceNicks.filter(x => x.nick.toLowerCase() !== targetNick.toLowerCase());
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} removes voice (-v) from ${targetNick}` }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
  } else if (act === 'mute') {
    if (!findChatMute(chObj, targetNick)) {
      chObj.mutedNicks.push({ nick: targetNick, reason: cleanReason, createdAt: new Date().toISOString(), createdBy: opNick });
    }
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} sets mode +q on ${targetNick} (${cleanReason})` }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
  } else if (act === 'unmute') {
    chObj.mutedNicks = chObj.mutedNicks.filter(m => m.nick.toLowerCase() !== targetNick.toLowerCase());
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} sets mode -q on ${targetNick}` }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
  } else if (act === 'ban' || act === 'kickban') {
    let targetIp = '';
    for (const c of chatSseClients.values()) {
      if (c.nick.toLowerCase() === targetNick.toLowerCase()) targetIp = c.ip;
    }
    chObj.opNicks = chObj.opNicks.filter(x => x.nick.toLowerCase() !== targetNick.toLowerCase());
    chObj.voiceNicks = chObj.voiceNicks.filter(x => x.nick.toLowerCase() !== targetNick.toLowerCase());
    if (!chObj.bannedEntries.some(b => b.nick && b.nick.toLowerCase() === targetNick.toLowerCase())) {
      chObj.bannedEntries.push({
        id: 'ban-' + Date.now(),
        nick: targetNick,
        ip: targetIp,
        reason: cleanReason,
        createdAt: new Date().toISOString(),
        createdBy: opNick
      });
    }
    const modeLabel = act === 'kickban' ? 'kick & ban +b' : 'ban +b';
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} sets ${modeLabel} on ${targetNick} (${cleanReason})` }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
    disconnectMatchingChatClients({ nick: targetNick, ip: targetIp, reason: `Baneado por @${opNick}: ${cleanReason}`, channel: chObj.name });
  } else if (act === 'unban') {
    const banId = String(id || '');
    chObj.bannedEntries = chObj.bannedEntries.filter(b =>
      (banId ? b.id !== banId : true) &&
      (targetNick ? (b.nick || '').toLowerCase() !== targetNick.toLowerCase() : true)
    );
    if (targetNick) {
      appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* @${opNick} sets mode -b on ${targetNick}` }, chObj);
    } else {
      writeChatState(chat);
    }
    syncOnlineClientPrefixes(chat, chObj);
  } else if (act === 'kick') {
    appendChatMessage(chat, { type: 'system', nick: opNick, prefix: '@', role: 'system', text: `* ${targetNick} was kicked by @${opNick} (${cleanReason})` }, chObj);
    disconnectMatchingChatClients({ nick: targetNick, reason: `Expulsado por @${opNick}: ${cleanReason}`, channel: chObj.name });
  } else {
    return { ok: false, status: 400, error: 'Acción de moderación desconocida.' };
  }

  return {
    ok: true,
    status: 200,
    mutedNicks: chObj.mutedNicks,
    bannedEntries: chObj.bannedEntries,
    chatPayload: buildPublicChatPayload(chat, actorIdentity, '', chObj.name)
  };
}

function broadcastChatEvent(eventType, payload, targetChannel = null) {
  if (chatSseClients.size === 0) return;
  const targetLower = targetChannel ? sanitizeIrcChannel(targetChannel).toLowerCase() : '';
  const frame = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [cid, client] of chatSseClients.entries()) {
    if (targetLower && (client.channel || '#cyberpolis').toLowerCase() !== targetLower) continue;
    try {
      client.res.write(frame);
    } catch (e) {
      chatSseClients.delete(cid);
    }
  }
}

function disconnectMatchingChatClients({ nick = '', ip = '', reason = 'Desconectado por un operador (@)', channel = null }) {
  const lowerNick = String(nick || '').toLowerCase();
  const targetLower = channel ? sanitizeIrcChannel(channel).toLowerCase() : '';
  let removed = false;
  for (const [cid, client] of chatSseClients.entries()) {
    if (targetLower && (client.channel || '#cyberpolis').toLowerCase() !== targetLower) continue;
    const nickMatch = lowerNick && client.nick.toLowerCase() === lowerNick;
    const ipMatch = ip && client.ip === ip;
    if (nickMatch || ipMatch) {
      try {
        client.res.write(`event: kicked\ndata: ${JSON.stringify({ reason })}\n\n`);
        client.res.end();
      } catch (e) {}
      chatSseClients.delete(cid);
      removed = true;
    }
  }
  if (removed) {
    broadcastChatEvent('presence', {
      channel: targetLower || '#cyberpolis',
      onlineUsers: getOnlineChatNicks(targetLower || '#cyberpolis')
    }, targetLower || null);
  }
  return removed;
}

function appendChatMessage(chat, entry, chObj = null) {
  const targetCh = chObj || getChannelObject(chat);
  const msg = {
    id: 'irc-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
    type: ['msg', 'action', 'system'].includes(entry.type) ? entry.type : 'msg',
    nick: sanitizeIrcNick(entry.nick || 'ChanServ', 'ChanServ'),
    prefix: entry.prefix === '@' ? '@' : (entry.prefix === '+' ? '+' : ''),
    role: entry.role || 'guest',
    text: sanitizeInput(String(entry.text || ''), 480),
    ts: new Date().toISOString()
  };
  if (targetCh && Array.isArray(targetCh.messages)) {
    targetCh.messages.push(msg);
    if (targetCh.messages.length > 1000) {
      targetCh.messages = targetCh.messages.slice(-1000);
    }
  } else {
    chat.messages.push(msg);
    if (chat.messages.length > 1000) {
      chat.messages = chat.messages.slice(-1000);
    }
  }
  writeChatState(chat);
  broadcastChatEvent('message', { ...msg, channel: targetCh ? targetCh.name : chat.channel }, targetCh ? targetCh.name : chat.channel);
  return msg;
}

function evaluateCyberBotModeration(chat, chObj, identity, rawText) {
  const bot = chat.botConfig || DEFAULT_BOT_CONFIG;
  if (!bot.enabled || !identity || identity.isSiteAdmin || identity.isChannelOp) {
    return { blocked: false };
  }
  const botNick = bot.nick || 'CyberBot';
  const lowerText = String(rawText || '').toLowerCase();

  const floodKey = `${chObj.name.toLowerCase()}:${identity.nick.toLowerCase()}`;
  const now = Date.now();
  const winMs = (bot.antiFloodWindowSec || 8) * 1000;
  const recent = (chatBotFloodMap.get(floodKey) || []).filter(t => now - t <= winMs);
  recent.push(now);
  chatBotFloodMap.set(floodKey, recent);
  if (chatBotFloodMap.size > 2000) chatBotFloodMap.clear();

  if (recent.length > (bot.antiFloodMaxMsgs || 5)) {
    if (!findChatMute(chObj, identity.nick)) {
      chObj.mutedNicks.push({
        nick: identity.nick,
        reason: `Auto-flood (@${botNick})`,
        createdAt: new Date().toISOString(),
        createdBy: botNick
      });
    }
    appendChatMessage(chat, {
      type: 'system',
      nick: botNick,
      prefix: '@',
      role: 'bot',
      text: `🤖 @${botNick} sets mode +q on ${identity.nick} (Anti-flood automático)`
    }, chObj);
    syncOnlineClientPrefixes(chat, chObj);
    return { blocked: true, error: `🤖 @${botNick}: Demasiados mensajes seguidos (flood). Has sido silenciado (+q).` };
  }

  const matchedWord = (bot.badWords || []).find(w => w && lowerText.includes(w.toLowerCase()));
  if (matchedWord) {
    const action = bot.badWordAction || 'mute';
    if (action === 'mute') {
      if (!findChatMute(chObj, identity.nick)) {
        chObj.mutedNicks.push({
          nick: identity.nick,
          reason: `Lenguaje/spam detectado por @${botNick}`,
          createdAt: new Date().toISOString(),
          createdBy: botNick
        });
      }
      appendChatMessage(chat, {
        type: 'system',
        nick: botNick,
        prefix: '@',
        role: 'bot',
        text: `🤖 @${botNick} bloquea mensaje de ${identity.nick} y aplica +q (filtro de seguridad)`
      }, chObj);
      syncOnlineClientPrefixes(chat, chObj);
      return { blocked: true, error: `🤖 @${botNick}: Mensaje bloqueado por política del canal (+q aplicado).` };
    }
    if (action === 'delete') {
      appendChatMessage(chat, {
        type: 'system',
        nick: botNick,
        prefix: '@',
        role: 'bot',
        text: `🤖 @${botNick}: Aviso a ${identity.nick} — término bloqueado por moderación automática.`
      }, chObj);
      return { blocked: true, error: `🤖 @${botNick}: Tu mensaje contiene términos no permitidos en ${chObj.name}.` };
    }
    return { blocked: false, warn: `🤖 @${botNick}: ${identity.nick}, modera el lenguaje y evita spam.` };
  }

  if (bot.antiSpamLinks && identity.role === 'guest' && /https?:\/\/|www\./i.test(rawText) && !/cyberpolis\.onrender\.com/i.test(rawText)) {
    appendChatMessage(chat, {
      type: 'system',
      nick: botNick,
      prefix: '@',
      role: 'bot',
      text: `🤖 @${botNick}: Enlace externo de ${identity.nick} bloqueado (inicia sesión para compartir URLs).`
    }, chObj);
    return { blocked: true, error: `🤖 @${botNick}: Los invitados no pueden publicar enlaces externos.` };
  }

  return { blocked: false };
}

function handleCyberBotTrigger(chat, chObj, rawText) {
  const bot = chat.botConfig || DEFAULT_BOT_CONFIG;
  if (!bot.enabled) return;
  const botNick = bot.nick || 'CyberBot';
  const cmd = String(rawText || '').trim().toLowerCase().split(/\s+/)[0];
  let reply = '';
  if (cmd === '!help' || cmd === '!comandos') {
    reply = `🤖 [${botNick}] Comandos: !reglas | !noticias | !canales | !ping · IRC: /join #canal | /part | /list | /me | /slap | /whois`;
  } else if (cmd === '!reglas' || cmd === '!rules') {
    reply = `📜 [${botNick}] ${bot.welcomeRules}`;
  } else if (cmd === '!ping') {
    reply = `🏓 [${botNick}] PONG! Canal ${chObj.name} activo (${getOnlineChatNicks(chObj.name, chat).length} conectados).`;
  } else if (cmd === '!canales') {
    const pubs = Object.values(chat.channels || {}).filter(c => !c.isPrivate && !c.secret).map(c => c.name);
    reply = `📺 [${botNick}] Canales públicos: ${pubs.join(', ') || '#cyberpolis'} — Usa /join #canal o crea un canal privado.`;
  } else if (cmd === '!noticias') {
    const arts = readJSON(ARTICLES_FILE, []).filter(a => a && (!a.moderationStatus || a.moderationStatus === 'approved')).slice(0, 3);
    reply = arts.length
      ? `📰 [${botNick}] Últimos titulares: ` + arts.map((a, i) => `${i + 1}) ${String(a.title || '').slice(0, 70)}`).join(' | ')
      : `📰 [${botNick}] Sin noticias recientes en portada.`;
  }
  if (reply) {
    appendChatMessage(chat, {
      type: 'msg',
      nick: botNick,
      prefix: '@',
      role: 'bot',
      text: reply
    }, chObj);
  }
}

// ==========================================
// 2B. Motor Cloud OneDrive Multi-Tenant & WeTransfer Cifrado
// ==========================================
const cloudOAuthStates = new Map();

function readCloudStore() {
  const raw = readJSON(CLOUD_FILE, { tenants: [], backupHistory: [], mailGateway: null });
  return {
    tenants: Array.isArray(raw.tenants) ? raw.tenants : [],
    backupHistory: Array.isArray(raw.backupHistory) ? raw.backupHistory.slice(-40) : [],
    mailGateway: raw.mailGateway && typeof raw.mailGateway === 'object' ? raw.mailGateway : null
  };
}

function writeCloudStore(next) {
  const normalized = {
    tenants: Array.isArray(next.tenants) ? next.tenants.slice(0, 25) : [],
    backupHistory: Array.isArray(next.backupHistory) ? next.backupHistory.slice(-40) : [],
    mailGateway: next.mailGateway && typeof next.mailGateway === 'object' ? next.mailGateway : null
  };
  writeJSON(CLOUD_FILE, normalized, { critical: true });
  return normalized;
}

function sanitizeMailGatewayPublic(gw) {
  if (!gw || typeof gw !== 'object') {
    return { mode: 'none', host: '', port: 465, secure: true, user: '', fromEmail: '', fromName: 'CYBERPOLIS Transfer', hasPassword: false, fromEnv: false };
  }
  return {
    mode: gw.mode || 'none',
    host: gw.host || '',
    port: Number(gw.port) || 465,
    secure: gw.secure !== false,
    user: gw.user || '',
    fromEmail: gw.fromEmail || gw.user || '',
    fromName: gw.fromName || 'CYBERPOLIS Transfer',
    hasPassword: !!gw.passSealed,
    fromEnv: !!gw.fromEnv,
    updatedAt: gw.updatedAt || null
  };
}

function sanitizeTenantPublic(t, isAdmin = false) {
  if (!t || typeof t !== 'object') return null;
  const providerType = t.providerType || 'onedrive';
  const isGoogle = providerType === 'google-drive';
  const base = {
    id: t.id,
    providerType,
    name: t.name,
    companyDomain: t.companyDomain || (isGoogle ? 'google.com' : ''),
    isDefaultForBackup: !!t.isDefaultForBackup,
    connected: isGoogle
      ? !!(t.serviceAccountJsonSealed || (t.clientId && t.refreshTokenSealed))
      : !!(t.clientId && (t.clientSecretSealed || t.refreshTokenSealed)),
    fromEnv: !!t.fromEnv
  };
  if (!isAdmin) return base;
  return {
    ...base,
    tenantId: t.tenantId || (isGoogle ? 'google' : 'common'),
    clientId: t.clientId || '',
    authMode: t.authMode || (isGoogle ? 'google_oauth2' : 'client_credentials'),
    driveUserUpn: t.driveUserUpn || '',
    driveId: t.driveId || '',
    baseFolder: t.baseFolder || '/CYBERPOLIS_VAULT',
    serviceAccountEmail: t.serviceAccountEmail || '',
    autoBackupEnabled: t.autoBackupEnabled !== false,
    sendMailEnabled: t.sendMailEnabled !== false,
    hasClientSecret: !!t.clientSecretSealed,
    hasRefreshToken: !!t.refreshTokenSealed,
    hasServiceAccount: !!t.serviceAccountJsonSealed,
    lastTestedAt: t.lastTestedAt || null,
    quotaTotalBytes: Number(t.quotaTotalBytes) || 0,
    quotaUsedBytes: Number(t.quotaUsedBytes) || 0
  };
}

function hashTransferPassword(rawPass, salt) {
  return crypto.scryptSync(String(rawPass || ''), String(salt || 'cp-tr'), 32).toString('hex');
}

function resolveUserNotificationEmail(userObj) {
  if (!userObj) return '';
  if (userObj.notificationEmail && String(userObj.notificationEmail).includes('@')) {
    return String(userObj.notificationEmail).trim();
  }
  if (userObj.email && String(userObj.email).includes('@') && !String(userObj.email).endsWith('.local')) {
    return String(userObj.email).trim();
  }
  return '';
}

function canUserAccessTransfer(t, user, suppliedToken = '') {
  if (!t) return false;
  if (suppliedToken && t.shareToken && suppliedToken === t.shareToken) return true;
  if (!user) return false;
  if (t.senderId && t.senderId === user.id) return true;
  if (t.recipientId && t.recipientId === user.id) return true;
  if (t.recipientUsername && user.username && t.recipientUsername.toLowerCase() === user.username.toLowerCase()) return true;
  const userEmails = [user.email, user.notificationEmail]
    .filter(e => e && String(e).includes('@') && !String(e).endsWith('.local'))
    .map(e => String(e).toLowerCase());
  if (t.recipientEmail && userEmails.includes(String(t.recipientEmail).toLowerCase())) return true;
  return false;
}

function sanitizeTransferForViewer(t, includeSecretLink = true) {
  return {
    id: t.id,
    mode: t.mode || 'send',
    title: t.title || 'Envío cifrado',
    message: t.message || '',
    senderId: t.senderId || '',
    senderUserId: t.senderId || '',
    senderUsername: t.senderUsername || '',
    senderDisplayName: t.senderDisplayName || '',
    recipientId: t.recipientId || '',
    recipientUsername: t.recipientUsername || '',
    recipientEmail: t.recipientEmail || '',
    tenantId: t.tenantId || '',
    tenantName: t.tenantName || 'CYBERPOLIS Vault',
    requiresPassword: !!t.accessPasswordHash,
    hasPassword: !!t.accessPasswordHash,
    allowRecipientReply: t.allowRecipientReply !== false,
    allowRecipientUpload: t.allowRecipientUpload !== false,
    hasFile: !!(t.file && t.file.fileName),
    file: t.file ? {
      name: t.file.fileName,
      fileName: t.file.fileName,
      mimeType: t.file.mimeType,
      size: t.file.size,
      sha256: t.file.sha256,
      storageLocation: t.file.storageLocation || 'vault-local',
      oneDrivePath: t.file.oneDrivePath || ''
    } : null,
    responses: Array.isArray(t.responses) ? t.responses.map(r => ({
      id: r.id,
      authorName: r.authorName,
      authorEmail: r.authorEmail || '',
      text: r.text || '',
      hasFile: !!(r.file && r.file.fileName),
      file: r.file ? {
        name: r.file.fileName,
        fileName: r.file.fileName,
        mimeType: r.file.mimeType,
        size: r.file.size,
        sha256: r.file.sha256,
        storageLocation: r.file.storageLocation || 'vault-local'
      } : null,
      createdAt: r.createdAt,
      ip: r.ip || ''
    })) : [],
    emailNotifications: Array.isArray(t.emailNotifications) ? t.emailNotifications : [],
    events: Array.isArray(t.events) ? t.events : [],
    shareToken: includeSecretLink ? t.shareToken : undefined,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt
  };
}

async function storeEncryptedTransferFile(blobId, rawBuffer, fileName, mimeType, tenantCfg, keySalt) {
  const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
  const encryptedBuf = cloudOneDrive.encryptBinaryBuffer(rawBuffer, keySalt);
  const cleanName = sanitizeInput(String(fileName || 'archivo.bin').replace(/[/\\:*?"<>|]+/g, '_'), 120) || 'archivo.bin';
  const safeMime = sanitizeInput(String(mimeType || 'application/octet-stream'), 100) || 'application/octet-stream';

  let storageLocation = 'vault-local';
  let oneDrivePath = '';
  let oneDriveItemId = '';
  let oneDriveError = '';

  if (tenantCfg) {
    try {
      const isGoogle = tenantCfg.providerType === 'google-drive';
      const up = isGoogle
        ? await cloudGoogle.uploadBufferToGoogleDrive(tenantCfg, `transfers/${blobId}.enc`, encryptedBuf, 'application/octet-stream')
        : await cloudOneDrive.uploadBufferToOneDrive(tenantCfg, `transfers/${blobId}.enc`, encryptedBuf, 'application/octet-stream');
      storageLocation = isGoogle ? 'google-drive' : 'onedrive';
      oneDrivePath = up.remotePath;
      oneDriveItemId = up.itemId || '';
    } catch (err) {
      oneDriveError = err.message;
    }
  }

  if (storageLocation !== 'onedrive' && storageLocation !== 'google-drive') {
    if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
    fs.writeFileSync(path.join(VAULT_DIR, `${blobId}.enc`), encryptedBuf);
  }

  return {
    blobId,
    fileName: cleanName,
    mimeType: safeMime,
    size: rawBuffer.length,
    sha256,
    storageLocation,
    oneDrivePath,
    oneDriveItemId,
    oneDriveError: oneDriveError || undefined
  };
}

async function loadDecryptedTransferFile(fileMeta, tenantCfg, keySalt) {
  if (!fileMeta || !fileMeta.blobId) return null;
  let cipherBuf = null;
  if (fileMeta.storageLocation === 'google-drive' && fileMeta.oneDrivePath && tenantCfg) {
    cipherBuf = await cloudGoogle.downloadBufferFromGoogleDrive(tenantCfg, fileMeta.oneDrivePath).catch(() => null);
  } else if (fileMeta.storageLocation === 'onedrive' && fileMeta.oneDrivePath && tenantCfg) {
    cipherBuf = await cloudOneDrive.downloadBufferFromOneDrive(tenantCfg, fileMeta.oneDrivePath).catch(() => null);
  }
  if (!cipherBuf) {
    const localPath = path.join(VAULT_DIR, `${path.basename(fileMeta.blobId)}.enc`);
    if (fs.existsSync(localPath)) {
      cipherBuf = fs.readFileSync(localPath);
    }
  }
  if (!cipherBuf) return null;
  return cloudOneDrive.decryptBinaryBuffer(cipherBuf, keySalt);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '/';
  const method = req.method;
  const ip = extractClientIp(req);

  if (!applySameOriginCorsAndCheckCsrf(req, res, pathname, method)) {
    return;
  }

  try {
    // ----------------------------------------------------
    // API CONFIGURACIÓN Y ESTADO DEL SISTEMA
    // ----------------------------------------------------

    if (pathname === '/api/admin/config' && method === 'GET') {
      const config = readJSON(CONFIG_FILE, {});
      sendJSON(req, res, 200, {
        ...config,
        adBanner: sanitizeAdBannerConfig(config.adBanner),
        moderationPolicy: sanitizeModerationPolicy(config.moderationPolicy, DEFAULT_MODERATION_POLICY)
      });
      return;
    }

    if (pathname === '/api/admin/config' && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado: solo el Administrador puede modificar la configuración' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const currentConfig = readJSON(CONFIG_FILE, {});

      let validatedFeeds = currentConfig.feeds || [];
      if (Array.isArray(body.feeds)) {
        validatedFeeds = [];
        for (const f of body.feeds.slice(0, 20)) {
          if (!f || typeof f !== 'object') continue;
          const safeUrl = sanitizeExternalUrl(f.url);
          if (!safeUrl) {
            sendJSON(req, res, 400, { error: 'Una de las URLs de feed no es http/https válida.' }, {}, { noStore: true });
            return;
          }
          const check = await validateSafeExternalUrl(safeUrl, { skipDns: true });
          if (!check.ok) {
            sendJSON(req, res, 400, { error: `URL de feed bloqueada por seguridad: ${check.error}` }, {}, { noStore: true });
            return;
          }
          validatedFeeds.push({
            id: sanitizeInput(String(f.id || ('feed-' + Date.now())), 48),
            name: sanitizeInput(String(f.name || 'Fuente RSS'), 100),
            url: check.url,
            category: ['hacking', 'politica', 'tecnopolitica'].includes(f.category) ? f.category : 'hacking',
            language: 'es',
            enabled: f.enabled !== false
          });
        }
      }

      const updatedConfig = {
        ...currentConfig,
        autoSyncEnabled: body.autoSyncEnabled !== undefined ? !!body.autoSyncEnabled : currentConfig.autoSyncEnabled,
        syncIntervalMinutes: Math.max(5, Math.min(720, parseInt(body.syncIntervalMinutes, 10) || currentConfig.syncIntervalMinutes || 30)),
        themeAccent: sanitizeInput(body.themeAccent || currentConfig.themeAccent || 'cyan', 24),
        polygonDensity: sanitizeInput(body.polygonDensity || currentConfig.polygonDensity || 'paused', 24),
        portalTitle: sanitizeInput(body.portalTitle || currentConfig.portalTitle || 'CYBERPOLIS', 60),
        portalSubcallsign: body.portalSubcallsign !== undefined ? sanitizeInput(body.portalSubcallsign, 40) : (currentConfig.portalSubcallsign || ''),
        portalSubtitle: sanitizeInput(body.portalSubtitle || currentConfig.portalSubtitle || 'TU HACKNOTICIERO', 80),
        portalLogoUrl: body.portalLogoUrl !== undefined ? sanitizeLogoUrl(body.portalLogoUrl) : (currentConfig.portalLogoUrl || 'assets/silverbot-unix-logo.png'),
        contactEmail: body.contactEmail !== undefined ? sanitizeEmail(body.contactEmail) : (currentConfig.contactEmail || ''),
        layoutMode: sanitizeInput(body.layoutMode || currentConfig.layoutMode || 'editorial', 24),
        adBanner: body.adBanner !== undefined ? sanitizeAdBannerConfig(body.adBanner, currentConfig.adBanner) : sanitizeAdBannerConfig(currentConfig.adBanner),
        moderationPolicy: body.moderationPolicy !== undefined
          ? sanitizeModerationPolicy(body.moderationPolicy, currentConfig.moderationPolicy || DEFAULT_MODERATION_POLICY)
          : sanitizeModerationPolicy(currentConfig.moderationPolicy, DEFAULT_MODERATION_POLICY),
        feeds: validatedFeeds
      };

      writeJSON(CONFIG_FILE, updatedConfig, { critical: true });
      initBackgroundSync();

      sendJSON(req, res, 200, { success: true, message: 'Configuración y apariencia actualizadas', config: updatedConfig }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/feeds/sync' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede forzar la sincronización de feeds' }, {}, { noStore: true });
        return;
      }

      const result = await syncSpanishFeeds();
      await enrichStoredArticlesImages();
      sendJSON(req, res, 200, {
        success: true,
        message: `Sincronización completada. ${result.newArticlesAdded} nuevos despachos importados.`,
        newCount: result.newArticlesAdded,
        lastSync: result.lastSync
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/system-status' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const sessions = readJSON(SESSIONS_FILE, []);
      const now = Date.now();
      sendJSON(req, res, 200, {
        storage: store.getStatus(),
        security: {
          httpOnlyCookie: true,
          hashedSessionTokens: true,
          strictCsp: true,
          ssrfProtection: true,
          staticDataBlocked: true,
          bruteForceLockout: true,
          passwordUpdatedAt: currentUser.passwordUpdatedAt || null,
          recommendPasswordRotation: !currentUser.passwordUpdatedAt
        },
        activeSessionsCount: sessions.filter(s => s && s.expiresAt > now).length
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/backup/full' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede exportar una copia completa' }, {}, { noStore: true });
        return;
      }
      sendJSON(req, res, 200, store.exportFullSnapshot(), {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/backup/full' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede restaurar una copia completa' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req);
      if (!body || typeof body !== 'object') {
        sendJSON(req, res, 400, { error: 'Formato de respaldo inválido' }, {}, { noStore: true });
        return;
      }

      const restoredSections = [];
      if (body.config && typeof body.config === 'object') {
        const curCfg = readJSON(CONFIG_FILE, {});
        const nextCfg = {
          ...curCfg,
          ...body.config,
          portalTitle: sanitizeInput(body.config.portalTitle || curCfg.portalTitle || 'CYBERPOLIS', 60),
          portalSubcallsign: body.config.portalSubcallsign !== undefined ? sanitizeInput(body.config.portalSubcallsign, 40) : '',
          portalSubtitle: sanitizeInput(body.config.portalSubtitle || curCfg.portalSubtitle || 'TU HACKNOTICIERO', 80),
          portalLogoUrl: sanitizeLogoUrl(body.config.portalLogoUrl || curCfg.portalLogoUrl),
          contactEmail: body.config.contactEmail !== undefined ? sanitizeEmail(body.config.contactEmail) : '',
          adBanner: body.config.adBanner !== undefined ? sanitizeAdBannerConfig(body.config.adBanner, curCfg.adBanner) : sanitizeAdBannerConfig(curCfg.adBanner),
          moderationPolicy: body.config.moderationPolicy !== undefined
            ? sanitizeModerationPolicy(body.config.moderationPolicy, curCfg.moderationPolicy || DEFAULT_MODERATION_POLICY)
            : sanitizeModerationPolicy(curCfg.moderationPolicy, DEFAULT_MODERATION_POLICY)
        };
        writeJSON(CONFIG_FILE, nextCfg, { critical: true });
        restoredSections.push('config');
      }

      if (Array.isArray(body.users) && body.users.length > 0) {
        const cleanUsers = body.users
          .filter(u => u && typeof u.username === 'string' && typeof u.salt === 'string' && typeof u.hash === 'string')
          .map(u => ({
            id: sanitizeInput(u.id || ('usr-' + Date.now()), 64),
            username: sanitizeInput(u.username.toLowerCase(), 24),
            displayName: sanitizeInput(u.displayName || u.username, 64),
            email: sanitizeEmail(u.email || '') || `${sanitizeInput(u.username.toLowerCase(), 24)}@cyberpolis.local`,
            notificationEmail: sanitizeEmail(u.notificationEmail || ''),
            role: u.role === 'admin' ? 'admin' : 'analyst',
            status: u.status === 'suspended' ? 'suspended' : 'active',
            linkedInProfile: sanitizeExternalUrl(u.linkedInProfile || ''),
            avatar: sanitizeImageUrl(u.avatar || '', 'assets/silverbot-unix-logo.png'),
            tokens: Math.max(0, Number(u.tokens) || 0),
            approvedPosts: Math.max(0, Number(u.approvedPosts) || 0),
            trustedPublisher: !!u.trustedPublisher,
            registrationIp: sanitizeInput(u.registrationIp || '', 64),
            lastLoginIp: sanitizeInput(u.lastLoginIp || '', 64),
            legalAcceptedAt: u.legalAcceptedAt || null,
            salt: u.salt,
            hash: u.hash,
            passwordUpdatedAt: u.passwordUpdatedAt || null,
            lastLoginAt: u.lastLoginAt || null,
            createdAt: u.createdAt || new Date().toISOString()
          }));
        if (cleanUsers.length > 0) {
          writeJSON(USERS_FILE, cleanUsers, { critical: true });
          restoredSections.push('users');
        }
      }

      if (Array.isArray(body.articles)) {
        const cleanArticles = body.articles.slice(0, 100).map(a => sanitizeArticleRecord(a, currentUser));
        writeJSON(ARTICLES_FILE, cleanArticles, { critical: true });
        restoredSections.push('articles');
      }

      if (Array.isArray(body.forum)) {
        const cleanForum = body.forum.slice(0, 200).map(t => ({
          id: sanitizeInput(t.id || ('frm-' + Date.now()), 64),
          title: sanitizeInput(t.title || 'Debate', 160),
          category: sanitizeInput(t.category || 'General', 40),
          prefix: ['Debate', 'Tutorial', 'Noticia', 'Consulta', 'Off-Topic'].includes(t.prefix) ? t.prefix : 'Debate',
          body: sanitizeInput(t.body || '', 4000),
          author: sanitizeInput(t.author || 'Usuario', 64),
          authorId: sanitizeInput(t.authorId || '', 64),
          authorRole: t.authorRole === 'admin' ? 'admin' : 'analyst',
          pinned: !!t.pinned,
          locked: !!t.locked,
          views: Math.max(1, Number(t.views) || 1),
          likedBy: Array.isArray(t.likedBy) ? t.likedBy.slice(0, 200).map(x => sanitizeInput(String(x), 64)) : [],
          likes: Array.isArray(t.likedBy) ? t.likedBy.length : (Number(t.likes) || 0),
          createdAt: t.createdAt || new Date().toISOString(),
          lastActivityAt: t.lastActivityAt || t.createdAt || new Date().toISOString(),
          replies: Array.isArray(t.replies) ? t.replies.slice(0, 200).map(r => ({
            id: sanitizeInput(r.id || ('rep-' + Date.now()), 64),
            text: sanitizeInput(r.text || '', 2500),
            author: sanitizeInput(r.author || 'Usuario', 64),
            authorId: sanitizeInput(r.authorId || '', 64),
            authorRole: r.authorRole === 'admin' ? 'admin' : 'analyst',
            likedBy: Array.isArray(r.likedBy) ? r.likedBy.slice(0, 200).map(x => sanitizeInput(String(x), 64)) : [],
            likes: Array.isArray(r.likedBy) ? r.likedBy.length : (Number(r.likes) || 0),
            createdAt: r.createdAt || new Date().toISOString()
          })) : []
        }));
        writeJSON(FORUM_FILE, cleanForum, { critical: true });
        restoredSections.push('forum');
      }

      if (body.chat && typeof body.chat === 'object') {
        writeChatState(body.chat);
        restoredSections.push('chat');
      }

      if (Array.isArray(body.transfers)) {
        writeJSON(TRANSFERS_FILE, body.transfers.slice(0, 500), { critical: true });
        restoredSections.push('transfers');
      }

      if (body.analytics && typeof body.analytics === 'object') {
        const cleanAnalytics = {
          totalViews: Math.max(0, parseInt(body.analytics.totalViews, 10) || 0),
          dailyStats: (body.analytics.dailyStats && typeof body.analytics.dailyStats === 'object') ? body.analytics.dailyStats : {},
          visitors: Array.isArray(body.analytics.visitors) ? body.analytics.visitors.slice(0, 250) : []
        };
        writeJSON(ANALYTICS_FILE, cleanAnalytics, { critical: true });
        restoredSections.push('analytics');
      }

      if (Array.isArray(body.audit)) {
        writeJSON(AUDIT_FILE, body.audit.slice(0, 1000), { critical: true });
        restoredSections.push('audit');
      }

      await store.flush();
      sendJSON(req, res, 200, {
        success: true,
        message: `Respaldo restaurado (${restoredSections.join(', ')})`,
        sections: restoredSections
      }, {}, { noStore: true });
      return;
    }

    // ----------------------------------------------------
    // API AUTENTICACIÓN Y SESIONES (Cookies HttpOnly + SHA-256)
    // ----------------------------------------------------

    if (pathname === '/api/auth/login' && method === 'POST') {
      if (!checkRateLimit(`login:${ip}`, 8, 5 * 60000)) {
        sendJSON(req, res, 429, { error: 'Demasiados intentos desde esta IP. Espera unos minutos por seguridad.' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');

      if (!username || !password) {
        sendJSON(req, res, 400, { error: 'Usuario y contraseña requeridos' }, {}, { noStore: true });
        return;
      }

      const usernameKey = username.toLowerCase();
      const lockState = getAccountLockStatus(usernameKey);
      if (lockState.locked) {
        sendJSON(req, res, 429, {
          error: `Cuenta bloqueada temporalmente por múltiples intentos fallidos. Espera ${Math.ceil(lockState.remainingSec / 60)} min.`
        }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      const user = users.find(u => u.username.toLowerCase() === usernameKey);

      const passwordOk = user
        ? verifyPassword(password, user.salt, user.hash)
        : (verifyPassword(password, DUMMY_SALT, DUMMY_HASH), false);

      if (!user || !passwordOk) {
        recordFailedLogin(usernameKey);
        sendJSON(req, res, 401, { error: 'Credenciales inválidas' }, {}, { noStore: true });
        return;
      }

      if (user.status === 'suspended') {
        sendJSON(req, res, 403, { error: 'Tu cuenta está suspendida por un administrador.' }, {}, { noStore: true });
        return;
      }

      clearFailedLogin(usernameKey);
      user.lastLoginAt = new Date().toISOString();
      user.lastLoginIp = sanitizeInput(ip || '', 64);
      writeJSON(USERS_FILE, users, { critical: true });

      const token = generateSecureToken();
      const sessions = pruneAndSaveSessions(readJSON(SESSIONS_FILE, []));
      sessions.push(createSessionRecord(token, user.id, ip));
      writeJSON(SESSIONS_FILE, sessions, { critical: true });

      recordLegalAudit({
        action: 'user_login',
        targetType: 'user',
        targetId: user.id,
        summary: `Inicio de sesión de @${user.username}`,
        currentUser: user,
        ip,
        req
      });

      const { salt, hash, registrationIp, lastLoginIp, registrationUa, ...safeUser } = user;
      sendJSON(
        req,
        res,
        200,
        {
          success: true,
          user: {
            ...safeUser,
            tokens: Math.max(0, Number(user.tokens) || 0),
            approvedPosts: Math.max(0, Number(user.approvedPosts) || 0),
            trustedPublisher: !!user.trustedPublisher
          }
        },
        { 'Set-Cookie': buildSessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)) },
        { noStore: true }
      );
      return;
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!checkRateLimit(`register:${ip}`, 5, 15 * 60000)) {
        sendJSON(req, res, 429, { error: 'Límite de registros alcanzado temporalmente.' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const { username, password, displayName, email, linkedInProfile } = body;

      if (!username || !password || !displayName) {
        sendJSON(req, res, 400, { error: 'Usuario, nombre y contraseña son requeridos' }, {}, { noStore: true });
        return;
      }

      const cleanUser = String(username).trim().toLowerCase();
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(cleanUser)) {
        sendJSON(req, res, 400, { error: 'El usuario debe tener entre 3 y 24 caracteres alfanuméricos o _' }, {}, { noStore: true });
        return;
      }

      const strength = validatePasswordStrength(String(password));
      if (!strength.ok) {
        sendJSON(req, res, 400, { error: strength.error }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      if (users.some(u => u.username.toLowerCase() === cleanUser)) {
        sendJSON(req, res, 409, { error: 'Este usuario ya está registrado' }, {}, { noStore: true });
        return;
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const isFirst = users.length === 0;
      const nowIso = new Date().toISOString();

      const newUser = {
        id: 'usr-' + Date.now(),
        username: cleanUser,
        displayName: sanitizeInput(displayName, 64) || cleanUser,
        email: sanitizeEmail(email || '') || `${cleanUser}@cyberpolis.local`,
        role: isFirst ? 'admin' : 'analyst',
        status: 'active',
        linkedInProfile: sanitizeExternalUrl(linkedInProfile || ''),
        avatar: 'assets/silverbot-unix-logo.png',
        tokens: 0,
        approvedPosts: 0,
        trustedPublisher: isFirst,
        registrationIp: sanitizeInput(ip || '', 64),
        lastLoginIp: sanitizeInput(ip || '', 64),
        registrationUa: sanitizeInput((req.headers && req.headers['user-agent']) || '', 240),
        legalAcceptedAt: nowIso,
        salt,
        hash,
        passwordUpdatedAt: nowIso,
        lastLoginAt: nowIso,
        createdAt: nowIso
      };

      users.push(newUser);
      writeJSON(USERS_FILE, users, { critical: true });

      const token = generateSecureToken();
      const sessions = pruneAndSaveSessions(readJSON(SESSIONS_FILE, []));
      sessions.push(createSessionRecord(token, newUser.id, ip));
      writeJSON(SESSIONS_FILE, sessions, { critical: true });

      recordLegalAudit({
        action: 'user_register',
        targetType: 'user',
        targetId: newUser.id,
        summary: `Registro de cuenta @${newUser.username} (rol: ${newUser.role})`,
        currentUser: newUser,
        ip,
        req
      });

      const { salt: _s, hash: _h, registrationIp: _ri, lastLoginIp: _li, registrationUa: _ru, ...safeUser } = newUser;
      sendJSON(
        req,
        res,
        201,
        { success: true, user: safeUser },
        { 'Set-Cookie': buildSessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)) },
        { noStore: true }
      );
      return;
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = extractAuthTokenFromRequest(req);
      if (token) {
        const tokenHash = hashSessionToken(token);
        let sessions = readJSON(SESSIONS_FILE, []);
        sessions = sessions.filter(s => s && s.tokenHash !== tokenHash && s.token !== token);
        writeJSON(SESSIONS_FILE, sessions, { critical: true });
      }
      sendJSON(
        req,
        res,
        200,
        { success: true, message: 'Sesión cerrada' },
        { 'Set-Cookie': buildSessionCookie(req, '', 0) },
        { noStore: true }
      );
      return;
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'No autenticado' }, {}, { noStore: true });
        return;
      }
      sendJSON(req, res, 200, { user: currentUser }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/auth/change-password' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para cambiar tu contraseña' }, {}, { noStore: true });
        return;
      }
      if (!checkRateLimit(`chpass:${currentUser.id}`, 6, 15 * 60000)) {
        sendJSON(req, res, 429, { error: 'Demasiados intentos de cambio de contraseña.' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');

      if (!currentPassword || !newPassword) {
        sendJSON(req, res, 400, { error: 'Debes indicar la contraseña actual y la nueva.' }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      const idx = users.findIndex(u => u.id === currentUser.id);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Usuario no encontrado' }, {}, { noStore: true });
        return;
      }

      if (!verifyPassword(currentPassword, users[idx].salt, users[idx].hash)) {
        sendJSON(req, res, 401, { error: 'La contraseña actual no es correcta' }, {}, { noStore: true });
        return;
      }

      if (currentPassword === newPassword) {
        sendJSON(req, res, 400, { error: 'La nueva contraseña debe ser distinta a la actual.' }, {}, { noStore: true });
        return;
      }

      const strength = validatePasswordStrength(newPassword);
      if (!strength.ok) {
        sendJSON(req, res, 400, { error: strength.error }, {}, { noStore: true });
        return;
      }

      const newSalt = crypto.randomBytes(16).toString('hex');
      users[idx].salt = newSalt;
      users[idx].hash = hashPassword(newPassword, newSalt);
      users[idx].passwordUpdatedAt = new Date().toISOString();
      users[idx].updatedAt = users[idx].passwordUpdatedAt;
      writeJSON(USERS_FILE, users, { critical: true });

      // Revocar todas las demás sesiones del usuario manteniendo la actual
      const currentHash = hashSessionToken(extractAuthTokenFromRequest(req));
      let sessions = readJSON(SESSIONS_FILE, []);
      sessions = sessions.filter(s => s && (s.userId !== currentUser.id || s.tokenHash === currentHash));
      writeJSON(SESSIONS_FILE, sessions, { critical: true });

      const { salt: _s, hash: _h, ...safeUser } = users[idx];
      sendJSON(req, res, 200, {
        success: true,
        message: 'Contraseña actualizada correctamente. Las demás sesiones han sido cerradas.',
        user: safeUser
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/users' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para ver el directorio de analistas' }, {}, { noStore: true });
        return;
      }
      const users = readJSON(USERS_FILE, []);
      const safeList = users
        .filter(u => u.status !== 'suspended')
        .map(u => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          role: u.role,
          linkedInProfile: sanitizeExternalUrl(u.linkedInProfile || ''),
          avatar: sanitizeImageUrl(u.avatar || '', 'assets/silverbot-unix-logo.png'),
          createdAt: u.createdAt
        }));
      sendJSON(req, res, 200, safeList, {}, { noStore: true });
      return;
    }

    // ----------------------------------------------------
    // API ANALÍTICA DE VISITAS Y MÉTRICAS
    // ----------------------------------------------------

    if (pathname === '/api/analytics/visit' && method === 'POST') {
      if (checkRateLimit(`visit:${ip}`, 45, 60000)) {
        const body = await parseBody(req).catch(() => ({}));
        recordVisitEvent(req, {
          page: body.page || '/',
          articleTitle: body.articleTitle || '',
          referrer: body.referrer || ''
        });
      }
      sendJSON(req, res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/admin/analytics' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado: solo el Administrador puede ver las métricas' }, {}, { noStore: true });
        return;
      }
      sendJSON(req, res, 200, buildAnalyticsDashboard(), {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/analytics' && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      writeJSON(ANALYTICS_FILE, { totalViews: 0, dailyStats: {}, visitors: [] }, { critical: true });
      sendJSON(req, res, 200, { success: true, message: 'Historial de métricas reiniciado' }, {}, { noStore: true });
      return;
    }

    // ----------------------------------------------------
    // API GESTIÓN DE USUARIOS (SOLO ADMIN)
    // ----------------------------------------------------

    if (pathname === '/api/admin/users' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado: solo el Administrador puede gestionar usuarios' }, {}, { noStore: true });
        return;
      }
      const users = readJSON(USERS_FILE, []);
      const sessions = readJSON(SESSIONS_FILE, []);
      const articles = readJSON(ARTICLES_FILE, []);
      const forumThreads = readJSON(FORUM_FILE, []);
      const now = Date.now();

      const policy = getModerationPolicy();
      const adminList = users.map(u => {
        const trust = evaluateUserPublishTrust(u, policy, articles, forumThreads);
        return {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          email: u.email || '',
          notificationEmail: u.notificationEmail || (u.email && !String(u.email).endsWith('.local') ? u.email : ''),
          role: u.role || 'analyst',
          status: u.status || 'active',
          tokens: trust.tokens,
          approvedPosts: trust.approvedPosts,
          accountAgeDays: trust.accountAgeDays,
          trustedPublisher: trust.trustedPublisher,
          autoPublishEligible: trust.autoApprove,
          registrationIp: u.registrationIp || '',
          lastLoginIp: u.lastLoginIp || '',
          legalAcceptedAt: u.legalAcceptedAt || null,
          createdAt: u.createdAt || u.updatedAt || null,
          lastLoginAt: u.lastLoginAt || null,
          passwordUpdatedAt: u.passwordUpdatedAt || null,
          articlesCount: articles.filter(a => a.authorId === u.id).length,
          forumThreadsCount: forumThreads.filter(t => t.authorId === u.id).length,
          activeSessions: sessions.filter(s => s && s.userId === u.id && s.expiresAt > now).length
        };
      });
      sendJSON(req, res, 200, adminList, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/users' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req);
      const cleanUser = String(body.username || '').trim().toLowerCase();
      const displayName = sanitizeInput(body.displayName || cleanUser, 64);
      const email = sanitizeEmail(body.email || '');
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'analyst';

      if (!/^[a-zA-Z0-9_]{3,24}$/.test(cleanUser)) {
        sendJSON(req, res, 400, { error: 'El usuario debe tener entre 3 y 24 caracteres alfanuméricos o _' }, {}, { noStore: true });
        return;
      }
      const strength = validatePasswordStrength(password);
      if (!strength.ok) {
        sendJSON(req, res, 400, { error: strength.error }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      if (users.some(u => u.username.toLowerCase() === cleanUser)) {
        sendJSON(req, res, 409, { error: 'Ya existe un usuario con ese nombre' }, {}, { noStore: true });
        return;
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const nowIso = new Date().toISOString();
      const newUser = {
        id: 'usr-' + Date.now(),
        username: cleanUser,
        displayName: displayName || cleanUser,
        email: email || `${cleanUser}@cyberpolis.local`,
        role,
        status: 'active',
        linkedInProfile: '',
        avatar: 'assets/silverbot-unix-logo.png',
        tokens: 0,
        approvedPosts: 0,
        trustedPublisher: role === 'admin',
        registrationIp: sanitizeInput(ip || '', 64),
        lastLoginIp: '',
        legalAcceptedAt: nowIso,
        salt,
        hash,
        passwordUpdatedAt: nowIso,
        createdAt: nowIso
      };
      users.push(newUser);
      writeJSON(USERS_FILE, users, { critical: true });

      const { salt: _s, hash: _h, registrationIp: _ri, lastLoginIp: _li, registrationUa: _ru, ...safeUser } = newUser;
      sendJSON(req, res, 201, { success: true, user: safeUser }, {}, { noStore: true });
      return;
    }

    if (/^\/api\/admin\/users\/[^/]+\/trust$/.test(pathname) && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const userId = decodeURIComponent(pathname.split('/')[4]);
      const body = await parseBody(req).catch(() => ({}));
      const users = readJSON(USERS_FILE, []);
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Usuario no encontrado' }, {}, { noStore: true });
        return;
      }

      const prevTokens = Math.max(0, Number(users[idx].tokens) || 0);
      if (body.setTokens !== undefined) {
        users[idx].tokens = Math.max(0, Math.min(100000, parseInt(body.setTokens, 10) || 0));
      } else if (body.deltaTokens !== undefined) {
        const delta = parseInt(body.deltaTokens, 10) || 0;
        users[idx].tokens = Math.max(0, Math.min(100000, prevTokens + delta));
      } else {
        users[idx].tokens = prevTokens;
      }

      if (body.trustedPublisher !== undefined) {
        users[idx].trustedPublisher = !!body.trustedPublisher;
      }
      if (body.notificationEmail !== undefined) {
        users[idx].notificationEmail = sanitizeEmail(body.notificationEmail || '');
      }
      users[idx].updatedAt = new Date().toISOString();
      writeJSON(USERS_FILE, users, { critical: true });

      const policy = getModerationPolicy();
      const trust = evaluateUserPublishTrust(users[idx], policy);

      recordLegalAudit({
        action: 'update_user_trust',
        targetType: 'user',
        targetId: users[idx].id,
        summary: `Confianza actualizada para @${users[idx].username}: tokens=${trust.tokens}, trusted=${trust.trustedPublisher}`,
        currentUser,
        ip,
        req
      });

      sendJSON(req, res, 200, {
        success: true,
        message: `Confianza de @${users[idx].username} actualizada (${trust.tokens} tokens${trust.trustedPublisher ? ', publicador verificado' : ''})`,
        user: {
          id: users[idx].id,
          username: users[idx].username,
          tokens: trust.tokens,
          approvedPosts: trust.approvedPosts,
          accountAgeDays: trust.accountAgeDays,
          trustedPublisher: trust.trustedPublisher,
          autoPublishEligible: trust.autoApprove
        }
      }, {}, { noStore: true });
      return;
    }

    if (/^\/api\/admin\/users\/[^/]+\/reset-password$/.test(pathname) && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const userId = decodeURIComponent(pathname.split('/')[4]);
      const body = await parseBody(req).catch(() => ({}));
      const requestedPass = String(body.newPassword || '').trim();
      const finalPassword = requestedPass || ('Cyp!' + crypto.randomBytes(6).toString('hex') + '9a');

      const strength = validatePasswordStrength(finalPassword);
      if (!strength.ok) {
        sendJSON(req, res, 400, { error: strength.error }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Usuario no encontrado' }, {}, { noStore: true });
        return;
      }

      const newSalt = crypto.randomBytes(16).toString('hex');
      users[idx].salt = newSalt;
      users[idx].hash = hashPassword(finalPassword, newSalt);
      users[idx].passwordUpdatedAt = new Date().toISOString();
      users[idx].updatedAt = users[idx].passwordUpdatedAt;
      writeJSON(USERS_FILE, users, { critical: true });

      const currentTokenHash = hashSessionToken(extractAuthTokenFromRequest(req));
      let sessions = readJSON(SESSIONS_FILE, []);
      sessions = sessions.filter(s => s && (s.userId !== userId || s.tokenHash === currentTokenHash));
      writeJSON(SESSIONS_FILE, sessions, { critical: true });

      sendJSON(req, res, 200, {
        success: true,
        message: `Contraseña restablecida para ${users[idx].username}`,
        tempPassword: finalPassword
      }, {}, { noStore: true });
      return;
    }

    if (/^\/api\/admin\/users\/[^/]+\/role$/.test(pathname) && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const userId = decodeURIComponent(pathname.split('/')[4]);
      const body = await parseBody(req).catch(() => ({}));
      const newRole = body.role === 'admin' ? 'admin' : 'analyst';

      if (userId === currentUser.id && newRole !== 'admin') {
        sendJSON(req, res, 400, { error: 'No puedes quitarte a ti mismo el rol de Administrador' }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Usuario no encontrado' }, {}, { noStore: true });
        return;
      }
      users[idx].role = newRole;
      users[idx].updatedAt = new Date().toISOString();
      writeJSON(USERS_FILE, users, { critical: true });
      sendJSON(req, res, 200, { success: true, role: newRole }, {}, { noStore: true });
      return;
    }

    if (/^\/api\/admin\/users\/[^/]+\/status$/.test(pathname) && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const userId = decodeURIComponent(pathname.split('/')[4]);
      const body = await parseBody(req).catch(() => ({}));
      const newStatus = body.status === 'suspended' ? 'suspended' : 'active';

      if (userId === currentUser.id && newStatus === 'suspended') {
        sendJSON(req, res, 400, { error: 'No puedes suspender tu propia cuenta de Administrador' }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Usuario no encontrado' }, {}, { noStore: true });
        return;
      }
      users[idx].status = newStatus;
      users[idx].updatedAt = new Date().toISOString();
      writeJSON(USERS_FILE, users, { critical: true });

      if (newStatus === 'suspended') {
        let sessions = readJSON(SESSIONS_FILE, []);
        sessions = sessions.filter(s => s && s.userId !== userId);
        writeJSON(SESSIONS_FILE, sessions, { critical: true });
      }

      sendJSON(req, res, 200, { success: true, status: newStatus }, {}, { noStore: true });
      return;
    }

    if (/^\/api\/admin\/users\/[^/]+$/.test(pathname) && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const userId = decodeURIComponent(pathname.split('/')[4]);
      if (userId === currentUser.id) {
        sendJSON(req, res, 400, { error: 'No puedes eliminar tu propia cuenta activa' }, {}, { noStore: true });
        return;
      }

      const users = readJSON(USERS_FILE, []);
      if (!users.some(u => u.id === userId)) {
        sendJSON(req, res, 404, { error: 'Usuario no encontrado' }, {}, { noStore: true });
        return;
      }
      writeJSON(USERS_FILE, users.filter(u => u.id !== userId), { critical: true });

      let sessions = readJSON(SESSIONS_FILE, []);
      sessions = sessions.filter(s => s && s.userId !== userId);
      writeJSON(SESSIONS_FILE, sessions, { critical: true });

      sendJSON(req, res, 200, { success: true }, {}, { noStore: true });
      return;
    }

    // ----------------------------------------------------
    // API MODERACIÓN, TOKENS DE CONFIANZA Y TRAZABILIDAD LEGAL
    // ----------------------------------------------------

    if (pathname === '/api/admin/moderation' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado: solo el Administrador puede acceder a la cola de moderación' }, {}, { noStore: true });
        return;
      }

      const policy = getModerationPolicy();
      const users = readJSON(USERS_FILE, []);
      const userMap = new Map(users.map(u => [u.id, u]));
      const articles = readJSON(ARTICLES_FILE, []);
      const forumThreads = readJSON(FORUM_FILE, []);
      const auditLog = Array.isArray(readJSON(AUDIT_FILE, [])) ? readJSON(AUDIT_FILE, []) : [];

      const buildAuthorSnapshot = (authorId) => {
        const u = authorId ? userMap.get(authorId) : null;
        if (!u) return { username: 'desconocido', tokens: 0, approvedPosts: 0, accountAgeDays: 0, trustedPublisher: false, autoPublishEligible: false };
        const t = evaluateUserPublishTrust(u, policy, articles, forumThreads);
        return {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          role: u.role,
          tokens: t.tokens,
          approvedPosts: t.approvedPosts,
          accountAgeDays: t.accountAgeDays,
          trustedPublisher: t.trustedPublisher,
          autoPublishEligible: t.autoApprove
        };
      };

      const pendingArticles = articles
        .filter(a => a && a.moderationStatus === 'pending')
        .map(a => ({
          targetType: 'article',
          id: a.id,
          title: a.title,
          category: a.category,
          summary: a.summary,
          contentPreview: String(a.content || '').slice(0, 600),
          sourceName: a.sourceName,
          sourceUrl: a.sourceUrl,
          author: a.author,
          authorId: a.authorId,
          createdAt: a.date,
          moderationStatus: a.moderationStatus,
          legalTrace: a.legalTrace || null,
          authorTrust: buildAuthorSnapshot(a.authorId)
        }));

      const pendingThreads = forumThreads
        .filter(t => t && t.moderationStatus === 'pending')
        .map(t => ({
          targetType: 'thread',
          id: t.id,
          title: t.title,
          category: t.category,
          prefix: t.prefix || 'Debate',
          contentPreview: String(t.body || '').slice(0, 600),
          author: t.author,
          authorId: t.authorId,
          createdAt: t.createdAt,
          moderationStatus: t.moderationStatus,
          legalTrace: t.legalTrace || null,
          authorTrust: buildAuthorSnapshot(t.authorId)
        }));

      const pendingReplies = [];
      for (const t of forumThreads) {
        if (!t || !Array.isArray(t.replies)) continue;
        for (const r of t.replies) {
          if (r && r.moderationStatus === 'pending') {
            pendingReplies.push({
              targetType: 'reply',
              id: t.id,
              replyId: r.id,
              threadTitle: t.title,
              category: t.category,
              contentPreview: String(r.text || '').slice(0, 600),
              author: r.author,
              authorId: r.authorId,
              createdAt: r.createdAt,
              moderationStatus: r.moderationStatus,
              legalTrace: r.legalTrace || null,
              authorTrust: buildAuthorSnapshot(r.authorId)
            });
          }
        }
      }

      sendJSON(req, res, 200, {
        policy,
        counts: {
          articles: pendingArticles.length,
          threads: pendingThreads.length,
          replies: pendingReplies.length,
          total: pendingArticles.length + pendingThreads.length + pendingReplies.length
        },
        pendingArticles,
        pendingThreads,
        pendingReplies,
        auditLog: auditLog.slice(0, 100)
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/moderation/policy' && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req);
      const currentConfig = readJSON(CONFIG_FILE, {});
      const nextPolicy = sanitizeModerationPolicy(body, currentConfig.moderationPolicy || DEFAULT_MODERATION_POLICY);
      const updatedConfig = {
        ...currentConfig,
        moderationPolicy: nextPolicy
      };
      writeJSON(CONFIG_FILE, updatedConfig, { critical: true });

      recordLegalAudit({
        action: 'update_moderation_policy',
        targetType: 'config',
        targetId: 'moderationPolicy',
        summary: `Política actualizada: mod=${nextPolicy.requireModeration}, días>=${nextPolicy.minAccountAgeDays}, tokens>=${nextPolicy.minTrustTokens}, posts>=${nextPolicy.minApprovedPosts}`,
        currentUser,
        ip,
        req
      });

      sendJSON(req, res, 200, {
        success: true,
        message: 'Política de moderación y tokens guardada',
        policy: nextPolicy
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/moderation/decision' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado: solo administradores pueden moderar publicaciones' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const targetType = String(body.targetType || '').toLowerCase();
      const targetId = String(body.id || '');
      const replyId = String(body.replyId || '');
      const decision = String(body.decision || '').toLowerCase();
      const reason = sanitizeInput(body.reason || '', 240);

      if (!['article', 'thread', 'reply'].includes(targetType) || !targetId || !['approve', 'reject'].includes(decision)) {
        sendJSON(req, res, 400, { error: 'Parámetros de moderación inválidos' }, {}, { noStore: true });
        return;
      }

      const policy = getModerationPolicy();
      const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
      const nowIso = new Date().toISOString();
      let awardedUser = null;
      let tokenDelta = 0;
      let itemSummary = '';
      let contentHash = '';
      let itemAuthorId = '';

      if (targetType === 'article') {
        const articles = readJSON(ARTICLES_FILE, []);
        const idx = articles.findIndex(a => a && a.id === targetId);
        if (idx === -1) {
          sendJSON(req, res, 404, { error: 'Noticia no encontrada' }, {}, { noStore: true });
          return;
        }
        const prevStatus = articles[idx].moderationStatus || 'approved';
        articles[idx].moderationStatus = nextStatus;
        articles[idx].moderatedBy = currentUser.displayName;
        articles[idx].moderatedById = currentUser.id;
        articles[idx].moderatedAt = nowIso;
        articles[idx].moderationReason = reason;
        itemSummary = articles[idx].title || targetId;
        itemAuthorId = articles[idx].authorId || '';
        contentHash = (articles[idx].legalTrace && articles[idx].legalTrace.contentHash) || '';
        writeJSON(ARTICLES_FILE, articles, { critical: true });

        if (prevStatus !== 'approved' && nextStatus === 'approved' && itemAuthorId) {
          tokenDelta = policy.tokensPerApprovedArticle;
          awardedUser = awardTokensToUser(itemAuthorId, tokenDelta, true);
        }
      } else {
        const threads = readJSON(FORUM_FILE, []);
        const tIdx = threads.findIndex(t => t && t.id === targetId);
        if (tIdx === -1) {
          sendJSON(req, res, 404, { error: 'Tema del foro no encontrado' }, {}, { noStore: true });
          return;
        }
        if (targetType === 'thread') {
          const prevStatus = threads[tIdx].moderationStatus || 'approved';
          threads[tIdx].moderationStatus = nextStatus;
          threads[tIdx].moderatedBy = currentUser.displayName;
          threads[tIdx].moderatedById = currentUser.id;
          threads[tIdx].moderatedAt = nowIso;
          threads[tIdx].moderationReason = reason;
          itemSummary = threads[tIdx].title || targetId;
          itemAuthorId = threads[tIdx].authorId || '';
          contentHash = (threads[tIdx].legalTrace && threads[tIdx].legalTrace.contentHash) || '';
          writeJSON(FORUM_FILE, threads, { critical: true });

          if (prevStatus !== 'approved' && nextStatus === 'approved' && itemAuthorId) {
            tokenDelta = policy.tokensPerApprovedThread;
            awardedUser = awardTokensToUser(itemAuthorId, tokenDelta, true);
          }
        } else {
          if (!Array.isArray(threads[tIdx].replies)) threads[tIdx].replies = [];
          const rIdx = threads[tIdx].replies.findIndex(r => r && r.id === replyId);
          if (rIdx === -1) {
            sendJSON(req, res, 404, { error: 'Respuesta del foro no encontrada' }, {}, { noStore: true });
            return;
          }
          const prevStatus = threads[tIdx].replies[rIdx].moderationStatus || 'approved';
          threads[tIdx].replies[rIdx].moderationStatus = nextStatus;
          threads[tIdx].replies[rIdx].moderatedBy = currentUser.displayName;
          threads[tIdx].replies[rIdx].moderatedById = currentUser.id;
          threads[tIdx].replies[rIdx].moderatedAt = nowIso;
          threads[tIdx].replies[rIdx].moderationReason = reason;
          itemSummary = `${threads[tIdx].title} // ${(threads[tIdx].replies[rIdx].text || '').slice(0, 80)}`;
          itemAuthorId = threads[tIdx].replies[rIdx].authorId || '';
          contentHash = (threads[tIdx].replies[rIdx].legalTrace && threads[tIdx].replies[rIdx].legalTrace.contentHash) || '';
          writeJSON(FORUM_FILE, threads, { critical: true });

          if (prevStatus !== 'approved' && nextStatus === 'approved' && itemAuthorId) {
            tokenDelta = policy.tokensPerApprovedReply;
            awardedUser = awardTokensToUser(itemAuthorId, tokenDelta, true);
          }
        }
      }

      recordLegalAudit({
        action: decision === 'approve' ? 'approve_content' : 'reject_content',
        targetType,
        targetId: replyId ? `${targetId}/${replyId}` : targetId,
        summary: `${decision === 'approve' ? 'APROBADO' : 'RECHAZADO'}: ${itemSummary}${tokenDelta ? ` (+${tokenDelta} tokens)` : ''}`,
        currentUser,
        ip,
        req,
        contentHash,
        moderationStatus: nextStatus,
        meta: { authorId: itemAuthorId, tokenDelta, reason }
      });

      sendJSON(req, res, 200, {
        success: true,
        decision: nextStatus,
        tokenDelta,
        awardedUser,
        message: decision === 'approve'
          ? `Publicación aprobada${tokenDelta > 0 && awardedUser ? ` (+${tokenDelta} tokens a @${awardedUser.username})` : ''}`
          : 'Publicación rechazada y ocultada del portal'
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/audit-log' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso denegado' }, {}, { noStore: true });
        return;
      }
      const auditLog = Array.isArray(readJSON(AUDIT_FILE, [])) ? readJSON(AUDIT_FILE, []) : [];
      sendJSON(req, res, 200, auditLog.slice(0, 300), {}, { noStore: true });
      return;
    }

    // ----------------------------------------------------
    // API INGESTIÓN LINKEDIN
    // ----------------------------------------------------

    if (pathname === '/api/linkedin/sync' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para importar de LinkedIn' }, {}, { noStore: true });
        return;
      }
      if (!checkRateLimit(`write:${ip}`, 30, 60000)) {
        sendJSON(req, res, 429, { error: 'Límite temporal de publicaciones alcanzado.' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const { rawUrl, postText, customTitle, categoryHint } = body;

      if (!rawUrl && !postText) {
        sendJSON(req, res, 400, { error: 'URL o texto requeridos' });
        return;
      }

      const cleanUrl = sanitizeExternalUrl(rawUrl || currentUser.linkedInProfile || 'https://www.linkedin.com') || 'https://www.linkedin.com';
      const content = sanitizeInput(postText || 'Despacho de inteligencia extraído de LinkedIn.', 12000);

      let title = customTitle ? sanitizeInput(customTitle, 200) : '';
      if (!title) {
        const firstLine = content.split('\n')[0].replace(/^[#•\-\*\s]+/, '').trim();
        title = firstLine.length > 15 ? firstLine.slice(0, 140) : `Despacho de LinkedIn // ${currentUser.displayName}`;
      }

      const tagMatches = content.match(/#([\w\d_-]+)/g) || [];
      const extractedTags = tagMatches.map(t => t.replace('#', '').toLowerCase());
      if (!extractedTags.includes('linkedin')) extractedTags.unshift('linkedin');

      let category = ['hacking', 'politica', 'tecnopolitica'].includes(categoryHint) ? categoryHint : 'hacking';
      const lowerContent = (title + ' ' + content).toLowerCase();
      if (lowerContent.includes('elecciones') || lowerContent.includes('ley') || lowerContent.includes('parlamento') || lowerContent.includes('geopolitica') || lowerContent.includes('gobierno') || lowerContent.includes('sancion')) {
        category = 'politica';
      } else if (lowerContent.includes('pegasus') || lowerContent.includes('espionaje') || lowerContent.includes('nis2') || lowerContent.includes('directiva') || lowerContent.includes('soberania')) {
        category = 'tecnopolitica';
      }

      const sentences = content.split(/[.\n]/).filter(s => s.trim().length > 20);
      const summary = sentences.length > 0 ? sentences[0].trim() + '.' : content.slice(0, 180) + '...';
      const fallbackImg = createIntelSVG(`LinkedIn // ${currentUser.displayName}`, category, title);

      const articles = readJSON(ARTICLES_FILE, []);
      const policy = getModerationPolicy();
      const trust = evaluateUserPublishTrust(currentUser, policy, articles);
      const moderationStatus = trust.autoApprove ? 'approved' : 'pending';
      const legalTrace = createLegalTrace(req, ip, currentUser, { title, summary, content, sourceUrl: cleanUrl }, body.legalAccepted !== false);

      const newDispatch = {
        id: 'svb-ln-' + Date.now(),
        title,
        category,
        sourceName: `LinkedIn // ${currentUser.displayName}`,
        sourceUrl: cleanUrl,
        imageUrl: sanitizeImageUrl(body.imageUrl || '', fallbackImg),
        summary,
        content,
        tags: extractedTags.slice(0, 6),
        readTime: `${Math.max(1, Math.ceil(content.split(/\s+/).length / 180))} min`,
        isBreaking: moderationStatus === 'approved' ? !!body.isBreaking : false,
        isFeatured: false,
        author: currentUser.displayName,
        authorId: currentUser.id,
        authorRole: currentUser.role,
        verifiedLinkedIn: true,
        moderationStatus,
        legalTrace,
        date: new Date().toISOString(),
        views: 0
      };

      articles.unshift(newDispatch);
      writeJSON(ARTICLES_FILE, articles, { critical: true });

      recordLegalAudit({
        action: 'publish_linkedin',
        targetType: 'article',
        targetId: newDispatch.id,
        summary: title,
        currentUser,
        ip,
        req,
        contentHash: legalTrace.contentHash,
        moderationStatus,
        meta: { trustReason: trust.reason, tokens: trust.tokens, accountAgeDays: trust.accountAgeDays }
      });

      sendJSON(req, res, 201, {
        success: true,
        moderationStatus,
        message: moderationStatus === 'approved'
          ? 'Despacho de LinkedIn publicado en el terminal'
          : 'Despacho enviado a cola de moderación (requiere aprobación de Admin)',
        article: stripPrivateArticleFields(newDispatch)
      });
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
          syncSpanishFeeds()
            .then(() => enrichStoredArticlesImages())
            .catch(e => console.error('Error en sync bajo demanda:', e));
        }
      }
      const viewer = getSessionUser(req);
      const isAdmin = viewer && viewer.role === 'admin';
      const articles = readJSON(ARTICLES_FILE, [])
        .filter(a => {
          if (!a) return false;
          const st = a.moderationStatus || 'approved';
          if (st === 'approved') return true;
          if (isAdmin) return true;
          return !!(viewer && st === 'pending' && a.authorId === viewer.id);
        })
        .map(stripPrivateArticleFields);
      sendJSON(req, res, 200, articles);
      return;
    }

    if (pathname === '/api/articles' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para publicar una noticia' });
        return;
      }
      if (!checkRateLimit(`write:${ip}`, 30, 60000)) {
        sendJSON(req, res, 429, { error: 'Demasiadas publicaciones seguidas.' });
        return;
      }

      const body = await parseBody(req);
      if (!body.title || !body.category) {
        sendJSON(req, res, 400, { error: 'Título y categoría son obligatorios' });
        return;
      }

      const articles = readJSON(ARTICLES_FILE, []);
      const policy = getModerationPolicy();
      const trust = evaluateUserPublishTrust(currentUser, policy, articles);
      const moderationStatus = trust.autoApprove ? 'approved' : 'pending';
      const legalTrace = createLegalTrace(req, ip, currentUser, {
        title: body.title,
        category: body.category,
        summary: body.summary || '',
        content: body.content || ''
      }, body.legalAccepted !== false);

      const newArticle = sanitizeArticleRecord({
        ...body,
        sourceName: body.sourceName || `LinkedIn // ${currentUser.displayName}`,
        sourceUrl: body.sourceUrl || currentUser.linkedInProfile || '',
        verifiedLinkedIn: !!currentUser.linkedInProfile,
        moderationStatus,
        isFeatured: moderationStatus === 'approved' ? !!body.isFeatured : false,
        legalTrace
      }, currentUser);

      if (newArticle.isFeatured && moderationStatus === 'approved') {
        articles.forEach(a => { if (a.isFeatured) a.isFeatured = false; });
      }

      articles.unshift(newArticle);
      writeJSON(ARTICLES_FILE, articles, { critical: true });

      recordLegalAudit({
        action: 'publish_article',
        targetType: 'article',
        targetId: newArticle.id,
        summary: newArticle.title,
        currentUser,
        ip,
        req,
        contentHash: legalTrace.contentHash,
        moderationStatus,
        meta: { trustReason: trust.reason, tokens: trust.tokens, accountAgeDays: trust.accountAgeDays }
      });

      sendJSON(req, res, 201, {
        success: true,
        moderationStatus,
        message: moderationStatus === 'approved'
          ? 'Despacho publicado en el terminal.'
          : 'Despacho enviado a cola de moderación. Un Administrador debe aprobarlo antes de publicarse.',
        article: stripPrivateArticleFields(newArticle)
      });
      return;
    }

    if (pathname.startsWith('/api/articles/') && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para editar' });
        return;
      }

      const id = decodeURIComponent(pathname.replace('/api/articles/', ''));
      const body = await parseBody(req);
      const articles = readJSON(ARTICLES_FILE, []);
      const index = articles.findIndex(a => a.id === id);

      if (index === -1) {
        sendJSON(req, res, 404, { error: 'Artículo no encontrado' });
        return;
      }

      const target = articles[index];
      if (target.authorId && target.authorId !== currentUser.id && currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'No tienes permisos para modificar despachos de otro autor' });
        return;
      }

      const policy = getModerationPolicy();
      const trust = evaluateUserPublishTrust(currentUser, policy, articles);
      const nextStatus = trust.autoApprove ? (target.moderationStatus === 'rejected' && currentUser.role !== 'admin' ? 'pending' : 'approved') : 'pending';
      const legalTrace = createLegalTrace(req, ip, currentUser, {
        id,
        title: body.title || target.title,
        summary: body.summary || target.summary,
        content: body.content || target.content
      }, true);

      const updated = sanitizeArticleRecord({
        ...body,
        moderationStatus: nextStatus,
        legalTrace
      }, currentUser, target);
      updated.modifiedAt = new Date().toISOString();
      if (updated.isFeatured && nextStatus === 'approved') {
        articles.forEach(a => { if (a.id !== updated.id && a.isFeatured) a.isFeatured = false; });
      }
      articles[index] = updated;

      writeJSON(ARTICLES_FILE, articles, { critical: true });
      recordLegalAudit({
        action: 'edit_article',
        targetType: 'article',
        targetId: updated.id,
        summary: updated.title,
        currentUser,
        ip,
        req,
        contentHash: legalTrace.contentHash,
        moderationStatus: nextStatus
      });
      sendJSON(req, res, 200, { success: true, moderationStatus: nextStatus, article: stripPrivateArticleFields(articles[index]) });
      return;
    }

    if (pathname.startsWith('/api/articles/') && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para eliminar' });
        return;
      }

      const id = decodeURIComponent(pathname.replace('/api/articles/', ''));
      const articles = readJSON(ARTICLES_FILE, []);
      const target = articles.find(a => a.id === id);

      if (!target) {
        sendJSON(req, res, 404, { error: 'Artículo no encontrado' });
        return;
      }

      if (target.authorId && target.authorId !== currentUser.id && currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Permiso denegado: solo el creador o un admin puede eliminar este despacho' });
        return;
      }

      const filtered = articles.filter(a => a.id !== id);
      writeJSON(ARTICLES_FILE, filtered, { critical: true });
      sendJSON(req, res, 200, { success: true, message: 'Despacho eliminado' });
      return;
    }

    if (pathname === '/api/articles/import' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo administradores pueden realizar importaciones masivas' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      if (!Array.isArray(body)) {
        sendJSON(req, res, 400, { error: 'Se esperaba un array de despachos' }, {}, { noStore: true });
        return;
      }

      const cleanList = body.slice(0, 100).map(item => sanitizeArticleRecord(item, currentUser));
      writeJSON(ARTICLES_FILE, cleanList, { critical: true });
      sendJSON(req, res, 200, { success: true, count: cleanList.length }, {}, { noStore: true });
      return;
    }

    // ----------------------------------------------------
    // API FORO COMUNITARIO
    // ----------------------------------------------------

    // ----------------------------------------------------
    // API FORO COMUNITARIO ESTILO HTCMANIA (vBulletin)
    // ----------------------------------------------------
    const FORUM_PREFIXES = ['Debate', 'Tutorial', 'Noticia', 'Consulta', 'Off-Topic'];
    const normalizeForumThread = (t) => {
      const replies = Array.isArray(t.replies) ? t.replies.map(r => {
        const rLikes = Array.isArray(r.likedBy) ? r.likedBy : [];
        return {
          ...r,
          moderationStatus: ['approved', 'pending', 'rejected'].includes(r.moderationStatus) ? r.moderationStatus : 'approved',
          likedBy: rLikes,
          likes: rLikes.length
        };
      }) : [];
      const tLikes = Array.isArray(t.likedBy) ? t.likedBy : [];
      const lastReply = replies.length ? replies[replies.length - 1] : null;
      return {
        ...t,
        moderationStatus: ['approved', 'pending', 'rejected'].includes(t.moderationStatus) ? t.moderationStatus : 'approved',
        prefix: FORUM_PREFIXES.includes(t.prefix) ? t.prefix : 'Debate',
        pinned: !!t.pinned,
        locked: !!t.locked,
        views: Math.max(1, Number(t.views) || 1),
        likedBy: tLikes,
        likes: tLikes.length,
        lastActivityAt: t.lastActivityAt || (lastReply && lastReply.createdAt) || t.createdAt,
        replies
      };
    };

    const stripPrivateForumThread = (t, viewer) => {
      const norm = normalizeForumThread(t);
      const isAdmin = viewer && viewer.role === 'admin';
      const cleanReplies = norm.replies
        .filter(r => {
          const st = r.moderationStatus || 'approved';
          if (st === 'approved') return true;
          if (isAdmin) return true;
          return !!(viewer && st === 'pending' && r.authorId === viewer.id);
        })
        .map(r => {
          const { legalTrace, ...pubReply } = r;
          return pubReply;
        });
      const { legalTrace, ...pubThread } = norm;
      return {
        ...pubThread,
        replies: cleanReplies
      };
    };

    if (pathname === '/api/forum' && method === 'GET') {
      const viewer = getSessionUser(req);
      const isAdmin = viewer && viewer.role === 'admin';
      const threads = readJSON(FORUM_FILE, [])
        .map(t => normalizeForumThread(t))
        .filter(t => {
          const st = t.moderationStatus || 'approved';
          if (st === 'approved') return true;
          if (isAdmin) return true;
          return !!(viewer && st === 'pending' && t.authorId === viewer.id);
        })
        .map(t => stripPrivateForumThread(t, viewer));
      threads.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.lastActivityAt || b.createdAt) - new Date(a.lastActivityAt || a.createdAt);
      });
      sendJSON(req, res, 200, threads);
      return;
    }

    if (pathname === '/api/forum' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para abrir un tema en el foro' });
        return;
      }
      if (!checkRateLimit(`write:${ip}`, 15, 60000)) {
        sendJSON(req, res, 429, { error: 'Demasiadas publicaciones seguidas. Espera un momento.' });
        return;
      }

      const body = await parseBody(req);
      const title = sanitizeInput(body.title || '', 160);
      const category = sanitizeInput(body.category || 'Ciberseguridad', 40);
      const prefix = FORUM_PREFIXES.includes(body.prefix) ? body.prefix : 'Debate';
      const text = sanitizeInput(body.body || '', 4000);

      if (!title || !text) {
        sendJSON(req, res, 400, { error: 'El título y el mensaje son obligatorios' });
        return;
      }

      const nowIso = new Date().toISOString();
      const threads = readJSON(FORUM_FILE, []);
      const policy = getModerationPolicy();
      const trust = evaluateUserPublishTrust(currentUser, policy, null, threads);
      const moderationStatus = trust.autoApprove ? 'approved' : 'pending';
      const legalTrace = createLegalTrace(req, ip, currentUser, { title, category, prefix, body: text }, body.legalAccepted !== false);

      const newThread = {
        id: 'frm-' + Date.now(),
        title,
        category,
        prefix,
        body: text,
        author: currentUser.displayName,
        authorId: currentUser.id,
        authorRole: currentUser.role,
        pinned: false,
        locked: false,
        views: 1,
        likedBy: [],
        likes: 0,
        moderationStatus,
        legalTrace,
        createdAt: nowIso,
        lastActivityAt: nowIso,
        replies: []
      };

      threads.unshift(newThread);
      if (threads.length > 200) threads.length = 200;
      writeJSON(FORUM_FILE, threads, { critical: true });

      recordLegalAudit({
        action: 'create_thread',
        targetType: 'thread',
        targetId: newThread.id,
        summary: `[${prefix}] ${title}`,
        currentUser,
        ip,
        req,
        contentHash: legalTrace.contentHash,
        moderationStatus,
        meta: { category, trustReason: trust.reason, tokens: trust.tokens, accountAgeDays: trust.accountAgeDays }
      });

      sendJSON(req, res, 201, {
        success: true,
        moderationStatus,
        message: moderationStatus === 'approved'
          ? 'Tema publicado en el foro.'
          : 'Tema enviado a cola de moderación. Un Administrador lo revisará antes de hacerlo visible.',
        thread: stripPrivateForumThread(newThread, currentUser)
      });
      return;
    }

    if (/^\/api\/forum\/[^/]+\/reply$/.test(pathname) && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para responder en el foro' });
        return;
      }
      if (!checkRateLimit(`write:${ip}`, 25, 60000)) {
        sendJSON(req, res, 429, { error: 'Demasiadas respuestas seguidas. Espera un momento.' });
        return;
      }

      const threadId = decodeURIComponent(pathname.split('/')[3]);
      const body = await parseBody(req);
      const text = sanitizeInput(body.text || '', 2500);
      if (!text) {
        sendJSON(req, res, 400, { error: 'La respuesta no puede estar vacía' });
        return;
      }

      const threads = readJSON(FORUM_FILE, []);
      const idx = threads.findIndex(t => t.id === threadId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Tema no encontrado' });
        return;
      }
      const thread = threads[idx];
      if ((thread.moderationStatus || 'approved') !== 'approved' && currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Este hilo está pendiente de moderación.' });
        return;
      }
      if (thread.locked && currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Este hilo está cerrado por un administrador.' });
        return;
      }

      const policy = getModerationPolicy();
      const trust = evaluateUserPublishTrust(currentUser, policy, null, threads);
      const moderationStatus = trust.autoApprove ? 'approved' : 'pending';
      const legalTrace = createLegalTrace(req, ip, currentUser, { threadId, text }, body.legalAccepted !== false);

      const reply = {
        id: 'rep-' + Date.now(),
        text,
        author: currentUser.displayName,
        authorId: currentUser.id,
        authorRole: currentUser.role,
        likedBy: [],
        likes: 0,
        moderationStatus,
        legalTrace,
        createdAt: new Date().toISOString()
      };

      if (!Array.isArray(thread.replies)) thread.replies = [];
      thread.replies.push(reply);
      if (moderationStatus === 'approved') {
        thread.lastActivityAt = reply.createdAt;
      }
      threads[idx] = normalizeForumThread(thread);
      writeJSON(FORUM_FILE, threads, { critical: true });

      recordLegalAudit({
        action: 'post_reply',
        targetType: 'reply',
        targetId: `${thread.id}/${reply.id}`,
        summary: `${thread.title} // ${text.slice(0, 80)}`,
        currentUser,
        ip,
        req,
        contentHash: legalTrace.contentHash,
        moderationStatus,
        meta: { threadId: thread.id, trustReason: trust.reason }
      });

      const { legalTrace: _rlt, ...pubReply } = reply;
      sendJSON(req, res, 201, {
        success: true,
        moderationStatus,
        message: moderationStatus === 'approved'
          ? 'Respuesta publicada.'
          : 'Respuesta enviada a moderación antes de hacerse visible.',
        reply: pubReply,
        thread: stripPrivateForumThread(threads[idx], currentUser)
      });
      return;
    }

    if (/^\/api\/forum\/[^/]+\/view$/.test(pathname) && method === 'POST') {
      const threadId = decodeURIComponent(pathname.split('/')[3]);
      const threads = readJSON(FORUM_FILE, []);
      const idx = threads.findIndex(t => t.id === threadId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Tema no encontrado' });
        return;
      }
      if (checkRateLimit(`fview:${ip}:${threadId}`, 3, 60000)) {
        threads[idx].views = Math.max(1, Number(threads[idx].views) || 1) + 1;
        writeJSON(FORUM_FILE, threads);
      }
      sendJSON(req, res, 200, { success: true, views: Math.max(1, Number(threads[idx].views) || 1) });
      return;
    }

    if (/^\/api\/forum\/[^/]+\/like$/.test(pathname) && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Inicia sesión para agradecer un post.' });
        return;
      }
      const threadId = decodeURIComponent(pathname.split('/')[3]);
      const body = await parseBody(req);
      const replyId = body && body.replyId ? String(body.replyId) : '';
      const threads = readJSON(FORUM_FILE, []);
      const idx = threads.findIndex(t => t.id === threadId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Tema no encontrado' });
        return;
      }
      const thread = normalizeForumThread(threads[idx]);
      let targetObj = thread;
      if (replyId) {
        targetObj = thread.replies.find(r => r.id === replyId);
        if (!targetObj) {
          sendJSON(req, res, 404, { error: 'Respuesta no encontrada' });
          return;
        }
      }
      const hasLiked = targetObj.likedBy.includes(currentUser.id);
      targetObj.likedBy = hasLiked
        ? targetObj.likedBy.filter(uid => uid !== currentUser.id)
        : [...targetObj.likedBy, currentUser.id];
      targetObj.likes = targetObj.likedBy.length;
      threads[idx] = normalizeForumThread(thread);
      writeJSON(FORUM_FILE, threads, { critical: true });
      sendJSON(req, res, 200, { success: true, thread: stripPrivateForumThread(threads[idx], currentUser) });
      return;
    }

    if (/^\/api\/forum\/[^/]+\/moderate$/.test(pathname) && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede fijar o cerrar temas.' });
        return;
      }
      const threadId = decodeURIComponent(pathname.split('/')[3]);
      const body = await parseBody(req);
      const action = String((body && body.action) || '').toLowerCase();
      const threads = readJSON(FORUM_FILE, []);
      const idx = threads.findIndex(t => t.id === threadId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Tema no encontrado' });
        return;
      }
      const thread = normalizeForumThread(threads[idx]);
      if (action === 'pin') thread.pinned = true;
      else if (action === 'unpin') thread.pinned = false;
      else if (action === 'lock') thread.locked = true;
      else if (action === 'unlock') thread.locked = false;
      else {
        sendJSON(req, res, 400, { error: 'Acción de moderación no válida.' });
        return;
      }
      threads[idx] = thread;
      writeJSON(FORUM_FILE, threads, { critical: true });
      sendJSON(req, res, 200, { success: true, thread: stripPrivateForumThread(thread, currentUser) });
      return;
    }

    if (/^\/api\/forum\/[^/]+\/reply\/[^/]+$/.test(pathname) && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'No autenticado' });
        return;
      }
      const parts = pathname.split('/');
      const threadId = decodeURIComponent(parts[3]);
      const replyId = decodeURIComponent(parts[5]);
      const threads = readJSON(FORUM_FILE, []);
      const idx = threads.findIndex(t => t.id === threadId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Tema no encontrado' });
        return;
      }
      const thread = normalizeForumThread(threads[idx]);
      const targetReply = thread.replies.find(r => r.id === replyId);
      if (!targetReply) {
        sendJSON(req, res, 404, { error: 'Respuesta no encontrada' });
        return;
      }
      if (targetReply.authorId !== currentUser.id && currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Sin permisos para eliminar esta respuesta.' });
        return;
      }
      thread.replies = thread.replies.filter(r => r.id !== replyId);
      threads[idx] = thread;
      writeJSON(FORUM_FILE, threads, { critical: true });
      sendJSON(req, res, 200, { success: true, thread: stripPrivateForumThread(thread, currentUser) });
      return;
    }

    if (pathname.startsWith('/api/forum/') && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'No autenticado' });
        return;
      }

      const id = decodeURIComponent(pathname.replace('/api/forum/', ''));
      const threads = readJSON(FORUM_FILE, []);
      const target = threads.find(t => t.id === id);
      if (!target) {
        sendJSON(req, res, 404, { error: 'Tema no encontrado' });
        return;
      }

      if (target.authorId !== currentUser.id && currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el autor o el administrador pueden eliminar este tema' });
        return;
      }

      writeJSON(FORUM_FILE, threads.filter(t => t.id !== id), { critical: true });
      sendJSON(req, res, 200, { success: true });
      return;
    }

    // ----------------------------------------------------
    // API CHAT IRC EN VIVO (ESTILO mIRC32 + MODERACIÓN ADMIN)
    // ----------------------------------------------------

    if (pathname === '/api/chat/state' && method === 'GET') {
      const chat = readChatState();
      const requestedNick = (parsedUrl.query && parsedUrl.query.nick) || '';
      const requestedCh = (parsedUrl.query && parsedUrl.query.channel) || '';
      const suppliedKey = (parsedUrl.query && parsedUrl.query.key) || '';
      const chObj = getChannelObject(chat, requestedCh);
      if (requestedCh && !chObj) {
        sendJSON(req, res, 404, { error: 'Canal IRC no encontrado.' }, {}, { noStore: true });
        return;
      }
      const targetCh = chObj || getChannelObject(chat);
      const identity = resolveChatIdentity(req, requestedNick, chat, targetCh.name);
      if (!canUserAccessChannel(targetCh, identity.ok ? identity : null, suppliedKey)) {
        sendJSON(req, res, 403, {
          error: targetCh.inviteOnly
            ? `Canal privado (+i): necesitas invitación de @op para entrar en ${targetCh.name}.`
            : `Canal privado (+k/+p): clave inválida o acceso denegado en ${targetCh.name}.`,
          requiresKey: !!targetCh.keyHash,
          inviteOnly: !!targetCh.inviteOnly,
          channel: targetCh.name
        }, {}, { noStore: true });
        return;
      }
      if (suppliedKey && targetCh.keyHash && identity.ok && hashChannelKey(suppliedKey) === targetCh.keyHash) {
        const nl = identity.nick.toLowerCase();
        if (!targetCh.unlockedNicks.includes(nl)) {
          targetCh.unlockedNicks.push(nl);
          writeChatState(chat);
        }
      }
      sendJSON(req, res, 200, buildPublicChatPayload(chat, identity.ok ? identity : null, ip, targetCh.name), {}, { noStore: true });
      return;
    }

    if (pathname === '/api/chat/channels' && method === 'GET') {
      const chat = readChatState();
      const requestedNick = (parsedUrl.query && parsedUrl.query.nick) || '';
      const identity = resolveChatIdentity(req, requestedNick, chat);
      sendJSON(req, res, 200, {
        channels: listAccessibleChannels(chat, identity.ok ? identity : null)
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/chat/channels' && method === 'POST') {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para crear nuevos canales IRC.' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req);
      const chName = sanitizeIrcChannel(body.channel || '');
      if (!chName || chName.length < 3) {
        sendJSON(req, res, 400, { error: 'Nombre de canal inválido (ej. #seguridad, mínimo 2 caracteres).' }, {}, { noStore: true });
        return;
      }
      const chat = readChatState();
      const chLower = chName.toLowerCase();
      if (chLower === '#cyberpolis' || chat.channels[chLower]) {
        sendJSON(req, res, 409, { error: `El canal ${chName} ya existe.` }, {}, { noStore: true });
        return;
      }
      if (Object.keys(chat.channels || {}).length >= 30) {
        sendJSON(req, res, 400, { error: 'Límite de 30 canales alcanzado. Elimina alguno antes de crear otro.' }, {}, { noStore: true });
        return;
      }
      const ownerNick = sanitizeIrcNick(sessionUser.username || sessionUser.displayName, 'usuario');
      const rawKey = String(body.key || '').trim();
      const keyHash = rawKey ? hashChannelKey(rawKey) : '';
      const isPrivate = !!body.isPrivate || !!rawKey || !!body.inviteOnly;
      const newCh = normalizeSingleChannel(chName, {
        name: chName,
        topic: sanitizeInput(body.topic || `Canal ${chName} creado por @${ownerNick}`, 180),
        owner: ownerNick,
        isPrivate,
        secret: !!body.secret,
        inviteOnly: !!body.inviteOnly,
        keyHash,
        allowGuests: body.allowGuests !== undefined ? !!body.allowGuests : !isPrivate,
        moderatedMode: !!body.moderatedMode,
        unlockedNicks: [ownerNick.toLowerCase()],
        opNicks: [{ nick: ownerNick, reason: 'Creador del canal', createdAt: new Date().toISOString(), createdBy: ownerNick }],
        messages: [{
          id: 'irc-ch-' + Date.now(),
          type: 'system',
          nick: 'ChanServ',
          prefix: '@',
          role: 'system',
          text: `*** ${chName} creado por @${ownerNick} ${keyHash ? '(+p +k con clave)' : (isPrivate ? '(+p privado)' : '(+nt público)')} · Bot @${(chat.botConfig && chat.botConfig.nick) || 'CyberBot'} activo`,
          ts: new Date().toISOString()
        }]
      });
      chat.channels[chLower] = newCh;
      const saved = writeChatState(chat);
      const identity = resolveChatIdentity(req, ownerNick, saved, chName);
      sendJSON(req, res, 201, {
        success: true,
        channel: newCh.name,
        chat: buildPublicChatPayload(saved, identity, ip, newCh.name)
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/chat/channels/join' && method === 'POST') {
      const body = await parseBody(req);
      const chName = sanitizeIrcChannel(body.channel || '#cyberpolis');
      const chat = readChatState();
      const chObj = getChannelObject(chat, chName);
      if (!chObj) {
        sendJSON(req, res, 404, { error: `El canal ${chName} no existe.` }, {}, { noStore: true });
        return;
      }
      const identity = resolveChatIdentity(req, body.nick || '', chat, chObj.name);
      if (!identity.ok) {
        sendJSON(req, res, identity.status || 403, { error: identity.error }, {}, { noStore: true });
        return;
      }
      const ban = findChatBan(chObj, identity.nick, ip);
      if (ban) {
        sendJSON(req, res, 403, { error: `Estás baneado de ${chObj.name}: ${ban.reason || 'Baneado por @op'}` }, {}, { noStore: true });
        return;
      }
      const suppliedKey = String(body.key || '').trim();
      if (!canUserAccessChannel(chObj, identity, suppliedKey)) {
        sendJSON(req, res, 403, {
          error: chObj.inviteOnly
            ? `Canal ${chObj.name} (+i): solo por invitación de un @op.`
            : `Canal privado ${chObj.name}: se requiere clave válida (+k) o permiso.`,
          requiresKey: !!chObj.keyHash,
          inviteOnly: !!chObj.inviteOnly,
          channel: chObj.name
        }, {}, { noStore: true });
        return;
      }
      if (suppliedKey && chObj.keyHash && hashChannelKey(suppliedKey) === chObj.keyHash) {
        const nl = identity.nick.toLowerCase();
        if (!chObj.unlockedNicks.includes(nl)) {
          chObj.unlockedNicks.push(nl);
          writeChatState(chat);
        }
      }
      sendJSON(req, res, 200, {
        success: true,
        channel: chObj.name,
        chat: buildPublicChatPayload(chat, identity, ip, chObj.name)
      }, {}, { noStore: true });
      return;
    }

    if (pathname.startsWith('/api/chat/channels/') && method === 'DELETE') {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        sendJSON(req, res, 401, { error: 'Inicia sesión para gestionar canales.' }, {}, { noStore: true });
        return;
      }
      const rawName = decodeURIComponent(pathname.replace('/api/chat/channels/', ''));
      const chName = sanitizeIrcChannel(rawName);
      if (chName.toLowerCase() === '#cyberpolis') {
        sendJSON(req, res, 400, { error: 'No se puede eliminar el canal principal #cyberpolis.' }, {}, { noStore: true });
        return;
      }
      const chat = readChatState();
      const chObj = getChannelObject(chat, chName);
      if (!chObj) {
        sendJSON(req, res, 404, { error: 'Canal no encontrado.' }, {}, { noStore: true });
        return;
      }
      const actorNick = sanitizeIrcNick(sessionUser.username || sessionUser.displayName, 'usuario');
      if (sessionUser.role !== 'admin' && chObj.owner.toLowerCase() !== actorNick.toLowerCase()) {
        sendJSON(req, res, 403, { error: 'Solo el creador del canal o el Administrador pueden eliminarlo.' }, {}, { noStore: true });
        return;
      }
      disconnectMatchingChatClients({
        channel: chObj.name,
        reason: `Canal ${chObj.name} cerrado por @${actorNick}`
      });
      delete chat.channels[chObj.name.toLowerCase()];
      const saved = writeChatState(chat);
      const identity = resolveChatIdentity(req, actorNick, saved);
      sendJSON(req, res, 200, {
        success: true,
        deleted: chObj.name,
        channels: listAccessibleChannels(saved, identity)
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/chat/whois' && method === 'GET') {
      const chat = readChatState();
      const targetNick = sanitizeIrcNick((parsedUrl.query && parsedUrl.query.nick) || '', '');
      const requestedCh = (parsedUrl.query && parsedUrl.query.channel) || '';
      const chObj = getChannelObject(chat, requestedCh) || getChannelObject(chat);
      if (!targetNick) {
        sendJSON(req, res, 400, { error: 'Nick inválido.' }, {}, { noStore: true });
        return;
      }
      const lower = targetNick.toLowerCase();
      const onlineMatch = getOnlineChatNicks(chObj.name, chat).find(u => u.nick.toLowerCase() === lower);
      const isSiteAdmin = isRegisteredAdminNick(targetNick);
      const isOp = isSiteAdmin || isNickChannelOp(chObj, targetNick) || (onlineMatch && onlineMatch.role === 'bot');
      const isVoice = !isOp && (isNickChannelVoice(chObj, targetNick) || !!(onlineMatch && onlineMatch.prefix === '+'));
      const userMsgs = (chObj.messages || []).filter(m => m.type !== 'system' && String(m.nick || '').toLowerCase() === lower);
      const lastMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : null;
      sendJSON(req, res, 200, {
        nick: onlineMatch ? onlineMatch.nick : targetNick,
        prefix: isOp ? '@' : (isVoice ? '+' : ''),
        isOnline: !!onlineMatch,
        isSiteAdmin,
        isChannelOp: isOp,
        isVoice,
        isBot: !!(onlineMatch && onlineMatch.role === 'bot'),
        isMuted: !!findChatMute(chObj, targetNick),
        isBanned: !!findChatBan(chObj, targetNick, ''),
        messageCount: userMsgs.length,
        lastSeen: lastMsg ? lastMsg.ts : null,
        channel: chObj.name
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/chat/stream' && method === 'GET') {
      const chat = readChatState();
      if (!chat.enabled) {
        sendJSON(req, res, 503, { error: 'El chat IRC está desactivado temporalmente por el administrador.' }, {}, { noStore: true });
        return;
      }

      const requestedNick = (parsedUrl.query && parsedUrl.query.nick) || '';
      const requestedCh = (parsedUrl.query && parsedUrl.query.channel) || '';
      const suppliedKey = (parsedUrl.query && parsedUrl.query.key) || '';
      const chObj = getChannelObject(chat, requestedCh);
      if (requestedCh && !chObj) {
        sendJSON(req, res, 404, { error: 'Canal IRC no encontrado.' }, {}, { noStore: true });
        return;
      }
      const targetCh = chObj || getChannelObject(chat);
      const identity = resolveChatIdentity(req, requestedNick, chat, targetCh.name);
      if (!identity.ok) {
        sendJSON(req, res, identity.status || 403, { error: identity.error }, {}, { noStore: true });
        return;
      }

      if (!canUserAccessChannel(targetCh, identity, suppliedKey)) {
        sendJSON(req, res, 403, { error: `Acceso privado restringido en ${targetCh.name}.` }, {}, { noStore: true });
        return;
      }

      const ban = findChatBan(targetCh, identity.nick, ip);
      if (ban) {
        sendJSON(req, res, 403, { error: `Acceso denegado en ${targetCh.name}: ${ban.reason || 'Baneado por @op'}` }, {}, { noStore: true });
        return;
      }

      const clientId = 'sse-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      const headers = {
        ...buildSecurityHeaders(req, {
          isHtml: false,
          contentType: 'text/event-stream; charset=UTF-8',
          cacheControl: 'no-cache, no-transform'
        }),
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      };
      res.writeHead(200, headers);

      const isOpScoped = identity.isSiteAdmin || (targetCh.owner && targetCh.owner.toLowerCase() === identity.nick.toLowerCase()) || isNickChannelOp(targetCh, identity.nick);
      const isVoiceScoped = !isOpScoped && (identity.authenticated || isNickChannelVoice(targetCh, identity.nick));
      const clientPrefix = isOpScoped ? '@' : (isVoiceScoped ? '+' : '');

      chatSseClients.set(clientId, {
        id: clientId,
        res,
        channel: targetCh.name.toLowerCase(),
        nick: identity.nick,
        prefix: clientPrefix,
        role: identity.role,
        ip,
        connectedAt: Date.now()
      });

      const initPayload = buildPublicChatPayload(chat, identity, ip, targetCh.name);
      res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);
      broadcastChatEvent('presence', {
        channel: targetCh.name,
        onlineUsers: getOnlineChatNicks(targetCh.name, chat)
      }, targetCh.name);

      const cleanupClient = () => {
        if (chatSseClients.has(clientId)) {
          chatSseClients.delete(clientId);
          broadcastChatEvent('presence', {
            channel: targetCh.name,
            onlineUsers: getOnlineChatNicks(targetCh.name, readChatState())
          }, targetCh.name);
        }
      };
      req.on('close', cleanupClient);
      res.on('close', cleanupClient);
      return;
    }

    if (pathname === '/api/chat/messages' && method === 'POST') {
      const chat = readChatState();
      if (!chat.enabled) {
        sendJSON(req, res, 403, { error: 'El chat IRC está desactivado por el administrador.' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const requestedCh = body.channel || '';
      const chObj = getChannelObject(chat, requestedCh);
      if (requestedCh && !chObj) {
        sendJSON(req, res, 404, { error: 'Canal IRC no encontrado.' }, {}, { noStore: true });
        return;
      }
      const targetCh = chObj || getChannelObject(chat);
      const identity = resolveChatIdentity(req, body.nick || '', chat, targetCh.name);
      if (!identity.ok) {
        sendJSON(req, res, identity.status || 403, { error: identity.error }, {}, { noStore: true });
        return;
      }

      if (!canUserAccessChannel(targetCh, identity, body.key || '')) {
        sendJSON(req, res, 403, { error: `No tienes acceso al canal privado ${targetCh.name}.` }, {}, { noStore: true });
        return;
      }

      if (!identity.authenticated && !targetCh.allowGuests) {
        sendJSON(req, res, 401, { error: `Debes iniciar sesión para escribir en ${targetCh.name}.` }, {}, { noStore: true });
        return;
      }

      const ban = findChatBan(targetCh, identity.nick, ip);
      if (ban) {
        sendJSON(req, res, 403, { error: `Estás baneado en ${targetCh.name}: ${ban.reason || 'Baneado por @op'}` }, {}, { noStore: true });
        return;
      }

      const mute = findChatMute(targetCh, identity.nick);
      if (mute) {
        sendJSON(req, res, 403, { error: `Estás silenciado en ${targetCh.name} por un operador (@).` }, {}, { noStore: true });
        return;
      }

      if (targetCh.moderatedMode && !identity.isChannelOp && identity.prefix !== '+' && identity.role !== 'admin' && identity.role !== 'analyst') {
        sendJSON(req, res, 403, { error: `Canal ${targetCh.name} en modo moderado (+m): solo @ops y +voces pueden hablar.` }, {}, { noStore: true });
        return;
      }

      if (!checkRateLimit(`chat:${ip}`, 25, 30000)) {
        sendJSON(req, res, 429, { error: 'Flood protection: espera unos segundos antes de enviar otro mensaje.' }, {}, { noStore: true });
        return;
      }

      const rawText = sanitizeInput(String(body.text || ''), 480);
      if (!rawText) {
        sendJSON(req, res, 400, { error: 'El mensaje no puede estar vacío.' }, {}, { noStore: true });
        return;
      }

      // Comandos IRC clásicos ejecutables desde el propio chat
      if (rawText.startsWith('/')) {
        const spaceIdx = rawText.indexOf(' ');
        const cmd = (spaceIdx === -1 ? rawText : rawText.slice(0, spaceIdx)).toLowerCase();
        const arg = spaceIdx === -1 ? '' : rawText.slice(spaceIdx + 1).trim();

        if (cmd === '/me' || cmd === '/slap') {
          if (!arg) {
            sendJSON(req, res, 400, { error: `Uso: ${cmd} <objetivo o acción>` }, {}, { noStore: true });
            return;
          }
          const actionText = cmd === '/slap'
            ? `slaps ${sanitizeIrcNick(arg, arg.slice(0, 24))} around a bit with a large trout`
            : arg;
          const msg = appendChatMessage(chat, {
            type: 'action',
            nick: identity.nick,
            prefix: identity.prefix,
            role: identity.role,
            text: actionText
          }, targetCh);
          sendJSON(req, res, 201, { success: true, message: msg }, {}, { noStore: true });
          return;
        }

        if (identity.isChannelOp) {
          if (cmd === '/topic' && arg) {
            targetCh.topic = sanitizeInput(arg, 180);
            const msg = appendChatMessage(chat, {
              type: 'system',
              nick: identity.nick,
              prefix: '@',
              role: 'system',
              text: `* @${identity.nick} changes topic to '${targetCh.topic}'`
            }, targetCh);
            syncOnlineClientPrefixes(chat, targetCh);
            sendJSON(req, res, 200, { success: true, topic: targetCh.topic, message: msg }, {}, { noStore: true });
            return;
          }

          if (cmd === '/clear') {
            const out = executeIrcModAction(chat, identity, { action: 'clear', channel: targetCh.name });
            sendJSON(req, res, out.status, { success: true }, {}, { noStore: true });
            return;
          }

          if (cmd === '/notice' && arg) {
            const out = executeIrcModAction(chat, identity, { action: 'notice', text: arg, channel: targetCh.name });
            sendJSON(req, res, out.status, out.ok ? { success: true, message: out.message } : { error: out.error }, {}, { noStore: true });
            return;
          }

          if (cmd === '/invite' && arg) {
            const out = executeIrcModAction(chat, identity, { action: 'invite', nick: arg.split(/\s+/)[0], channel: targetCh.name });
            sendJSON(req, res, out.status, out.ok ? { success: true, chat: out.chatPayload } : { error: out.error }, {}, { noStore: true });
            return;
          }

          if (cmd === '/mode' && arg) {
            const parts = arg.split(/\s+/);
            const modeFlag = parts[0] || '';
            const modeTarget = parts[1] || '';
            const modeMap = {
              '+o': 'op', '-o': 'deop',
              '+v': 'voice', '-v': 'devoice',
              '+q': 'mute', '-q': 'unmute',
              '+b': 'ban', '-b': 'unban'
            };
            if (modeFlag === '+m' || modeFlag === '-m') {
              if ((modeFlag === '+m') !== !!targetCh.moderatedMode) {
                executeIrcModAction(chat, identity, { action: 'toggle_moderated', channel: targetCh.name });
              }
              sendJSON(req, res, 200, { success: true }, {}, { noStore: true });
              return;
            }
            if ((modeFlag === '+p' || modeFlag === '-p' || modeFlag === '+i' || modeFlag === '-i' || modeFlag === '+k' || modeFlag === '-k' || modeFlag === '+s' || modeFlag === '-s') && targetCh.name.toLowerCase() !== '#cyberpolis') {
              if (modeFlag === '+p') targetCh.isPrivate = true;
              if (modeFlag === '-p') targetCh.isPrivate = false;
              if (modeFlag === '+s') targetCh.secret = true;
              if (modeFlag === '-s') targetCh.secret = false;
              if (modeFlag === '+i') { targetCh.inviteOnly = true; targetCh.isPrivate = true; }
              if (modeFlag === '-i') targetCh.inviteOnly = false;
              if (modeFlag === '+k' && modeTarget) { targetCh.keyHash = hashChannelKey(modeTarget); targetCh.isPrivate = true; }
              if (modeFlag === '-k') targetCh.keyHash = '';
              appendChatMessage(chat, {
                type: 'system',
                nick: identity.nick,
                prefix: '@',
                role: 'system',
                text: `* @${identity.nick} sets mode ${modeFlag} on ${targetCh.name}`
              }, targetCh);
              syncOnlineClientPrefixes(chat, targetCh);
              sendJSON(req, res, 200, { success: true, chat: buildPublicChatPayload(chat, identity, ip, targetCh.name) }, {}, { noStore: true });
              return;
            }
            const mappedAction = modeMap[modeFlag];
            if (!mappedAction || !modeTarget) {
              sendJSON(req, res, 400, { error: 'Uso: /mode +o|-o|+v|-v|+q|-q|+b|-b <nick> · /mode +m|-m|+p|-p|+i|-i|+k <clave>|-k' }, {}, { noStore: true });
              return;
            }
            const out = executeIrcModAction(chat, identity, { action: mappedAction, nick: modeTarget, channel: targetCh.name });
            sendJSON(req, res, out.status, out.ok ? { success: true } : { error: out.error }, {}, { noStore: true });
            return;
          }

          const cmdActionMap = {
            '/kick': 'kick', '/mute': 'mute', '/unmute': 'unmute',
            '/ban': 'ban', '/unban': 'unban', '/kickban': 'kickban',
            '/op': 'op', '/deop': 'deop', '/voice': 'voice', '/devoice': 'devoice'
          };
          if (cmdActionMap[cmd] && arg) {
            const parts = arg.split(/\s+/);
            const targetNick = sanitizeIrcNick(parts[0], '');
            const reason = parts.slice(1).join(' ').trim() || 'Moderación @op';
            const out = executeIrcModAction(chat, identity, { action: cmdActionMap[cmd], nick: targetNick, reason, channel: targetCh.name });
            sendJSON(req, res, out.status, out.ok ? { success: true } : { error: out.error }, {}, { noStore: true });
            return;
          }
        }
      }

      const botResult = evaluateCyberBotModeration(chat, targetCh, identity, rawText);
      if (botResult.blocked) {
        sendJSON(req, res, 403, { error: botResult.error }, {}, { noStore: true });
        return;
      }

      const savedMsg = appendChatMessage(chat, {
        type: 'msg',
        nick: identity.nick,
        prefix: identity.prefix,
        role: identity.role,
        text: rawText
      }, targetCh);

      if (botResult.warn) {
        appendChatMessage(chat, {
          type: 'system',
          nick: (chat.botConfig && chat.botConfig.nick) || 'CyberBot',
          prefix: '@',
          role: 'bot',
          text: botResult.warn
        }, targetCh);
      }

      handleCyberBotTrigger(chat, targetCh, rawText);
      sendJSON(req, res, 201, { success: true, message: savedMsg }, {}, { noStore: true });
      return;
    }

    if (pathname.startsWith('/api/chat/messages/') && method === 'DELETE') {
      const chat = readChatState();
      const chObj = getChannelObject(chat, (parsedUrl.query && parsedUrl.query.channel) || '') || getChannelObject(chat);
      const identity = resolveChatIdentity(req, (parsedUrl.query && parsedUrl.query.actorNick) || '', chat, chObj.name);
      const isAdminOrOp = identity.ok && (identity.role === 'admin' || identity.isChannelOp);
      if (!isAdminOrOp) {
        sendJSON(req, res, 403, { error: 'Solo el Administrador o un @op puede borrar mensajes del IRC' }, {}, { noStore: true });
        return;
      }

      const msgId = decodeURIComponent(pathname.replace('/api/chat/messages/', ''));
      const existed = (chObj.messages || []).some(m => m.id === msgId);
      if (!existed) {
        sendJSON(req, res, 404, { error: 'Mensaje no encontrado' }, {}, { noStore: true });
        return;
      }
      chObj.messages = chObj.messages.filter(m => m.id !== msgId);
      writeChatState(chat);
      broadcastChatEvent('delete', { id: msgId, channel: chObj.name }, chObj.name);
      sendJSON(req, res, 200, { success: true, id: msgId }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/chat/op-action' && method === 'POST') {
      const body = await parseBody(req);
      const chat = readChatState();
      const chObj = getChannelObject(chat, body.channel || '') || getChannelObject(chat);
      const identity = resolveChatIdentity(req, body.actorNick || '', chat, chObj.name);
      if (!identity.ok || (!identity.isSiteAdmin && !identity.isChannelOp)) {
        sendJSON(req, res, 403, { error: 'Requiere privilegios de Operador (@) en el canal.' }, {}, { noStore: true });
        return;
      }
      if (String(body.action || '').toLowerCase() === 'topic') {
        const nextTopic = sanitizeInput(body.topic || '', 180);
        if (!nextTopic) {
          sendJSON(req, res, 400, { error: 'El topic no puede estar vacío.' }, {}, { noStore: true });
          return;
        }
        chObj.topic = nextTopic;
        appendChatMessage(chat, {
          type: 'system',
          nick: identity.nick,
          prefix: '@',
          role: 'system',
          text: `* @${identity.nick} changes topic to '${chObj.topic}'`
        }, chObj);
        syncOnlineClientPrefixes(chat, chObj);
        sendJSON(req, res, 200, { success: true, chat: buildPublicChatPayload(chat, identity, ip, chObj.name) }, {}, { noStore: true });
        return;
      }
      const out = executeIrcModAction(chat, identity, { ...body, channel: chObj.name });
      sendJSON(req, res, out.status, out.ok ? {
        success: true,
        mutedNicks: out.mutedNicks,
        bannedEntries: out.bannedEntries,
        chat: out.chatPayload
      } : { error: out.error }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/chat/config' && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede configurar el chat IRC' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const chat = readChatState();
      const mainCh = getChannelObject(chat);
      const prevTopic = mainCh.topic;
      if (body.topic !== undefined) mainCh.topic = sanitizeInput(body.topic, 180) || mainCh.topic;
      if (body.allowGuests !== undefined) mainCh.allowGuests = !!body.allowGuests;
      if (body.moderatedMode !== undefined) mainCh.moderatedMode = !!body.moderatedMode;

      const next = writeChatState({
        ...chat,
        enabled: body.enabled !== undefined ? !!body.enabled : chat.enabled,
        theme: body.theme !== undefined ? (body.theme === 'mirc-dark' ? 'mirc-dark' : 'mirc-classic') : chat.theme,
        botConfig: body.botConfig ? sanitizeBotConfig(body.botConfig, chat.botConfig) : chat.botConfig
      });

      const opNick = sanitizeIrcNick(currentUser.username || currentUser.displayName, 'admin');
      if (next.topic !== prevTopic) {
        appendChatMessage(next, {
          type: 'system',
          nick: opNick,
          prefix: '@',
          role: 'system',
          text: `* @${opNick} changes topic to '${next.topic}'`
        }, getChannelObject(next));
      }
      syncOnlineClientPrefixes(next, getChannelObject(next));
      sendJSON(req, res, 200, {
        success: true,
        config: buildPublicChatPayload(next),
        botConfig: next.botConfig
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/chat/moderation' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const chat = readChatState();
      const chObj = getChannelObject(chat, (parsedUrl.query && parsedUrl.query.channel) || '') || getChannelObject(chat);
      const adminNick = sanitizeIrcNick(currentUser.username || currentUser.displayName, 'admin');
      sendJSON(req, res, 200, {
        channel: chObj.name,
        topic: chObj.topic,
        enabled: chat.enabled,
        allowGuests: chObj.allowGuests,
        moderatedMode: chObj.moderatedMode,
        theme: chat.theme,
        botConfig: chat.botConfig || DEFAULT_BOT_CONFIG,
        channels: listAccessibleChannels(chat, { ok: true, isSiteAdmin: true, nick: adminNick }),
        onlineUsers: getOnlineChatNicks(chObj.name, chat),
        recentMessages: (chObj.messages || []).slice(-80),
        mutedNicks: chObj.mutedNicks || [],
        bannedEntries: chObj.bannedEntries || []
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/chat/action' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }

      const body = await parseBody(req);
      const chat = readChatState();
      const opNick = sanitizeIrcNick(currentUser.username || currentUser.displayName, 'admin');
      const out = executeIrcModAction(chat, { nick: opNick, isSiteAdmin: true, isChannelOp: true }, body);
      sendJSON(req, res, out.status, out.ok ? {
        success: true,
        mutedNicks: out.mutedNicks || chat.mutedNicks,
        bannedEntries: out.bannedEntries || chat.bannedEntries,
        chat: out.chatPayload
      } : { error: out.error }, {}, { noStore: true });
      return;
    }

    // ----------------------------------------------------
    // API PERFIL, MULTI-TENANT AZURE ONEDRIVE & WETRANSFER CIFRADO
    // ----------------------------------------------------

    if (pathname === '/api/profile/notification-email' && method === 'PUT') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Inicia sesión para configurar tu correo de notificaciones.' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req);
      const nextEmail = sanitizeEmail(body.notificationEmail || '');
      if (body.notificationEmail && !nextEmail) {
        sendJSON(req, res, 400, { error: 'Formato de correo electrónico inválido.' }, {}, { noStore: true });
        return;
      }
      const users = readJSON(USERS_FILE, []);
      const idx = users.findIndex(u => u.id === currentUser.id);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Usuario no encontrado' }, {}, { noStore: true });
        return;
      }
      users[idx].notificationEmail = nextEmail;
      users[idx].updatedAt = new Date().toISOString();
      writeJSON(USERS_FILE, users, { critical: true });
      sendJSON(req, res, 200, { success: true, notificationEmail: nextEmail }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/cloud/tenants/public' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Autenticación requerida' }, {}, { noStore: true });
        return;
      }
      const cloud = readCloudStore();
      const envT = cloudOneDrive.resolveEnvPrimaryTenant();
      const envG = cloudGoogle.resolveEnvGoogleProvider();
      const list = [
        ...(envT ? [envT] : []),
        ...(envG ? [envG] : []),
        ...cloud.tenants
      ].map(t => sanitizeTenantPublic(t, false)).filter(Boolean);
      sendJSON(req, res, 200, { tenants: list }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/cloud/status' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const cloud = readCloudStore();
      const envT = cloudOneDrive.resolveEnvPrimaryTenant();
      const envG = cloudGoogle.resolveEnvGoogleProvider();
      const all = [
        ...(envT ? [envT] : []),
        ...(envG ? [envG] : []),
        ...cloud.tenants
      ].map(t => sanitizeTenantPublic(t, true)).filter(Boolean);
      const storageStatus = store.getStatus();
      const activeGw = cloudGoogle.resolveActiveMailGateway(cloud);
      sendJSON(req, res, 200, {
        storage: storageStatus,
        tenants: all,
        mailGateway: sanitizeMailGatewayPublic(activeGw),
        backupHistory: cloud.backupHistory || []
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/cloud/mail-gateway' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede configurar la pasarela de correo.' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req);
      const mode = ['gmail_app_password', 'custom_smtp', 'gmail_oauth2', 'microsoft_graph', 'none'].includes(body.mode)
        ? body.mode
        : 'gmail_app_password';
      const cloud = readCloudStore();
      const prevGw = cloud.mailGateway || {};
      const userEmail = sanitizeInput(body.user || body.fromEmail || '', 160);
      const rawPass = String(body.password || '').replace(/\s+/g, '').trim();
      const host = sanitizeInput(body.host || (mode === 'gmail_app_password' ? 'smtp.gmail.com' : ''), 160);
      const port = parseInt(body.port, 10) || 465;

      if ((mode === 'gmail_app_password' || mode === 'custom_smtp') && (!userEmail || (!rawPass && !prevGw.passSealed))) {
        sendJSON(req, res, 400, { error: 'Indica tu dirección de correo Gmail / SMTP y la contraseña de aplicación.' }, {}, { noStore: true });
        return;
      }

      const nextGw = {
        mode,
        host: mode === 'gmail_app_password' ? 'smtp.gmail.com' : host,
        port,
        secure: body.secure !== undefined ? !!body.secure : (port === 465),
        user: userEmail,
        passSealed: rawPass ? cloudOneDrive.sealCloudSecret(rawPass) : (prevGw.passSealed || ''),
        fromEmail: sanitizeInput(body.fromEmail || userEmail, 160),
        fromName: sanitizeInput(body.fromName || 'CYBERPOLIS Transfer', 80) || 'CYBERPOLIS Transfer',
        updatedAt: new Date().toISOString()
      };
      cloud.mailGateway = nextGw;
      writeCloudStore(cloud);

      recordLegalAudit({
        action: 'cloud_mail_gateway_update',
        targetType: 'mail_gateway',
        targetId: nextGw.mode,
        summary: `Pasarela de correo actualizada (${nextGw.mode}: ${nextGw.fromEmail || nextGw.user || 'auto'})`,
        currentUser,
        ip,
        req
      });
      sendJSON(req, res, 200, { success: true, mailGateway: sanitizeMailGatewayPublic(nextGw) }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/cloud/mail-test' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req).catch(() => ({}));
      const toEmail = sanitizeInput(body.to || '', 160);
      if (!toEmail || !toEmail.includes('@')) {
        sendJSON(req, res, 400, { error: 'Indica un correo destino válido para la prueba.' }, {}, { noStore: true });
        return;
      }
      const cloud = readCloudStore();
      const activeGw = cloudGoogle.resolveActiveMailGateway(cloud);
      const tCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, body.tenantId || '');
      const resMail = await cloudOneDrive.sendTransferNotificationEmail(tCfg, {
        to: toEmail,
        subject: '[CYBERPOLIS] Prueba de Pasarela de Correo Gmail / Cloud',
        textBody: 'Esta es una confirmación automática de que la pasarela de correo de CYBERPOLIS funciona correctamente.',
        htmlBody: '<p><strong>✅ CYBERPOLIS</strong>: La pasarela de correo está configurada y enviando notificaciones correctamente.</p>',
        mailGateway: activeGw,
        cloudState: cloud
      });
      if (!resMail.sent) {
        sendJSON(req, res, 502, { error: resMail.error || 'No se pudo enviar el correo de prueba.', details: resMail }, {}, { noStore: true });
        return;
      }
      sendJSON(req, res, 200, { success: true, ...resMail }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/admin/cloud/tenants' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede gestionar proveedores nube' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req);
      const providerType = body.providerType === 'google-drive' ? 'google-drive' : 'onedrive';
      const name = sanitizeInput(body.name || (providerType === 'google-drive' ? 'Google Drive 5 TB' : 'Empresa Azure M365'), 80);
      const tenantId = sanitizeInput(body.tenantId || (providerType === 'google-drive' ? 'google' : 'common'), 96) || 'common';
      const clientId = sanitizeInput(body.clientId || '', 160);
      const rawSecret = String(body.clientSecret || '').trim();
      const rawSaJson = String(body.serviceAccountJson || '').trim();
      const driveUserUpn = sanitizeInput(body.driveUserUpn || '', 140);
      const driveId = sanitizeInput(body.driveId || '', 140);
      const baseFolder = sanitizeInput(body.baseFolder || '/CYBERPOLIS_VAULT', 120) || '/CYBERPOLIS_VAULT';
      const companyDomain = sanitizeInput(body.companyDomain || (driveUserUpn.includes('@') ? driveUserUpn.split('@')[1] : (providerType === 'google-drive' ? 'google.com' : 'microsoft365')), 80);

      let authMode = 'client_credentials';
      if (providerType === 'google-drive') {
        authMode = body.authMode === 'service_account' ? 'service_account' : 'google_oauth2';
      } else {
        authMode = body.authMode === 'delegated_oauth2' ? 'delegated_oauth2' : 'client_credentials';
      }

      const cloud = readCloudStore();
      const existingIdx = body.id ? cloud.tenants.findIndex(t => t.id === body.id) : -1;
      const existing = existingIdx >= 0 ? cloud.tenants[existingIdx] : null;
      const secretSealed = rawSecret
        ? cloudOneDrive.sealCloudSecret(rawSecret)
        : (existing ? existing.clientSecretSealed : '');

      let saEmail = existing ? (existing.serviceAccountEmail || '') : '';
      let saJsonSealed = existing ? (existing.serviceAccountJsonSealed || '') : '';
      if (rawSaJson) {
        let parsedSa;
        try {
          parsedSa = JSON.parse(rawSaJson);
        } catch (e) {
          sendJSON(req, res, 400, { error: 'El JSON de Google Service Account no tiene formato JSON válido.' }, {}, { noStore: true });
          return;
        }
        if (!parsedSa.client_email || !parsedSa.private_key) {
          sendJSON(req, res, 400, { error: 'El JSON de Service Account debe incluir client_email y private_key.' }, {}, { noStore: true });
          return;
        }
        saEmail = sanitizeInput(parsedSa.client_email, 160);
        saJsonSealed = cloudOneDrive.sealCloudSecret(rawSaJson);
      }

      if (providerType === 'google-drive') {
        if (authMode === 'service_account' && !saJsonSealed) {
          sendJSON(req, res, 400, { error: 'En modo Service Account debes pegar el archivo JSON de Google Cloud.' }, {}, { noStore: true });
          return;
        }
        if (authMode !== 'service_account' && !clientId) {
          sendJSON(req, res, 400, { error: 'En modo Google OAuth2 debes indicar el Client ID de Google Cloud Console.' }, {}, { noStore: true });
          return;
        }
      } else {
        if (!clientId) {
          sendJSON(req, res, 400, { error: 'El Client ID (Application ID) de Azure Entra ID es obligatorio.' }, {}, { noStore: true });
          return;
        }
        if (authMode === 'client_credentials' && !secretSealed) {
          sendJSON(req, res, 400, { error: 'En modo App-Only Daemon debes indicar el Client Secret de Azure AD.' }, {}, { noStore: true });
          return;
        }
      }

      const record = {
        id: existing ? existing.id : ((providerType === 'google-drive' ? 'gd-' : 'ten-') + Date.now() + '-' + crypto.randomBytes(2).toString('hex')),
        providerType,
        name,
        companyDomain,
        tenantId,
        clientId,
        clientSecretSealed: secretSealed,
        refreshTokenSealed: existing ? (existing.refreshTokenSealed || '') : '',
        serviceAccountJsonSealed: saJsonSealed,
        serviceAccountEmail: saEmail,
        authMode,
        driveUserUpn,
        driveId,
        baseFolder,
        isDefaultForBackup: body.isDefaultForBackup !== undefined ? !!body.isDefaultForBackup : (cloud.tenants.length === 0),
        autoBackupEnabled: body.autoBackupEnabled !== undefined ? !!body.autoBackupEnabled : true,
        sendMailEnabled: body.sendMailEnabled !== undefined ? !!body.sendMailEnabled : true,
        lastTestedAt: existing ? existing.lastTestedAt : null,
        quotaTotalBytes: existing ? (existing.quotaTotalBytes || 0) : 0,
        quotaUsedBytes: existing ? (existing.quotaUsedBytes || 0) : 0,
        updatedAt: new Date().toISOString()
      };

      if (record.isDefaultForBackup) {
        cloud.tenants.forEach(t => { if (t.id !== record.id) t.isDefaultForBackup = false; });
      }
      if (existingIdx >= 0) {
        cloud.tenants[existingIdx] = record;
      } else {
        cloud.tenants.push(record);
      }
      writeCloudStore(cloud);

      recordLegalAudit({
        action: 'cloud_tenant_upsert',
        targetType: 'cloud_tenant',
        targetId: record.id,
        summary: `Nube (${providerType}) configurada: ${record.name}`,
        currentUser,
        ip,
        req
      });

      sendJSON(req, res, 200, { success: true, tenant: sanitizeTenantPublic(record, true) }, {}, { noStore: true });
      return;
    }

    if (pathname.startsWith('/api/admin/cloud/tenants/') && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const id = decodeURIComponent(pathname.replace('/api/admin/cloud/tenants/', ''));
      if (id === 'env-primary') {
        sendJSON(req, res, 400, { error: 'El tenant principal definido por variables de entorno se gestiona desde Render.' }, {}, { noStore: true });
        return;
      }
      const cloud = readCloudStore();
      cloud.tenants = cloud.tenants.filter(t => t.id !== id);
      writeCloudStore(cloud);
      sendJSON(req, res, 200, { success: true }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/cloud/oauth/start' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Solo el Administrador puede vincular cuentas Cloud OAuth2.' }, {}, { noStore: true });
        return;
      }
      const cloud = readCloudStore();
      const targetId = (parsedUrl.query && parsedUrl.query.tenantRecordId) || '';
      const tCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, targetId);
      if (!tCfg || !tCfg.clientId) {
        sendJSON(req, res, 400, { error: 'Primero registra el proveedor (Client ID) antes de autorizar por OAuth2.' }, {}, { noStore: true });
        return;
      }
      const stateNonce = crypto.randomBytes(24).toString('hex');
      const proto = isSecureRequest(req) ? 'https' : 'http';
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'cyberpolis.onrender.com').split(',')[0].trim();
      const redirectUri = `${proto}://${host}/api/cloud/oauth/callback`;
      const returnTo = sanitizeInput((parsedUrl.query && parsedUrl.query.returnTo) || '', 160);
      cloudOAuthStates.set(stateNonce, { tenantRecordId: tCfg.id, providerType: tCfg.providerType || 'onedrive', redirectUri, returnTo, createdAt: Date.now(), adminId: currentUser.id });

      const authUrl = tCfg.providerType === 'google-drive'
        ? cloudGoogle.buildGoogleOAuthAuthorizeUrl({
            clientId: tCfg.clientId,
            redirectUri,
            state: stateNonce,
            loginHint: tCfg.driveUserUpn || ''
          })
        : `https://login.microsoftonline.com/${encodeURIComponent(tCfg.tenantId || 'common')}/oauth2/v2.0/authorize?` + new URLSearchParams({
            client_id: tCfg.clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            response_mode: 'query',
            scope: 'offline_access Files.ReadWrite.All User.Read Mail.Send',
            state: stateNonce
          }).toString();

      sendJSON(req, res, 200, { authorizeUrl: authUrl, redirectUri }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/cloud/oauth/callback' && method === 'GET') {
      const code = (parsedUrl.query && parsedUrl.query.code) || '';
      const stateNonce = (parsedUrl.query && parsedUrl.query.state) || '';
      const oauthErr = (parsedUrl.query && (parsedUrl.query.error_description || parsedUrl.query.error)) || '';
      const st = cloudOAuthStates.get(stateNonce);
      cloudOAuthStates.delete(stateNonce);

      if (oauthErr || !st || !code || (Date.now() - st.createdAt > 10 * 60 * 1000)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(`<h3>Error vinculando cuenta Cloud OAuth2</h3><p>${escapeHtmlSsr(oauthErr || 'Estado OAuth expirado o inválido.')}</p>`);
        return;
      }
      const cloud = readCloudStore();
      const idx = cloud.tenants.findIndex(t => t.id === st.tenantRecordId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end('<h3>Proveedor Cloud no encontrado.</h3>');
        return;
      }
      const tCfg = cloud.tenants[idx];
      const clientSecret = cloudOneDrive.unsealCloudSecret(tCfg.clientSecretSealed);

      if (tCfg.providerType === 'google-drive' || st.providerType === 'google-drive') {
        try {
          const tokData = await cloudGoogle.exchangeGoogleOAuthCode({
            clientId: tCfg.clientId,
            clientSecret,
            code,
            redirectUri: st.redirectUri
          });
          cloud.tenants[idx].refreshTokenSealed = cloudOneDrive.sealCloudSecret(tokData.refresh_token);
          cloud.tenants[idx].authMode = 'google_oauth2';
          cloud.tenants[idx].updatedAt = new Date().toISOString();
          writeCloudStore(cloud);
          const dest = (st && st.returnTo)
            ? (st.returnTo.includes('?') ? `${st.returnTo}&cloudOAuth=ok` : `${st.returnTo}?cloudOAuth=ok`)
            : '/?cloudOAuth=ok';
          res.writeHead(302, { 'Location': dest });
          res.end();
        } catch (gErr) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=UTF-8' });
          res.end(`<h3>Error intercambiando token Google OAuth2</h3><p>${escapeHtmlSsr(gErr.message)}</p>`);
        }
        return;
      }

      const params = new URLSearchParams({
        client_id: tCfg.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: st.redirectUri,
        scope: 'offline_access Files.ReadWrite.All User.Read Mail.Send'
      });
      if (clientSecret) params.set('client_secret', clientSecret);

      const tokRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tCfg.tenantId || 'common')}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(15000)
      });
      const tokData = await tokRes.json().catch(() => ({}));
      if (!tokRes.ok || !tokData.refresh_token) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(`<h3>Error intercambiando token OAuth2</h3><p>${escapeHtmlSsr(tokData.error_description || tokData.error || 'Falta offline_access refresh_token')}</p>`);
        return;
      }
      cloud.tenants[idx].refreshTokenSealed = cloudOneDrive.sealCloudSecret(tokData.refresh_token);
      cloud.tenants[idx].authMode = 'delegated_oauth2';
      cloud.tenants[idx].updatedAt = new Date().toISOString();
      writeCloudStore(cloud);
      const destMs = (st && st.returnTo)
        ? (st.returnTo.includes('?') ? `${st.returnTo}&cloudOAuth=ok` : `${st.returnTo}?cloudOAuth=ok`)
        : '/?cloudOAuth=ok';
      res.writeHead(302, { 'Location': destMs });
      res.end();
      return;
    }

    if (pathname === '/api/admin/cloud/test' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req).catch(() => ({}));
      const cloud = readCloudStore();
      const tCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, body.tenantId || '');
      if (!tCfg) {
        sendJSON(req, res, 400, { error: 'No hay ningún proveedor OneDrive / Google Drive configurado todavía.' }, {}, { noStore: true });
        return;
      }
      try {
        const info = tCfg.providerType === 'google-drive'
          ? await cloudGoogle.testGoogleDriveConnection(tCfg)
          : await cloudOneDrive.testOneDriveConnection(tCfg);
        const idx = cloud.tenants.findIndex(t => t.id === tCfg.id);
        if (idx >= 0) {
          cloud.tenants[idx].lastTestedAt = new Date().toISOString();
          cloud.tenants[idx].quotaTotalBytes = info.quotaTotalBytes;
          cloud.tenants[idx].quotaUsedBytes = info.quotaUsedBytes;
          if (info.ownerEmail && !cloud.tenants[idx].driveUserUpn) {
            cloud.tenants[idx].driveUserUpn = info.ownerEmail;
          }
          writeCloudStore(cloud);
        }
        sendJSON(req, res, 200, { success: true, ...info, tenantName: tCfg.name }, {}, { noStore: true });
      } catch (err) {
        sendJSON(req, res, 502, { error: `Error conectando con Cloud Drive: ${err.message}` }, {}, { noStore: true });
      }
      return;
    }

    if (pathname === '/api/admin/cloud/backup' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req).catch(() => ({}));
      const cloud = readCloudStore();
      const tCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, body.tenantId || '');
      if (!tCfg) {
        sendJSON(req, res, 400, { error: 'Configura primero tus credenciales de Azure AD / OneDrive.' }, {}, { noStore: true });
        return;
      }
      try {
        const up = await store.pushOneDriveSnapshot(tCfg);
        cloud.backupHistory.unshift({
          id: 'bkp-' + Date.now(),
          action: 'backup',
          tenantName: tCfg.name,
          remotePath: up.remotePath,
          size: up.size,
          actor: currentUser.username,
          ts: new Date().toISOString()
        });
        writeCloudStore(cloud);
        sendJSON(req, res, 200, { success: true, ...up }, {}, { noStore: true });
      } catch (err) {
        sendJSON(req, res, 502, { error: `No se pudo subir el backup a OneDrive: ${err.message}` }, {}, { noStore: true });
      }
      return;
    }

    if (pathname === '/api/admin/cloud/restore' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req).catch(() => ({}));
      const cloud = readCloudStore();
      const tCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, body.tenantId || '');
      if (!tCfg) {
        sendJSON(req, res, 400, { error: 'Configura primero tus credenciales de Azure AD / OneDrive.' }, {}, { noStore: true });
        return;
      }
      try {
        const resRestore = await store.restoreFromOneDriveSnapshot(tCfg);
        if (!resRestore.restored) {
          sendJSON(req, res, 404, { error: 'No existe todavía ningún backup previo en OneDrive (/backups/cyberpolis-latest.enc.json).' }, {}, { noStore: true });
          return;
        }
        cloud.backupHistory.unshift({
          id: 'rst-' + Date.now(),
          action: 'restore',
          tenantName: tCfg.name,
          remotePath: '/backups/cyberpolis-latest.enc.json',
          actor: currentUser.username,
          ts: new Date().toISOString()
        });
        writeCloudStore(cloud);
        sendJSON(req, res, 200, { success: true, ...resRestore }, {}, { noStore: true });
      } catch (err) {
        sendJSON(req, res, 502, { error: `Error restaurando backup de OneDrive: ${err.message}` }, {}, { noStore: true });
      }
      return;
    }

    if (pathname === '/api/admin/transfers/audit' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        sendJSON(req, res, 403, { error: 'Acceso restringido al Administrador' }, {}, { noStore: true });
        return;
      }
      const list = readJSON(TRANSFERS_FILE, []);
      const auditRows = (Array.isArray(list) ? list : []).slice(0, 200).map(t => ({
        id: t.id,
        mode: t.mode,
        title: t.title,
        senderUsername: t.senderUsername,
        recipientUsername: t.recipientUsername || '',
        recipientEmail: t.recipientEmail || '',
        tenantName: t.tenantName || 'CYBERPOLIS Vault',
        fileName: t.file ? t.file.fileName : '',
        fileSize: t.file ? t.file.size : 0,
        fileSha256: t.file ? t.file.sha256 : '',
        storageLocation: t.file ? t.file.storageLocation : 'none',
        oneDrivePath: t.file ? (t.file.oneDrivePath || '') : '',
        responseCount: Array.isArray(t.responses) ? t.responses.length : 0,
        eventsCount: Array.isArray(t.events) ? t.events.length : 0,
        emailNotifications: Array.isArray(t.emailNotifications) ? t.emailNotifications : [],
        createdAt: t.createdAt,
        expiresAt: t.expiresAt
      }));
      sendJSON(req, res, 200, { transfers: auditRows }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/transfers/mine' && method === 'GET') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para acceder a tu espacio CYBERPOLIS Transfer.' }, {}, { noStore: true });
        return;
      }
      const all = readJSON(TRANSFERS_FILE, []);
      const users = readJSON(USERS_FILE, []);
      const fullUser = users.find(u => u.id === currentUser.id) || currentUser;
      const myEmails = [fullUser.email, fullUser.notificationEmail]
        .filter(e => e && String(e).includes('@') && !String(e).endsWith('.local'))
        .map(e => String(e).toLowerCase());

      const sent = [];
      const received = [];
      const links = [];

      for (const t of (Array.isArray(all) ? all : [])) {
        const isSender = t.senderId === currentUser.id;
        const isRecip = t.recipientId === currentUser.id ||
          (t.recipientUsername && t.recipientUsername.toLowerCase() === currentUser.username.toLowerCase()) ||
          (t.recipientEmail && myEmails.includes(String(t.recipientEmail).toLowerCase()));
        if (!isSender && !isRecip) continue;
        const view = sanitizeTransferForViewer(t, true);
        if (isSender && t.mode === 'link') links.push(view);
        else if (isSender) sent.push(view);
        if (isRecip && !isSender) received.push(view);
      }

      sendJSON(req, res, 200, {
        notificationEmail: resolveUserNotificationEmail(fullUser),
        sent,
        received,
        links
      }, {}, { noStore: true });
      return;
    }

    if (pathname === '/api/transfers' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Debes iniciar sesión para enviar o crear enlaces cifrados.' }, {}, { noStore: true });
        return;
      }
      if (!checkRateLimit(`transfer:${currentUser.id}`, 20, 60000)) {
        sendJSON(req, res, 429, { error: 'Demasiados envíos en poco tiempo.' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req, 26 * 1024 * 1024);
      const mode = ['send', 'receive', 'link'].includes(body.mode) ? body.mode : 'send';
      const title = sanitizeInput(body.title || (mode === 'link' ? 'Enlace de intercambio cifrado' : 'Envío cifrado WeTransfer'), 120);
      const message = sanitizeInput(body.message || '', 2000);
      const expiresDays = Math.max(1, Math.min(90, parseInt(body.expiresDays, 10) || 14));
      const accessPassword = String(body.accessPassword || '').trim();

      const users = readJSON(USERS_FILE, []);
      let recipientUser = null;
      if (body.recipientUsername) {
        const ruLower = String(body.recipientUsername).trim().toLowerCase();
        recipientUser = users.find(u => u.username && u.username.toLowerCase() === ruLower) || null;
      }
      let recipientEmail = sanitizeEmail(body.recipientEmail || '');
      if (!recipientEmail && recipientUser) {
        recipientEmail = resolveUserNotificationEmail(recipientUser);
      }
      if (mode === 'send' && !recipientUser && !recipientEmail) {
        sendJSON(req, res, 400, { error: 'Elige un usuario destinatario o indica su correo electrónico.' }, {}, { noStore: true });
        return;
      }

      let rawBuf = null;
      if (body.file && body.file.base64Data) {
        const cleanB64 = String(body.file.base64Data).replace(/^data:[^;]+;base64,/, '');
        rawBuf = Buffer.from(cleanB64, 'base64');
        if (rawBuf.length === 0 || rawBuf.length > 18 * 1024 * 1024) {
          sendJSON(req, res, 400, { error: 'Archivo vacío o superior al límite de 18 MB por transferencia web.' }, {}, { noStore: true });
          return;
        }
      } else if (mode === 'send' && !message) {
        sendJSON(req, res, 400, { error: 'Adjunta un archivo o escribe un mensaje para enviar.' }, {}, { noStore: true });
        return;
      }

      const cloud = readCloudStore();
      const tenantCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, body.tenantId || '');
      const transferId = 'tr-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      const shareToken = crypto.randomBytes(24).toString('hex');
      const keySalt = crypto.randomBytes(16).toString('hex');

      let fileMeta = null;
      if (rawBuf) {
        fileMeta = await storeEncryptedTransferFile(
          transferId + '-main',
          rawBuf,
          body.file.name,
          body.file.mimeType,
          tenantCfg,
          keySalt
        );
      }

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + expiresDays * 86400000).toISOString();
      const proto = isSecureRequest(req) ? 'https' : 'http';
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'cyberpolis.onrender.com').split(',')[0].trim();
      const shareUrl = `${proto}://${host}/?transfer=${encodeURIComponent(shareToken)}`;

      const emailNotifications = [];
      if (recipientEmail && body.notifyByEmail !== false) {
        const notif = await cloudOneDrive.sendTransferNotificationEmail(tenantCfg, {
          to: recipientEmail,
          subject: `[CYBERPOLIS Transfer] ${currentUser.displayName || currentUser.username} te ha enviado: ${title}`,
          textBody: `${currentUser.displayName || currentUser.username} (@${currentUser.username}) te ha compartido un enlace cifrado en CYBERPOLIS.\n\nMensaje:\n${message || '(Sin texto adicional)'}\n\nAccede y agrega tu respuesta o archivos aquí:\n${shareUrl}\n\nCaduca: ${expiresAt}`,
          htmlBody: `<p><strong>${escapeHtmlSsr(currentUser.displayName || currentUser.username)}</strong> (@${escapeHtmlSsr(currentUser.username)}) ha creado una transferencia cifrada para ti en <strong>CYBERPOLIS</strong>.</p><p><strong>Asunto:</strong> ${escapeHtmlSsr(title)}</p>${message ? `<blockquote style="border-left:3px solid #0078d4;padding-left:10px;">${escapeHtmlSsr(message)}</blockquote>` : ''}<p><a href="${shareUrl}">Abrir transferencia cifrada y responder →</a></p><p><small>Caducidad: ${expiresAt}</small></p>`,
          mailGateway: cloudGoogle.resolveActiveMailGateway(cloud),
          cloudState: cloud
        });
        emailNotifications.push({ ...notif, trigger: 'created' });
      }

      const transferRecord = {
        id: transferId,
        mode,
        title,
        message,
        senderId: currentUser.id,
        senderUsername: currentUser.username,
        senderDisplayName: currentUser.displayName || currentUser.username,
        senderEmail: resolveUserNotificationEmail(users.find(u => u.id === currentUser.id) || currentUser),
        recipientId: recipientUser ? recipientUser.id : '',
        recipientUsername: recipientUser ? recipientUser.username : '',
        recipientEmail,
        tenantId: tenantCfg ? tenantCfg.id : '',
        tenantName: tenantCfg ? tenantCfg.name : 'Bóveda Local Cifrada',
        encryptionKeySalt: keySalt,
        accessPasswordHash: accessPassword ? hashTransferPassword(accessPassword, keySalt) : '',
        allowRecipientReply: body.allowRecipientReply !== false,
        allowRecipientUpload: body.allowRecipientUpload !== false,
        shareToken,
        file: fileMeta,
        responses: [],
        emailNotifications,
        events: [{
          type: 'created',
          actor: currentUser.username,
          ip,
          sha256: fileMeta ? fileMeta.sha256 : '',
          storageLocation: fileMeta ? fileMeta.storageLocation : 'none',
          ts: nowIso
        }],
        createdAt: nowIso,
        expiresAt
      };

      const allTransfers = readJSON(TRANSFERS_FILE, []);
      allTransfers.unshift(transferRecord);
      writeJSON(TRANSFERS_FILE, allTransfers.slice(0, 500), { critical: true });

      recordLegalAudit({
        action: 'create_encrypted_transfer',
        targetType: 'transfer',
        targetId: transferId,
        summary: `Transferencia cifrada (${mode}) "${title}" -> ${recipientEmail || recipientUser?.username || 'Link compartido'}`,
        currentUser,
        ip,
        req
      });

      sendJSON(req, res, 201, {
        success: true,
        shareUrl,
        transfer: sanitizeTransferForViewer(transferRecord, true)
      }, {}, { noStore: true });
      return;
    }

    if (pathname.startsWith('/api/transfers/link/') && pathname.endsWith('/unlock') && method === 'POST') {
      const shareToken = decodeURIComponent(pathname.slice('/api/transfers/link/'.length, -'/unlock'.length));
      const all = readJSON(TRANSFERS_FILE, []);
      const idx = all.findIndex(x => x.shareToken === shareToken);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Enlace de transferencia no encontrado o revocado.' }, {}, { noStore: true });
        return;
      }
      const t = all[idx];
      if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) {
        sendJSON(req, res, 410, { error: 'Este enlace cifrado ha caducado.' }, {}, { noStore: true });
        return;
      }
      const body = await parseBody(req).catch(() => ({}));
      const pwd = String(body.password || '');
      if (t.accessPasswordHash && hashTransferPassword(pwd, t.encryptionKeySalt) !== t.accessPasswordHash) {
        sendJSON(req, res, 403, { error: 'Clave de acceso incorrecta.' }, {}, { noStore: true });
        return;
      }
      sendJSON(req, res, 200, { unlocked: true, transfer: sanitizeTransferForViewer(t, true) }, {}, { noStore: true });
      return;
    }

    if (pathname.startsWith('/api/transfers/link/') && method === 'GET') {
      const shareToken = decodeURIComponent(pathname.replace('/api/transfers/link/', ''));
      const all = readJSON(TRANSFERS_FILE, []);
      const t = all.find(x => x.shareToken === shareToken);
      if (!t) {
        sendJSON(req, res, 404, { error: 'Enlace de transferencia no encontrado o revocado.' }, {}, { noStore: true });
        return;
      }
      if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) {
        sendJSON(req, res, 410, { error: 'Este enlace cifrado ha caducado.' }, {}, { noStore: true });
        return;
      }
      const suppliedPass = (parsedUrl.query && parsedUrl.query.password) || '';
      const locked = !!(t.accessPasswordHash && hashTransferPassword(suppliedPass, t.encryptionKeySalt) !== t.accessPasswordHash);
      if (locked) {
        sendJSON(req, res, 200, {
          locked: true,
          transfer: {
            id: t.id,
            mode: t.mode,
            title: t.title,
            senderDisplayName: t.senderDisplayName,
            requiresPassword: true,
            expiresAt: t.expiresAt
          }
        }, {}, { noStore: true });
        return;
      }
      sendJSON(req, res, 200, { locked: false, transfer: sanitizeTransferForViewer(t, true) }, {}, { noStore: true });
      return;
    }

    if (/^\/api\/transfers\/[^/]+\/download$/.test(pathname) && method === 'GET') {
      const transferId = decodeURIComponent(pathname.split('/')[3]);
      const currentUser = getSessionUser(req);
      const shareToken = (parsedUrl.query && parsedUrl.query.token) || '';
      const suppliedPass = (parsedUrl.query && parsedUrl.query.password) || '';
      const responseId = (parsedUrl.query && parsedUrl.query.responseId) || '';

      const all = readJSON(TRANSFERS_FILE, []);
      const idx = all.findIndex(x => x.id === transferId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Transferencia no encontrada.' }, {}, { noStore: true });
        return;
      }
      const t = all[idx];
      if (!canUserAccessTransfer(t, currentUser, shareToken)) {
        sendJSON(req, res, 403, { error: 'Acceso denegado: este archivo cifrado pertenece únicamente a su emisor/destinatario.' }, {}, { noStore: true });
        return;
      }
      if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) {
        sendJSON(req, res, 410, { error: 'Este archivo cifrado ha caducado.' }, {}, { noStore: true });
        return;
      }
      if (t.accessPasswordHash && (!currentUser || currentUser.id !== t.senderId)) {
        if (hashTransferPassword(suppliedPass, t.encryptionKeySalt) !== t.accessPasswordHash) {
          sendJSON(req, res, 403, { error: 'Clave de transferencia requerida o incorrecta.' }, {}, { noStore: true });
          return;
        }
      }

      let fileMeta = t.file;
      if (responseId) {
        const respEntry = (t.responses || []).find(r => r.id === responseId);
        fileMeta = respEntry ? respEntry.file : null;
      }
      if (!fileMeta) {
        sendJSON(req, res, 404, { error: 'No hay ningún archivo adjunto en esta transferencia.' }, {}, { noStore: true });
        return;
      }

      const cloud = readCloudStore();
      const tenantCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, t.tenantId);
      const plainBuf = await loadDecryptedTransferFile(fileMeta, tenantCfg, t.encryptionKeySalt);
      if (!plainBuf) {
        sendJSON(req, res, 404, { error: 'No se pudo recuperar el blob cifrado desde la nube.' }, {}, { noStore: true });
        return;
      }

      t.events = Array.isArray(t.events) ? t.events : [];
      t.events.push({
        type: 'download',
        actor: currentUser ? currentUser.username : 'link-recipient',
        ip,
        fileName: fileMeta.fileName,
        sha256: fileMeta.sha256,
        ts: new Date().toISOString()
      });
      writeJSON(TRANSFERS_FILE, all, { critical: true });

      const headers = {
        ...buildSecurityHeaders(req, {
          isHtml: false,
          contentType: fileMeta.mimeType || 'application/octet-stream',
          cacheControl: 'no-store'
        }),
        'Content-Length': String(plainBuf.length),
        'Content-Disposition': `attachment; filename="${String(fileMeta.fileName || 'archivo.bin').replace(/"/g, '')}"`
      };
      res.writeHead(200, headers);
      res.end(plainBuf);
      return;
    }

    if (/^\/api\/transfers\/[^/]+\/respond$/.test(pathname) && method === 'POST') {
      const transferId = decodeURIComponent(pathname.split('/')[3]);
      const currentUser = getSessionUser(req);
      const body = await parseBody(req, 26 * 1024 * 1024);
      const shareToken = body.token || (parsedUrl.query && parsedUrl.query.token) || '';

      const all = readJSON(TRANSFERS_FILE, []);
      const idx = all.findIndex(x => x.id === transferId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Transferencia no encontrada.' }, {}, { noStore: true });
        return;
      }
      const t = all[idx];
      if (!canUserAccessTransfer(t, currentUser, shareToken)) {
        sendJSON(req, res, 403, { error: 'No autorizado para agregar información en esta transferencia.' }, {}, { noStore: true });
        return;
      }
      if (t.allowRecipientReply === false) {
        sendJSON(req, res, 403, { error: 'El emisor deshabilitó respuestas en esta transferencia.' }, {}, { noStore: true });
        return;
      }
      if (t.accessPasswordHash && !currentUser) {
        if (hashTransferPassword(String(body.password || ''), t.encryptionKeySalt) !== t.accessPasswordHash) {
          sendJSON(req, res, 403, { error: 'Clave de acceso requerida para responder.' }, {}, { noStore: true });
          return;
        }
      }

      const replyText = sanitizeInput(body.text || '', 2000);
      const authorName = sanitizeInput(
        (currentUser && (currentUser.displayName || currentUser.username)) || body.authorName || 'Destinatario Externo',
        64
      );
      const authorEmail = sanitizeEmail((currentUser && currentUser.email) || body.authorEmail || '');

      let respFileMeta = null;
      if (body.file && body.file.base64Data) {
        if (t.allowRecipientUpload === false) {
          sendJSON(req, res, 403, { error: 'El emisor no permite adjuntar archivos en este enlace.' }, {}, { noStore: true });
          return;
        }
        const cleanB64 = String(body.file.base64Data).replace(/^data:[^;]+;base64,/, '');
        const rawBuf = Buffer.from(cleanB64, 'base64');
        if (rawBuf.length === 0 || rawBuf.length > 18 * 1024 * 1024) {
          sendJSON(req, res, 400, { error: 'Archivo adjunto inválido o mayor de 18 MB.' }, {}, { noStore: true });
          return;
        }
        const cloud = readCloudStore();
        const tenantCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, t.tenantId);
        respFileMeta = await storeEncryptedTransferFile(
          `${t.id}-resp-${Date.now()}`,
          rawBuf,
          body.file.name,
          body.file.mimeType,
          tenantCfg,
          t.encryptionKeySalt
        );
      }

      if (!replyText && !respFileMeta) {
        sendJSON(req, res, 400, { error: 'Escribe información o adjunta un archivo de respuesta.' }, {}, { noStore: true });
        return;
      }

      const nowIso = new Date().toISOString();
      const respObj = {
        id: 'resp-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
        authorName,
        authorEmail,
        text: replyText,
        file: respFileMeta,
        ip,
        createdAt: nowIso
      };
      t.responses = Array.isArray(t.responses) ? t.responses : [];
      t.responses.push(respObj);
      t.events = Array.isArray(t.events) ? t.events : [];
      t.events.push({
        type: 'recipient_response',
        actor: authorName,
        ip,
        sha256: respFileMeta ? respFileMeta.sha256 : '',
        ts: nowIso
      });

      if (t.senderEmail) {
        const cloud = readCloudStore();
        const tenantCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, t.tenantId);
        const notif = await cloudOneDrive.sendTransferNotificationEmail(tenantCfg, {
          to: t.senderEmail,
          subject: `[CYBERPOLIS Transfer] Nueva información recibida en: ${t.title}`,
          textBody: `${authorName} ha agregado información${respFileMeta ? ` y adjuntado "${respFileMeta.fileName}"` : ''} en tu transferencia "${t.title}".\n\nTexto:\n${replyText || '(Sin texto)'}`,
          htmlBody: `<p><strong>${escapeHtmlSsr(authorName)}</strong> ha añadido información en tu transferencia <strong>${escapeHtmlSsr(t.title)}</strong>.</p>${replyText ? `<blockquote style="border-left:3px solid #16a34a;padding-left:10px;">${escapeHtmlSsr(replyText)}</blockquote>` : ''}${respFileMeta ? `<p>📎 Archivo adjunto cifrado: <strong>${escapeHtmlSsr(respFileMeta.fileName)}</strong></p>` : ''}`,
          mailGateway: cloudGoogle.resolveActiveMailGateway(cloud),
          cloudState: cloud
        });
        t.emailNotifications = Array.isArray(t.emailNotifications) ? t.emailNotifications : [];
        t.emailNotifications.push({ ...notif, trigger: 'recipient_response' });
      }

      writeJSON(TRANSFERS_FILE, all, { critical: true });
      sendJSON(req, res, 201, { success: true, transfer: sanitizeTransferForViewer(t, true) }, {}, { noStore: true });
      return;
    }

    if (pathname.startsWith('/api/transfers/') && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(req, res, 401, { error: 'Autenticación requerida.' }, {}, { noStore: true });
        return;
      }
      const transferId = decodeURIComponent(pathname.replace('/api/transfers/', ''));
      const all = readJSON(TRANSFERS_FILE, []);
      const idx = all.findIndex(x => x.id === transferId);
      if (idx === -1) {
        sendJSON(req, res, 404, { error: 'Transferencia no encontrada.' }, {}, { noStore: true });
        return;
      }
      const t = all[idx];
      if (currentUser.role !== 'admin' && t.senderId !== currentUser.id) {
        sendJSON(req, res, 403, { error: 'Solo el emisor o el Administrador puede revocar esta transferencia.' }, {}, { noStore: true });
        return;
      }

      const cloud = readCloudStore();
      const tenantCfg = cloudOneDrive.resolveActiveTenantConfig(cloud, t.tenantId);
      if (t.file && t.file.oneDrivePath && tenantCfg) {
        cloudOneDrive.deleteItemFromOneDrive(tenantCfg, t.file.oneDrivePath);
      }
      if (t.file && t.file.blobId) {
        try { fs.unlinkSync(path.join(VAULT_DIR, `${path.basename(t.file.blobId)}.enc`)); } catch (e) {}
      }
      for (const r of (t.responses || [])) {
        if (r.file && r.file.oneDrivePath && tenantCfg) {
          cloudOneDrive.deleteItemFromOneDrive(tenantCfg, r.file.oneDrivePath);
        }
        if (r.file && r.file.blobId) {
          try { fs.unlinkSync(path.join(VAULT_DIR, `${path.basename(r.file.blobId)}.enc`)); } catch (e) {}
        }
      }

      all.splice(idx, 1);
      writeJSON(TRANSFERS_FILE, all, { critical: true });
      sendJSON(req, res, 200, { success: true, deleted: transferId }, {}, { noStore: true });
      return;
    }

    const lowerPath = pathname.toLowerCase();
    if (lowerPath.startsWith('/api/enviox') || lowerPath.startsWith('/api/tranxfer')) {
      const handled = await (envioxBackend.handleEnvioxApi || envioxBackend.handleTranxferApi)(req, res, pathname, method, {
        getSessionUser,
        parseBody,
        getDbStore: () => store,
        readCloudStore,
        writeCloudStore,
        cloudOneDrive,
        cloudGoogle,
        storeEncryptedTransferFile,
        loadDecryptedTransferFile,
        sendTransferNotificationEmail: (tenantCfg, toEmail, subject, textBody, htmlBody, mailGateway) => {
          return cloudOneDrive.sendTransferNotificationEmail(tenantCfg, {
            to: toEmail,
            subject,
            textBody,
            htmlBody,
            mailGateway: mailGateway || cloudGoogle.resolveActiveMailGateway(readCloudStore())
          });
        },
        sendJSON,
        isSecureRequest,
        getClientIp: (r) => extractClientIp(r)
      });
      if (handled) return;
    }

    if (pathname === '/api/status' && (method === 'GET' || method === 'HEAD')) {
      const config = readJSON(CONFIG_FILE, {});
      if (method === 'HEAD') {
        res.writeHead(200, buildSecurityHeaders(req));
        res.end();
        return;
      }
      sendJSON(req, res, 200, {
        status: 'online',
        autoSyncEnabled: !!config.autoSyncEnabled,
        lastSync: config.lastSync || null,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Proxy seguro de imágenes externas (con guardia anti-SSRF, bloqueo SVG externo y límite de tamaño)
    if (pathname === '/api/proxy/image' && method === 'GET') {
      if (!checkRateLimit(`proxy:${ip}`, 90, 60000)) {
        sendJSON(req, res, 429, { error: 'Demasiadas peticiones de imagen.' });
        return;
      }

      const rawUrl = (parsedUrl.query && parsedUrl.query.url) || '';
      const ssrfCheck = await validateSafeExternalUrl(rawUrl);
      if (!ssrfCheck.ok) {
        sendJSON(req, res, 403, { error: ssrfCheck.error || 'URL de imagen no permitida.' });
        return;
      }

      const targetUrl = upgradeImageUrl(ssrfCheck.url);

      const sendSvgFallback = () => {
        res.writeHead(200, {
          ...buildSecurityHeaders(req, {
            isHtml: false,
            contentType: 'image/svg+xml; charset=utf-8',
            cacheControl: 'public, max-age=3600'
          }),
          'Content-Security-Policy': "sandbox; default-src 'none'"
        });
        const fallback = decodeURIComponent(createIntelSVG('CYBERPOLIS', 'hacking', 'INFORME DE CIBERSEGURIDAD').replace('data:image/svg+xml;charset=utf-8,', ''));
        res.end(fallback);
      };

      try {
        const upstream = await safeFetchExternal(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5'
          },
          signal: AbortSignal.timeout(6500)
        });

        const declaredLen = parseInt(upstream.headers.get('content-length') || '0', 10);
        if (!upstream.ok || (declaredLen && declaredLen > MAX_PROXY_BYTES)) {
          sendSvgFallback();
          return;
        }

        const reader = upstream.body && upstream.body.getReader ? upstream.body.getReader() : null;
        let buffer;
        if (reader) {
          const chunks = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_PROXY_BYTES) {
              try { await reader.cancel(); } catch (e) {}
              sendSvgFallback();
              return;
            }
            chunks.push(Buffer.from(value));
          }
          buffer = Buffer.concat(chunks);
        } else {
          buffer = Buffer.from(await upstream.arrayBuffer());
        }

        if (buffer.length < 100 || buffer.length > MAX_PROXY_BYTES) {
          sendSvgFallback();
          return;
        }

        // Detección estricta por magic bytes (nunca servir SVG o HTML externo a través del proxy)
        let detectedType = '';
        if (buffer[0] === 0xff && buffer[1] === 0xd8) detectedType = 'image/jpeg';
        else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) detectedType = 'image/png';
        else if (buffer.slice(0, 4).toString('ascii') === 'GIF8') detectedType = 'image/gif';
        else if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') detectedType = 'image/webp';
        else {
          const headerType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (ALLOWED_IMAGE_MIMES.has(headerType) && headerType === 'image/avif') {
            detectedType = 'image/avif';
          }
        }

        if (!detectedType) {
          sendSvgFallback();
          return;
        }

        res.writeHead(200, {
          ...buildSecurityHeaders(req, {
            isHtml: false,
            contentType: detectedType,
            cacheControl: 'public, max-age=86400, stale-while-revalidate=43200'
          }),
          'Content-Security-Policy': "sandbox; default-src 'none'"
        });
        res.end(buffer);
      } catch (err) {
        sendSvgFallback();
      }
      return;
    }

    if (pathname === '/robots.txt' && (method === 'GET' || method === 'HEAD')) {
      const proto = isSecureRequest(req) ? 'https' : 'http';
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'cyberpolis.onrender.com').split(',')[0].trim().replace(/[^a-zA-Z0-9.\-:]/g, '');
      const baseUrl = `${proto}://${host}`;
      const robotsTxt = [
        'User-agent: *',
        'Allow: /',
        'Allow: /api/articles',
        'Allow: /api/forum',
        'Allow: /api/admin/config',
        'Allow: /api/proxy/image',
        'Disallow: /api/auth/',
        'Disallow: /api/admin/',
        'Disallow: /data/',
        '',
        `Sitemap: ${baseUrl}/sitemap.xml`
      ].join('\n');
      res.writeHead(200, buildSecurityHeaders(req, {
        contentType: 'text/plain; charset=UTF-8',
        cacheControl: 'public, max-age=3600'
      }));
      res.end(method === 'HEAD' ? undefined : robotsTxt);
      return;
    }

    if (pathname === '/sitemap.xml' && (method === 'GET' || method === 'HEAD')) {
      const proto = isSecureRequest(req) ? 'https' : 'http';
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'cyberpolis.onrender.com').split(',')[0].trim().replace(/[^a-zA-Z0-9.\-:]/g, '');
      const baseUrl = `${proto}://${host}`;
      const escapeXml = str => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const articles = readJSON(ARTICLES_FILE, []).filter(a => a && (!a.moderationStatus || a.moderationStatus === 'approved'));
      const todayIso = new Date().toISOString().slice(0, 10);

      const staticUrls = [
        { loc: `${baseUrl}/`, lastmod: todayIso, changefreq: 'hourly', priority: '1.0' },
        { loc: `${baseUrl}/?cat=hacking`, lastmod: todayIso, changefreq: 'daily', priority: '0.85' },
        { loc: `${baseUrl}/?cat=politica`, lastmod: todayIso, changefreq: 'daily', priority: '0.8' },
        { loc: `${baseUrl}/?cat=tecnopolitica`, lastmod: todayIso, changefreq: 'daily', priority: '0.8' },
        { loc: `${baseUrl}/?cat=forum`, lastmod: todayIso, changefreq: 'daily', priority: '0.75' },
        { loc: `${baseUrl}/?cat=contact`, lastmod: todayIso, changefreq: 'monthly', priority: '0.5' }
      ];

      const articleUrls = articles.slice(0, 40).map(a => {
        const d = a.date ? new Date(a.date) : new Date();
        const iso = Number.isNaN(d.getTime()) ? todayIso : d.toISOString().slice(0, 10);
        return {
          loc: `${baseUrl}/?article=${encodeURIComponent(a.id)}`,
          lastmod: iso,
          changefreq: 'weekly',
          priority: '0.7'
        };
      });

      const xmlEntries = [...staticUrls, ...articleUrls].map(u =>
        `  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
      ).join('\n');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xmlEntries}\n</urlset>`;
      res.writeHead(200, buildSecurityHeaders(req, {
        contentType: 'application/xml; charset=UTF-8',
        cacheControl: 'public, max-age=1800'
      }));
      res.end(method === 'HEAD' ? undefined : xml);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJSON(req, res, 404, { error: 'Endpoint no encontrado' });
      return;
    }

    serveStatic(req, res, pathname, parsedUrl.query);

  } catch (err) {
    console.error('Error interno del servidor:', err);
    sendJSON(req, res, 500, { error: 'Error de servidor interno' });
  }
});

ensureFiles();

function startServer(targetPort) {
  server.listen(targetPort)
    .on('listening', () => {
      const storageStatus = store.getStatus();
      console.log(`=======================================================`);
      console.log(`  🛡️  CYBERPOLIS — HARDENED CORE v7`);
      console.log(`  🔒 Auth: Scrypt + HttpOnly Cookies + CSP + Anti-SSRF`);
      console.log(`  💾 Store: ${storageStatus.label}`);
      console.log(`  🌐 Servidor activo en: http://localhost:${targetPort}`);
      console.log(`=======================================================`);

      if (process.env.NODE_ENV !== 'production') {
        const openCmd = process.platform === 'win32' ? `start http://localhost:${targetPort}` :
                        process.platform === 'darwin' ? `open http://localhost:${targetPort}` :
                        `xdg-open http://localhost:${targetPort}`;
        exec(openCmd, () => {});
      }
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        startServer(targetPort + 1);
      } else {
        console.error('Error al iniciar servidor:', err);
      }
    });
}

async function bootstrap() {
  await store.init();
  sanitizeStoredArticles();
  initBackgroundSync();
  startServer(PORT);
}

async function shutdownGracefully(signal) {
  console.log(`Recibido ${signal}, vaciando caché persistente...`);
  try {
    await store.close();
  } catch (e) {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));

if (require.main === module) {
  bootstrap();
}

server.store = store;
module.exports = server;
