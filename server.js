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
const FORUM_FILE = path.join(DATA_DIR, 'forum.json');

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

function sanitizeLogoUrl(raw) {
  if (!raw || typeof raw !== 'string') return 'assets/silverbot-unix-logo.png';
  const trimmed = raw.trim();
  if (/^assets\/[a-zA-Z0-9._\-\/]+$/.test(trimmed)) return trimmed;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) return sanitizeInput(trimmed);
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length <= 600000) {
    return trimmed;
  }
  return 'assets/silverbot-unix-logo.png';
}

function sanitizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim().slice(0, 120);
  if (!trimmed) return '';
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(trimmed) ? trimmed : '';
}

// ==========================================
// 2. Persistencia en Disco
// ==========================================
function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ARTICLES_FILE)) fs.writeFileSync(ARTICLES_FILE, '[]', 'utf-8');
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(FORUM_FILE)) fs.writeFileSync(FORUM_FILE, '[]', 'utf-8');
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
  // Mejorar resolución de miniaturas de Blogger / Blogspot (ej: s72-w640-h426-c -> s1200)
  if (upgraded.includes('blogger.googleusercontent.com') || upgraded.includes('bp.blogspot.com') || upgraded.includes('ggpht.com')) {
    upgraded = upgraded
      .replace(/\/(?:s(?:72|[1-8]\d\d)|w\d+-h\d+)(?:-[a-z0-9]+)*\//i, '/s1200/')
      .replace(/=(?:s(?:72|[1-8]\d\d)|w\d+-h\d+)(?:-[a-z0-9]+)*$/i, '=s1200');
  }
  // Mejorar miniaturas pequeñas de YouTube (default.jpg / mqdefault.jpg -> hqdefault.jpg)
  if (upgraded.includes('img.youtube.com/vi/')) {
    upgraded = upgraded.replace(/\/(?:default|mqdefault)\.jpg(\?.*)?$/i, '/hqdefault.jpg');
  }
  return upgraded;
}

async function fetchOgImage(articleUrl) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return '';
  try {
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(4500)
    });
    if (!res.ok) return '';
    const html = await res.text();
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

      // Desanclar demos antiguos como portada permanente si existen noticias reales
      if (hasFreshFeeds && a.isFeatured && /^(art-00\d|svb-00\d)$/.test(String(a.id || ''))) {
        a.isFeatured = false;
        modified = true;
      }

      // Mejorar calidad de imágenes reales o regenerar fallback limpio editorial
      if (!a.imageUrl || a.imageUrl.includes('unsplash.com')) {
        a.imageUrl = createIntelSVG(a.sourceName, a.category, a.title);
        modified = true;
      } else if (a.imageUrl.startsWith('data:image/svg+xml')) {
        const decoded = decodeURIComponent(a.imageUrl.replace('data:image/svg+xml;charset=utf-8,', ''));
        if (decoded.includes('&') || a.imageUrl.includes('%26') || decoded.includes('#04070d') || decoded.includes('POLÍTICA DIGITAL')) {
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
// 3. Motor de Ingestión Automática en Castellano (RSS / Feeds) & Gráficos de Inteligencia
// ==========================================

const ENTITY_MAP = {
  '&quot;': '"', '&#039;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&',
  '&nbsp;': ' ', '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó',
  '&uacute;': 'ú', '&ntilde;': 'ñ', '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í',
  '&Oacute;': 'Ó', '&Uacute;': 'Ú', '&Ntilde;': 'Ñ', '&laquo;': '«', '&raquo;': '»',
  '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'", '&mdash;': '—',
  '&ndash;': '–', '&hellip;': '...'
};

// Limpieza profunda de HTML y decodificación de entidades para que nunca se muestren etiquetas crudas en los despachos
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

  // Segunda pasada para etiquetas que estaban ofuscadas en entidades HTML
  str = str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  return str.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// Generador de portadas editoriales vectoriales limpias cuando una alerta oficial carece de fotografía propia
function createIntelSVG(sourceName, category, title = '') {
  const isPol = category === 'politica' || category === 'tecnopolitica';
  const accent = isPol ? '#d97706' : '#0284c7';
  const softTint = isPol ? '#fef3c7' : '#e0f2fe';
  const badge = String(sourceName || 'SILVERBOT2 // UNIX').split('—')[0].trim().toUpperCase().replace(/[<>"'&]/g, '');
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
    <text x="82" y="362" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#475569" letter-spacing="0.5">SILVERBOT2 // UNIX — TU HACKNOTICIERO</text>
    <text x="718" y="362" text-anchor="end" font-family="'Inter', system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="${accent}">BOLETÍN VERIFICADO</text>
  </svg>`;

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Parseador nativo de XML para RSS y Atom con extracción de imágenes reales y limpieza de HTML
function parseXMLFeed(xmlText, feedUrl = '') {
  const items = [];
  const cleanXml = xmlText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // Buscar bloques <item> o <entry>
  const itemMatches = cleanXml.match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi) || [];

  for (const block of itemMatches) {
    const summaryMatch = block.match(/<(?:description|summary)[^>]*>([\s\S]*?)<\/(?:description|summary)>/i);
    const contentEncMatch = block.match(/<(?:content:encoded|content)[^>]*>([\s\S]*?)<\/(?:content:encoded|content)>/i);
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const dateMatch = block.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i);

    const title = cleanHtmlContent(titleMatch ? titleMatch[1] : '');
    const link = linkMatch ? linkMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const rawBestBody = (contentEncMatch && contentEncMatch[1]) || (summaryMatch && summaryMatch[1]) || '';
    const rawShortSummary = (summaryMatch && summaryMatch[1]) || rawBestBody;
    const summaryClean = cleanHtmlContent(rawShortSummary);
    const description = cleanHtmlContent(rawBestBody) || summaryClean;

    let pubDate = new Date().toISOString();
    if (dateMatch && dateMatch[1]) {
      const parsed = new Date(dateMatch[1].trim());
      if (!Number.isNaN(parsed.getTime())) pubDate = parsed.toISOString();
    }

    // Decodificar entidades HTML en el bloque para detectar imágenes incluso dentro de contenido escapado
    const searchableBlock = block
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/&amp;/g, '&');

    // Extracción de imagen real de la noticia si existe en la fuente
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

// Despachos de contingencia en castellano si no hay conexión a internet activa
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

// Sincronización de Fuentes en Castellano
async function syncSpanishFeeds() {
  const config = readJSON(CONFIG_FILE, {});
  const feeds = config.feeds || [];
  let articles = readJSON(ARTICLES_FILE, []);
  let newArticlesAdded = 0;

  for (const feed of feeds) {
    if (!feed.enabled) continue;

    let items = [];
    try {
      // Intentar descargar feed online con User-Agent de navegador y timeout de 8 segundos
      const res = await fetch(feed.url, {
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
      // Silenciar fallo puntual de red de un feed concreto para que el resto siga funcionando
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

        // Imagen real de la fuente (o scraping de og:image si el RSS no incluía foto)
        let resolvedImg = (item.imageUrl && isValidArticleImageUrl(item.imageUrl)) ? item.imageUrl.trim() : '';
        if (!resolvedImg && item.link && /^https?:\/\//i.test(item.link)) {
          resolvedImg = await fetchOgImage(item.link);
        }
        const articleImg = resolvedImg || createIntelSVG(feed.name, category, item.title);

        const cleanTitle = cleanHtmlContent(item.title);
        const cleanDesc = cleanHtmlContent(item.description);
        const cleanSum = cleanHtmlContent(item.summaryClean || cleanDesc);

        const newArticle = {
          id: 'auto-es-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          title: sanitizeInput(cleanTitle),
          category,
          sourceName: sanitizeInput(feed.name),
          sourceUrl: sanitizeInput(item.link || feed.url),
          imageUrl: sanitizeInput(articleImg),
          summary: sanitizeInput(cleanSum.slice(0, 260) + (cleanSum.length > 260 ? '...' : '')),
          content: sanitizeInput(cleanDesc + `\n\nFuente oficial en castellano: ${feed.name}.\nConsulta el artículo íntegro y detalles técnicos en el enlace de procedencia original.`),
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
    // Respaldo de emergencia únicamente si el almacenamiento está completamente vacío y no hubo red
    for (const item of FALLBACK_SPANISH_INTEL) {
      articles.push({
        id: 'auto-es-fallback-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        title: sanitizeInput(item.title),
        category: item.category || 'hacking',
        sourceName: sanitizeInput(item.feedSource),
        sourceUrl: sanitizeInput(item.link),
        imageUrl: item.imageUrl,
        summary: sanitizeInput(item.description),
        content: sanitizeInput(item.description),
        tags: ['ciberseguridad'],
        readTime: '3 min',
        isBreaking: false,
        isFeatured: false,
        author: sanitizeInput(item.feedSource),
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
    // Mantener representación equilibrada por fuente (máximo 8 por fuente auto-feed) + publicaciones manuales
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
    // Sincronización inmediata al arrancar el servidor + enriquecimiento de imágenes reales
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
        portalSubtitle: sanitizeInput(body.portalSubtitle || currentConfig.portalSubtitle || 'TU HACKNOTICIERO'),
        portalLogoUrl: body.portalLogoUrl !== undefined ? sanitizeLogoUrl(body.portalLogoUrl) : (currentConfig.portalLogoUrl || 'assets/silverbot-unix-logo.png'),
        contactEmail: body.contactEmail !== undefined ? sanitizeEmail(body.contactEmail) : (currentConfig.contactEmail || ''),
        layoutMode: sanitizeInput(body.layoutMode || currentConfig.layoutMode || 'editorial'),
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
      await enrichStoredArticlesImages();
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
        avatar: isFirst ? 'assets/silverbot-unix-logo.png' : 'assets/silverbot-unix-logo.png',
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
        imageUrl: body.imageUrl || createIntelSVG(`LinkedIn // ${currentUser.displayName}`, category, title),
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
          syncSpanishFeeds()
            .then(() => enrichStoredArticlesImages())
            .catch(e => console.error('Error en sync bajo demanda:', e));
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
        imageUrl: sanitizeInput(body.imageUrl || createIntelSVG(body.sourceName || `LinkedIn // ${currentUser.displayName}`, body.category, body.title)),
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

    // ----------------------------------------------------
    // API FORO COMUNITARIO
    // ----------------------------------------------------

    if (pathname === '/api/forum' && method === 'GET') {
      const threads = readJSON(FORUM_FILE, []);
      threads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      sendJSON(res, 200, threads);
      return;
    }

    if (pathname === '/api/forum' && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'Debes iniciar sesión para abrir un tema en el foro' });
        return;
      }
      if (!checkRateLimit(ip, 15, 60000)) {
        sendJSON(res, 429, { error: 'Demasiadas publicaciones seguidas. Espera un momento.' });
        return;
      }

      const body = await parseBody(req);
      const title = sanitizeInput(body.title || '').slice(0, 160);
      const category = sanitizeInput(body.category || 'General').slice(0, 40);
      const text = sanitizeInput(body.body || '').slice(0, 4000);

      if (!title || !text) {
        sendJSON(res, 400, { error: 'El título y el mensaje son obligatorios' });
        return;
      }

      const threads = readJSON(FORUM_FILE, []);
      const newThread = {
        id: 'frm-' + Date.now(),
        title,
        category,
        body: text,
        author: currentUser.displayName,
        authorId: currentUser.id,
        authorRole: currentUser.role,
        createdAt: new Date().toISOString(),
        replies: []
      };

      threads.unshift(newThread);
      if (threads.length > 100) threads.length = 100;
      writeJSON(FORUM_FILE, threads);
      sendJSON(res, 201, { success: true, thread: newThread });
      return;
    }

    if (/^\/api\/forum\/[^/]+\/reply$/.test(pathname) && method === 'POST') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'Debes iniciar sesión para responder en el foro' });
        return;
      }
      if (!checkRateLimit(ip, 25, 60000)) {
        sendJSON(res, 429, { error: 'Demasiadas respuestas seguidas. Espera un momento.' });
        return;
      }

      const threadId = pathname.split('/')[3];
      const body = await parseBody(req);
      const text = sanitizeInput(body.text || '').slice(0, 2500);
      if (!text) {
        sendJSON(res, 400, { error: 'La respuesta no puede estar vacía' });
        return;
      }

      const threads = readJSON(FORUM_FILE, []);
      const thread = threads.find(t => t.id === threadId);
      if (!thread) {
        sendJSON(res, 404, { error: 'Tema no encontrado' });
        return;
      }

      const reply = {
        id: 'rep-' + Date.now(),
        text,
        author: currentUser.displayName,
        authorId: currentUser.id,
        authorRole: currentUser.role,
        createdAt: new Date().toISOString()
      };

      if (!Array.isArray(thread.replies)) thread.replies = [];
      thread.replies.push(reply);
      writeJSON(FORUM_FILE, threads);
      sendJSON(res, 201, { success: true, reply, thread });
      return;
    }

    if (pathname.startsWith('/api/forum/') && method === 'DELETE') {
      const currentUser = getSessionUser(req);
      if (!currentUser) {
        sendJSON(res, 401, { error: 'No autenticado' });
        return;
      }

      const id = pathname.replace('/api/forum/', '');
      const threads = readJSON(FORUM_FILE, []);
      const target = threads.find(t => t.id === id);
      if (!target) {
        sendJSON(res, 404, { error: 'Tema no encontrado' });
        return;
      }

      if (target.authorId !== currentUser.id && currentUser.role !== 'admin') {
        sendJSON(res, 403, { error: 'Solo el autor o el administrador pueden eliminar este tema' });
        return;
      }

      writeJSON(FORUM_FILE, threads.filter(t => t.id !== id));
      sendJSON(res, 200, { success: true });
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

    // Proxy de imágenes de fuentes externas para eludir bloqueos de hotlinking, tracking y CORS
    if (pathname === '/api/proxy/image' && method === 'GET') {
      const rawUrl = (parsedUrl.query && parsedUrl.query.url) || (new URL(req.url, 'http://localhost')).searchParams.get('url');
      if (!rawUrl || !rawUrl.startsWith('http')) {
        sendJSON(res, 400, { error: 'URL requerida' });
        return;
      }

      const targetUrl = upgradeImageUrl(rawUrl);

      const sendSvgFallback = () => {
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        });
        const fallback = decodeURIComponent(createIntelSVG('REDACCIÓN', 'hacking', 'INFORME DE CIBERSEGURIDAD').replace('data:image/svg+xml;charset=utf-8,', ''));
        res.end(fallback);
      };

      try {
        const upstream = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          },
          signal: AbortSignal.timeout(6500)
        });

        let contentType = (upstream.headers.get('content-type') || '').toLowerCase();
        const buffer = Buffer.from(await upstream.arrayBuffer());
        if (!upstream.ok || buffer.length < 100) {
          sendSvgFallback();
          return;
        }

        // Detección por magic bytes si el servidor origen envía application/octet-stream
        if (!contentType.startsWith('image/')) {
          if (buffer[0] === 0xff && buffer[1] === 0xd8) contentType = 'image/jpeg';
          else if (buffer[0] === 0x89 && buffer[1] === 0x50) contentType = 'image/png';
          else if (buffer.slice(0, 4).toString('ascii') === 'GIF8') contentType = 'image/gif';
          else if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') contentType = 'image/webp';
          else {
            sendSvgFallback();
            return;
          }
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=43200',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(buffer);
      } catch (err) {
        sendSvgFallback();
      }
      return;
    }

    if (pathname === '/robots.txt' && method === 'GET') {
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers.host || 'cyberpolis.onrender.com').replace(/[^a-zA-Z0-9.\-:]/g, '');
      const baseUrl = `${proto}://${host}`;
      const robotsTxt = [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/admin/',
        'Disallow: /api/backup/',
        '',
        `Sitemap: ${baseUrl}/sitemap.xml`
      ].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=UTF-8',
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(robotsTxt);
      return;
    }

    if (pathname === '/sitemap.xml' && method === 'GET') {
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers.host || 'cyberpolis.onrender.com').replace(/[^a-zA-Z0-9.\-:]/g, '');
      const baseUrl = `${proto}://${host}`;
      const escapeXml = str => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const articles = readJSON(ARTICLES_FILE, []);
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
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=UTF-8',
        'Cache-Control': 'public, max-age=1800'
      });
      res.end(xml);
      return;
    }

    serveStatic(req, res, pathname);

  } catch (err) {
    console.error('Error interno del servidor:', err);
    sendJSON(res, 500, { error: 'Error de servidor interno' });
  }
});

ensureFiles();
sanitizeStoredArticles();
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
