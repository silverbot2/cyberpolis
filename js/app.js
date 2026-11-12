/**
 * CYBERPOLIS — TU HACKNOTICIERO
 * Client Application Logic with Auto Spanish RSS Sync, Metrics & Admin Controls
 */

(function () {
  'use strict';

  // ==========================================
  // 1. Estado de la Aplicación
  // ==========================================
  const DEFAULT_AD_BANNER = {
    enabled: true,
    title: '¿Quién manda hoy en The Prison?',
    description: 'Alcatraz en directo: bandas, poder y Trapicheo 24/7.',
    ctaText: 'ENTRAR AHORA ↗',
    targetUrl: 'https://theprison.com/carceles',
    imageUrl: 'assets/ads/theprison-alcatraz.webp',
    logoUrl: 'assets/ads/theprison-marca.webp',
    delaySeconds: 2,
    durationSeconds: 15,
    position: 'bottom-right',
    size: 'compact'
  };

  const state = {
    articles: [],
    currentUser: null,
    config: {
      autoSyncEnabled: true,
      syncIntervalMinutes: 30,
      lastSync: null,
      themeAccent: 'cyan',
      polygonDensity: 'paused',
      portalTitle: 'CYBERPOLIS',
      portalSubcallsign: '',
      portalSubtitle: 'TU HACKNOTICIERO',
      portalLogoUrl: 'assets/silverbot-unix-logo.png',
      contactEmail: '',
      layoutMode: 'editorial',
      adBanner: { ...DEFAULT_AD_BANNER },
      feeds: [
        { id: "feed-redeszone", name: "RedesZone — Seguridad y Redes", url: "https://www.redeszone.net/feed/", category: "hacking", enabled: true },
        { id: "feed-cybernews-es", name: "CyberSecurity News ES", url: "https://www.cybersecuritynews.es/feed/", category: "hacking", enabled: true },
        { id: "feed-unaaldia", name: "Una al Día — Hispasec", url: "https://unaaldia.hispasec.com/feed", category: "hacking", enabled: true },
        { id: "feed-hackplayers", name: "HackPlayers — Ciberseguridad", url: "https://www.hackplayers.com/feeds/posts/default?alt=rss", category: "hacking", enabled: true },
        { id: "feed-genbeta-sec", name: "Genbeta — Ciberseguridad", url: "https://www.genbeta.com/tag/ciberseguridad/rss2.xml", category: "hacking", enabled: true },
        { id: "feed-eldiario-tecno", name: "elDiario.es — Tecnopolítica y Sociedad", url: "https://www.eldiario.es/rss/tecnologia/", category: "tecnopolitica", enabled: true }
      ]
    },
    currentCategory: 'all',
    currentTag: 'all',
    searchQuery: '',
    sortBy: 'recent',
    bookmarks: new Set(JSON.parse(localStorage.getItem('silverbot_bookmarks') || '[]')),
    theme: localStorage.getItem('silverbot_theme_v3') || 'light',
    serverMode: false,
    activeReaderArticle: null,
    forumThreads: [],
    forumView: 'index',
    forumFilter: 'Todos',
    forumPrefixFilter: 'Todos',
    activeForumThreadId: null,
    pendingLogoDataUrl: null,
    pendingAdImageDataUrl: null,
    adShowTimer: null,
    adHideTimer: null,
    adCountdownRemainingMs: 0,
    adCountdownStartedAt: 0,
    adLastRenderKey: '',
    chat: {
      channel: '#cyberpolis',
      topic: 'Bienvenidos a #cyberpolis — Hacknoticiero & Debate IRC en vivo',
      enabled: true,
      allowGuests: true,
      moderatedMode: false,
      theme: 'mirc-classic',
      messages: [],
      onlineUsers: [],
      opNickNames: [],
      voiceNickNames: [],
      mutedNickNames: [],
      isChannelOp: false,
      identityPrefix: '',
      isBanned: false,
      isMuted: false,
      guestNick: localStorage.getItem('cyberpolis_irc_nick') || '',
      collapsed: true,
      popupsEnabled: localStorage.getItem('cyberpolis_irc_popups') !== '0',
      ignoredNicks: new Set((() => {
        try { return JSON.parse(localStorage.getItem('cyberpolis_irc_ignored') || '[]'); } catch (e) { return []; }
      })()),
      hideNicks: false,
      sse: null,
      pollTimer: null,
      lastSessionKey: '',
      bootstrapped: false,
      seenIds: new Set(),
      unreadIds: new Set(),
      lastReadActivityAt: Date.now(),
      contextTargetNick: '',
      contextTargetMode: ''
    },
    adminMetrics: null,
    adminUsers: [],
    systemStatus: null,
    adminUserSearch: '',
    resetPasswordUserId: null,
    confirmDeleteUserId: null
  };

  function apiFetch(url, options = {}) {
    return fetch(url, {
      credentials: 'same-origin',
      ...options
    });
  }

  function safeHref(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed, window.location.origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (e) {}
    return '';
  }

  function generateStrongPassword(length = 12) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const buf = new Uint32Array(length);
    window.crypto.getRandomValues(buf);
    let out = 'Cy!';
    for (let i = 0; i < Math.max(8, length - 3); i++) {
      out += chars[buf[i] % chars.length];
    }
    return out + '9';
  }

  const ENTITY_MAP = {
    '&quot;': '"', '&#039;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&',
    '&nbsp;': ' ', '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó',
    '&uacute;': 'ú', '&ntilde;': 'ñ', '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í',
    '&Oacute;': 'Ó', '&Uacute;': 'Ú', '&Ntilde;': 'Ñ', '&laquo;': '«', '&raquo;': '»',
    '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'", '&mdash;': '—',
    '&ndash;': '–', '&hellip;': '...'
  };

  // Limpiador total de etiquetas HTML y decodificador de entidades para evitar código crudo en pantalla
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

  // Manejador global robusto de error de imagen: si la fuente externa falla, asigna la portada editorial SVG del artículo
  window.handleImgError = function(img) {
    if (!img) return;
    img.onerror = null;
    const card = img.closest('[data-id]') || img.closest('article');
    const artId = card ? card.getAttribute('data-id') : null;
    const art = artId ? state.articles.find(a => a.id === artId) : null;
    if (art) {
      img.src = createIntelSVG(art.sourceName, art.category, art.title);
      return;
    }
    const badge = card ? (card.querySelector('.dispatch-source, .source-token-link')?.textContent || 'REDACCIÓN') : 'REDACCIÓN';
    img.src = createIntelSVG(badge.replace(/ORIGEN|\/\//g, '').trim(), 'hacking', img.alt || 'INFORME DE ACTUALIDAD');
  };

  function isClientImageValid(imgUrl) {
    if (!imgUrl || typeof imgUrl !== 'string') return false;
    const lower = imgUrl.trim().toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
    const blacklist = ['unsplash.com', 's.w.org/images/core/emoji', 'gravatar.com', 'feedburner.com', 'doubleclick.net', 'pixel.', '1x1.', 'spacer.', 'blank.gif', 'favicon.', 'apple-touch-icon'];
    if (blacklist.some(b => lower.includes(b)) || lower.endsWith('.ico')) return false;
    return true;
  }

  function upgradeClientImageUrl(imgUrl) {
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

  // Generador de portadas editoriales limpias cuando una alerta carece de fotografía propia
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

  // Resuelve la URL de la imagen enrutando fuentes externas por el proxy del servidor para eludir bloqueos
  function resolveArticleImage(url, category, sourceName, title) {
    if (!url) return getDefaultImage(category, sourceName, title);
    if (url.startsWith('data:image/svg+xml')) {
      if (url.includes('%26') || url.includes('&') || url.includes('04070d') || url.includes('HUD')) {
        return createIntelSVG(sourceName, category, title);
      }
      return url;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const upgraded = upgradeClientImageUrl(url);
      if (!isClientImageValid(upgraded)) {
        return createIntelSVG(sourceName, category, title);
      }
      if (state.serverMode || (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http'))) {
        return `/api/proxy/image?url=${encodeURIComponent(upgraded)}`;
      }
      return upgraded;
    }
    return url;
  }

  const DEFAULT_SEED_ARTICLES = [
    {
      id: "svb-001",
      title: "Alerta de Inteligencia: Campaña de ingeniería social masiva en LinkedIn con infostealers Lumma y RedLine",
      category: "hacking",
      summary: "Identificada una red de perfiles señuelo haciéndose pasar por consultoras de talento IT internacionales para distribuir troyanos empaquetados en archivos supuestamente confidenciales.",
      content: "Durante el último ciclo de monitorización de amenazas se ha constatado un repunte agresivo en ataques dirigidos a perfiles técnicos, analistas de datos y desarrolladores en LinkedIn.\n\nModus Operandi:\n• Los atacantes entablan contacto ofreciendo posiciones remotas con salarios fuera de mercado.\n• Solicitan realizar una supuesta prueba técnica descargable desde repositorios privados o enlaces compartidos.\n• El paquete contiene ejecutables ofuscados o scripts de PowerShell que eluden la detección perimetral e instalan 'Lumma Stealer', extrayendo cookies de sesión activas, credenciales de navegador y monederos de criptomonedas en segundos.\n\nContramedidas Urgentes:\n• No descargar bajo ningún concepto archivos ejecutables (.exe, .bat, .cmd, .scr) enviados por chat.\n• Forzar el cierre de sesiones remotas y validar periódicamente los tokens OAuth.\n• Implementar aislamiento de navegador (RBI) para la navegación corporativa en redes sociales.",
      sourceName: "LinkedIn Threat Intel",
      sourceUrl: "https://www.linkedin.com",
      author: "Silverbot2 // Unix",
      authorRole: "admin",
      authorId: "usr-admin-01",
      verifiedLinkedIn: true,
      date: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
      imageUrl: createIntelSVG('LinkedIn Threat Intel', 'hacking', 'ALERTA PHISHING E INFOSTEALERS'),
      tags: ["linkedin", "phishing", "infostealer", "ingeniería-social", "malware"],
      isBreaking: true,
      isFeatured: false,
      views: 520,
      readTime: "3 min"
    },
    {
      id: "auto-es-incibe-01",
      title: "INCIBE alerta sobre campaña activa de 'Smishing' suplantando a la Agencia Tributaria con malware bancario",
      category: "hacking",
      summary: "El Instituto Nacional de Ciberseguridad ha detectado una oleada masiva de mensajes SMS fraudulentos que instan a los contribuyentes a descargar una supuesta actualización de la app oficial para cobrar una devolución, instalando un troyano de acceso remoto.",
      content: "El Instituto Nacional de Ciberseguridad (INCIBE) ha emitido una alerta de nivel alto por una campaña de phishing a través de SMS (smishing).\n\nLos mensajes fraudulentos incluyen enlaces a dominios falsos que imitan la estética oficial de la Agencia Tributaria. Al acceder, se descarga un archivo APK malicioso que solicita permisos de accesibilidad para interceptar códigos de verificación bancarios.\n\nMedidas recomendadas por INCIBE:\n• Nunca descargar aplicaciones fuera de las tiendas oficiales (Google Play Store o App Store).\n• La Agencia Tributaria nunca solicita datos bancarios ni envía enlaces de descarga directa por SMS.\n• En caso de infección, desinstalar la app en modo seguro y contactar con la entidad bancaria.",
      sourceName: "INCIBE — Avisos de Seguridad",
      sourceUrl: "https://www.incibe.es",
      author: "INCIBE",
      authorRole: "feed",
      verifiedLinkedIn: false,
      isAutoFeed: true,
      date: new Date(Date.now() - 1000 * 60 * 50).toISOString(),
      imageUrl: createIntelSVG('INCIBE — Avisos de Seguridad', 'hacking', 'ALERTA SMISHING AGENCIA TRIBUTARIA'),
      tags: ["incibe", "ciberseguridad", "smishing", "phishing", "malware"],
      isBreaking: true,
      isFeatured: false,
      views: 410,
      readTime: "3 min"
    },
    {
      id: "svb-002",
      title: "La Unión Europea activa el régimen de supervisión de la directiva NIS2 con multas directas a juntas directivas",
      category: "politica",
      summary: "Los estados miembros implementan la directiva de ciberresiliencia estableciendo la obligación de notificar cualquier brecha de seguridad grave en menos de 24 horas.",
      content: "La agenda política y de seguridad en el continente da un giro decisivo con la entrada en vigor operativa de NIS2.\n\nLa normativa no solo amplía la definición de infraestructuras críticas a proveedores de software, cadenas logísticas y centros de datos, sino que introduce un mecanismo punitivo sin precedentes: los miembros de consejos de administración pueden ser inhabilitados profesionalmente si se demuestra negligencia en la protección de sistemas esenciales.\n\nPuntos Clave del Marco Político:\n• Plazo estricto: Alerta temprana obligatoria en 24h ante el CSIRT nacional.\n• Multas de hasta 10 millones de euros o el 2% del volumen de negocio global.\n• Creación del marco EU-CyCLONe para respuesta coordinada ante cibercrisis a escala geopolítica.",
      sourceName: "Comisión Europea / Política Digital",
      sourceUrl: "https://ec.europa.eu",
      author: "Silverbot2 // Unix",
      authorRole: "admin",
      authorId: "usr-admin-01",
      verifiedLinkedIn: true,
      date: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
      imageUrl: createIntelSVG('Comisión Europea // NIS2', 'politica', 'DIRECTIVA NIS2 — SUPERVISIÓN Y MULTAS'),
      tags: ["nis2", "union-europea", "legislacion", "politica", "normativa"],
      isBreaking: false,
      isFeatured: false,
      views: 340,
      readTime: "4 min"
    },
    {
      id: "auto-es-hispasec-01",
      title: "Una al Día: Análisis de vulnerabilidad crítica en núcleos Linux que compromete privilegios root en servidores",
      category: "hacking",
      summary: "Investigadores de Hispasec desglosan el fallo de desbordamiento en el subsistema de gestión de memoria virtual del kernel. Se recomienda actualizar inmediatamente las distribuciones corporativas afectadas.",
      content: "El equipo de investigación de 'Una al Día' (Hispasec) ha publicado el análisis forense de una vulnerabilidad de escalada local de privilegios que afecta a los kernels Linux 5.x y 6.x.\n\nEl fallo reside en una condición de carrera en la gestión de páginas de memoria compartida (Dirty COW variant). Un usuario con acceso restringido puede forzar la sobrescritura de ficheros protegidos como /etc/passwd o inyectar código en procesos con permisos de superusuario.",
      sourceName: "Una al Día (Hispasec)",
      sourceUrl: "https://unaaldia.hispasec.com",
      author: "Una al Día (Hispasec)",
      authorRole: "feed",
      verifiedLinkedIn: false,
      isAutoFeed: true,
      date: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
      imageUrl: createIntelSVG('Una al Día (Hispasec)', 'hacking', 'VULNERABILIDAD KERNEL LINUX ROOT'),
      tags: ["unaaldia", "hispasec", "linux", "0-day", "kernel"],
      isBreaking: false,
      isFeatured: false,
      views: 380,
      readTime: "4 min"
    },
    {
      id: "auto-es-ccn-01",
      title: "CCN-CERT publica la guía de implementación de medidas urgentes para el cumplimiento de la Directiva NIS2",
      category: "tecnopolitica",
      summary: "El Centro Criptológico Nacional emite el marco de referencia técnico para que las entidades críticas y esenciales implanten los controles criptográficos y el protocolo de notificación en menos de 24 horas.",
      content: "El Centro Criptológico Nacional (CCN-CERT), adscrito al Centro Nacional de Inteligencia (CNI), ha puesto a disposición de las administraciones públicas y operadores de servicios esenciales la nueva serie de guías CCN-STIC 800 para la adaptación a la normativa europea NIS2.\n\nLa guía detalla las pautas de auditoría técnica, los requisitos de firma electrónica avanzada y el catálogo de productos de seguridad cualificados.",
      sourceName: "CCN-CERT (Centro Criptológico Nacional)",
      sourceUrl: "https://www.ccn-cert.cni.es",
      author: "CCN-CERT",
      authorRole: "feed",
      verifiedLinkedIn: false,
      isAutoFeed: true,
      date: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
      imageUrl: createIntelSVG('CCN-CERT // CNI', 'tecnopolitica', 'GUÍA DE MEDIDAS URGENTES NIS2'),
      tags: ["ccn-cert", "cni", "nis2", "tecnopolitica", "ciberdefensa"],
      isBreaking: false,
      isFeatured: false,
      views: 290,
      readTime: "4 min"
    }
  ];

  // ==========================================
  // 2. Selectores del DOM
  // ==========================================
  const DOM = {
    tickerTrack: document.getElementById('tickerTrack'),
    systemClock: document.getElementById('systemClock'),
    autoSyncBadge: document.getElementById('autoSyncBadge'),
    searchInput: document.getElementById('searchInput'),
    clearSearchBtn: document.getElementById('clearSearchBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    backupModalBtn: document.getElementById('backupModalBtn'),
    openNewArticleModalBtn: document.getElementById('openNewArticleModalBtn'),
    openLinkedInModalBtn: document.getElementById('openLinkedInModalBtn'),
    openAdminControlBtn: document.getElementById('openAdminControlBtn'),
    userSessionWidget: document.getElementById('userSessionWidget'),
    categoryTabs: document.getElementById('categoryTabs'),
    sortSelect: document.getElementById('sortSelect'),
    popularTagsBar: document.getElementById('popularTagsBar'),
    featuredSection: document.getElementById('featuredSection'),
    articlesGrid: document.getElementById('articlesGrid'),
    emptyState: document.getElementById('emptyState'),
    emptyMessage: document.getElementById('emptyMessage'),
    resetFiltersBtn: document.getElementById('resetFiltersBtn'),
    emptyCreateBtn: document.getElementById('emptyCreateBtn'),
    feedTitle: document.getElementById('feedTitle'),
    feedMeta: document.getElementById('feedMeta'),
    serverStatusBadge: document.getElementById('serverStatusBadge'),
    syncStatusText: document.getElementById('syncStatusText'),
    toastContainer: document.getElementById('toastContainer'),
    brandResetBtn: document.getElementById('brandResetBtn'),

    // Elementos de Identidad Transformables
    uiPortalLogo: document.getElementById('uiPortalLogo'),
    uiPortalTitle: document.getElementById('uiPortalTitle'),
    uiPortalSlash: document.getElementById('uiPortalSlash'),
    uiPortalSubcallsign: document.getElementById('uiPortalSubcallsign'),
    uiPortalSubtitle: document.getElementById('uiPortalSubtitle'),
    tagsMatrix: document.querySelector('.tags-matrix'),
    feedHeader: document.querySelector('.feed-header-module'),
    forumSection: document.getElementById('forumSection'),
    contactSection: document.getElementById('contactSection'),
    legalModal: document.getElementById('legalModal'),
    legalModalTitle: document.getElementById('legalModalTitle'),
    legalModalBody: document.getElementById('legalModalBody'),
    legalTabsRow: document.getElementById('legalTabsRow'),
    closeLegalModalBtn: document.getElementById('closeLegalModalBtn'),
    closeLegalFooterBtn: document.getElementById('closeLegalFooterBtn'),
    footerContactLink: document.getElementById('footerContactLink'),
    footerCopyrightBrand: document.getElementById('footerCopyrightBrand'),

    // Contadores
    countAll: document.getElementById('countAll'),
    countHacking: document.getElementById('countHacking'),
    countPolitica: document.getElementById('countPolitica'),
    countTecno: document.getElementById('countTecno'),
    countBookmarks: document.getElementById('countBookmarks'),
    countForum: document.getElementById('countForum'),

    // Modal Panel Admin & Transformador
    adminControlModal: document.getElementById('adminControlModal'),
    closeAdminControlBtn: document.getElementById('closeAdminControlBtn'),
    closeAdminModalFooterBtn: document.getElementById('closeAdminModalFooterBtn'),
    adminTabFeedsBtn: document.getElementById('adminTabFeedsBtn'),
    adminTabMetricsBtn: document.getElementById('adminTabMetricsBtn'),
    adminTabUsersBtn: document.getElementById('adminTabUsersBtn'),
    adminTabTransformBtn: document.getElementById('adminTabTransformBtn'),
    adminTabChatBtn: document.getElementById('adminTabChatBtn'),
    adminTabAdsBtn: document.getElementById('adminTabAdsBtn'),
    adminTabSecurityBtn: document.getElementById('adminTabSecurityBtn'),
    adminFeedsSection: document.getElementById('adminFeedsSection'),
    adminMetricsSection: document.getElementById('adminMetricsSection'),
    adminUsersSection: document.getElementById('adminUsersSection'),
    adminTransformSection: document.getElementById('adminTransformSection'),
    adminChatSection: document.getElementById('adminChatSection'),
    adminAdsSection: document.getElementById('adminAdsSection'),
    adminSecuritySection: document.getElementById('adminSecuritySection'),
    portalChatShell: document.getElementById('portalChatShell'),
    ircLateralPanel: document.getElementById('ircLateralPanel'),
    mircWindow: document.getElementById('mircWindow'),
    ircTitlebarText: document.getElementById('ircTitlebarText'),
    ircLiveBadge: document.getElementById('ircLiveBadge'),
    ircPopupToggleBtn: document.getElementById('ircPopupToggleBtn'),
    ircToggleNicksBtn: document.getElementById('ircToggleNicksBtn'),
    ircAdminShortcutBtn: document.getElementById('ircAdminShortcutBtn'),
    ircCollapseBtn: document.getElementById('ircCollapseBtn'),
    ircChannelBadge: document.getElementById('ircChannelBadge'),
    ircTopicBar: document.getElementById('ircTopicBar'),
    ircTopicText: document.getElementById('ircTopicText'),
    ircTopicInlineInput: document.getElementById('ircTopicInlineInput'),
    ircBody: document.getElementById('ircBody'),
    ircMessagesList: document.getElementById('ircMessagesList'),
    ircNickList: document.getElementById('ircNickList'),
    ircContextMenu: document.getElementById('ircContextMenu'),
    ircGuestNickInput: document.getElementById('ircGuestNickInput'),
    ircIdentityBadge: document.getElementById('ircIdentityBadge'),
    ircOnlineCount: document.getElementById('ircOnlineCount'),
    ircChatForm: document.getElementById('ircChatForm'),
    ircChatInput: document.getElementById('ircChatInput'),
    ircSendBtn: document.getElementById('ircSendBtn'),
    ircReopenTab: document.getElementById('ircReopenTab'),
    ircReopenLabel: document.getElementById('ircReopenLabel'),
    ircReopenBadge: document.getElementById('ircReopenBadge'),
    ircHeaderToggleBtn: document.getElementById('ircHeaderToggleBtn'),
    ircHeaderBadge: document.getElementById('ircHeaderBadge'),
    ircPopupContainer: document.getElementById('ircPopupContainer'),
    chatAdminEnabledToggle: document.getElementById('chatAdminEnabledToggle'),
    chatAdminAllowGuestsToggle: document.getElementById('chatAdminAllowGuestsToggle'),
    chatAdminModeratedToggle: document.getElementById('chatAdminModeratedToggle'),
    chatAdminChannelInput: document.getElementById('chatAdminChannelInput'),
    chatAdminThemeSelect: document.getElementById('chatAdminThemeSelect'),
    chatAdminTopicInput: document.getElementById('chatAdminTopicInput'),
    chatAdminRefreshBtn: document.getElementById('chatAdminRefreshBtn'),
    chatAdminSaveConfigBtn: document.getElementById('chatAdminSaveConfigBtn'),
    chatAdminNoticeInput: document.getElementById('chatAdminNoticeInput'),
    chatAdminNoticeBtn: document.getElementById('chatAdminNoticeBtn'),
    chatAdminClearBtn: document.getElementById('chatAdminClearBtn'),
    chatAdminModNickInput: document.getElementById('chatAdminModNickInput'),
    chatAdminModReasonInput: document.getElementById('chatAdminModReasonInput'),
    chatAdminOpBtn: document.getElementById('chatAdminOpBtn'),
    chatAdminVoiceBtn: document.getElementById('chatAdminVoiceBtn'),
    chatAdminMuteBtn: document.getElementById('chatAdminMuteBtn'),
    chatAdminKickBtn: document.getElementById('chatAdminKickBtn'),
    chatAdminBanBtn: document.getElementById('chatAdminBanBtn'),
    chatAdminMessagesList: document.getElementById('chatAdminMessagesList'),
    chatAdminBansList: document.getElementById('chatAdminBansList'),
    floatingAdBanner: document.getElementById('floatingAdBanner'),
    adEnabledToggle: document.getElementById('adEnabledToggle'),
    adDelayInput: document.getElementById('adDelayInput'),
    adDurationInput: document.getElementById('adDurationInput'),
    adPositionSelect: document.getElementById('adPositionSelect'),
    adSizeSelect: document.getElementById('adSizeSelect'),
    adTitleInput: document.getElementById('adTitleInput'),
    adDescInput: document.getElementById('adDescInput'),
    adCtaInput: document.getElementById('adCtaInput'),
    adTargetUrlInput: document.getElementById('adTargetUrlInput'),
    adImageUrlInput: document.getElementById('adImageUrlInput'),
    adImageFile: document.getElementById('adImageFile'),
    adImagePreview: document.getElementById('adImagePreview'),
    adLogoUrlInput: document.getElementById('adLogoUrlInput'),
    adResetBtn: document.getElementById('adResetBtn'),
    adPreviewBtn: document.getElementById('adPreviewBtn'),
    adSaveBtn: document.getElementById('adSaveBtn'),
    adminSystemStatusContent: document.getElementById('adminSystemStatusContent'),
    refreshSystemStatusBtn: document.getElementById('refreshSystemStatusBtn'),
    adminOpenChangePassBtn: document.getElementById('adminOpenChangePassBtn'),
    adminMetricsContent: document.getElementById('adminMetricsContent'),
    refreshMetricsBtn: document.getElementById('refreshMetricsBtn'),
    resetMetricsBtn: document.getElementById('resetMetricsBtn'),
    adminUserSearchInput: document.getElementById('adminUserSearchInput'),
    toggleAdminCreateUserBtn: document.getElementById('toggleAdminCreateUserBtn'),
    adminCreateUserForm: document.getElementById('adminCreateUserForm'),
    cancelAdminCreateUserBtn: document.getElementById('cancelAdminCreateUserBtn'),
    adminUsersManageList: document.getElementById('adminUsersManageList'),
    admNewUsername: document.getElementById('admNewUsername'),
    admNewDisplayName: document.getElementById('admNewDisplayName'),
    admNewEmail: document.getElementById('admNewEmail'),
    admNewRole: document.getElementById('admNewRole'),
    admNewPassword: document.getElementById('admNewPassword'),
    adminAutoSyncToggle: document.getElementById('adminAutoSyncToggle'),
    adminSyncIntervalSelect: document.getElementById('adminSyncIntervalSelect'),
    adminForceSyncBtn: document.getElementById('adminForceSyncBtn'),
    adminLastSyncText: document.getElementById('adminLastSyncText'),
    adminFeedsList: document.getElementById('adminFeedsList'),
    saveAdminFeedsBtn: document.getElementById('saveAdminFeedsBtn'),
    accentColorPicker: document.getElementById('accentColorPicker'),
    polygonModeSelector: document.getElementById('polygonModeSelector'),
    layoutModeSelector: document.getElementById('layoutModeSelector'),
    adminPortalTitleInput: document.getElementById('adminPortalTitleInput'),
    adminPortalSubcallsignInput: document.getElementById('adminPortalSubcallsignInput'),
    adminPortalSubtitleInput: document.getElementById('adminPortalSubtitleInput'),
    adminContactEmailInput: document.getElementById('adminContactEmailInput'),
    adminLogoPreview: document.getElementById('adminLogoPreview'),
    adminPortalLogoInput: document.getElementById('adminPortalLogoInput'),
    adminPortalLogoFile: document.getElementById('adminPortalLogoFile'),
    adminResetLogoBtn: document.getElementById('adminResetLogoBtn'),
    applyTransformBtn: document.getElementById('applyTransformBtn'),
    cancelTransformBtn: document.getElementById('cancelTransformBtn'),

    // Modal Autenticación
    authModal: document.getElementById('authModal'),
    closeAuthModalBtn: document.getElementById('closeAuthModalBtn'),
    tabLoginBtn: document.getElementById('tabLoginBtn'),
    tabRegisterBtn: document.getElementById('tabRegisterBtn'),
    loginForm: document.getElementById('loginForm'),
    registerForm: document.getElementById('registerForm'),
    loginUsername: document.getElementById('loginUsername'),
    loginPassword: document.getElementById('loginPassword'),
    regUsername: document.getElementById('regUsername'),
    regDisplayName: document.getElementById('regDisplayName'),
    regPassword: document.getElementById('regPassword'),
    regLinkedIn: document.getElementById('regLinkedIn'),
    cancelAuthBtn: document.getElementById('cancelAuthBtn'),
    cancelRegisterBtn: document.getElementById('cancelRegisterBtn'),

    // Modal LinkedIn
    linkedInModal: document.getElementById('linkedInModal'),
    closeLinkedInModalBtn: document.getElementById('closeLinkedInModalBtn'),
    linkedInIngestionForm: document.getElementById('linkedInIngestionForm'),
    lnPostUrl: document.getElementById('lnPostUrl'),
    lnPostText: document.getElementById('lnPostText'),
    lnCustomTitle: document.getElementById('lnCustomTitle'),
    lnCategoryHint: document.getElementById('lnCategoryHint'),
    lnIsBreaking: document.getElementById('lnIsBreaking'),
    closeLnBtn: document.getElementById('closeLnBtn'),

    // Modal Directorio Usuarios
    usersDirectoryModal: document.getElementById('usersDirectoryModal'),
    closeUsersModalBtn: document.getElementById('closeUsersModalBtn'),
    usersDirectoryList: document.getElementById('usersDirectoryList'),

    // Modal Noticia Manual
    articleFormModal: document.getElementById('articleFormModal'),
    closeFormModalBtn: document.getElementById('closeFormModalBtn'),
    cancelFormBtn: document.getElementById('cancelFormBtn'),
    articleForm: document.getElementById('articleForm'),
    formModalTitle: document.getElementById('formModalTitle'),
    editArticleId: document.getElementById('editArticleId'),
    formTitle: document.getElementById('formTitle'),
    formCategory: document.getElementById('formCategory'),
    formSourceName: document.getElementById('formSourceName'),
    formSourceUrl: document.getElementById('formSourceUrl'),
    formImageUrl: document.getElementById('formImageUrl'),
    previewImgBtn: document.getElementById('previewImgBtn'),
    formSummary: document.getElementById('formSummary'),
    formContent: document.getElementById('formContent'),
    formTags: document.getElementById('formTags'),
    formReadTime: document.getElementById('formReadTime'),
    formIsBreaking: document.getElementById('formIsBreaking'),
    formIsFeatured: document.getElementById('formIsFeatured'),

    // Modal Lector
    readerModal: document.getElementById('readerModal'),
    closeReaderModalBtn: document.getElementById('closeReaderModalBtn'),
    readerContentArea: document.getElementById('readerContentArea'),
    readerBadges: document.getElementById('readerBadges'),
    readerBookmarkBtn: document.getElementById('readerBookmarkBtn'),
    readerShareBtn: document.getElementById('readerShareBtn'),

    // Modal Backup
    backupModal: document.getElementById('backupModal'),
    closeBackupModalBtn: document.getElementById('closeBackupModalBtn'),
    backupPersistenceBanner: document.getElementById('backupPersistenceBanner'),
    exportFullBackupBtn: document.getElementById('exportFullBackupBtn'),
    importFullBackupInput: document.getElementById('importFullBackupInput'),
    exportJsonBtn: document.getElementById('exportJsonBtn'),
    importJsonFileInput: document.getElementById('importJsonFileInput'),
    resetDemoBtn: document.getElementById('resetDemoBtn'),

    // Modal Cambio de Contraseña
    changePasswordModal: document.getElementById('changePasswordModal'),
    closeChangePassBtn: document.getElementById('closeChangePassBtn'),
    cancelChangePassBtn: document.getElementById('cancelChangePassBtn'),
    changePasswordForm: document.getElementById('changePasswordForm'),
    curPassInput: document.getElementById('curPassInput'),
    newPassInput: document.getElementById('newPassInput'),
    confirmPassInput: document.getElementById('confirmPassInput')
  };

  // ==========================================
  // 3. Inicialización
  // ==========================================
  async function init() {
    try { localStorage.removeItem('silverbot_auth_token'); } catch (e) {}
    applyTheme(state.theme);
    startLiveClock();
    bindEvents();
    setupShortcuts();

    await checkServerConnection();
    await checkAuthSession();
    await loadConfig();
    await loadArticles();
    await loadForum();

    applySiteTransformation(state.config);
    renderUserWidget();
    renderAll();
    initLiveIrcChat();
    handleUrlSeoParams();
    trackClientVisit(window.location.pathname + window.location.search);

    // Auto-recarga silenciosa de noticias cada 3 minutos para mostrar despachos frescos sin recargar
    setInterval(async () => {
      await loadArticles();
      renderAll();
    }, 3 * 60 * 1000);
  }

  function startLiveClock() {
    function update() {
      const now = new Date();
      if (DOM.systemClock) {
        DOM.systemClock.textContent = now.toISOString().slice(11, 19) + ' UTC';
      }
    }
    update();
    setInterval(update, 1000);
  }

  // ==========================================
  // 4. Configuración y Transformación Visual
  // ==========================================
  async function loadConfig() {
    if (state.serverMode) {
      try {
        const res = await fetch('/api/admin/config');
        if (res.ok) {
          const cfg = await res.json();
          state.config = {
            ...state.config,
            ...cfg,
            adBanner: { ...DEFAULT_AD_BANNER, ...(cfg.adBanner || {}) }
          };
          return;
        }
      } catch (e) {}
    }

    const localCfg = localStorage.getItem('silverbot_config');
    if (localCfg) {
      try {
        const parsed = JSON.parse(localCfg);
        state.config = {
          ...state.config,
          ...parsed,
          adBanner: { ...DEFAULT_AD_BANNER, ...(parsed.adBanner || {}) }
        };
      } catch (e) {}
    }
  }

  function getPortalBrandLabel(includeSubtitle = false) {
    const title = (state.config.portalTitle || 'CYBERPOLIS').trim();
    const sub = (state.config.portalSubcallsign || '').trim();
    const subtitle = (state.config.portalSubtitle || 'TU HACKNOTICIERO').trim();
    const base = sub ? `${title} // ${sub}` : title;
    return includeSubtitle && subtitle ? `${base} — ${subtitle}` : base;
  }

  function applySiteTransformation(cfg) {
    if (!cfg) return;

    // 1. Color de Acento Neón
    const accents = ['cyan', 'emerald', 'amber', 'crimson', 'silver', 'indigo'];
    accents.forEach(acc => document.body.classList.remove(`theme-accent-${acc}`));
    document.body.classList.add(`theme-accent-${cfg.themeAccent || 'cyan'}`);

    // 2. Disposición de Tarjetas (Layout Mode)
    document.body.classList.remove('layout-normal', 'layout-compact', 'layout-editorial');
    document.body.classList.add(`layout-${cfg.layoutMode || 'normal'}`);

    // 3. Títulos, Logo e Identidad
    const titleVal = (cfg.portalTitle || 'CYBERPOLIS').trim();
    const subVal = (cfg.portalSubcallsign || '').trim();
    const subtitleVal = (cfg.portalSubtitle || 'TU HACKNOTICIERO').trim();
    if (DOM.uiPortalTitle) DOM.uiPortalTitle.textContent = titleVal;
    if (DOM.uiPortalSlash) DOM.uiPortalSlash.style.display = subVal ? 'inline' : 'none';
    if (DOM.uiPortalSubcallsign) {
      DOM.uiPortalSubcallsign.textContent = subVal;
      DOM.uiPortalSubcallsign.style.display = subVal ? 'inline' : 'none';
    }
    if (DOM.uiPortalSubtitle) DOM.uiPortalSubtitle.textContent = subtitleVal;
    const activeLogo = cfg.portalLogoUrl || 'assets/silverbot-unix-logo.png';
    if (DOM.uiPortalLogo) {
      DOM.uiPortalLogo.src = activeLogo;
      DOM.uiPortalLogo.onerror = () => {
        DOM.uiPortalLogo.onerror = null;
        DOM.uiPortalLogo.src = 'assets/silverbot-unix-logo.png';
      };
    }
    if (DOM.adminLogoPreview) {
      DOM.adminLogoPreview.src = activeLogo;
      DOM.adminLogoPreview.onerror = () => {
        DOM.adminLogoPreview.onerror = null;
        DOM.adminLogoPreview.src = 'assets/silverbot-unix-logo.png';
      };
    }
    if (DOM.footerCopyrightBrand) {
      DOM.footerCopyrightBrand.textContent = getPortalBrandLabel(true);
    }
    if (state.currentCategory === 'contact') {
      renderContact();
    }
    updateSeoMeta(state.activeReaderArticle);

    // 4. Malla de Polígonos 3D
    if (window.polygonEngine) {
      const canvas = document.getElementById('polygonCanvas');
      if (cfg.polygonDensity === 'paused') {
        if (canvas) canvas.style.opacity = '0.15';
      } else if (cfg.polygonDensity === 'dense') {
        if (canvas) canvas.style.opacity = '0.9';
      } else if (cfg.polygonDensity === 'minimal') {
        if (canvas) canvas.style.opacity = '0.4';
      } else {
        if (canvas) canvas.style.opacity = '0.72';
      }
    }

    // 5. Badge de Sincronización Automática
    if (DOM.autoSyncBadge) {
      DOM.autoSyncBadge.textContent = cfg.autoSyncEnabled ? '📡 AUTO-SYNC: ON' : '📡 AUTO-SYNC: OFF';
      DOM.autoSyncBadge.style.color = cfg.autoSyncEnabled ? 'var(--accent-cyan)' : 'var(--text-muted)';
    }

    // 6. Banner Publicitario Lateral Flotante y Temporal
    renderFloatingAdBanner(false, cfg.adBanner);
  }

  function safeAdMediaSrc(raw, fallback = '') {
    if (!raw || typeof raw !== 'string') return fallback;
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-zA-Z0-9+/=]+$/i.test(trimmed)) {
      return trimmed;
    }
    const href = safeHref(trimmed);
    return href || fallback;
  }

  function getNormalizedAdBanner(override = null) {
    const src = override && typeof override === 'object' ? override : (state.config.adBanner || {});
    const rawDelay = src.delaySeconds !== undefined && src.delaySeconds !== '' ? Number(src.delaySeconds) : DEFAULT_AD_BANNER.delaySeconds;
    const rawDuration = src.durationSeconds !== undefined && src.durationSeconds !== '' ? Number(src.durationSeconds) : DEFAULT_AD_BANNER.durationSeconds;
    return {
      enabled: src.enabled !== false,
      title: String(src.title ?? DEFAULT_AD_BANNER.title).trim().slice(0, 90) || DEFAULT_AD_BANNER.title,
      description: String(src.description ?? DEFAULT_AD_BANNER.description).trim().slice(0, 160),
      ctaText: String(src.ctaText ?? DEFAULT_AD_BANNER.ctaText).trim().slice(0, 40) || DEFAULT_AD_BANNER.ctaText,
      targetUrl: safeHref(src.targetUrl || '') || DEFAULT_AD_BANNER.targetUrl,
      imageUrl: safeAdMediaSrc(src.imageUrl, DEFAULT_AD_BANNER.imageUrl),
      logoUrl: src.logoUrl === '' ? '' : safeAdMediaSrc(src.logoUrl, ''),
      delaySeconds: Number.isFinite(rawDelay) ? Math.max(0, Math.min(60, Math.round(rawDelay))) : DEFAULT_AD_BANNER.delaySeconds,
      durationSeconds: Number.isFinite(rawDuration) ? Math.max(0, Math.min(300, Math.round(rawDuration))) : DEFAULT_AD_BANNER.durationSeconds,
      position: src.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
      size: src.size === 'mini' ? 'mini' : 'compact'
    };
  }

  function clearAdBannerTimers() {
    if (state.adShowTimer) {
      clearTimeout(state.adShowTimer);
      state.adShowTimer = null;
    }
    if (state.adHideTimer) {
      clearTimeout(state.adHideTimer);
      state.adHideTimer = null;
    }
  }

  function hideFloatingAdBanner(dismissForSession = false) {
    clearAdBannerTimers();
    state.adCountdownRemainingMs = 0;
    state.adCountdownStartedAt = 0;
    if (dismissForSession) {
      try { sessionStorage.setItem('cyberpolis_ad_dismissed', '1'); } catch (e) {}
    }
    if (!DOM.floatingAdBanner) return;
    DOM.floatingAdBanner.classList.remove('is-visible');
    setTimeout(() => {
      if (DOM.floatingAdBanner && !DOM.floatingAdBanner.classList.contains('is-visible')) {
        DOM.floatingAdBanner.style.display = 'none';
      }
    }, 300);
  }

  function startAdAutoHideCountdown(ms) {
    if (state.adHideTimer) {
      clearTimeout(state.adHideTimer);
      state.adHideTimer = null;
    }
    if (!Number.isFinite(ms) || ms <= 0 || !DOM.floatingAdBanner) return;
    state.adCountdownRemainingMs = ms;
    state.adCountdownStartedAt = Date.now();
    const bar = DOM.floatingAdBanner.querySelector('.floating-ad-progress-bar');
    if (bar) {
      const totalDurationMs = Math.max(ms, 1000);
      bar.style.transition = 'none';
      const curScale = Math.max(0.02, Math.min(1, ms / (state.adTotalDurationMs || totalDurationMs)));
      bar.style.transform = `scaleX(${curScale})`;
      void bar.offsetWidth;
      bar.style.transition = `transform ${ms}ms linear`;
      bar.style.transform = 'scaleX(0)';
    }
    state.adHideTimer = setTimeout(() => hideFloatingAdBanner(false), ms);
  }

  function pauseAdAutoHideCountdown() {
    if (!state.adHideTimer || !state.adCountdownStartedAt) return;
    const elapsed = Date.now() - state.adCountdownStartedAt;
    state.adCountdownRemainingMs = Math.max(400, state.adCountdownRemainingMs - elapsed);
    clearTimeout(state.adHideTimer);
    state.adHideTimer = null;
    state.adCountdownStartedAt = 0;
    if (DOM.floatingAdBanner && state.adTotalDurationMs > 0) {
      const bar = DOM.floatingAdBanner.querySelector('.floating-ad-progress-bar');
      if (bar) {
        const frac = Math.max(0, Math.min(1, state.adCountdownRemainingMs / state.adTotalDurationMs));
        bar.style.transition = 'none';
        bar.style.transform = `scaleX(${frac})`;
      }
    }
  }

  function renderFloatingAdBanner(forceShow = false, overrideCfg = null) {
    const el = DOM.floatingAdBanner;
    if (!el) return;
    const ad = getNormalizedAdBanner(overrideCfg);
    const renderKey = JSON.stringify(ad);

    if (!ad.enabled && !forceShow) {
      state.adLastRenderKey = renderKey;
      hideFloatingAdBanner(false);
      return;
    }

    let dismissed = false;
    try { dismissed = sessionStorage.getItem('cyberpolis_ad_dismissed') === '1'; } catch (e) {}
    if (!forceShow && dismissed) {
      state.adLastRenderKey = renderKey;
      return;
    }

    if (!forceShow && state.adLastRenderKey === renderKey) {
      return;
    }
    state.adLastRenderKey = renderKey;
    clearAdBannerTimers();

    el.className = 'floating-ad-banner';
    if (ad.position === 'bottom-left') el.classList.add('pos-left');
    if (ad.size === 'mini') el.classList.add('is-mini');

    const imgHtml = ad.imageUrl
      ? `<img src="${escapeHtml(ad.imageUrl)}" alt="${escapeHtml(ad.title)}" class="floating-ad-photo ad-banner-img" loading="lazy">`
      : '';
    const logoHtml = ad.logoUrl
      ? `<img src="${escapeHtml(ad.logoUrl)}" alt="" class="floating-ad-logo ad-banner-img" loading="lazy">`
      : '';
    const descHtml = ad.description
      ? `<p class="floating-ad-desc">${escapeHtml(ad.description)}</p>`
      : '';
    const progressHtml = ad.durationSeconds > 0
      ? `<div class="floating-ad-progress"><div class="floating-ad-progress-bar"></div></div>`
      : '';

    el.innerHTML = `
      <div class="floating-ad-topbar">
        <span class="floating-ad-badge">PATROCINADO</span>
        <button type="button" class="floating-ad-close" aria-label="Cerrar anuncio" title="Cerrar anuncio">&times;</button>
      </div>
      <a href="${escapeHtml(ad.targetUrl)}" target="_blank" rel="noopener noreferrer sponsored" class="floating-ad-link" title="${escapeHtml(ad.title)}">
        <div class="floating-ad-media">
          ${imgHtml}
          <div class="floating-ad-scrim"></div>
          ${logoHtml}
        </div>
        <div class="floating-ad-body">
          <h3 class="floating-ad-title">${escapeHtml(ad.title)}</h3>
          ${descHtml}
          <span class="floating-ad-cta">${escapeHtml(ad.ctaText)}</span>
        </div>
      </a>
      ${progressHtml}
    `;

    const delayMs = forceShow ? 0 : ad.delaySeconds * 1000;
    const durationMs = ad.durationSeconds > 0 ? ad.durationSeconds * 1000 : 0;
    state.adTotalDurationMs = durationMs;
    el.style.display = 'none';

    state.adShowTimer = setTimeout(() => {
      el.style.display = 'block';
      void el.offsetWidth;
      el.classList.add('is-visible');
      if (durationMs > 0) {
        startAdAutoHideCountdown(durationMs);
      }
    }, delayMs);
  }

  function populateAdminAdForm(override = null) {
    const ad = getNormalizedAdBanner(override);
    state.pendingAdImageDataUrl = null;
    if (DOM.adEnabledToggle) DOM.adEnabledToggle.checked = !!ad.enabled;
    if (DOM.adDelayInput) DOM.adDelayInput.value = String(ad.delaySeconds);
    if (DOM.adDurationInput) DOM.adDurationInput.value = String(ad.durationSeconds);
    if (DOM.adPositionSelect) DOM.adPositionSelect.value = ad.position;
    if (DOM.adSizeSelect) DOM.adSizeSelect.value = ad.size;
    if (DOM.adTitleInput) DOM.adTitleInput.value = ad.title;
    if (DOM.adDescInput) DOM.adDescInput.value = ad.description;
    if (DOM.adCtaInput) DOM.adCtaInput.value = ad.ctaText;
    if (DOM.adTargetUrlInput) DOM.adTargetUrlInput.value = ad.targetUrl;
    if (DOM.adImageUrlInput) {
      DOM.adImageUrlInput.value = ad.imageUrl.startsWith('data:image/') ? '[Imagen personalizada cargada]' : ad.imageUrl;
    }
    if (DOM.adLogoUrlInput) {
      DOM.adLogoUrlInput.value = ad.logoUrl.startsWith('data:image/') ? '[Logo personalizado]' : ad.logoUrl;
    }
    if (DOM.adImagePreview) {
      DOM.adImagePreview.style.display = '';
      DOM.adImagePreview.src = ad.imageUrl || DEFAULT_AD_BANNER.imageUrl;
    }
    if (DOM.adImageFile) DOM.adImageFile.value = '';
  }

  function readAdminAdForm() {
    const cur = getNormalizedAdBanner();
    const rawImg = DOM.adImageUrlInput ? DOM.adImageUrlInput.value.trim() : '';
    let imageUrl = cur.imageUrl;
    if (state.pendingAdImageDataUrl) {
      imageUrl = state.pendingAdImageDataUrl;
    } else if (rawImg && rawImg !== '[Imagen personalizada cargada]' && rawImg !== '[Imagen personalizada lista para guardar]') {
      imageUrl = safeAdMediaSrc(rawImg, cur.imageUrl);
    }

    const rawLogo = DOM.adLogoUrlInput ? DOM.adLogoUrlInput.value.trim() : '';
    let logoUrl = cur.logoUrl;
    if (rawLogo === '') {
      logoUrl = '';
    } else if (rawLogo !== '[Logo personalizado]') {
      logoUrl = safeAdMediaSrc(rawLogo, '');
    }

    return getNormalizedAdBanner({
      enabled: DOM.adEnabledToggle ? DOM.adEnabledToggle.checked : true,
      delaySeconds: DOM.adDelayInput ? DOM.adDelayInput.value : 2,
      durationSeconds: DOM.adDurationInput ? DOM.adDurationInput.value : 15,
      position: DOM.adPositionSelect ? DOM.adPositionSelect.value : 'bottom-right',
      size: DOM.adSizeSelect ? DOM.adSizeSelect.value : 'compact',
      title: DOM.adTitleInput ? DOM.adTitleInput.value : DEFAULT_AD_BANNER.title,
      description: DOM.adDescInput ? DOM.adDescInput.value : '',
      ctaText: DOM.adCtaInput ? DOM.adCtaInput.value : DEFAULT_AD_BANNER.ctaText,
      targetUrl: DOM.adTargetUrlInput ? DOM.adTargetUrlInput.value : DEFAULT_AD_BANNER.targetUrl,
      imageUrl,
      logoUrl
    });
  }

  async function handleSaveAdBannerConfig() {
    const rawTarget = DOM.adTargetUrlInput ? DOM.adTargetUrlInput.value.trim() : '';
    if (rawTarget && !safeHref(rawTarget)) {
      showToast('La URL de destino debe comenzar por https:// o http://.', 'error');
      return;
    }
    const nextAd = readAdminAdForm();
    state.config.adBanner = nextAd;
    state.pendingAdImageDataUrl = null;
    try { sessionStorage.removeItem('cyberpolis_ad_dismissed'); } catch (e) {}
    state.adLastRenderKey = '';
    renderFloatingAdBanner(true, nextAd);
    await saveConfigToServer();
    showToast('Configuración de publicidad guardada.');
    closeAdminControl();
  }

  // ==========================================
  // 5. Panel de Control Administrador
  // ==========================================
  function openAdminControl() {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Acceso restringido: requiere permisos de Administrador.', 'error');
      return;
    }

    // Cargar valores actuales en el modal
    DOM.adminAutoSyncToggle.checked = !!state.config.autoSyncEnabled;
    DOM.adminSyncIntervalSelect.value = state.config.syncIntervalMinutes || '30';
    DOM.adminLastSyncText.textContent = state.config.lastSync
      ? `Última sincronización: ${getRelativeTime(state.config.lastSync)} (${new Date(state.config.lastSync).toLocaleTimeString('es-ES')})`
      : 'Última sincronización: Sin registros recientes';

    // Lista de fuentes en castellano
    renderAdminFeedsList();

    // Valores de transformación
    DOM.adminPortalTitleInput.value = state.config.portalTitle || 'CYBERPOLIS';
    DOM.adminPortalSubcallsignInput.value = state.config.portalSubcallsign || '';
    DOM.adminPortalSubtitleInput.value = state.config.portalSubtitle || 'TU HACKNOTICIERO';
    if (DOM.adminContactEmailInput) {
      DOM.adminContactEmailInput.value = state.config.contactEmail || '';
    }
    const currentLogo = state.config.portalLogoUrl || 'assets/silverbot-unix-logo.png';
    state.pendingLogoDataUrl = null;
    if (DOM.adminPortalLogoInput) {
      DOM.adminPortalLogoInput.value = currentLogo.startsWith('data:image/') ? '[Imagen personalizada cargada]' : currentLogo;
    }
    if (DOM.adminLogoPreview) {
      DOM.adminLogoPreview.src = currentLogo;
    }

    // Botones de acento activo
    document.querySelectorAll('.accent-color-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.accent === (state.config.themeAccent || 'cyan'));
    });

    // Botones de polígono activo
    document.querySelectorAll('.poly-mode-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.poly === (state.config.polygonDensity || 'normal'));
    });

    // Botones de layout activo
    document.querySelectorAll('.layout-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layout === (state.config.layoutMode || 'normal'));
    });

    // Valores de Publicidad Lateral
    populateAdminAdForm();

    DOM.adminControlModal.style.display = 'flex';
    switchAdminTab('feeds');
  }

  function closeAdminControl() {
    DOM.adminControlModal.style.display = 'none';
  }

  function switchAdminTab(tab) {
    const panels = {
      feeds: [DOM.adminTabFeedsBtn, DOM.adminFeedsSection],
      metrics: [DOM.adminTabMetricsBtn, DOM.adminMetricsSection],
      users: [DOM.adminTabUsersBtn, DOM.adminUsersSection],
      transform: [DOM.adminTabTransformBtn, DOM.adminTransformSection],
      chat: [DOM.adminTabChatBtn, DOM.adminChatSection],
      ads: [DOM.adminTabAdsBtn, DOM.adminAdsSection],
      security: [DOM.adminTabSecurityBtn, DOM.adminSecuritySection]
    };
    for (const [key, [btn, sec]] of Object.entries(panels)) {
      const isActive = key === tab;
      if (btn) btn.classList.toggle('active', isActive);
      if (sec) sec.style.display = isActive ? 'block' : 'none';
    }
    if (tab === 'metrics') loadAdminMetrics();
    if (tab === 'users') loadAdminUsers();
    if (tab === 'chat') loadAdminChatModeration();
    if (tab === 'security') loadAdminSystemStatus();
  }

  function renderAdminFeedsList() {
    const feeds = state.config.feeds || [];
    DOM.adminFeedsList.innerHTML = feeds.map(feed => `
      <div class="feed-manage-row" data-feed-id="${feed.id}">
        <div class="feed-row-left">
          <span class="feed-flag-pill">🇪🇸 ES</span>
          <div class="feed-info-meta">
            <span class="feed-name-txt">${escapeHtml(feed.name)}</span>
            <span class="feed-url-txt">${escapeHtml(feed.url)}</span>
          </div>
        </div>
        <div>
          <label class="hud-checkbox-label">
            <input type="checkbox" class="feed-toggle-check" ${feed.enabled ? 'checked' : ''}>
            <span>${feed.enabled ? 'ACTIVA' : 'PAUSADA'}</span>
          </label>
        </div>
      </div>
    `).join('');
  }

  async function handleForceSync() {
    DOM.adminForceSyncBtn.disabled = true;
    DOM.adminForceSyncBtn.innerHTML = '<span>⚡ SINCRONIZANDO FUENTES...</span>';
    showToast('Consultando INCIBE, Hispasec, CCN-CERT...', 'info');

    if (state.serverMode && state.currentUser) {
      try {
        const res = await apiFetch('/api/admin/feeds/sync', {
          method: 'POST'
        });
        const data = await res.json();
        if (res.ok) {
          await loadArticles();
          await loadConfig();
          renderAll();
          showToast(`¡Sincronización completada! ${data.newCount} nuevos despachos importados.`);
          DOM.adminLastSyncText.textContent = `Última sincronización: Hace un instante`;
        } else {
          showToast(data.error || 'Fallo en la sincronización.', 'error');
        }
      } catch (e) {
        showToast('Error de red al sincronizar.', 'error');
      }
    } else {
      // Modo local simulado
      showToast('Sincronización local completada: 3 despachos españoles verificados.');
      DOM.adminLastSyncText.textContent = `Última sincronización: Hace un instante`;
    }

    DOM.adminForceSyncBtn.disabled = false;
    DOM.adminForceSyncBtn.innerHTML = '<span>⚡ SINCRONIZAR AHORA</span>';
  }

  async function handleSaveFeedsConfig() {
    const autoSyncEnabled = DOM.adminAutoSyncToggle.checked;
    const syncIntervalMinutes = parseInt(DOM.adminSyncIntervalSelect.value, 10);

    // Leer estado de cada toggle de feed
    const feedRows = document.querySelectorAll('.feed-manage-row');
    feedRows.forEach(row => {
      const feedId = row.dataset.feedId;
      const isChecked = row.querySelector('.feed-toggle-check').checked;
      const target = state.config.feeds.find(f => f.id === feedId);
      if (target) target.enabled = isChecked;
    });

    state.config.autoSyncEnabled = autoSyncEnabled;
    state.config.syncIntervalMinutes = syncIntervalMinutes;

    await saveConfigToServer();
    applySiteTransformation(state.config);
    showToast('Preferencias de fuentes en castellano guardadas.');
    closeAdminControl();
  }

  async function handleApplyTransformation() {
    // 1. Acento seleccionado
    const activeAccentBtn = document.querySelector('.accent-color-btn.active');
    const themeAccent = activeAccentBtn ? activeAccentBtn.dataset.accent : 'cyan';

    // 2. Modo Polígono
    const activePolyBtn = document.querySelector('.poly-mode-chip.active');
    const polygonDensity = activePolyBtn ? activePolyBtn.dataset.poly : 'normal';

    // 3. Layout Mode
    const activeLayoutBtn = document.querySelector('.layout-mode-btn.active');
    const layoutMode = activeLayoutBtn ? activeLayoutBtn.dataset.layout : 'normal';

    // 4. Títulos y Logotipo
    const portalTitle = DOM.adminPortalTitleInput.value.trim() || 'CYBERPOLIS';
    const portalSubcallsign = DOM.adminPortalSubcallsignInput ? DOM.adminPortalSubcallsignInput.value.trim() : '';
    const portalSubtitle = DOM.adminPortalSubtitleInput.value.trim() || 'TU HACKNOTICIERO';
    const rawEmail = DOM.adminContactEmailInput ? DOM.adminContactEmailInput.value.trim() : '';
    if (rawEmail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(rawEmail)) {
      showToast('El correo de contacto no tiene un formato válido.', 'error');
      return;
    }
    const rawLogoInput = DOM.adminPortalLogoInput ? DOM.adminPortalLogoInput.value.trim() : '';
    let portalLogoUrl = state.config.portalLogoUrl || 'assets/silverbot-unix-logo.png';
    if (state.pendingLogoDataUrl) {
      portalLogoUrl = state.pendingLogoDataUrl;
    } else if (rawLogoInput && rawLogoInput !== '[Imagen personalizada cargada]') {
      portalLogoUrl = rawLogoInput;
    }

    state.config.themeAccent = themeAccent;
    state.config.polygonDensity = polygonDensity;
    state.config.layoutMode = layoutMode;
    state.config.portalTitle = portalTitle;
    state.config.portalSubcallsign = portalSubcallsign;
    state.config.portalSubtitle = portalSubtitle;
    state.config.contactEmail = rawEmail;
    state.config.portalLogoUrl = portalLogoUrl;
    state.pendingLogoDataUrl = null;

    applySiteTransformation(state.config);
    await saveConfigToServer();

    showToast('¡Transformación aplicada con éxito a toda la web! ⚡');
    closeAdminControl();
  }

  async function saveConfigToServer() {
    localStorage.setItem('silverbot_config', JSON.stringify(state.config));

    if (state.serverMode && state.currentUser) {
      try {
        await apiFetch('/api/admin/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.config)
        });
      } catch (err) {}
    }
  }

  // ==========================================
  // 6. Autenticación y Sesiones
  // ==========================================
  async function checkServerConnection() {
    try {
      const res = await fetch('/api/status', { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        state.serverMode = true;
        if (DOM.syncStatusText) {
          DOM.syncStatusText.textContent = 'EDICIÓN ONLINE · FUENTES EN CASTELLANO ACTIVAS';
          DOM.syncStatusText.style.color = 'var(--accent-green)';
        }
        return;
      }
    } catch (e) {}
    state.serverMode = false;
    if (DOM.syncStatusText) {
      DOM.syncStatusText.textContent = 'MODO LOCAL · EDICIÓN SIN CONEXIÓN';
      DOM.syncStatusText.style.color = 'var(--text-silver)';
    }
  }

  async function checkAuthSession() {
    if (!state.serverMode) {
      state.currentUser = null;
      return;
    }

    try {
      const res = await apiFetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        state.currentUser = data.user || null;
        if (state.currentUser) {
          localStorage.setItem('silverbot_current_user', JSON.stringify(state.currentUser));
        }
        return;
      }
    } catch (err) {}

    state.currentUser = null;
    localStorage.removeItem('silverbot_auth_token');
    localStorage.removeItem('silverbot_current_user');
  }

  function renderUserWidget() {
    if (!DOM.userSessionWidget) return;

    const isLoggedIn = !!state.currentUser;
    const isAdmin = isLoggedIn && state.currentUser.role === 'admin';

    if (DOM.openAdminControlBtn) {
      DOM.openAdminControlBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (DOM.backupModalBtn) {
      DOM.backupModalBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (DOM.openNewArticleModalBtn) {
      DOM.openNewArticleModalBtn.style.display = isLoggedIn ? 'inline-flex' : 'none';
    }
    if (DOM.openLinkedInModalBtn) {
      DOM.openLinkedInModalBtn.style.display = isLoggedIn ? 'inline-flex' : 'none';
    }
    if (DOM.emptyCreateBtn) {
      DOM.emptyCreateBtn.style.display = isLoggedIn ? 'inline-flex' : 'none';
    }
    syncIrcIdentityUi(true);

    if (!state.currentUser) {
      DOM.userSessionWidget.innerHTML = `
        <button id="openAuthModalBtn" class="footer-action-link footer-login-link" title="Acceso para usuarios registrados y administrador">
          Acceder / Registro
        </button>
      `;
      const btn = document.getElementById('openAuthModalBtn');
      if (btn) btn.onclick = openAuthModal;
    } else {
      const roleBadgeClass = state.currentUser.role === 'admin' ? 'admin' : 'analyst';
      const roleLabel = state.currentUser.role === 'admin' ? '[ADMIN]' : '[ANALYST]';

      DOM.userSessionWidget.innerHTML = `
        <div class="user-profile-pill" id="userProfileDropdownTrigger">
          <img src="${escapeHtml(state.currentUser.avatar || 'assets/silverbot-unix-logo.png')}" alt="Avatar" class="user-avatar-mini">
          <div class="user-pill-info">
            <span class="user-pill-name">${escapeHtml(state.currentUser.displayName)}</span>
            <span class="user-role-badge ${roleBadgeClass}">${roleLabel}</span>
          </div>
          <span style="font-size: 0.7rem; color: var(--text-muted); margin-left: 2px;">▴</span>
        </div>

        <div class="user-dropdown-menu" id="userDropdownMenu" style="display: none;">
          ${state.currentUser.role === 'admin' ? `
            <button class="dropdown-item" id="menuOpenAdminBtn" style="color: #fbbf24; font-weight: 700;">
              <span>⚙️</span>
              <span>Panel de Control Admin</span>
            </button>
            <div class="dropdown-divider"></div>
          ` : ''}
          <button class="dropdown-item" id="menuOpenLinkedInBtn">
            <span class="linkedin-glyph">in</span>
            <span>Ingestión LinkedIn</span>
          </button>
          <button class="dropdown-item" id="menuUsersListBtn">
            <span>👥</span>
            <span>Directorio de Analistas</span>
          </button>
          <button class="dropdown-item" id="menuChangePasswordBtn">
            <span>🔑</span>
            <span>Cambiar mi contraseña</span>
          </button>
          <div class="dropdown-divider"></div>
          <button class="dropdown-item danger-item" id="menuLogoutBtn">
            <span>🚪</span>
            <span>Cerrar Sesión</span>
          </button>
        </div>
      `;

      const trigger = document.getElementById('userProfileDropdownTrigger');
      const menu = document.getElementById('userDropdownMenu');

      trigger.onclick = (e) => {
        e.stopPropagation();
        menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
      };

      if (document.getElementById('menuOpenAdminBtn')) {
        document.getElementById('menuOpenAdminBtn').onclick = openAdminControl;
      }
      document.getElementById('menuOpenLinkedInBtn').onclick = openLinkedInModal;
      document.getElementById('menuUsersListBtn').onclick = openUsersDirectory;
      document.getElementById('menuChangePasswordBtn').onclick = openChangePasswordModal;
      document.getElementById('menuLogoutBtn').onclick = handleLogout;
    }

    if (state.currentCategory === 'forum') {
      renderForum();
    } else if (state.currentCategory === 'contact') {
      renderContact();
    }
  }

  function openAuthModal() {
    DOM.authModal.style.display = 'flex';
    switchAuthTab('login');
  }

  function closeAuthModal() {
    DOM.authModal.style.display = 'none';
  }

  function switchAuthTab(tab) {
    if (tab === 'login') {
      DOM.tabLoginBtn.classList.add('active');
      DOM.tabRegisterBtn.classList.remove('active');
      DOM.loginForm.style.display = 'block';
      DOM.registerForm.style.display = 'none';
      DOM.loginUsername.focus();
    } else {
      DOM.tabLoginBtn.classList.remove('active');
      DOM.tabRegisterBtn.classList.add('active');
      DOM.loginForm.style.display = 'none';
      DOM.registerForm.style.display = 'block';
      DOM.regUsername.focus();
    }
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const username = DOM.loginUsername.value.trim();
    const password = DOM.loginPassword.value;

    if (!username || !password) {
      showToast('Introduce usuario y contraseña.', 'error');
      return;
    }

    if (!state.serverMode) {
      showToast('Autenticación no disponible sin servidor backend activo.', 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Credenciales no autorizadas.', 'error');
        return;
      }

      state.currentUser = data.user;
      localStorage.setItem('silverbot_current_user', JSON.stringify(data.user));
      DOM.loginPassword.value = '';

      if (data.user.role === 'admin' && !data.user.passwordUpdatedAt) {
        showToast('Aviso de seguridad: rota la contraseña de administrador en Panel Admin → Seguridad.', 'info');
      } else {
        showToast(`¡Bienvenido de nuevo, ${data.user.displayName}!`);
      }
      closeAuthModal();
      renderUserWidget();
      renderAll();
    } catch (err) {
      showToast('Error de conexión con el servidor.', 'error');
    }
  }

  async function handleRegisterSubmit(e) {
    e.preventDefault();
    const username = DOM.regUsername.value.trim();
    const displayName = DOM.regDisplayName.value.trim();
    const password = DOM.regPassword.value;
    const linkedInProfile = DOM.regLinkedIn.value.trim();

    if (!username || !password || !displayName) {
      showToast('Completa los campos obligatorios.', 'error');
      return;
    }

    if (password.length < 10) {
      showToast('La contraseña debe tener mínimo 10 caracteres.', 'error');
      return;
    }

    if (!state.serverMode) {
      showToast('El registro requiere conexión activa con el servidor.', 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName, linkedInProfile })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Error al registrar analista.', 'error');
        return;
      }

      state.currentUser = data.user;
      localStorage.setItem('silverbot_current_user', JSON.stringify(data.user));
      DOM.regPassword.value = '';

      showToast(`¡Cuenta creada con éxito! Bienvenido, ${data.user.displayName}.`);
      closeAuthModal();
      renderUserWidget();
      renderAll();
    } catch (err) {
      showToast('Error en el servidor al registrar.', 'error');
    }
  }

  async function handleLogout() {
    if (state.serverMode) {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {}
    }

    state.currentUser = null;
    localStorage.removeItem('silverbot_auth_token');
    localStorage.removeItem('silverbot_current_user');

    showToast('Sesión cerrada correctamente.', 'info');
    renderUserWidget();
    renderAll();
  }

  function openChangePasswordModal() {
    if (!state.currentUser || !DOM.changePasswordModal) {
      openAuthModal();
      return;
    }
    if (DOM.changePasswordForm) DOM.changePasswordForm.reset();
    DOM.changePasswordModal.style.display = 'flex';
    if (DOM.curPassInput) DOM.curPassInput.focus();
  }

  function closeChangePasswordModal() {
    if (DOM.changePasswordModal) DOM.changePasswordModal.style.display = 'none';
  }

  async function handleChangePasswordSubmit(e) {
    e.preventDefault();
    if (!state.currentUser || !state.serverMode) return;
    const currentPassword = DOM.curPassInput ? DOM.curPassInput.value : '';
    const newPassword = DOM.newPassInput ? DOM.newPassInput.value : '';
    const confirmPassword = DOM.confirmPassInput ? DOM.confirmPassInput.value : '';

    if (newPassword !== confirmPassword) {
      showToast('Las dos contraseñas nuevas no coinciden.', 'error');
      return;
    }
    if (newPassword.length < 10) {
      showToast('La nueva contraseña debe tener mínimo 10 caracteres.', 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo cambiar la contraseña.', 'error');
        return;
      }
      if (data.user) {
        state.currentUser = data.user;
        localStorage.setItem('silverbot_current_user', JSON.stringify(data.user));
      }
      if (DOM.changePasswordForm) DOM.changePasswordForm.reset();
      closeChangePasswordModal();
      showToast(data.message || 'Contraseña actualizada correctamente.');
      loadAdminSystemStatus();
    } catch (err) {
      showToast('Error al actualizar la contraseña.', 'error');
    }
  }

  // ==========================================
  // 7. Ingestión Inteligente de LinkedIn
  // ==========================================
  function openLinkedInModal() {
    if (!state.currentUser) {
      showToast('Debes iniciar sesión con tu cuenta para importar de LinkedIn.', 'info');
      openAuthModal();
      return;
    }
    DOM.linkedInModal.style.display = 'flex';
    DOM.lnPostText.focus();
  }

  function closeLinkedInModal() {
    DOM.linkedInModal.style.display = 'none';
  }

  async function handleLinkedInIngestionSubmit(e) {
    e.preventDefault();
    const rawUrl = DOM.lnPostUrl.value.trim();
    const postText = DOM.lnPostText.value.trim();
    const customTitle = DOM.lnCustomTitle.value.trim();
    const categoryHint = DOM.lnCategoryHint.value;
    const isBreaking = DOM.lnIsBreaking.checked;

    if (!postText && !rawUrl) {
      showToast('Ingresa el texto o la URL del post de LinkedIn.', 'error');
      return;
    }

    showToast('Procesando y extrayendo despacho de LinkedIn...', 'info');

    if (state.serverMode) {
      try {
        const res = await apiFetch('/api/linkedin/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawUrl, postText, customTitle, categoryHint, isBreaking })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Error al importar desde LinkedIn.', 'error');
          return;
        }

        state.articles.unshift(data.article);
        closeLinkedInModal();
        DOM.linkedInIngestionForm.reset();
        renderAll();
        showToast('¡Despacho de LinkedIn importado y verificado!');
        return;
      } catch (err) {
        showToast('Fallo al conectar con el motor de LinkedIn.', 'error');
        return;
      }
    }

    const tagMatches = postText.match(/#([\w\d_-]+)/g) || [];
    const extractedTags = tagMatches.map(t => t.replace('#', '').toLowerCase());
    if (!extractedTags.includes('linkedin')) extractedTags.unshift('linkedin');

    let title = customTitle;
    if (!title) {
      const firstLine = postText.split('\n')[0].replace(/^[#•\-\*\s]+/, '').trim();
      title = firstLine.length > 15 ? firstLine.slice(0, 130) : `Despacho de LinkedIn // ${state.currentUser.displayName}`;
    }

    const sentences = postText.split(/[.\n]/).filter(s => s.trim().length > 20);
    const summary = sentences.length > 0 ? sentences[0].trim() + '.' : postText.slice(0, 180) + '...';

    const newDispatch = {
      id: 'svb-ln-' + Date.now(),
      title,
      category: categoryHint,
      sourceName: `LinkedIn // ${state.currentUser.displayName}`,
      sourceUrl: rawUrl || state.currentUser.linkedInProfile || 'https://www.linkedin.com',
      imageUrl: createIntelSVG(`LinkedIn // ${state.currentUser.displayName}`, categoryHint, title),
      summary,
      content: postText,
      tags: extractedTags.slice(0, 5),
      readTime: `${Math.max(1, Math.ceil(postText.split(/\s+/).length / 180))} min`,
      isBreaking,
      isFeatured: false,
      author: state.currentUser.displayName,
      authorId: state.currentUser.id,
      authorRole: state.currentUser.role,
      verifiedLinkedIn: true,
      date: new Date().toISOString(),
      views: 0
    };

    state.articles.unshift(newDispatch);
    persistArticles();
    closeLinkedInModal();
    DOM.linkedInIngestionForm.reset();
    renderAll();
    showToast('¡Despacho de LinkedIn creado localmente!');
  }

  // ==========================================
  // 8. Directorio de Analistas
  // ==========================================
  async function openUsersDirectory() {
    if (!state.currentUser) {
      openAuthModal();
      return;
    }
    DOM.usersDirectoryModal.style.display = 'flex';
    DOM.usersDirectoryList.innerHTML = '<div style="font-family: var(--font-mono); color: var(--text-muted);">Cargando directorio de analistas...</div>';

    if (state.serverMode) {
      try {
        const res = await apiFetch('/api/users');
        if (res.ok) {
          const users = await res.json();
          renderUsersList(users);
          return;
        }
      } catch (e) {}
    }

    renderUsersList([]);
  }

  function renderUsersList(users) {
    if (!users || users.length === 0) {
      DOM.usersDirectoryList.innerHTML = '<div>Sin analistas registrados disponibles.</div>';
      return;
    }

    DOM.usersDirectoryList.innerHTML = users.map(u => {
      const safeLinkedIn = safeHref(u.linkedInProfile);
      const roleClass = u.role === 'admin' ? 'admin' : 'analyst';
      const roleLabel = escapeHtml(String(u.role || 'analyst').toUpperCase());
      return `
      <div class="user-card-item">
        <div class="user-card-head">
          <img src="${escapeHtml(u.avatar || 'assets/silverbot-unix-logo.png')}" alt="Avatar" class="user-avatar-mini">
          <div>
            <div class="user-card-name">${escapeHtml(u.displayName)}</div>
            <div class="user-card-handle">@${escapeHtml(u.username)} • <span class="user-role-badge ${roleClass}">[${roleLabel}]</span></div>
          </div>
        </div>
        ${safeLinkedIn ? `
          <div style="font-family: var(--font-mono); font-size: 0.72rem; margin-top: 6px;">
            <a href="${escapeHtml(safeLinkedIn)}" target="_blank" rel="noopener noreferrer" class="verified-linkedin-badge">
              <span>in</span>
              <span>${escapeHtml(safeLinkedIn.replace(/https?:\/\/(www\.)?linkedin\.com\//, ''))}</span>
            </a>
          </div>
        ` : '<div style="font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted);">Sin cuenta de LinkedIn vinculada</div>'}
      </div>
    `;
    }).join('');
  }

  function closeUsersDirectory() {
    DOM.usersDirectoryModal.style.display = 'none';
  }

  // ==========================================
  // 9. Carga y Persistencia de Artículos
  // ==========================================
  function sanitizeClientArticles(list) {
    if (!Array.isArray(list)) return [];
    let changed = false;
    const realCount = list.filter(a => !/^(art-00\d|svb-00\d)$/.test(String(a && a.id || ''))).length;

    list.forEach(a => {
      if (realCount >= 4 && a.isFeatured && /^(art-00\d|svb-00\d)$/.test(String(a.id || ''))) {
        a.isFeatured = false;
        changed = true;
      }
      if (!a.imageUrl || a.imageUrl.includes('unsplash.com')) {
        a.imageUrl = createIntelSVG(a.sourceName, a.category, a.title);
        changed = true;
      } else if (a.imageUrl.startsWith('data:image/svg+xml')) {
        if (a.imageUrl.includes('%26') || a.imageUrl.includes('&') || a.imageUrl.includes('04070d') || a.imageUrl.includes('HUD')) {
          a.imageUrl = createIntelSVG(a.sourceName, a.category, a.title);
          changed = true;
        }
      } else if (/^https?:\/\//i.test(a.imageUrl)) {
        const up = upgradeClientImageUrl(a.imageUrl);
        if (up !== a.imageUrl) {
          a.imageUrl = up;
          changed = true;
        }
      }
    });
    return changed;
  }

  async function loadArticles() {
    if (state.serverMode) {
      try {
        const res = await fetch('/api/articles');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            state.articles = data;
            sanitizeClientArticles(state.articles);
            saveLocalArticles();
            return;
          }
        }
      } catch (e) {}
    }

    const stored = localStorage.getItem('silverbot_articles');
    if (stored) {
      try {
        state.articles = JSON.parse(stored);
      } catch (e) {
        state.articles = DEFAULT_SEED_ARTICLES;
      }
    } else {
      state.articles = DEFAULT_SEED_ARTICLES;
    }

    const changed = sanitizeClientArticles(state.articles);
    if (changed || !stored) {
      saveLocalArticles();
    }
  }

  function saveLocalArticles() {
    localStorage.setItem('silverbot_articles', JSON.stringify(state.articles));
  }

  async function persistArticles() {
    saveLocalArticles();
  }

  // ==========================================
  // 10. Renderizado del Feed
  // ==========================================
  function renderAll() {
    renderTicker();
    updateCategoryCounts();
    renderFeed();
  }

  function renderTicker() {
    const breakingArticles = state.articles.filter(a => a.isBreaking && !isDemoPlaceholder(a));
    const curatedFallback = curateTopArticles(state.articles, 6);
    const displayList = breakingArticles.length > 0 ? breakingArticles.slice(0, 8) : curatedFallback;

    if (displayList.length === 0) {
      DOM.tickerTrack.innerHTML = '<span>Actualizando titulares de Ciberseguridad y Geopolítica...</span>';
      return;
    }

    const itemsHtml = displayList.map(a => `
      <span class="ticker-item" data-id="${a.id}">
        <span class="ticker-prefix">[${getCategoryLabel(a.category)}]</span>
        <span>${escapeHtml(a.title)}</span>
      </span>
    `).join('');

    DOM.tickerTrack.innerHTML = itemsHtml + itemsHtml;

    DOM.tickerTrack.querySelectorAll('.ticker-item').forEach(el => {
      el.addEventListener('click', () => {
        openReaderModal(el.getAttribute('data-id'));
      });
    });
  }

  function isDemoPlaceholder(article) {
    return /^(art-00\d|svb-00\d)$/.test(String(article && article.id || ''));
  }

  function isRealPhoto(article) {
    return Boolean(article && article.imageUrl && /^https?:\/\//i.test(article.imageUrl) && !article.imageUrl.includes('unsplash.com'));
  }

  function cleanSourceDisplay(sourceName) {
    return String(sourceName || 'Redacción').split('—')[0].trim();
  }

  function getSourceGroupKey(article) {
    const raw = String(article.sourceName || article.author || 'redaccion').toLowerCase();
    if (raw.includes('incibe')) return 'incibe';
    if (raw.includes('una al') || raw.includes('hispasec')) return 'unaaldia';
    if (raw.includes('ccn')) return 'ccn-cert';
    if (raw.includes('hackplayers')) return 'hackplayers';
    if (raw.includes('linkedin')) return 'linkedin';
    return raw.split(/[—\-\/\|]/)[0].trim() || 'otros';
  }

  function sortArticlesByMode(list, sortBy = state.sortBy) {
    const copy = [...list];
    if (sortBy === 'popular') {
      copy.sort((a, b) => ((b.views || 0) - (a.views || 0)) || (new Date(b.date) - new Date(a.date)));
    } else if (sortBy === 'breaking') {
      copy.sort((a, b) => {
        const brkDiff = (b.isBreaking ? 1 : 0) - (a.isBreaking ? 1 : 0);
        if (brkDiff !== 0) return brkDiff;
        return new Date(b.date) - new Date(a.date);
      });
    } else {
      copy.sort((a, b) => {
        const diff = new Date(b.date) - new Date(a.date);
        // Si están dentro de la misma ventana de 2 horas, priorizar foto real y urgencia
        if (Math.abs(diff) <= 2 * 3600 * 1000) {
          const scoreB = (isRealPhoto(b) ? 2 : 0) + (b.isBreaking ? 1 : 0);
          const scoreA = (isRealPhoto(a) ? 2 : 0) + (a.isBreaking ? 1 : 0);
          if (scoreB !== scoreA) return scoreB - scoreA;
        }
        return diff;
      });
    }
    return copy;
  }

  // Selección editorial equilibrada: elige las 8 noticias más importantes repartidas entre TODAS las fuentes activas recientes
  function curateTopArticles(articlesList, limit = 8) {
    if (!Array.isArray(articlesList) || articlesList.length === 0) return [];
    const nonDemos = articlesList.filter(a => !isDemoPlaceholder(a));
    let workingPool = nonDemos.length >= 4 ? nonDemos : articlesList;

    // Si hay suficientes noticias recientes (<= 5 días respecto a la más actual), evitar que fuentes sin publicar semanas atrás ocupen portada
    const newestPoolTs = Math.max(...workingPool.map(a => new Date(a.date).getTime() || 0));
    const recentPool = workingPool.filter(a => (newestPoolTs - (new Date(a.date).getTime() || 0)) <= 120 * 3600 * 1000);
    if (recentPool.length >= limit) {
      workingPool = recentPool;
    }

    const groups = new Map();
    for (const art of workingPool) {
      const key = getSourceGroupKey(art);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(art);
    }

    const sortedBuckets = [];
    for (const [, items] of groups.entries()) {
      sortedBuckets.push(sortArticlesByMode(items, state.sortBy));
    }

    // Ordenar las fuentes por la frescura/importancia de su artículo principal
    sortedBuckets.sort((bucketA, bucketB) => {
      const topA = bucketA[0];
      const topB = bucketB[0];
      return sortArticlesByMode([topA, topB], state.sortBy)[0].id === topA.id ? -1 : 1;
    });

    const selected = [];
    const seenIds = new Set();
    let round = 0;

    while (selected.length < limit) {
      let pickedInRound = false;
      for (const bucket of sortedBuckets) {
        if (round < bucket.length) {
          const candidate = bucket[round];
          if (!seenIds.has(candidate.id)) {
            selected.push(candidate);
            seenIds.add(candidate.id);
            pickedInRound = true;
            if (selected.length >= limit) break;
          }
        }
      }
      if (!pickedInRound) break;
      round++;
    }

    return sortArticlesByMode(selected, state.sortBy);
  }

  // Selección dinámica de Portada (#1): prioriza titulares de HOY con fotografía real
  function selectPortadaLead(curatedList, sortBy = state.sortBy) {
    if (!curatedList || curatedList.length === 0) return null;
    if (sortBy === 'popular' || sortBy === 'breaking') {
      return curatedList[0];
    }

    const newestTs = Math.max(...curatedList.map(a => new Date(a.date).getTime() || 0));

    const scored = [...curatedList].sort((a, b) => {
      const tsA = new Date(a.date).getTime() || 0;
      const tsB = new Date(b.date).getTime() || 0;
      const ageHoursA = Math.max(0, (newestTs - tsA) / 3600000);
      const ageHoursB = Math.max(0, (newestTs - tsB) / 3600000);

      const featA = (a.isFeatured && !isDemoPlaceholder(a) && ageHoursA <= 18) ? 10 : 0;
      const featB = (b.isFeatured && !isDemoPlaceholder(b) && ageHoursB <= 18) ? 10 : 0;

      const scoreA = featA + (isRealPhoto(a) ? 8 : 0) + (a.isBreaking ? 3 : 0) - (ageHoursA * 0.55);
      const scoreB = featB + (isRealPhoto(b) ? 8 : 0) + (b.isBreaking ? 3 : 0) - (ageHoursB * 0.55);

      if (Math.abs(scoreB - scoreA) > 0.05) return scoreB - scoreA;
      return tsB - tsA;
    });

    return scored[0] || curatedList[0];
  }

  function updateCategoryCounts() {
    const nonDemos = state.articles.filter(a => !isDemoPlaceholder(a));
    const activePool = nonDemos.length >= 4 ? nonDemos : state.articles;

    DOM.countAll.textContent = Math.min(curateTopArticles(state.articles, 8).length, 8);
    DOM.countHacking.textContent = Math.min(activePool.filter(a => a.category === 'hacking').length, 8);
    DOM.countPolitica.textContent = Math.min(activePool.filter(a => a.category === 'politica').length, 8);
    DOM.countTecno.textContent = Math.min(activePool.filter(a => a.category === 'tecnopolitica').length, 8);
    DOM.countBookmarks.textContent = state.articles.filter(a => state.bookmarks.has(a.id)).length;
  }

  function getFilteredArticles() {
    let list = [...state.articles];
    const nonDemos = list.filter(a => !isDemoPlaceholder(a));
    if (nonDemos.length >= 4 && state.currentCategory !== 'bookmarks') {
      list = nonDemos;
    }

    if (state.currentCategory === 'bookmarks') {
      list = state.articles.filter(a => state.bookmarks.has(a.id));
    } else if (state.currentCategory !== 'all') {
      list = list.filter(a => a.category === state.currentCategory);
    }

    if (state.currentTag && state.currentTag !== 'all') {
      const targetTag = state.currentTag.toLowerCase();
      list = list.filter(a => Array.isArray(a.tags) && a.tags.some(t => t.toLowerCase().includes(targetTag)));
    }

    if (state.searchQuery.trim() !== '') {
      const q = state.searchQuery.toLowerCase().trim();
      list = list.filter(a => {
        const titleMatch = (a.title || '').toLowerCase().includes(q);
        const summaryMatch = (a.summary || '').toLowerCase().includes(q);
        const contentMatch = (a.content || '').toLowerCase().includes(q);
        const sourceMatch = (a.sourceName || '').toLowerCase().includes(q);
        const authorMatch = (a.author || '').toLowerCase().includes(q);
        const tagMatch = Array.isArray(a.tags) && a.tags.some(t => t.toLowerCase().includes(q));
        return titleMatch || summaryMatch || contentMatch || sourceMatch || authorMatch || tagMatch;
      });
    }

    return sortArticlesByMode(list, state.sortBy);
  }

  function renderFeed() {
    if (state.currentCategory === 'forum') {
      if (DOM.tagsMatrix) DOM.tagsMatrix.style.display = 'none';
      if (DOM.feedHeader) DOM.feedHeader.style.display = 'none';
      if (DOM.featuredSection) {
        DOM.featuredSection.innerHTML = '';
        DOM.featuredSection.style.display = 'none';
      }
      if (DOM.articlesGrid) DOM.articlesGrid.innerHTML = '';
      if (DOM.emptyState) DOM.emptyState.style.display = 'none';
      if (DOM.contactSection) {
        DOM.contactSection.style.display = 'none';
        DOM.contactSection.innerHTML = '';
      }
      if (DOM.forumSection) DOM.forumSection.style.display = 'flex';
      renderForum();
      updateSeoMeta();
      return;
    }

    if (state.currentCategory === 'contact') {
      if (DOM.tagsMatrix) DOM.tagsMatrix.style.display = 'none';
      if (DOM.feedHeader) DOM.feedHeader.style.display = 'none';
      if (DOM.featuredSection) {
        DOM.featuredSection.innerHTML = '';
        DOM.featuredSection.style.display = 'none';
      }
      if (DOM.articlesGrid) DOM.articlesGrid.innerHTML = '';
      if (DOM.emptyState) DOM.emptyState.style.display = 'none';
      if (DOM.forumSection) {
        DOM.forumSection.style.display = 'none';
        DOM.forumSection.innerHTML = '';
      }
      if (DOM.contactSection) DOM.contactSection.style.display = 'flex';
      renderContact();
      updateSeoMeta();
      return;
    }

    if (DOM.tagsMatrix) DOM.tagsMatrix.style.display = '';
    if (DOM.feedHeader) DOM.feedHeader.style.display = '';
    if (DOM.forumSection) {
      DOM.forumSection.style.display = 'none';
      DOM.forumSection.innerHTML = '';
    }
    if (DOM.contactSection) {
      DOM.contactSection.style.display = 'none';
      DOM.contactSection.innerHTML = '';
    }
    updateSeoMeta();

    const filtered = getFilteredArticles();

    let titleText = 'LO MÁS IMPORTANTE HOY';
    if (state.currentCategory === 'hacking') titleText = 'CIBERSEGURIDAD Y HACKING';
    else if (state.currentCategory === 'politica') titleText = 'POLÍTICA Y GEOPOLÍTICA';
    else if (state.currentCategory === 'tecnopolitica') titleText = 'TECNOPOLÍTICA Y NORMATIVA';
    else if (state.currentCategory === 'bookmarks') titleText = 'NOTICIAS GUARDADAS';

    if (state.currentTag !== 'all') {
      titleText += ` · #${state.currentTag.toUpperCase()}`;
    }

    DOM.feedTitle.textContent = titleText;

    if (filtered.length === 0) {
      DOM.feedMeta.textContent = '0 noticias encontradas';
      DOM.featuredSection.innerHTML = '';
      DOM.featuredSection.style.display = 'none';
      DOM.articlesGrid.innerHTML = '';
      DOM.emptyState.style.display = 'block';

      if (state.currentCategory === 'bookmarks') {
        DOM.emptyMessage.textContent = 'No hay noticias guardadas todavía. Pulsa el icono ⭐ en cualquier artículo.';
      } else if (state.searchQuery) {
        DOM.emptyMessage.textContent = `Sin resultados para la búsqueda "${state.searchQuery}".`;
      } else {
        DOM.emptyMessage.textContent = 'No hay noticias en esta sección.';
      }
      return;
    }

    DOM.emptyState.style.display = 'none';

    const isEditorialFrontpage = state.currentCategory === 'all' && state.currentTag === 'all' && !state.searchQuery.trim();

    if (isEditorialFrontpage) {
      const topEight = curateTopArticles(filtered, 8);
      const featuredArticle = selectPortadaLead(topEight, state.sortBy);
      const remaining = featuredArticle ? topEight.filter(a => a.id !== featuredArticle.id) : topEight;

      DOM.feedMeta.textContent = `Las ${topEight.length} noticias principales entre todas las fuentes`;

      if (featuredArticle) {
        DOM.featuredSection.innerHTML = createFeaturedCardHtml(featuredArticle);
        DOM.featuredSection.style.display = 'block';
      } else {
        DOM.featuredSection.innerHTML = '';
        DOM.featuredSection.style.display = 'none';
      }

      const trioArticles = remaining.slice(0, 3);
      const secondaryArticles = remaining.slice(3, 7);

      let gridHtml = '';
      if (trioArticles.length > 0) {
        gridHtml += `<div class="articles-trio-grid">${trioArticles.map(createArticleCardHtml).join('')}</div>`;
      }
      if (secondaryArticles.length > 0) {
        gridHtml += `
          <div class="press-secondary-header">
            <span class="press-secondary-title">Más actualidad seleccionada</span>
            <span class="press-secondary-line"></span>
          </div>
          <div class="press-horizontal-grid">${secondaryArticles.map(createHorizontalPressCardHtml).join('')}</div>
        `;
      }

      DOM.articlesGrid.innerHTML = gridHtml;
      attachCardListeners();
      return;
    }

    // Subsecciones o búsquedas
    DOM.featuredSection.innerHTML = '';
    DOM.featuredSection.style.display = 'none';

    const isCategoryOnly = !state.searchQuery.trim() && state.currentTag === 'all' && state.currentCategory !== 'bookmarks';
    const displayList = isCategoryOnly ? curateTopArticles(filtered, 8) : filtered.slice(0, 16);

    DOM.feedMeta.textContent = isCategoryOnly
      ? `${displayList.length} ${displayList.length === 1 ? 'noticia destacada' : 'noticias principales en esta sección'}`
      : `${filtered.length} ${filtered.length === 1 ? 'noticia encontrada' : 'noticias encontradas'}`;

    DOM.articlesGrid.innerHTML = `<div class="dispatches-grid-standard">${displayList.map(createArticleCardHtml).join('')}</div>`;
    attachCardListeners();
  }

  function canManageArticle(article) {
    if (!state.currentUser) return false;
    if (state.currentUser.role === 'admin') return true;
    return article.authorId === state.currentUser.id;
  }

  function createFeaturedCardHtml(a) {
    const isBookmarked = state.bookmarks.has(a.id);
    const catClass = escapeHtml(a.category || 'hacking');
    const catName = getCategoryLabel(a.category);
    const relativeTime = getRelativeTime(a.date);
    const readTime = a.readTime || calculateReadTime(a.content);
    const canEdit = canManageArticle(a);
    const sourceShort = cleanSourceDisplay(a.sourceName);
    const safeSrcUrl = safeHref(a.sourceUrl);

    return `
      <article class="hero-dispatch-card" data-id="${escapeHtml(a.id)}">
        <div class="hero-image-chamber" data-action="read" style="cursor: pointer;">
          <img src="${escapeHtml(resolveArticleImage(a.imageUrl, a.category, a.sourceName, a.title))}" alt="${escapeHtml(a.title)}" class="hero-image" loading="lazy" referrerpolicy="no-referrer">
          <span class="hero-portada-ribbon">PORTADA</span>
          <div class="hero-image-overlay"></div>
        </div>
        <div class="hero-content-chamber">
          <div class="dispatch-telemetry-row">
            <span class="intel-badge ${catClass}">${catName}</span>
            ${a.isBreaking ? '<span class="breaking-flag">ÚLTIMA HORA</span>' : ''}
            ${a.verifiedLinkedIn ? '<span class="verified-linkedin-badge"><span>in</span> LINKEDIN</span>' : ''}
          </div>

          <div class="hero-source-eyebrow">${escapeHtml(sourceShort)}</div>
          <h1 class="hero-headline" data-action="read">${escapeHtml(a.title)}</h1>
          <p class="hero-abstract">${escapeHtml(a.summary)}</p>

          <div class="hero-dispatch-meta">
            <span class="meta-token">
              ${safeSrcUrl ? `
                <a href="${escapeHtml(safeSrcUrl)}" target="_blank" rel="noopener noreferrer" class="source-token-link">
                  ${escapeHtml(sourceShort)} ↗
                </a>
              ` : `
                <span class="source-token-link">${escapeHtml(sourceShort)}</span>
              `}
            </span>
            <span class="meta-token">• ${relativeTime}</span>
            <span class="meta-token">• ${readTime} de lectura</span>
          </div>

          <div class="hero-chamber-foot">
            <button class="hud-btn hud-btn-action" data-action="read">
              <span>Leer noticia completa</span>
              <span class="btn-arrow">→</span>
            </button>
            <div class="card-quick-actions">
              <button class="hud-btn hud-btn-icon ${isBookmarked ? 'bookmarked' : ''}" data-action="bookmark" title="Guardar noticia">
                <span>${isBookmarked ? '⭐' : '☆'}</span>
              </button>
              ${canEdit ? `<button class="action-glyph-btn" data-action="edit" title="Editar">✎</button>` : ''}
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function createArticleCardHtml(a) {
    const isBookmarked = state.bookmarks.has(a.id);
    const catClass = escapeHtml(a.category || 'hacking');
    const catName = getCategoryLabel(a.category);
    const relativeTime = getRelativeTime(a.date);
    const readTime = a.readTime || calculateReadTime(a.content);
    const canEdit = canManageArticle(a);
    const sourceShort = cleanSourceDisplay(a.sourceName);

    const tagsHtml = Array.isArray(a.tags)
      ? a.tags.slice(0, 3).map(t => `<span class="dispatch-tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')
      : '';

    return `
      <article class="dispatch-card" data-id="${escapeHtml(a.id)}">
        <div class="dispatch-image-box" data-action="read" style="cursor: pointer;">
          <img src="${escapeHtml(resolveArticleImage(a.imageUrl, a.category, a.sourceName, a.title))}" alt="${escapeHtml(a.title)}" class="dispatch-img" loading="lazy" referrerpolicy="no-referrer">
          <div class="dispatch-card-badges">
            <span class="intel-badge ${catClass}">${catName}</span>
            <button class="bookmark-toggle-btn ${isBookmarked ? 'bookmarked' : ''}" data-action="bookmark" title="Guardar noticia">
              <span>${isBookmarked ? '⭐' : '☆'}</span>
            </button>
          </div>
        </div>

        <div class="dispatch-card-body">
          <div class="dispatch-card-telemetry">
            <span class="dispatch-source">${escapeHtml(sourceShort)}</span>
            <span>${relativeTime}</span>
          </div>

          <h3 class="dispatch-title" data-action="read">${escapeHtml(a.title)}</h3>
          <p class="dispatch-summary">${escapeHtml(a.summary)}</p>

          ${tagsHtml ? `<div class="dispatch-tags-strip">${tagsHtml}</div>` : ''}

          <div class="dispatch-card-foot">
            <span class="dispatch-read-link" data-action="read">Leer completa →</span>
            <div class="card-quick-actions">
              <span style="font-size: 0.72rem; color: var(--text-muted); margin-right: 4px;">${readTime}</span>
              ${canEdit ? `
                <button class="action-glyph-btn" data-action="edit" title="Editar">✎</button>
                <button class="action-glyph-btn danger" data-action="delete" title="Eliminar">✕</button>
              ` : ''}
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function createHorizontalPressCardHtml(a) {
    const isBookmarked = state.bookmarks.has(a.id);
    const catClass = escapeHtml(a.category || 'hacking');
    const catName = getCategoryLabel(a.category);
    const relativeTime = getRelativeTime(a.date);
    const readTime = a.readTime || calculateReadTime(a.content);
    const canEdit = canManageArticle(a);
    const sourceShort = cleanSourceDisplay(a.sourceName);

    return `
      <article class="press-horizontal-card" data-id="${escapeHtml(a.id)}">
        <div class="press-thumb-box" data-action="read" style="cursor: pointer;">
          <img src="${escapeHtml(resolveArticleImage(a.imageUrl, a.category, a.sourceName, a.title))}" alt="${escapeHtml(a.title)}" class="press-thumb-img" loading="lazy" referrerpolicy="no-referrer">
        </div>
        <div class="press-card-body">
          <div>
            <div class="press-card-meta-top">
              <span class="intel-badge ${catClass}">${catName}</span>
              <span style="font-size: 0.74rem; color: var(--text-muted);">${relativeTime}</span>
            </div>
            <h3 class="press-card-title" data-action="read">${escapeHtml(a.title)}</h3>
            <p class="press-card-summary">${escapeHtml(a.summary)}</p>
          </div>
          <div class="press-card-foot">
            <span class="dispatch-source">${escapeHtml(sourceShort)} · ${readTime}</span>
            <div class="card-quick-actions">
              <span class="dispatch-read-link" data-action="read" style="margin-right: 6px;">Leer →</span>
              <button class="action-glyph-btn ${isBookmarked ? 'bookmarked' : ''}" data-action="bookmark" title="Guardar" style="${isBookmarked ? 'color: var(--accent-amber);' : ''}">
                <span>${isBookmarked ? '⭐' : '☆'}</span>
              </button>
              ${canEdit ? `
                <button class="action-glyph-btn" data-action="edit" title="Editar">✎</button>
                <button class="action-glyph-btn danger" data-action="delete" title="Eliminar">✕</button>
              ` : ''}
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function attachCardListeners() {
    [DOM.featuredSection, DOM.articlesGrid].forEach(container => {
      container.onclick = e => {
        const target = e.target.closest('[data-action], [data-tag]');
        if (!target) return;

        if (target.dataset.tag) {
          e.stopPropagation();
          setTagFilter(target.dataset.tag);
          return;
        }

        const card = target.closest('article');
        if (!card) return;
        const articleId = card.getAttribute('data-id');
        const action = target.dataset.action;

        if (action === 'read') {
          openReaderModal(articleId);
        } else if (action === 'bookmark') {
          e.stopPropagation();
          toggleBookmark(articleId);
        } else if (action === 'edit') {
          e.stopPropagation();
          openEditModal(articleId);
        } else if (action === 'delete') {
          e.stopPropagation();
          confirmDeleteArticle(articleId);
        }
      };
    });
  }

  // ==========================================
  // 11. Modal Lector
  // ==========================================
  function openReaderModal(articleId) {
    const article = state.articles.find(a => a.id === articleId);
    if (!article) return;

    state.activeReaderArticle = article;
    article.views = (article.views || 0) + 1;
    persistArticles();
    updateSeoMeta(article);
    trackClientVisit('/?article=' + encodeURIComponent(article.id), article.title);

    const isBookmarked = state.bookmarks.has(article.id);
    const catName = getCategoryLabel(article.category);
    const dateFormatted = new Date(article.date).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    DOM.readerBadges.innerHTML = `
      <span class="intel-badge ${escapeHtml(String(article.category || 'hacking').replace(/[^a-z0-9_-]/gi, ''))}">${escapeHtml(catName)}</span>
      ${article.isBreaking ? '<span class="breaking-flag">ÚLTIMA HORA</span>' : ''}
      ${article.verifiedLinkedIn ? '<span class="verified-linkedin-badge"><span>in</span> LINKEDIN</span>' : ''}
    `;

    DOM.readerBookmarkBtn.innerHTML = `<span>${isBookmarked ? '⭐' : '☆'}</span>`;
    DOM.readerBookmarkBtn.classList.toggle('bookmarked', isBookmarked);

    const formattedBody = formatArticleBody(article.content);
    const sourceDisplay = cleanSourceDisplay(article.sourceName);
    const safeOriginUrl = safeHref(article.sourceUrl);
    const imgSrc = resolveArticleImage(article.imageUrl, article.category, article.sourceName, article.title);

    DOM.readerContentArea.innerHTML = `
      ${article.imageUrl ? `<img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(article.title)}" class="reader-cover-img" loading="lazy" referrerpolicy="no-referrer" data-fallback-cat="${escapeHtml(article.category || 'hacking')}">` : ''}

      <h1 class="reader-headline">${escapeHtml(article.title)}</h1>

      <div class="reader-telemetry-strip">
        <span>📅 ${dateFormatted}</span>
        <span>⏱️ ${escapeHtml(article.readTime || calculateReadTime(article.content))}</span>
        <span>👁️ ${Number(article.views || 0)} lecturas</span>
        <span>📰 Fuente: <strong>${escapeHtml(sourceDisplay)}</strong></span>
      </div>

      <div class="reader-lead-summary">
        ${escapeHtml(article.summary)}
      </div>

      <div class="reader-article-body">
        ${formattedBody}
      </div>

      <div class="reader-source-module">
        <div class="source-left-col">
          <span class="source-pill-label">Publicado originalmente en</span>
          <span class="source-pill-name">${escapeHtml(article.sourceName || 'Fuente de Información')}</span>
        </div>
        ${safeOriginUrl ? `
          <a href="${escapeHtml(safeOriginUrl)}" target="_blank" rel="noopener noreferrer" class="hud-btn hud-btn-action">
            <span>Leer artículo original ↗</span>
          </a>
        ` : ''}
      </div>
    `;

    DOM.readerModal.style.display = 'flex';
  }

  function closeReaderModal() {
    DOM.readerModal.style.display = 'none';
    state.activeReaderArticle = null;
    updateSeoMeta();
  }

  // ==========================================
  // 12. Modal Noticia Manual
  // ==========================================
  function openCreateModal() {
    if (!state.currentUser) {
      showToast('Debes iniciar sesión para publicar un despacho de inteligencia.', 'info');
      openAuthModal();
      return;
    }

    DOM.formModalTitle.textContent = 'REGISTRAR NUEVA NOTICIA DE INTELIGENCIA';
    DOM.articleForm.reset();
    DOM.editArticleId.value = '';
    DOM.formCategory.value = !['all', 'bookmarks', 'forum', 'contact'].includes(state.currentCategory)
      ? state.currentCategory
      : 'hacking';
    DOM.formSourceName.value = `LinkedIn // ${state.currentUser.displayName}`;
    DOM.formSourceUrl.value = state.currentUser.linkedInProfile || '';
    DOM.formReadTime.value = '3 min';
    DOM.articleFormModal.style.display = 'flex';
    DOM.formTitle.focus();
  }

  function openEditModal(articleId) {
    const article = state.articles.find(a => a.id === articleId);
    if (!article) return;

    if (!canManageArticle(article)) {
      showToast('No tienes permisos para modificar este despacho.', 'error');
      return;
    }

    DOM.formModalTitle.textContent = 'MODIFICAR DESPACHO';
    DOM.editArticleId.value = article.id;
    DOM.formTitle.value = article.title;
    DOM.formCategory.value = article.category;
    DOM.formSourceName.value = article.sourceName || '';
    DOM.formSourceUrl.value = article.sourceUrl || '';
    DOM.formImageUrl.value = article.imageUrl || '';
    DOM.formSummary.value = article.summary || '';
    DOM.formContent.value = article.content || '';
    DOM.formTags.value = Array.isArray(article.tags) ? article.tags.join(', ') : '';
    DOM.formReadTime.value = article.readTime || '3 min';
    DOM.formIsBreaking.checked = !!article.isBreaking;
    DOM.formIsFeatured.checked = !!article.isFeatured;

    DOM.articleFormModal.style.display = 'flex';
  }

  function closeFormModal() {
    DOM.articleFormModal.style.display = 'none';
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    if (!state.currentUser) {
      showToast('Sesión no válida.', 'error');
      return;
    }

    const editId = DOM.editArticleId.value;
    const title = DOM.formTitle.value.trim();
    const category = DOM.formCategory.value;
    const sourceName = DOM.formSourceName.value.trim() || `LinkedIn // ${state.currentUser.displayName}`;
    const sourceUrl = DOM.formSourceUrl.value.trim() || state.currentUser.linkedInProfile || '';
    const imageUrl = DOM.formImageUrl.value.trim() || getDefaultImage(category, sourceName, title);
    const summary = DOM.formSummary.value.trim();
    const content = DOM.formContent.value.trim();
    const tags = DOM.formTags.value
      .split(',')
      .map(t => t.trim().toLowerCase().replace(/^#/, ''))
      .filter(t => t.length > 0);
    const readTime = DOM.formReadTime.value.trim() || calculateReadTime(content);
    const isBreaking = DOM.formIsBreaking.checked;
    const isFeatured = DOM.formIsFeatured.checked;

    if (!title || !category || !summary || !content) {
      showToast('Campos requeridos incompletos.', 'error');
      return;
    }

    if (state.serverMode && state.currentUser) {
      const endpoint = editId ? `/api/articles/${encodeURIComponent(editId)}` : '/api/articles';
      const method = editId ? 'PUT' : 'POST';

      try {
        const res = await apiFetch(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title, category, sourceName, sourceUrl, imageUrl, summary, content, tags, readTime, isBreaking, isFeatured
          })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Error al guardar.', 'error');
          return;
        }

        if (editId) {
          const idx = state.articles.findIndex(a => a.id === editId);
          if (idx !== -1) state.articles[idx] = data.article;
          showToast('Despacho actualizado con éxito.');
        } else {
          state.articles.unshift(data.article);
          showToast('Despacho publicado en el terminal.');
        }

        closeFormModal();
        renderAll();
        return;
      } catch (err) {
        showToast('Error de comunicación con el backend.', 'error');
        return;
      }
    }

    // Modo local
    if (editId) {
      const index = state.articles.findIndex(a => a.id === editId);
      if (index !== -1) {
        state.articles[index] = {
          ...state.articles[index],
          title, category, sourceName, sourceUrl, imageUrl, summary, content, tags, readTime, isBreaking, isFeatured
        };
        showToast('Despacho actualizado con éxito.');
      }
    } else {
      const newArticle = {
        id: 'svb-' + Date.now(),
        title, category, sourceName, sourceUrl, imageUrl, summary, content, tags, readTime, isBreaking, isFeatured,
        author: state.currentUser.displayName,
        authorId: state.currentUser.id,
        authorRole: state.currentUser.role,
        verifiedLinkedIn: !!state.currentUser.linkedInProfile,
        date: new Date().toISOString(),
        views: 0
      };
      state.articles.unshift(newArticle);
      showToast('Despacho publicado en el terminal.');
    }

    persistArticles();
    closeFormModal();
    renderAll();
  }

  async function confirmDeleteArticle(articleId) {
    const article = state.articles.find(a => a.id === articleId);
    if (!article) return;

    if (!canManageArticle(article)) {
      showToast('No tienes permisos para eliminar este despacho.', 'error');
      return;
    }

    if (confirm(`¿Eliminar despacho permanentemente:\n"${article.title}"?`)) {
      if (state.serverMode && state.currentUser) {
        try {
          const res = await apiFetch(`/api/articles/${encodeURIComponent(articleId)}`, {
            method: 'DELETE'
          });
          if (!res.ok) {
            const data = await res.json();
            showToast(data.error || 'Error al eliminar.', 'error');
            return;
          }
        } catch (e) {}
      }

      state.articles = state.articles.filter(a => a.id !== articleId);
      state.bookmarks.delete(articleId);
      saveBookmarks();
      persistArticles();
      renderAll();
      showToast('Despacho eliminado.', 'info');
    }
  }

  // ==========================================
  // 13. Marcadores & Filtros
  // ==========================================
  function toggleBookmark(articleId) {
    if (state.bookmarks.has(articleId)) {
      state.bookmarks.delete(articleId);
      showToast('Eliminada de guardadas', 'info');
    } else {
      state.bookmarks.add(articleId);
      showToast('Guardada en favoritos ⭐');
    }
    saveBookmarks();
    updateCategoryCounts();

    if (state.currentCategory === 'bookmarks') {
      renderFeed();
    } else {
      Array.from(document.querySelectorAll('article[data-id]'))
        .filter(el => el.getAttribute('data-id') === articleId)
        .forEach(card => {
          const btn = card.querySelector('[data-action="bookmark"]');
          if (!btn) return;
          const isB = state.bookmarks.has(articleId);
          btn.classList.toggle('bookmarked', isB);
          btn.innerHTML = `<span>${isB ? '⭐' : '☆'}</span>`;
        });
    }

    if (state.activeReaderArticle && state.activeReaderArticle.id === articleId) {
      const isB = state.bookmarks.has(articleId);
      DOM.readerBookmarkBtn.classList.toggle('bookmarked', isB);
      DOM.readerBookmarkBtn.innerHTML = `<span>${isB ? '⭐' : '☆'}</span>`;
    }
  }

  function saveBookmarks() {
    localStorage.setItem('silverbot_bookmarks', JSON.stringify([...state.bookmarks]));
  }

  function setCategory(category) {
    state.currentCategory = category;
    document.querySelectorAll('.poly-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.category === category);
    });
    renderFeed();
    if (category !== 'all') {
      trackClientVisit('/?cat=' + encodeURIComponent(category));
    }
  }

  function setTagFilter(tag) {
    state.currentTag = tag;
    document.querySelectorAll('.poly-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.tag === tag);
    });
    renderFeed();
  }

  function handleSearchInput(e) {
    state.searchQuery = e.target.value;
    DOM.clearSearchBtn.style.display = state.searchQuery ? 'block' : 'none';
    renderFeed();
  }

  function clearSearch() {
    state.searchQuery = '';
    DOM.searchInput.value = '';
    DOM.clearSearchBtn.style.display = 'none';
    DOM.searchInput.focus();
    renderFeed();
  }

  function resetAllFilters() {
    state.currentCategory = 'all';
    state.currentTag = 'all';
    state.searchQuery = '';
    state.sortBy = 'recent';

    DOM.searchInput.value = '';
    DOM.clearSearchBtn.style.display = 'none';
    DOM.sortSelect.value = 'recent';

    document.querySelectorAll('.poly-tab').forEach(b => b.classList.toggle('active', b.dataset.category === 'all'));
    document.querySelectorAll('.poly-chip').forEach(c => c.classList.toggle('active', c.dataset.tag === 'all'));

    renderFeed();
    showToast('Filtros reiniciados.', 'info');
  }

  // ==========================================
  // 14. Copias de Seguridad (JSON e Integral)
  // ==========================================
  function downloadJsonFile(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportFullBackupJson() {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Acceso restringido al Administrador.', 'error');
      return;
    }
    if (!state.serverMode) {
      downloadJsonFile({
        version: 7,
        exportedAt: new Date().toISOString(),
        config: state.config,
        articles: state.articles,
        forum: state.forumThreads
      }, `cyberpolis-respaldo-local-${new Date().toISOString().slice(0, 10)}.json`);
      showToast('Respaldo local descargado.');
      return;
    }
    try {
      const res = await apiFetch('/api/admin/backup/full');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'No se pudo exportar el respaldo integral.', 'error');
        return;
      }
      const snapshot = await res.json();
      downloadJsonFile(snapshot, `cyberpolis-respaldo-completo-${new Date().toISOString().slice(0, 10)}.json`);
      showToast('Respaldo completo del portal descargado.');
    } catch (e) {
      showToast('Error de red al exportar el respaldo integral.', 'error');
    }
  }

  function importFullBackupJson(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Solo un Administrador puede restaurar el respaldo completo.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = async function (event) {
      try {
        const snapshot = JSON.parse(event.target.result);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          throw new Error('Formato inválido de respaldo integral');
        }
        const hasAnySection = snapshot.config || Array.isArray(snapshot.users) || Array.isArray(snapshot.articles) || Array.isArray(snapshot.forum) || snapshot.analytics;
        if (!hasAnySection) throw new Error('El archivo no contiene secciones válidas');

        if (!confirm('¿Restaurar respaldo integral completo (configuración, usuarios, métricas, foro y noticias)? Se sobrescribirán los datos actuales del servidor.')) {
          return;
        }

        if (state.serverMode) {
          const res = await apiFetch('/api/admin/backup/full', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot)
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showToast(data.error || 'Error al restaurar el respaldo integral.', 'error');
            return;
          }
          await checkAuthSession();
          await loadConfig();
          await loadArticles();
          await loadForum();
          renderAll();
          closeBackupModal();
          showToast(data.message || 'Respaldo integral restaurado correctamente.');
        }
      } catch (err) {
        showToast('Error al leer o restaurar el archivo de respaldo integral.', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function exportArticlesJson() {
    const filename = `cyberpolis-noticias-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJsonFile(state.articles, filename);
    showToast('Copia JSON de noticias descargada.');
  }

  function importArticlesJson(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Solo un Administrador puede realizar importaciones masivas.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = async function (event) {
      try {
        const imported = JSON.parse(event.target.result);
        if (!Array.isArray(imported)) throw new Error('Formato inválido');

        if (confirm(`Se cargarán ${imported.length} despachos. ¿Deseas reemplazar tu base de datos actual?`)) {
          if (state.serverMode && state.currentUser) {
            const res = await apiFetch('/api/articles/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(imported)
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              showToast(err.error || 'Error al importar noticias en el servidor.', 'error');
              return;
            }
            await loadArticles();
          } else {
            state.articles = imported;
            persistArticles();
          }
          renderAll();
          closeBackupModal();
          showToast(`¡Importación exitosa! ${imported.length} despachos cargados.`);
        }
      } catch (err) {
        showToast('Error al importar archivo JSON.', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function resetDemoData() {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Acceso restringido al Administrador.', 'error');
      return;
    }
    if (confirm('¿Restablecer las noticias al paquete de demostración inicial?')) {
      state.articles = [...DEFAULT_SEED_ARTICLES];
      persistArticles();
      renderAll();
      closeBackupModal();
      showToast('Demostración inicial cargada.');
    }
  }

  async function openBackupModal() {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Acceso restringido: Solo el Administrador puede gestionar respaldos.', 'error');
      return;
    }
    DOM.backupModal.style.display = 'flex';
    if (DOM.backupPersistenceBanner && state.serverMode) {
      DOM.backupPersistenceBanner.className = 'admin-storage-banner';
      DOM.backupPersistenceBanner.textContent = 'Comprobando modo de persistencia del servidor...';
      try {
        const res = await apiFetch('/api/admin/system-status');
        if (res.ok) {
          const st = await res.json();
          const isPerm = st.storage && st.storage.persistent;
          DOM.backupPersistenceBanner.className = `admin-storage-banner ${isPerm ? 'banner-ok' : 'banner-warn'}`;
          DOM.backupPersistenceBanner.innerHTML = isPerm
            ? `<strong>✅ Almacenamiento persistente activo (${escapeHtml(st.storage.label)}).</strong> Tus usuarios, métricas y ajustes perduran entre actualizaciones.`
            : `<strong>⚠️ Almacenamiento efímero activo:</strong> Si actualizas o reinicias en Render Free sin DB externa, las métricas y usuarios vuelven al estado inicial. Descarga el <strong>Respaldo Integral</strong> antes de cada cambio o configura <code>DATABASE_URL</code> en la pestaña <strong>🛡️ SEGURIDAD Y BD</strong>.`;
        }
      } catch (e) {}
    }
  }

  function closeBackupModal() {
    DOM.backupModal.style.display = 'none';
  }

  function toggleTheme() {
    const newTheme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('silverbot_theme_v3', theme);
  }

  // ==========================================
  // 15. Atajos y Eventos
  // ==========================================
  function setupShortcuts() {
    window.addEventListener('keydown', e => {
      const tag = document.activeElement.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.key === 'Escape') {
        closeFormModal();
        closeReaderModal();
        closeBackupModal();
        closeAuthModal();
        closeLinkedInModal();
        closeUsersDirectory();
        closeAdminControl();
        closeChangePasswordModal();
        return;
      }

      if (!isInput) {
        if (e.key === '/' || (e.ctrlKey && e.key === 'k')) {
          e.preventDefault();
          DOM.searchInput.focus();
        } else if ((e.key === 'n' || e.key === 'N') && state.currentUser) {
          e.preventDefault();
          openCreateModal();
        }
      }
    });
  }

  function bindEvents() {
    // Manejador global en fase de captura para imágenes externas rotas (compatible con CSP sin inline onerror)
    document.addEventListener('error', e => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG' || img.dataset.imgFallbackApplied === '1') return;
      img.dataset.imgFallbackApplied = '1';
      if (img.classList.contains('ad-banner-img')) {
        img.style.display = 'none';
        return;
      }
      if (img.id === 'uiPortalLogo' || img.id === 'adminLogoPreview' || img.classList.contains('user-logo-img') || img.classList.contains('user-avatar-mini')) {
        if (!img.src.endsWith('assets/silverbot-unix-logo.png')) {
          img.src = 'assets/silverbot-unix-logo.png';
        }
        return;
      }
      if (typeof window.handleImgError === 'function') {
        window.handleImgError(img);
      }
    }, true);

    // Único listener global para cerrar el menú de usuario al hacer clic fuera
    document.addEventListener('click', () => {
      const menu = document.getElementById('userDropdownMenu');
      if (menu) menu.style.display = 'none';
    });

    DOM.searchInput.addEventListener('input', handleSearchInput);
    DOM.clearSearchBtn.addEventListener('click', clearSearch);

    DOM.sortSelect.addEventListener('change', e => {
      state.sortBy = e.target.value;
      renderFeed();
    });

    DOM.categoryTabs.addEventListener('click', e => {
      const btn = e.target.closest('.poly-tab');
      if (btn) setCategory(btn.dataset.category);
    });

    DOM.popularTagsBar.addEventListener('click', e => {
      const chip = e.target.closest('.poly-chip');
      if (chip) setTagFilter(chip.dataset.tag);
    });

    DOM.themeToggleBtn.addEventListener('click', toggleTheme);
    DOM.openNewArticleModalBtn.addEventListener('click', openCreateModal);
    DOM.openLinkedInModalBtn.addEventListener('click', openLinkedInModal);
    if (DOM.openAdminControlBtn) DOM.openAdminControlBtn.addEventListener('click', openAdminControl);
    DOM.emptyCreateBtn.addEventListener('click', openCreateModal);
    DOM.resetFiltersBtn.addEventListener('click', resetAllFilters);
    DOM.backupModalBtn.addEventListener('click', openBackupModal);
    if (DOM.brandResetBtn) DOM.brandResetBtn.addEventListener('click', resetAllFilters);

    // Eventos del Panel Admin
    if (DOM.closeAdminControlBtn) DOM.closeAdminControlBtn.addEventListener('click', closeAdminControl);
    if (DOM.closeAdminModalFooterBtn) DOM.closeAdminModalFooterBtn.addEventListener('click', closeAdminControl);
    if (DOM.adminTabFeedsBtn) DOM.adminTabFeedsBtn.addEventListener('click', () => switchAdminTab('feeds'));
    if (DOM.adminTabMetricsBtn) DOM.adminTabMetricsBtn.addEventListener('click', () => switchAdminTab('metrics'));
    if (DOM.adminTabUsersBtn) DOM.adminTabUsersBtn.addEventListener('click', () => switchAdminTab('users'));
    if (DOM.adminTabTransformBtn) DOM.adminTabTransformBtn.addEventListener('click', () => switchAdminTab('transform'));
    if (DOM.adminTabChatBtn) DOM.adminTabChatBtn.addEventListener('click', () => switchAdminTab('chat'));
    if (DOM.adminTabAdsBtn) DOM.adminTabAdsBtn.addEventListener('click', () => switchAdminTab('ads'));
    if (DOM.adminTabSecurityBtn) DOM.adminTabSecurityBtn.addEventListener('click', () => switchAdminTab('security'));

    // Eventos del Chat IRC Lateral (mIRC32) y Moderación Admin
    if (DOM.ircChatForm) DOM.ircChatForm.addEventListener('submit', handleIrcChatSubmit);
    if (DOM.ircPopupToggleBtn) {
      DOM.ircPopupToggleBtn.addEventListener('click', () => {
        state.chat.popupsEnabled = !state.chat.popupsEnabled;
        try { localStorage.setItem('cyberpolis_irc_popups', state.chat.popupsEnabled ? '1' : '0'); } catch (e) {}
        syncIrcPopupToggleUi();
        if (!state.chat.popupsEnabled && DOM.ircPopupContainer) {
          DOM.ircPopupContainer.innerHTML = '';
        }
        showToast(state.chat.popupsEnabled ? 'Popups mIRC32 activados para mensajes no leídos.' : 'Popups mIRC32 silenciados.');
      });
    }
    if (DOM.ircToggleNicksBtn) {
      DOM.ircToggleNicksBtn.addEventListener('click', () => {
        state.chat.hideNicks = !state.chat.hideNicks;
        if (DOM.ircBody) DOM.ircBody.classList.toggle('hide-nicks', state.chat.hideNicks);
      });
    }
    if (DOM.ircAdminShortcutBtn) {
      DOM.ircAdminShortcutBtn.addEventListener('click', () => {
        openAdminControl();
        switchAdminTab('chat');
      });
    }
    if (DOM.ircCollapseBtn) {
      DOM.ircCollapseBtn.addEventListener('click', () => {
        setIrcCollapsed(true);
      });
    }
    if (DOM.ircReopenTab) {
      DOM.ircReopenTab.addEventListener('click', () => {
        openIrcDrawer();
      });
    }
    if (DOM.ircHeaderToggleBtn) {
      DOM.ircHeaderToggleBtn.addEventListener('click', () => {
        toggleIrcDrawer();
      });
    }
    if (DOM.mircWindow) {
      DOM.mircWindow.addEventListener('focusin', () => {
        markIrcMessagesRead();
      });
      DOM.mircWindow.addEventListener('click', () => {
        markIrcMessagesRead();
      });
    }
    if (DOM.ircMessagesList) {
      DOM.ircMessagesList.addEventListener('scroll', () => {
        const nearBottom = (DOM.ircMessagesList.scrollHeight - DOM.ircMessagesList.scrollTop - DOM.ircMessagesList.clientHeight) < 36;
        if (nearBottom) {
          state.chat.lastReadActivityAt = Date.now();
          if (DOM.mircWindow && DOM.mircWindow.matches(':hover') && state.chat.unreadIds.size > 0) {
            markIrcMessagesRead();
          }
        }
      });
    }
    if (DOM.ircPopupContainer) {
      DOM.ircPopupContainer.addEventListener('click', e => {
        const closeBtn = e.target.closest('[data-irc-popup-close]');
        if (closeBtn) {
          e.stopPropagation();
          const card = closeBtn.closest('.irc-popup-card');
          if (card) card.remove();
          return;
        }
        const card = e.target.closest('.irc-popup-card');
        if (card) {
          focusIrcFromPopup();
        }
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && DOM.mircWindow && DOM.mircWindow.contains(document.activeElement)) {
        markIrcMessagesRead();
      }
    });
    if (DOM.ircGuestNickInput) {
      DOM.ircGuestNickInput.addEventListener('change', () => {
        const cleaned = sanitizeGuestIrcNick(DOM.ircGuestNickInput.value);
        state.chat.guestNick = cleaned;
        DOM.ircGuestNickInput.value = cleaned;
        try { localStorage.setItem('cyberpolis_irc_nick', cleaned); } catch (e) {}
        syncIrcIdentityUi(true);
      });
    }
    if (DOM.ircNickList) {
      DOM.ircNickList.addEventListener('click', e => {
        const item = e.target.closest('[data-irc-nick]');
        if (!item || !DOM.ircChatInput) return;
        const nick = item.dataset.ircNick;
        if (nick) {
          DOM.ircChatInput.value = `${nick}: ${DOM.ircChatInput.value}`.trimStart();
          DOM.ircChatInput.focus();
        }
      });
      DOM.ircNickList.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        const item = e.target.closest('[data-irc-nick]');
        if (item && item.dataset.ircNick) {
          openIrcNickContextMenu(item.dataset.ircNick, e.clientX, e.clientY);
        } else {
          openIrcChannelContextMenu(e.clientX, e.clientY);
        }
      });
    }
    if (DOM.ircMessagesList) {
      DOM.ircMessagesList.addEventListener('click', e => {
        const delBtn = e.target.closest('[data-irc-del]');
        if (delBtn) {
          deleteChatMessageById(delBtn.dataset.ircDel);
          return;
        }
        const modBtn = e.target.closest('[data-irc-mod-action]');
        if (modBtn) {
          const action = modBtn.dataset.ircModAction;
          const target = modBtn.dataset.ircTargetNick;
          if (state.currentUser && state.currentUser.role === 'admin') {
            handleAdminChatAction(action, target, 'Moderación desde canal');
          } else {
            runIrcOpAction(action, target, { reason: 'Moderación desde canal' });
          }
        }
      });
      DOM.ircMessagesList.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        const nickEl = e.target.closest('[data-irc-nick]');
        if (nickEl && nickEl.dataset.ircNick) {
          openIrcNickContextMenu(nickEl.dataset.ircNick, e.clientX, e.clientY);
        } else {
          openIrcChannelContextMenu(e.clientX, e.clientY);
        }
      });
    }
    if (DOM.ircTopicBar) {
      DOM.ircTopicBar.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        openIrcChannelContextMenu(e.clientX, e.clientY);
      });
      DOM.ircTopicBar.addEventListener('dblclick', () => {
        if (isCurrentUserIrcOp()) startInlineTopicEdit();
      });
    }
    if (DOM.ircTopicInlineInput) {
      DOM.ircTopicInlineInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitInlineTopicEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelInlineTopicEdit();
        }
      });
      DOM.ircTopicInlineInput.addEventListener('blur', () => {
        cancelInlineTopicEdit();
      });
    }
    if (DOM.ircContextMenu) {
      DOM.ircContextMenu.addEventListener('contextmenu', e => e.preventDefault());
      DOM.ircContextMenu.addEventListener('click', e => {
        const btn = e.target.closest('[data-ctx-action]');
        if (!btn || btn.disabled) return;
        e.stopPropagation();
        handleIrcContextMenuAction(btn.dataset.ctxAction, btn.dataset.ctxNick || '');
      });
    }
    document.addEventListener('click', e => {
      if (DOM.ircContextMenu && DOM.ircContextMenu.style.display !== 'none' && !DOM.ircContextMenu.contains(e.target)) {
        closeIrcContextMenu();
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && DOM.ircContextMenu && DOM.ircContextMenu.style.display !== 'none') {
        closeIrcContextMenu();
      }
    });
    if (DOM.chatAdminRefreshBtn) DOM.chatAdminRefreshBtn.addEventListener('click', loadAdminChatModeration);
    if (DOM.chatAdminSaveConfigBtn) DOM.chatAdminSaveConfigBtn.addEventListener('click', handleSaveChatAdminConfig);
    if (DOM.chatAdminNoticeBtn) {
      DOM.chatAdminNoticeBtn.addEventListener('click', () => {
        const text = DOM.chatAdminNoticeInput ? DOM.chatAdminNoticeInput.value.trim() : '';
        if (!text) return showToast('Escribe un aviso para enviar al canal.', 'error');
        handleAdminChatAction('notice', '', '', text).then(ok => {
          if (ok && DOM.chatAdminNoticeInput) DOM.chatAdminNoticeInput.value = '';
        });
      });
    }
    if (DOM.chatAdminClearBtn) {
      DOM.chatAdminClearBtn.addEventListener('click', () => {
        handleAdminChatAction('clear');
      });
    }
    if (DOM.chatAdminOpBtn) {
      DOM.chatAdminOpBtn.addEventListener('click', () => {
        const nick = DOM.chatAdminModNickInput ? DOM.chatAdminModNickInput.value.trim() : '';
        if (!nick) return showToast('Indica el nick a elevar (@Op).', 'error');
        const alreadyOp = isNickInList(state.chat.opNickNames, nick);
        handleAdminChatAction(alreadyOp ? 'deop' : 'op', nick);
      });
    }
    if (DOM.chatAdminVoiceBtn) {
      DOM.chatAdminVoiceBtn.addEventListener('click', () => {
        const nick = DOM.chatAdminModNickInput ? DOM.chatAdminModNickInput.value.trim() : '';
        if (!nick) return showToast('Indica el nick para +Voz.', 'error');
        const alreadyVoice = isNickInList(state.chat.voiceNickNames, nick);
        handleAdminChatAction(alreadyVoice ? 'devoice' : 'voice', nick);
      });
    }
    if (DOM.chatAdminMuteBtn) {
      DOM.chatAdminMuteBtn.addEventListener('click', () => {
        const nick = DOM.chatAdminModNickInput ? DOM.chatAdminModNickInput.value.trim() : '';
        const reason = DOM.chatAdminModReasonInput ? DOM.chatAdminModReasonInput.value.trim() : '';
        if (!nick) return showToast('Indica el nick a silenciar.', 'error');
        handleAdminChatAction('mute', nick, reason);
      });
    }
    if (DOM.chatAdminKickBtn) {
      DOM.chatAdminKickBtn.addEventListener('click', () => {
        const nick = DOM.chatAdminModNickInput ? DOM.chatAdminModNickInput.value.trim() : '';
        const reason = DOM.chatAdminModReasonInput ? DOM.chatAdminModReasonInput.value.trim() : '';
        if (!nick) return showToast('Indica el nick a expulsar (/kick).', 'error');
        handleAdminChatAction('kick', nick, reason);
      });
    }
    if (DOM.chatAdminBanBtn) {
      DOM.chatAdminBanBtn.addEventListener('click', () => {
        const nick = DOM.chatAdminModNickInput ? DOM.chatAdminModNickInput.value.trim() : '';
        const reason = DOM.chatAdminModReasonInput ? DOM.chatAdminModReasonInput.value.trim() : '';
        if (!nick) return showToast('Indica el nick a banear.', 'error');
        handleAdminChatAction('ban', nick, reason);
      });
    }
    if (DOM.chatAdminMessagesList) {
      DOM.chatAdminMessagesList.addEventListener('click', e => {
        const delBtn = e.target.closest('[data-admin-chat-del]');
        if (delBtn) {
          deleteChatMessageById(delBtn.dataset.adminChatDel);
          return;
        }
        const actBtn = e.target.closest('[data-admin-chat-act]');
        if (actBtn) {
          handleAdminChatAction(actBtn.dataset.adminChatAct, actBtn.dataset.adminChatNick, 'Moderación desde Admin');
        }
      });
    }
    if (DOM.chatAdminBansList) {
      DOM.chatAdminBansList.addEventListener('click', e => {
        const unbanBtn = e.target.closest('[data-admin-chat-unban]');
        if (unbanBtn) {
          handleAdminChatAction('unban', unbanBtn.dataset.adminChatNick || '', '', '', unbanBtn.dataset.adminChatUnban);
          return;
        }
        const unmuteBtn = e.target.closest('[data-admin-chat-unmute]');
        if (unmuteBtn) {
          handleAdminChatAction('unmute', unmuteBtn.dataset.adminChatUnmute);
        }
      });
    }
    window.addEventListener('resize', updateIrcShellLayout);
    if (DOM.refreshSystemStatusBtn) DOM.refreshSystemStatusBtn.addEventListener('click', loadAdminSystemStatus);
    if (DOM.adminOpenChangePassBtn) DOM.adminOpenChangePassBtn.addEventListener('click', openChangePasswordModal);
    if (DOM.refreshMetricsBtn) DOM.refreshMetricsBtn.addEventListener('click', loadAdminMetrics);
    if (DOM.resetMetricsBtn) DOM.resetMetricsBtn.addEventListener('click', handleResetMetrics);

    if (DOM.adminUserSearchInput) {
      DOM.adminUserSearchInput.addEventListener('input', e => {
        state.adminUserSearch = e.target.value || '';
        renderAdminUsers();
      });
    }
    if (DOM.toggleAdminCreateUserBtn) {
      DOM.toggleAdminCreateUserBtn.addEventListener('click', () => {
        if (!DOM.adminCreateUserForm) return;
        const hidden = DOM.adminCreateUserForm.style.display === 'none';
        DOM.adminCreateUserForm.style.display = hidden ? 'block' : 'none';
      });
    }
    if (DOM.cancelAdminCreateUserBtn) {
      DOM.cancelAdminCreateUserBtn.addEventListener('click', () => {
        if (DOM.adminCreateUserForm) DOM.adminCreateUserForm.style.display = 'none';
      });
    }
    if (DOM.adminCreateUserForm) {
      DOM.adminCreateUserForm.addEventListener('submit', handleAdminCreateUser);
    }
    if (DOM.adminUsersManageList) {
      DOM.adminUsersManageList.addEventListener('click', e => {
        const resetToggle = e.target.closest('[data-user-reset-toggle]');
        if (resetToggle) {
          const uid = resetToggle.dataset.userResetToggle;
          state.resetPasswordUserId = state.resetPasswordUserId === uid ? null : uid;
          state.confirmDeleteUserId = null;
          renderAdminUsers();
          return;
        }
        const cancelReset = e.target.closest('[data-user-reset-cancel]');
        if (cancelReset) {
          state.resetPasswordUserId = null;
          renderAdminUsers();
          return;
        }
        const genBtn = e.target.closest('[data-user-gen-pass]');
        if (genBtn) {
          const card = genBtn.closest('.admin-user-card');
          const inp = card ? card.querySelector('.admin-reset-pass-input') : null;
          if (inp) {
            inp.value = generateStrongPassword(14);
          }
          return;
        }
        const statusBtn = e.target.closest('[data-user-status-toggle]');
        if (statusBtn) {
          handleAdminToggleStatus(statusBtn.dataset.userStatusToggle, statusBtn.dataset.nextStatus);
          return;
        }
        const deleteAsk = e.target.closest('[data-user-delete-ask]');
        if (deleteAsk) {
          const uid = deleteAsk.dataset.userDeleteAsk;
          state.confirmDeleteUserId = state.confirmDeleteUserId === uid ? null : uid;
          state.resetPasswordUserId = null;
          renderAdminUsers();
          return;
        }
        const deleteCancel = e.target.closest('[data-user-delete-cancel]');
        if (deleteCancel) {
          state.confirmDeleteUserId = null;
          renderAdminUsers();
          return;
        }
        const deleteConfirm = e.target.closest('[data-user-delete-confirm]');
        if (deleteConfirm) {
          handleAdminDeleteUser(deleteConfirm.dataset.userDeleteConfirm);
        }
      });

      DOM.adminUsersManageList.addEventListener('submit', e => {
        const resetForm = e.target.closest('.admin-reset-inline[data-user-id]');
        if (resetForm) {
          e.preventDefault();
          const uid = resetForm.dataset.userId;
          const inp = resetForm.querySelector('.admin-reset-pass-input');
          handleAdminResetPassword(uid, inp ? inp.value.trim() : '');
        }
      });

      DOM.adminUsersManageList.addEventListener('change', e => {
        const roleSelect = e.target.closest('.admin-role-select[data-user-role-id]');
        if (roleSelect) {
          handleAdminChangeRole(roleSelect.dataset.userRoleId, roleSelect.value);
        }
      });
    }
    if (DOM.adminForceSyncBtn) DOM.adminForceSyncBtn.addEventListener('click', handleForceSync);
    if (DOM.saveAdminFeedsBtn) DOM.saveAdminFeedsBtn.addEventListener('click', handleSaveFeedsConfig);
    if (DOM.applyTransformBtn) DOM.applyTransformBtn.addEventListener('click', handleApplyTransformation);
    if (DOM.cancelTransformBtn) DOM.cancelTransformBtn.addEventListener('click', closeAdminControl);

    // Personalizador de logotipo del portal (Admin)
    if (DOM.adminPortalLogoFile) {
      DOM.adminPortalLogoFile.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const dataUrl = ev.target.result;
          if (typeof dataUrl !== 'string') return;
          const img = new Image();
          img.onload = () => {
            const maxDim = 220;
            const scale = Math.min(1, maxDim / Math.max(img.width || maxDim, img.height || maxDim));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(32, Math.round((img.width || maxDim) * scale));
            canvas.height = Math.max(32, Math.round((img.height || maxDim) * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const pngDataUrl = canvas.toDataURL('image/png');
            state.pendingLogoDataUrl = pngDataUrl;
            if (DOM.adminLogoPreview) DOM.adminLogoPreview.src = pngDataUrl;
            if (DOM.adminPortalLogoInput) DOM.adminPortalLogoInput.value = '[Imagen personalizada lista para guardar]';
            showToast('Logotipo cargado y optimizado. Pulsa "Aplicar Transformación Web" para guardar.');
          };
          img.onerror = () => {
            showToast('No se pudo leer la imagen seleccionada. Prueba con PNG, JPG o WebP.');
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
      });
    }
    if (DOM.adminPortalLogoInput) {
      DOM.adminPortalLogoInput.addEventListener('input', () => {
        const val = DOM.adminPortalLogoInput.value.trim();
        if (val && val !== '[Imagen personalizada cargada]' && val !== '[Imagen personalizada lista para guardar]') {
          state.pendingLogoDataUrl = null;
          if (DOM.adminLogoPreview) DOM.adminLogoPreview.src = val;
        }
      });
    }
    if (DOM.adminResetLogoBtn) {
      DOM.adminResetLogoBtn.addEventListener('click', () => {
        const defaultLogo = 'assets/silverbot-unix-logo.png';
        state.pendingLogoDataUrl = null;
        if (DOM.adminPortalLogoInput) DOM.adminPortalLogoInput.value = defaultLogo;
        if (DOM.adminLogoPreview) DOM.adminLogoPreview.src = defaultLogo;
        if (DOM.adminPortalLogoFile) DOM.adminPortalLogoFile.value = '';
        showToast('Vista previa restaurada al logo original. Aplica para guardar.');
      });
    }

    // Eventos del Banner Publicitario Flotante y Gestor Admin
    if (DOM.floatingAdBanner) {
      DOM.floatingAdBanner.addEventListener('click', e => {
        const closeBtn = e.target.closest('.floating-ad-close');
        if (closeBtn) {
          e.preventDefault();
          e.stopPropagation();
          hideFloatingAdBanner(true);
        }
      });
      DOM.floatingAdBanner.addEventListener('mouseenter', () => {
        pauseAdAutoHideCountdown();
      });
      DOM.floatingAdBanner.addEventListener('mouseleave', () => {
        if (!state.adHideTimer && state.adCountdownRemainingMs > 0) {
          startAdAutoHideCountdown(state.adCountdownRemainingMs);
        }
      });
    }
    if (DOM.adImageFile) {
      DOM.adImageFile.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const dataUrl = ev.target.result;
          if (typeof dataUrl !== 'string') return;
          const img = new Image();
          img.onload = () => {
            const maxDim = 480;
            const scale = Math.min(1, maxDim / Math.max(img.width || maxDim, img.height || maxDim));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(64, Math.round((img.width || maxDim) * scale));
            canvas.height = Math.max(48, Math.round((img.height || maxDim) * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const encoded = canvas.toDataURL('image/jpeg', 0.84);
            state.pendingAdImageDataUrl = encoded;
            if (DOM.adImagePreview) {
              DOM.adImagePreview.style.display = '';
              DOM.adImagePreview.src = encoded;
            }
            if (DOM.adImageUrlInput) DOM.adImageUrlInput.value = '[Imagen personalizada lista para guardar]';
            showToast('Imagen del anuncio optimizada. Pulsa "Guardar Publicidad".');
          };
          img.onerror = () => showToast('No se pudo leer la imagen del anuncio.', 'error');
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
      });
    }
    if (DOM.adImageUrlInput) {
      DOM.adImageUrlInput.addEventListener('input', () => {
        const val = DOM.adImageUrlInput.value.trim();
        if (val && val !== '[Imagen personalizada cargada]' && val !== '[Imagen personalizada lista para guardar]') {
          state.pendingAdImageDataUrl = null;
          if (DOM.adImagePreview) {
            DOM.adImagePreview.style.display = '';
            DOM.adImagePreview.src = safeAdMediaSrc(val, DEFAULT_AD_BANNER.imageUrl);
          }
        }
      });
    }
    if (DOM.adResetBtn) {
      DOM.adResetBtn.addEventListener('click', () => {
        populateAdminAdForm(DEFAULT_AD_BANNER);
        showToast('Campos restaurados a The Prison. Pulsa "Guardar Publicidad" para aplicar.');
      });
    }
    if (DOM.adPreviewBtn) {
      DOM.adPreviewBtn.addEventListener('click', () => {
        try { sessionStorage.removeItem('cyberpolis_ad_dismissed'); } catch (e) {}
        state.adLastRenderKey = '';
        renderFloatingAdBanner(true, readAdminAdForm());
        showToast('Vista previa del banner activada en pantalla.');
      });
    }
    if (DOM.adSaveBtn) {
      DOM.adSaveBtn.addEventListener('click', handleSaveAdBannerConfig);
    }

    // Delegación de eventos del Foro Comunitario estilo HTCMania
    if (DOM.forumSection) {
      DOM.forumSection.addEventListener('click', e => {
        const navIdxBtn = e.target.closest('[data-forum-nav="index"]');
        if (navIdxBtn) {
          state.forumView = 'index';
          state.forumFilter = 'Todos';
          state.forumPrefixFilter = 'Todos';
          state.activeForumThreadId = null;
          renderForum();
          return;
        }
        const boardBtn = e.target.closest('[data-forum-board]');
        if (boardBtn) {
          state.forumView = 'board';
          state.forumFilter = boardBtn.dataset.forumBoard || 'Todos';
          state.forumPrefixFilter = 'Todos';
          state.activeForumThreadId = null;
          renderForum();
          return;
        }
        const prefixBtn = e.target.closest('[data-forum-prefix]');
        if (prefixBtn) {
          state.forumPrefixFilter = prefixBtn.dataset.forumPrefix || 'Todos';
          renderForum();
          return;
        }
        const threadBtn = e.target.closest('[data-forum-thread]');
        if (threadBtn) {
          openForumThreadView(threadBtn.dataset.forumThread);
          return;
        }
        const likeBtn = e.target.closest('[data-forum-like]');
        if (likeBtn) {
          handleToggleForumLike(likeBtn.dataset.forumLike, likeBtn.dataset.forumReplyId || '');
          return;
        }
        const quoteBtn = e.target.closest('[data-forum-quote]');
        if (quoteBtn) {
          quoteForumPostIntoReply(quoteBtn.dataset.forumQuoteAuthor || 'Usuario', quoteBtn.dataset.forumQuote || '');
          return;
        }
        const modBtn = e.target.closest('[data-forum-mod]');
        if (modBtn) {
          handleModerateForumThread(modBtn.dataset.forumThreadId, modBtn.dataset.forumMod);
          return;
        }
        const delReplyBtn = e.target.closest('[data-forum-del-reply]');
        if (delReplyBtn) {
          handleDeleteForumReply(delReplyBtn.dataset.forumThreadId, delReplyBtn.dataset.forumDelReply);
          return;
        }
        const deleteBtn = e.target.closest('[data-forum-delete]');
        if (deleteBtn) {
          handleDeleteForumThread(deleteBtn.dataset.forumDelete);
          return;
        }
        if (e.target.closest('#forumQuickReplyScrollBtn')) {
          const box = document.getElementById('forumQuickReplyText');
          if (box) {
            box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            box.focus();
          } else {
            openAuthModal();
          }
          return;
        }
        if (e.target.closest('#toggleForumComposerBtn')) {
          if (!state.currentUser) {
            openAuthModal();
            return;
          }
          state.showForumComposer = !state.showForumComposer;
          renderForum();
          return;
        }
        if (e.target.closest('#cancelForumComposerBtn')) {
          state.showForumComposer = false;
          renderForum();
          return;
        }
        if (e.target.closest('#forumLoginPromptBtn') || e.target.closest('[data-forum-login]')) {
          openAuthModal();
        }
      });

      DOM.forumSection.addEventListener('submit', e => {
        if (e.target.id === 'forumCreateThreadForm') {
          e.preventDefault();
          handleCreateForumThread(e.target);
          return;
        }
        const replyForm = e.target.closest('.forum-reply-form[data-thread-id]');
        if (replyForm) {
          e.preventDefault();
          handlePostForumReply(replyForm.dataset.threadId, replyForm);
        }
      });
    }

    // Delegación de eventos de Sección Contacto Editorial
    if (DOM.contactSection) {
      DOM.contactSection.addEventListener('click', async e => {
        if (e.target.closest('[data-contact-forum]')) {
          setCategory('forum');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        if (e.target.closest('[data-contact-admin]')) {
          openAdminControl();
          switchAdminTab('transform');
          return;
        }
        const copyBtn = e.target.closest('[data-copy-email]');
        if (copyBtn) {
          const email = copyBtn.dataset.copyEmail || '';
          if (email && navigator.clipboard && navigator.clipboard.writeText) {
            try {
              await navigator.clipboard.writeText(email);
              showToast('Correo copiado al portapapeles.');
              return;
            } catch (err) {}
          }
          showToast(email ? `Correo de contacto: ${email}` : 'Correo todavía no configurado.');
        }
      });
    }

    // Enlaces Legales, Derechos de Autor y Política de Uso (Pie de Página)
    document.querySelectorAll('[data-legal-doc]').forEach(btn => {
      btn.addEventListener('click', () => openLegalModal(btn.dataset.legalDoc || 'aviso'));
    });
    if (DOM.legalTabsRow) {
      DOM.legalTabsRow.addEventListener('click', e => {
        const tabBtn = e.target.closest('[data-legal-tab]');
        if (tabBtn) openLegalModal(tabBtn.dataset.legalTab || 'aviso');
      });
    }
    if (DOM.closeLegalModalBtn) DOM.closeLegalModalBtn.addEventListener('click', closeLegalModal);
    if (DOM.closeLegalFooterBtn) DOM.closeLegalFooterBtn.addEventListener('click', closeLegalModal);
    if (DOM.legalModal) {
      DOM.legalModal.addEventListener('click', e => {
        if (e.target === DOM.legalModal) closeLegalModal();
      });
    }
    if (DOM.footerContactLink) {
      DOM.footerContactLink.addEventListener('click', () => {
        setCategory('contact');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && DOM.legalModal && DOM.legalModal.style.display === 'flex') {
        closeLegalModal();
      }
    });

    // Delegación para Color Picker en Transformador
    if (DOM.accentColorPicker) {
      DOM.accentColorPicker.addEventListener('click', e => {
        const btn = e.target.closest('.accent-color-btn');
        if (!btn) return;
        document.querySelectorAll('.accent-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    }

    // Delegación para Selector de Modo Polígono
    if (DOM.polygonModeSelector) {
      DOM.polygonModeSelector.addEventListener('click', e => {
        const chip = e.target.closest('.poly-mode-chip');
        if (!chip) return;
        document.querySelectorAll('.poly-mode-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      });
    }

    // Delegación para Layout Mode
    if (DOM.layoutModeSelector) {
      DOM.layoutModeSelector.addEventListener('click', e => {
        const btn = e.target.closest('.layout-mode-btn');
        if (!btn) return;
        document.querySelectorAll('.layout-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    }

    // Modales de Auth
    DOM.closeAuthModalBtn.addEventListener('click', closeAuthModal);
    DOM.cancelAuthBtn.addEventListener('click', closeAuthModal);
    DOM.cancelRegisterBtn.addEventListener('click', closeAuthModal);
    DOM.tabLoginBtn.addEventListener('click', () => switchAuthTab('login'));
    DOM.tabRegisterBtn.addEventListener('click', () => switchAuthTab('register'));
    DOM.loginForm.addEventListener('submit', handleLoginSubmit);
    DOM.registerForm.addEventListener('submit', handleRegisterSubmit);

    // Modal LinkedIn
    DOM.closeLinkedInModalBtn.addEventListener('click', closeLinkedInModal);
    DOM.closeLnBtn.addEventListener('click', closeLinkedInModal);
    DOM.linkedInIngestionForm.addEventListener('submit', handleLinkedInIngestionSubmit);

    // Modal Usuarios
    DOM.closeUsersModalBtn.addEventListener('click', closeUsersDirectory);

    // Modal Formulario Noticia
    DOM.closeFormModalBtn.addEventListener('click', closeFormModal);
    DOM.cancelFormBtn.addEventListener('click', closeFormModal);
    DOM.articleForm.addEventListener('submit', handleFormSubmit);

    document.querySelectorAll('.sc-chip[data-source]').forEach(btn => {
      btn.addEventListener('click', () => {
        DOM.formSourceName.value = btn.dataset.source;
        DOM.formSourceName.focus();
      });
    });

    document.querySelectorAll('.preset-img-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        if (preset) {
          const sourceName = DOM.formSourceName.value.trim() || 'Despacho de Inteligencia';
          const title = DOM.formTitle.value.trim() || 'Aviso de Ciberseguridad';
          DOM.formImageUrl.value = createIntelSVG(sourceName, preset === 'cert' ? 'hacking' : preset, title);
          showToast('Insignia de inteligencia asignada.');
        } else if (btn.dataset.img) {
          DOM.formImageUrl.value = btn.dataset.img;
          showToast('Preset de imagen aplicado.');
        }
      });
    });

    DOM.previewImgBtn.addEventListener('click', () => {
      const url = DOM.formImageUrl.value.trim();
      if (!url) {
        showToast('Especifica una URL de imagen.', 'error');
        return;
      }
      const allowedUrl = safeHref(url) || (url.startsWith('assets/') ? url : '');
      if (!allowedUrl) {
        showToast('URL de imagen no válida (usa http/https o assets/).', 'error');
        return;
      }
      window.open(allowedUrl, '_blank', 'noopener,noreferrer');
    });

    DOM.closeReaderModalBtn.addEventListener('click', closeReaderModal);
    DOM.readerBookmarkBtn.addEventListener('click', () => {
      if (state.activeReaderArticle) toggleBookmark(state.activeReaderArticle.id);
    });
    DOM.readerShareBtn.addEventListener('click', handleShareArticle);

    DOM.closeBackupModalBtn.addEventListener('click', closeBackupModal);
    if (DOM.exportFullBackupBtn) DOM.exportFullBackupBtn.addEventListener('click', exportFullBackupJson);
    if (DOM.importFullBackupInput) DOM.importFullBackupInput.addEventListener('change', importFullBackupJson);
    DOM.exportJsonBtn.addEventListener('click', exportArticlesJson);
    DOM.importJsonFileInput.addEventListener('change', importArticlesJson);
    DOM.resetDemoBtn.addEventListener('click', resetDemoData);

    // Modal Cambio de Contraseña
    if (DOM.closeChangePassBtn) DOM.closeChangePassBtn.addEventListener('click', closeChangePasswordModal);
    if (DOM.cancelChangePassBtn) DOM.cancelChangePassBtn.addEventListener('click', closeChangePasswordModal);
    if (DOM.changePasswordForm) DOM.changePasswordForm.addEventListener('submit', handleChangePasswordSubmit);

    [DOM.articleFormModal, DOM.readerModal, DOM.backupModal, DOM.authModal, DOM.linkedInModal, DOM.usersDirectoryModal, DOM.adminControlModal, DOM.changePasswordModal].forEach(modal => {
      if (modal) {
        modal.addEventListener('click', e => {
          if (e.target === modal) modal.style.display = 'none';
        });
      }
    });
  }

  function handleShareArticle() {
    if (!state.activeReaderArticle) return;
    const a = state.activeReaderArticle;
    const text = `📰 [${a.title}]\nAutor: ${a.author || getPortalBrandLabel()}\nFuente: ${a.sourceName}\n${a.sourceUrl || ''}`;

    if (navigator.share) {
      navigator.share({
        title: a.title,
        text: a.summary,
        url: a.sourceUrl || window.location.href
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Titular, autor y fuente copiados.');
      }).catch(() => {
        showToast('No se pudo copiar.', 'error');
      });
    }
  }

  // ==========================================
  // 16. Utilidades
  // ==========================================
  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `hud-toast toast-${type}`;
    let icon = '⬡';
    if (type === 'error') icon = '⚠';
    if (type === 'info') icon = 'ℹ';

    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    DOM.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, 2800);
  }

  function getCategoryLabel(category) {
    switch (category) {
      case 'hacking': return 'HACKING & CIBER';
      case 'politica': return 'POLÍTICA';
      case 'tecnopolitica': return 'TECNOPOLÍTICA';
      default: return 'GENERAL';
    }
  }

  function getDefaultImage(category, sourceName = '', title = '') {
    return createIntelSVG(sourceName, category, title);
  }

  function getRelativeTime(dateString) {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffSec = Math.floor((now - date) / 1000);

      if (diffSec < 60) return 'Hace un instante';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `Hace ${diffMin} min`;
      const diffHours = Math.floor(diffMin / 60);
      if (diffHours < 24) return `Hace ${diffHours} h`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays === 1) return 'Ayer';
      if (diffDays < 7) return `Hace ${diffDays} d`;
      return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    } catch (e) {
      return 'Reciente';
    }
  }

  function calculateReadTime(text) {
    if (!text) return '2 min';
    const words = text.trim().split(/\s+/).length;
    const minutes = Math.max(1, Math.ceil(words / 180));
    return `${minutes} min`;
  }

  function formatArticleBody(content) {
    if (!content) return '<p>Sin detalles adicionales.</p>';
    const cleanContent = cleanHtmlContent(content);
    const paragraphs = cleanContent.split(/\n\s*\n/);
    return paragraphs.map(p => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      const lines = trimmed.split('\n');
      const isList = lines.length > 1 && lines.every(l => l.trim().startsWith('•') || l.trim().startsWith('-') || l.trim().startsWith('*') || /^\d+\./.test(l.trim()));

      if (isList) {
        const listItems = lines.map(l => {
          const clean = l.replace(/^[•\-\*]|\d+\.\s*/, '').trim();
          return `<li>${escapeHtml(clean)}</li>`;
        }).join('');
        return `<ul>${listItems}</ul>`;
      }

      return `<p>${escapeHtml(trimmed).replace(/\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('');
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================
  // 14. Foro & Debate Comunitario
  // ==========================================
  async function loadForum() {
    if (state.serverMode) {
      try {
        const res = await fetch('/api/forum');
        if (res.ok) {
          const threads = await res.json();
          if (Array.isArray(threads)) {
            state.forumThreads = threads;
            localStorage.setItem('silverbot_forum_cache', JSON.stringify(threads));
            updateForumCount();
            if (state.currentCategory === 'forum') renderForum();
            return;
          }
        }
      } catch (e) {}
    }

    try {
      const cached = JSON.parse(localStorage.getItem('silverbot_forum_cache') || 'null');
      if (Array.isArray(cached) && cached.length > 0) {
        state.forumThreads = cached;
      }
    } catch (e) {}

    if (!Array.isArray(state.forumThreads) || state.forumThreads.length === 0) {
      state.forumThreads = [
        {
          id: 'frm-demo-1',
          title: '¿Qué herramientas usáis para analizar alertas CVE y vulnerabilidades críticas?',
          category: 'Ciberseguridad',
          body: 'Abrimos este hilo para compartir feeds, scripts o flujos recomendados en el día a día para priorizar parches.',
          author: 'Silverbot2',
          authorId: 'usr-admin-01',
          authorRole: 'admin',
          createdAt: new Date(Date.now() - 3600000 * 6).toISOString(),
          replies: []
        }
      ];
    }
    updateForumCount();
    if (state.currentCategory === 'forum') renderForum();
  }

  function updateForumCount() {
    if (DOM.countForum) {
      DOM.countForum.textContent = Array.isArray(state.forumThreads) ? state.forumThreads.length : 0;
    }
  }

  const FORUM_BOARD_GROUPS = [
    {
      title: 'Ciberseguridad, Hacking & Herramientas',
      subtitle: 'Debates técnicos, CVEs, análisis de malware y utilidades',
      boards: [
        { key: 'Ciberseguridad', icon: '🛡️', desc: 'Alertas CVE, vulnerabilidades 0-day, ransomware e incidentes en vivo.' },
        { key: 'Herramientas', icon: '🧰', desc: 'OSINT, pentesting, scripts, laboratorios y utilidades recomendadas.' }
      ]
    },
    {
      title: 'Comunidad, Legislación & Soporte',
      subtitle: 'Actualidad digital, consultas y charla general estilo HTCMania',
      boards: [
        { key: 'Tecnopolítica', icon: '⚖️', desc: 'Privacidad, NIS2, regulación europea, soberanía digital y geopolítica.' },
        { key: 'Dudas & Ayuda', icon: '❓', desc: 'Resolución de dudas, configuración de redes, Linux y seguridad básica.' },
        { key: 'Off-Topic', icon: '☕', desc: 'Presentaciones, hardware, cafetería digital y charla abierta de la comunidad.' }
      ]
    }
  ];

  function getForumPrefixBadgeHtml(prefix) {
    const p = prefix || 'Debate';
    const clsMap = {
      Debate: 'p-debate',
      Tutorial: 'p-tutorial',
      Noticia: 'p-noticia',
      Consulta: 'p-consulta',
      'Off-Topic': 'p-offtopic'
    };
    return `<span class="htc-prefix ${clsMap[p] || 'p-debate'}">[${escapeHtml(p)}]</span>`;
  }

  function formatForumPostHtml(rawText) {
    let html = escapeHtml(String(rawText || ''));
    html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre class="htc-code-block">${code.trim()}</pre>`);
    html = html.replace(/\[quote=([^\]]+)\]([\s\S]*?)\[\/quote\]/gi, (_m, who, inner) =>
      `<div class="htc-quote-box"><div class="htc-quote-head">❝ Cita de ${who}</div><div>${inner.trim()}</div></div>`
    );
    html = html.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, (_m, inner) =>
      `<div class="htc-quote-box"><div class="htc-quote-head">❝ Cita</div><div>${inner.trim()}</div></div>`
    );
    return html.replace(/\n/g, '<br>');
  }

  function buildForumAuthorStats(threads) {
    const counts = new Map();
    for (const t of threads) {
      const a = String(t.author || 'Anónimo').toLowerCase();
      counts.set(a, (counts.get(a) || 0) + 1);
      for (const r of (t.replies || [])) {
        const ra = String(r.author || 'Usuario').toLowerCase();
        counts.set(ra, (counts.get(ra) || 0) + 1);
      }
    }
    return counts;
  }

  function getForumRankMeta(authorName, role, postCount) {
    if (role === 'admin') return { label: 'ADMINISTRADOR', cls: 'is-admin' };
    if (postCount >= 15) return { label: 'MAESTRO CYBER', cls: 'is-veteran' };
    if (postCount >= 5) return { label: 'FORERO VETERANO', cls: 'is-veteran' };
    return { label: role === 'analyst' ? 'ANALISTA' : 'MIEMBRO', cls: '' };
  }

  function sortForumThreads(threads) {
    return [...threads].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      const da = new Date(a.lastActivityAt || a.createdAt || 0).getTime();
      const db = new Date(b.lastActivityAt || b.createdAt || 0).getTime();
      return db - da;
    });
  }

  function getThreadLastActivityMeta(t) {
    const replies = Array.isArray(t.replies) ? t.replies : [];
    const last = replies.length ? replies[replies.length - 1] : null;
    return {
      author: last ? (last.author || 'Usuario') : (t.author || 'Anónimo'),
      ts: last ? last.createdAt : (t.lastActivityAt || t.createdAt)
    };
  }

  function renderForumComposerCard() {
    if (!state.currentUser || !state.showForumComposer) return '';
    const defaultCat = state.forumFilter && state.forumFilter !== 'Todos' ? state.forumFilter : 'Ciberseguridad';
    const boardOptions = ['Ciberseguridad', 'Herramientas', 'Tecnopolítica', 'Dudas & Ayuda', 'Off-Topic'];
    return `
      <div class="forum-composer-card">
        <h3 class="forum-composer-title">📝 Publicar nuevo tema en el foro</h3>
        <form id="forumCreateThreadForm">
          <div class="form-grid-2">
            <div class="form-field">
              <label for="forumThreadTitle" class="hud-label">TÍTULO DEL TEMA *</label>
              <input type="text" id="forumThreadTitle" class="hud-input" maxlength="160" required placeholder="Ej: [Guía] Cómo blindar un router doméstico paso a paso...">
            </div>
            <div class="form-grid-2">
              <div class="form-field">
                <label for="forumThreadCategory" class="hud-label">SUBFORO</label>
                <select id="forumThreadCategory" class="hud-select">
                  ${boardOptions.map(c => `<option value="${escapeHtml(c)}" ${c === defaultCat ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                </select>
              </div>
              <div class="form-field">
                <label for="forumThreadPrefix" class="hud-label">PREFIJO</label>
                <select id="forumThreadPrefix" class="hud-select">
                  <option value="Debate">Debate</option>
                  <option value="Tutorial">Tutorial</option>
                  <option value="Noticia">Noticia</option>
                  <option value="Consulta">Consulta</option>
                  <option value="Off-Topic">Off-Topic</option>
                </select>
              </div>
            </div>
          </div>
          <div class="form-field">
            <label for="forumThreadBody" class="hud-label">MENSAJE * (soporta [quote=Autor]...[/quote] y bloques \`\`\`código\`\`\`)</label>
            <textarea id="forumThreadBody" class="hud-textarea" rows="5" maxlength="4000" required placeholder="Expón tu tutorial, noticia, análisis técnico o consulta..."></textarea>
          </div>
          <div class="modal-footer-actions">
            <button type="button" id="cancelForumComposerBtn" class="hud-btn hud-btn-outline">Cancelar</button>
            <button type="submit" class="hud-btn hud-btn-action">Publicar tema</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderForumThreadRowHtml(t) {
    const replies = Array.isArray(t.replies) ? t.replies : [];
    const last = getThreadLastActivityMeta(t);
    const statusIcon = t.pinned ? '📌' : (t.locked ? '🔒' : (replies.length >= 3 ? '🔥' : '💬'));
    const views = Math.max(1, Number(t.views) || 1);
    return `
      <div class="htc-thread-row ${t.pinned ? 'is-pinned' : ''}">
        <div class="htc-thread-status" title="${t.pinned ? 'Tema fijado (Chincheta)' : (t.locked ? 'Hilo cerrado' : 'Tema abierto')}">${statusIcon}</div>
        <div class="htc-thread-title-wrap">
          <div class="htc-thread-headline">
            ${t.pinned ? '<span class="htc-sticky-tag">CHINCHETA</span>' : ''}
            ${t.locked ? '<span class="htc-locked-tag">CERRADO</span>' : ''}
            ${getForumPrefixBadgeHtml(t.prefix)}
            <button type="button" class="htc-thread-link" data-forum-thread="${escapeHtml(t.id)}">${escapeHtml(t.title)}</button>
          </div>
          <div class="htc-thread-submeta">
            Iniciado por <strong>${escapeHtml(t.author || 'Anónimo')}</strong> · ${getRelativeTime(t.createdAt)} · en <span>${escapeHtml(t.category || 'General')}</span>
          </div>
        </div>
        <div class="htc-stat-cell">${replies.length}</div>
        <div class="htc-stat-cell">${views}</div>
        <div class="htc-lastpost-cell">
          <span class="htc-lastpost-link" data-forum-thread="${escapeHtml(t.id)}">por ${escapeHtml(last.author)}</span>
          <span class="htc-lastpost-meta">${getRelativeTime(last.ts)}</span>
        </div>
      </div>
    `;
  }

  function renderForum() {
    if (!DOM.forumSection) return;

    const allThreads = sortForumThreads(Array.isArray(state.forumThreads) ? state.forumThreads : []);
    const isLoggedIn = !!state.currentUser;
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    const q = (state.searchQuery || '').toLowerCase().trim();
    const authorStats = buildForumAuthorStats(allThreads);

    // Si hay búsqueda activa en el buscador global, mostrar resultados en formato tabla
    const effectiveView = q && state.forumView === 'index' ? 'board' : state.forumView;

    const actionBtnHtml = isLoggedIn
      ? `<button type="button" id="toggleForumComposerBtn" class="hud-btn hud-btn-action">${state.showForumComposer ? '× Cerrar editor' : '+ Nuevo tema'}</button>`
      : `<button type="button" id="forumLoginPromptBtn" class="hud-btn hud-btn-outline">🔑 Acceder / Registro para publicar</button>`;

    // VISTA 3: HILO COMPLETO ESTILO vBULLETIN (2 COLUMNAS)
    if (effectiveView === 'thread' && state.activeForumThreadId) {
      const thread = allThreads.find(t => t.id === state.activeForumThreadId);
      if (!thread) {
        state.forumView = 'index';
        state.activeForumThreadId = null;
        renderForum();
        return;
      }

      const replies = Array.isArray(thread.replies) ? thread.replies : [];
      const posts = [
        {
          id: thread.id,
          isOp: true,
          num: 1,
          author: thread.author || 'Anónimo',
          authorId: thread.authorId || '',
          authorRole: thread.authorRole || 'analyst',
          createdAt: thread.createdAt,
          text: thread.body || '',
          likedBy: Array.isArray(thread.likedBy) ? thread.likedBy : [],
          likes: Array.isArray(thread.likedBy) ? thread.likedBy.length : (Number(thread.likes) || 0)
        },
        ...replies.map((r, i) => ({
          id: r.id,
          isOp: false,
          num: i + 2,
          author: r.author || 'Usuario',
          authorId: r.authorId || '',
          authorRole: r.authorRole || 'analyst',
          createdAt: r.createdAt,
          text: r.text || '',
          likedBy: Array.isArray(r.likedBy) ? r.likedBy : [],
          likes: Array.isArray(r.likedBy) ? r.likedBy.length : (Number(r.likes) || 0)
        }))
      ];

      const canDeleteThread = isLoggedIn && (isAdmin || state.currentUser.id === thread.authorId);

      const breadcrumbHtml = `
        <div class="htc-breadcrumb">
          <div class="htc-crumb-trail">
            <button type="button" class="htc-crumb-link" data-forum-nav="index">🏠 Índice del Foro</button>
            <span>›</span>
            <button type="button" class="htc-crumb-link" data-forum-board="${escapeHtml(thread.category || 'Ciberseguridad')}">${escapeHtml(thread.category || 'Ciberseguridad')}</button>
            <span>›</span>
            <span class="htc-crumb-current">${escapeHtml(thread.title)}</span>
          </div>
          <div class="htc-forum-actions">
            <button type="button" class="hud-btn hud-btn-outline" data-forum-board="${escapeHtml(thread.category || 'Todos')}">← Volver al subforo</button>
            ${(!thread.locked || isAdmin) ? `<button type="button" id="forumQuickReplyScrollBtn" class="hud-btn hud-btn-action">↩ Responder</button>` : ''}
          </div>
        </div>
      `;

      const threadHeaderHtml = `
        <div class="htc-thread-header">
          <div>
            <div class="htc-thread-headline">
              ${thread.pinned ? '<span class="htc-sticky-tag">📌 CHINCHETA</span>' : ''}
              ${thread.locked ? '<span class="htc-locked-tag">🔒 CERRADO</span>' : ''}
              ${getForumPrefixBadgeHtml(thread.prefix)}
              <span style="font-size:0.78rem;color:var(--text-muted);">${Math.max(1, Number(thread.views) || 1)} visitas · ${replies.length} respuestas</span>
            </div>
            <h2>${escapeHtml(thread.title)}</h2>
          </div>
          <div class="htc-forum-actions">
            ${isAdmin ? `
              <button type="button" class="htc-action-btn" data-forum-thread-id="${escapeHtml(thread.id)}" data-forum-mod="${thread.pinned ? 'unpin' : 'pin'}">${thread.pinned ? '📌 Quitar chincheta' : '📌 Fijar tema'}</button>
              <button type="button" class="htc-action-btn" data-forum-thread-id="${escapeHtml(thread.id)}" data-forum-mod="${thread.locked ? 'unlock' : 'lock'}">${thread.locked ? '🔓 Reabrir hilo' : '🔒 Cerrar hilo'}</button>
            ` : ''}
            ${canDeleteThread ? `<button type="button" class="htc-action-btn is-danger" data-forum-delete="${escapeHtml(thread.id)}">🗑️ Eliminar hilo</button>` : ''}
          </div>
        </div>
      `;

      const postsHtml = posts.map(p => {
        const count = authorStats.get(String(p.author || '').toLowerCase()) || 1;
        const rank = getForumRankMeta(p.author, p.authorRole, count);
        const initial = String(p.author || 'U').trim().charAt(0).toUpperCase();
        const isLiked = isLoggedIn && p.likedBy.includes(state.currentUser.id);
        const canDeleteReply = !p.isOp && isLoggedIn && (isAdmin || state.currentUser.id === p.authorId);

        return `
          <article class="htc-post-card">
            <div class="htc-post-topbar">
              <span>🕒 Publicado ${getRelativeTime(p.createdAt)}</span>
              <span class="htc-post-num">#${p.num}</span>
            </div>
            <div class="htc-post-grid">
              <aside class="htc-post-author-col">
                <div class="htc-author-avatar">${escapeHtml(initial)}</div>
                <div class="htc-author-name">${escapeHtml(p.author)}</div>
                <span class="htc-rank-badge ${rank.cls}">${escapeHtml(rank.label)}</span>
                <div class="htc-author-stats">
                  <div>Mensajes: <strong>${count}</strong></div>
                  <div>${p.isOp ? 'Autor del hilo' : 'Participante'}</div>
                </div>
              </aside>
              <div class="htc-post-body-col">
                <div class="htc-post-content">${formatForumPostHtml(p.text)}</div>
                <div class="htc-post-footer">
                  <div class="htc-post-actions">
                    <button type="button" class="htc-action-btn ${isLiked ? 'is-liked' : ''}" data-forum-like="${escapeHtml(thread.id)}" ${p.isOp ? '' : `data-forum-reply-id="${escapeHtml(p.id)}"`}>
                      👍 Gracias (${p.likes})
                    </button>
                    ${(!thread.locked || isAdmin) ? `
                      <button type="button" class="htc-action-btn" data-forum-quote="${escapeHtml(p.text)}" data-forum-quote-author="${escapeHtml(p.author)}">
                        ❝ Citar
                      </button>
                    ` : ''}
                  </div>
                  <div class="htc-post-actions">
                    ${canDeleteReply ? `<button type="button" class="htc-action-btn is-danger" data-forum-thread-id="${escapeHtml(thread.id)}" data-forum-del-reply="${escapeHtml(p.id)}">🗑️ Borrar</button>` : ''}
                  </div>
                </div>
              </div>
            </div>
          </article>
        `;
      }).join('');

      let replyBoxHtml = '';
      if (thread.locked && !isAdmin) {
        replyBoxHtml = `
          <div class="forum-guest-notice">
            <span>🔒 Este tema ha sido cerrado por moderación y ya no admite nuevas respuestas.</span>
          </div>
        `;
      } else if (isLoggedIn) {
        replyBoxHtml = `
          <div class="forum-composer-card">
            <h3 class="forum-composer-title">↩ Respuesta rápida al tema</h3>
            <form class="forum-reply-form" data-thread-id="${escapeHtml(thread.id)}">
              <div class="form-field">
                <textarea id="forumQuickReplyText" class="hud-textarea" name="replyText" rows="4" maxlength="2500" required placeholder="Escribe tu respuesta... Puedes pulsar 'Citar' en cualquier post para responder a alguien en concreto."></textarea>
              </div>
              <div class="modal-footer-actions">
                <button type="submit" class="hud-btn hud-btn-action">Publicar respuesta</button>
              </div>
            </form>
          </div>
        `;
      } else {
        replyBoxHtml = `
          <div class="forum-guest-notice">
            <span>Inicia sesión o regístrate gratuitamente para responder, agradecer posts y citar mensajes.</span>
            <button type="button" class="hud-btn hud-btn-outline" data-forum-login="1">🔑 Acceder / Registro</button>
          </div>
        `;
      }

      DOM.forumSection.innerHTML = breadcrumbHtml + threadHeaderHtml + postsHtml + replyBoxHtml;
      return;
    }

    // VISTA 2: LISTADO DE TEMAS DE UN SUBFORO (O BÚSQUEDA GLOBAL)
    if (effectiveView === 'board') {
      const boardName = state.forumFilter || 'Todos';
      const prefixes = ['Todos', 'Debate', 'Tutorial', 'Noticia', 'Consulta', 'Off-Topic'];

      let list = [...allThreads];
      if (boardName !== 'Todos') {
        list = list.filter(t => (t.category || '').toLowerCase() === boardName.toLowerCase());
      }
      if (state.forumPrefixFilter && state.forumPrefixFilter !== 'Todos') {
        list = list.filter(t => (t.prefix || 'Debate').toLowerCase() === state.forumPrefixFilter.toLowerCase());
      }
      if (q) {
        list = list.filter(t =>
          (t.title || '').toLowerCase().includes(q) ||
          (t.body || '').toLowerCase().includes(q) ||
          (t.author || '').toLowerCase().includes(q) ||
          (t.category || '').toLowerCase().includes(q)
        );
      }

      const breadcrumbHtml = `
        <div class="htc-breadcrumb">
          <div class="htc-crumb-trail">
            <button type="button" class="htc-crumb-link" data-forum-nav="index">🏠 Índice del Foro</button>
            <span>›</span>
            <span class="htc-crumb-current">${q ? `Búsqueda: "${escapeHtml(q)}"` : (boardName === 'Todos' ? 'Todos los temas' : escapeHtml(boardName))}</span>
          </div>
          <div class="htc-forum-actions">
            <button type="button" class="hud-btn hud-btn-outline" data-forum-nav="index">← Índice</button>
            ${actionBtnHtml}
          </div>
        </div>
      `;

      const prefixBarHtml = `
        <div class="forum-toolbar">
          <div class="forum-filter-pills">
            ${prefixes.map(p => `
              <button type="button" class="forum-filter-pill ${state.forumPrefixFilter === p ? 'active' : ''}" data-forum-prefix="${escapeHtml(p)}">${escapeHtml(p)}</button>
            `).join('')}
          </div>
          <span class="feed-meta">${list.length} ${list.length === 1 ? 'tema' : 'temas'}</span>
        </div>
      `;

      const tableHtml = list.length === 0
        ? `
          <div class="empty-intel-box">
            <div class="empty-hud-icon">💬</div>
            <h3 class="empty-hud-title">Sin temas en este subforo todavía</h3>
            <p class="empty-hud-msg">Sé el primero en abrir un hilo técnico en ${escapeHtml(boardName)}.</p>
          </div>
        `
        : `
          <div class="htc-category-block">
            <div class="htc-category-bar">
              <span>📂 ${q ? 'Resultados encontrados' : (boardName === 'Todos' ? 'Todos los subforos' : escapeHtml(boardName))}</span>
              <span class="htc-category-sub">Ordenado por chinchetas y última actividad</span>
            </div>
            <div class="htc-threads-head">
              <div></div>
              <div>Tema / Autor</div>
              <div style="text-align:center;">Respuestas</div>
              <div style="text-align:center;">Visitas</div>
              <div>Último mensaje</div>
            </div>
            ${list.map(renderForumThreadRowHtml).join('')}
          </div>
        `;

      DOM.forumSection.innerHTML = breadcrumbHtml + renderForumComposerCard() + prefixBarHtml + tableHtml;
      return;
    }

    // VISTA 1: ÍNDICE GENERAL ESTILO HTCMANIA (SUBFOROS AGRUPADOS + ÚLTIMOS MENSAJES)
    const breadcrumbHtml = `
      <div class="htc-breadcrumb">
        <div class="htc-crumb-trail">
          <span class="htc-crumb-current">🏠 Foro CYBERPOLIS — Comunidad de Ciberseguridad &amp; Tecnología</span>
        </div>
        <div class="htc-forum-actions">
          <button type="button" class="hud-btn hud-btn-outline" data-forum-board="Todos">📋 Todos los temas (${allThreads.length})</button>
          ${actionBtnHtml}
        </div>
      </div>
    `;

    const groupsHtml = FORUM_BOARD_GROUPS.map(group => {
      const rowsHtml = group.boards.map(b => {
        const boardThreads = allThreads.filter(t => (t.category || 'Ciberseguridad').toLowerCase() === b.key.toLowerCase());
        const totalReplies = boardThreads.reduce((acc, t) => acc + (Array.isArray(t.replies) ? t.replies.length : 0), 0);
        const totalPosts = boardThreads.length + totalReplies;
        const latest = boardThreads[0] || null;
        const latestMeta = latest ? getThreadLastActivityMeta(latest) : null;

        return `
          <div class="htc-board-row">
            <div class="htc-board-icon" aria-hidden="true">${b.icon}</div>
            <div class="htc-board-main">
              <button type="button" class="htc-board-title" data-forum-board="${escapeHtml(b.key)}">${escapeHtml(b.key)}</button>
              <p class="htc-board-desc">${escapeHtml(b.desc)}</p>
            </div>
            <div class="htc-stat-cell">${boardThreads.length}</div>
            <div class="htc-stat-cell">${totalPosts}</div>
            <div class="htc-lastpost-cell">
              ${latest
                ? `<button type="button" class="htc-lastpost-link" data-forum-thread="${escapeHtml(latest.id)}" title="${escapeHtml(latest.title)}">${escapeHtml(latest.title)}</button>
                   <span class="htc-lastpost-meta">por ${escapeHtml(latestMeta.author)} · ${getRelativeTime(latestMeta.ts)}</span>`
                : '<span class="htc-lastpost-meta">Sin temas aún — ¡inaugúralo!</span>'
              }
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="htc-category-block">
          <div class="htc-category-bar">
            <span>📌 ${escapeHtml(group.title)}</span>
            <span class="htc-category-sub">${escapeHtml(group.subtitle)}</span>
          </div>
          <div class="htc-board-head">
            <div></div>
            <div>Subforo</div>
            <div style="text-align:center;">Temas</div>
            <div style="text-align:center;">Mensajes</div>
            <div>Último mensaje</div>
          </div>
          ${rowsHtml}
        </div>
      `;
    }).join('');

    const recentThreadsHtml = allThreads.length > 0 ? `
      <div class="htc-category-block">
        <div class="htc-category-bar">
          <span>🔥 Últimos mensajes activos en el foro</span>
          <span class="htc-category-sub">Hilos con actividad reciente</span>
        </div>
        <div class="htc-threads-head">
          <div></div>
          <div>Tema / Autor</div>
          <div style="text-align:center;">Respuestas</div>
          <div style="text-align:center;">Visitas</div>
          <div>Último mensaje</div>
        </div>
        ${allThreads.slice(0, 6).map(renderForumThreadRowHtml).join('')}
      </div>
    ` : '';

    const totalRepliesAll = allThreads.reduce((acc, t) => acc + (Array.isArray(t.replies) ? t.replies.length : 0), 0);
    const statsHtml = `
      <div class="htc-stats-bar">
        <span>📊 <strong>Estadísticas del Foro:</strong> ${allThreads.length} temas · ${allThreads.length + totalRepliesAll} mensajes · ${authorStats.size} participantes</span>
        <span>💡 Pulsa en cualquier subforo o hilo para abrir el debate completo estilo vBulletin</span>
      </div>
    `;

    DOM.forumSection.innerHTML = breadcrumbHtml + renderForumComposerCard() + groupsHtml + recentThreadsHtml + statsHtml;
  }

  function openForumThreadView(threadId) {
    if (!threadId) return;
    state.activeForumThreadId = threadId;
    state.forumView = 'thread';
    const localThread = state.forumThreads.find(t => t.id === threadId);
    if (localThread) {
      localThread.views = Math.max(1, Number(localThread.views) || 1) + 1;
    }
    renderForum();
    if (DOM.forumSection) DOM.forumSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (state.serverMode) {
      fetch(`/api/forum/${encodeURIComponent(threadId)}/view`, { method: 'POST' })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && data.views && localThread) localThread.views = data.views;
        })
        .catch(() => {});
    }
  }

  function quoteForumPostIntoReply(authorName, rawText) {
    if (!state.currentUser) {
      openAuthModal();
      return;
    }
    const box = document.getElementById('forumQuickReplyText');
    if (!box) return;
    const cleanExcerpt = String(rawText || '').replace(/\[quote[\s\S]*?\[\/quote\]/gi, '').trim().slice(0, 260);
    const snippet = `[quote=${authorName}]${cleanExcerpt}[/quote]\n`;
    box.value = box.value ? `${box.value.trimEnd()}\n\n${snippet}` : snippet;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box.focus();
  }

  async function handleToggleForumLike(threadId, replyId = '') {
    if (!state.currentUser) {
      openAuthModal();
      return;
    }
    if (state.serverMode) {
      try {
        const res = await apiFetch(`/api/forum/${encodeURIComponent(threadId)}/like`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ replyId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.error || 'No se pudo registrar el agradecimiento.', 'error');
          return;
        }
        const idx = state.forumThreads.findIndex(t => t.id === threadId);
        if (idx !== -1 && data.thread) state.forumThreads[idx] = data.thread;
        localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
        renderForum();
        return;
      } catch (e) {}
    }

    const thread = state.forumThreads.find(t => t.id === threadId);
    if (!thread) return;
    const target = replyId ? (thread.replies || []).find(r => r.id === replyId) : thread;
    if (!target) return;
    if (!Array.isArray(target.likedBy)) target.likedBy = [];
    const uid = state.currentUser.id;
    target.likedBy = target.likedBy.includes(uid)
      ? target.likedBy.filter(x => x !== uid)
      : [...target.likedBy, uid];
    target.likes = target.likedBy.length;
    localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
    renderForum();
  }

  async function handleModerateForumThread(threadId, action) {
    if (!state.currentUser || state.currentUser.role !== 'admin') return;
    if (!state.serverMode) return;
    try {
      const res = await apiFetch(`/api/forum/${encodeURIComponent(threadId)}/moderate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Acción fallida.', 'error');
        return;
      }
      const idx = state.forumThreads.findIndex(t => t.id === threadId);
      if (idx !== -1 && data.thread) state.forumThreads[idx] = data.thread;
      localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
      renderForum();
      showToast('Moderación del tema aplicada.');
    } catch (e) {
      showToast('Error al moderar el tema.', 'error');
    }
  }

  async function handleDeleteForumReply(threadId, replyId) {
    if (!state.currentUser || !threadId || !replyId) return;
    if (state.serverMode) {
      try {
        const res = await apiFetch(`/api/forum/${encodeURIComponent(threadId)}/reply/${encodeURIComponent(replyId)}`, {
          method: 'DELETE'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.error || 'No se pudo borrar la respuesta.', 'error');
          return;
        }
        const idx = state.forumThreads.findIndex(t => t.id === threadId);
        if (idx !== -1 && data.thread) state.forumThreads[idx] = data.thread;
        localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
        renderForum();
        showToast('Respuesta eliminada.');
        return;
      } catch (e) {}
    }
  }

  async function handleCreateForumThread(form) {
    if (!state.currentUser) {
      openAuthModal();
      return;
    }
    const titleEl = form.querySelector('#forumThreadTitle');
    const catEl = form.querySelector('#forumThreadCategory');
    const prefixEl = form.querySelector('#forumThreadPrefix');
    const bodyEl = form.querySelector('#forumThreadBody');
    const title = titleEl ? titleEl.value.trim() : '';
    const category = catEl ? catEl.value : 'Ciberseguridad';
    const prefix = prefixEl ? prefixEl.value : 'Debate';
    const body = bodyEl ? bodyEl.value.trim() : '';

    if (!title || !body) {
      showToast('Completa el título y el mensaje del hilo.');
      return;
    }

    if (state.serverMode && state.currentUser) {
      try {
        const res = await apiFetch('/api/forum', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, category, prefix, body })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.error || 'No se pudo publicar el tema.');
          return;
        }
        state.forumThreads.unshift(data.thread);
        localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
        state.showForumComposer = false;
        state.forumFilter = category;
        state.activeForumThreadId = data.thread.id;
        state.forumView = 'thread';
        updateForumCount();
        renderForum();
        showToast('¡Tema publicado en el foro!');
        return;
      } catch (e) {}
    }

    const nowIso = new Date().toISOString();
    const localThread = {
      id: 'frm-' + Date.now(),
      title,
      category,
      prefix,
      body,
      author: state.currentUser.displayName,
      authorId: state.currentUser.id,
      authorRole: state.currentUser.role,
      pinned: false,
      locked: false,
      views: 1,
      likedBy: [],
      likes: 0,
      createdAt: nowIso,
      lastActivityAt: nowIso,
      replies: []
    };
    state.forumThreads.unshift(localThread);
    localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
    state.showForumComposer = false;
    state.forumFilter = category;
    state.activeForumThreadId = localThread.id;
    state.forumView = 'thread';
    updateForumCount();
    renderForum();
    showToast('¡Tema guardado en modo local!');
  }

  async function handlePostForumReply(threadId, form) {
    if (!state.currentUser) {
      openAuthModal();
      return;
    }
    const textEl = form.querySelector('textarea[name="replyText"]');
    const text = textEl ? textEl.value.trim() : '';
    if (!text) return;

    if (state.serverMode && state.currentUser) {
      try {
        const res = await apiFetch(`/api/forum/${encodeURIComponent(threadId)}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.error || 'No se pudo publicar la respuesta.');
          return;
        }
        const idx = state.forumThreads.findIndex(t => t.id === threadId);
        if (idx !== -1 && data.thread) state.forumThreads[idx] = data.thread;
        localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
        renderForum();
        showToast('Respuesta publicada.');
        return;
      } catch (e) {}
    }

    const thread = state.forumThreads.find(t => t.id === threadId);
    if (thread) {
      if (!Array.isArray(thread.replies)) thread.replies = [];
      const nowIso = new Date().toISOString();
      thread.replies.push({
        id: 'rep-' + Date.now(),
        text,
        author: state.currentUser.displayName,
        authorId: state.currentUser.id,
        authorRole: state.currentUser.role,
        likedBy: [],
        likes: 0,
        createdAt: nowIso
      });
      thread.lastActivityAt = nowIso;
      localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
      renderForum();
      showToast('Respuesta guardada en modo local.');
    }
  }

  async function handleDeleteForumThread(threadId) {
    if (!state.currentUser) return;
    if (state.serverMode && state.currentUser) {
      try {
        const res = await apiFetch(`/api/forum/${encodeURIComponent(threadId)}`, {
          method: 'DELETE'
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'No tienes permisos para eliminar este tema.');
          return;
        }
      } catch (e) {}
    }
    state.forumThreads = state.forumThreads.filter(t => t.id !== threadId);
    if (state.activeForumThreadId === threadId) {
      state.activeForumThreadId = null;
      state.forumView = 'board';
    }
    localStorage.setItem('silverbot_forum_cache', JSON.stringify(state.forumThreads));
    updateForumCount();
    renderForum();
    showToast('Hilo eliminado del foro.');
  }

  // ==========================================
  // 15. Contacto Editorial, Marco Legal y SEO
  // ==========================================
  function renderContact() {
    if (!DOM.contactSection) return;
    const email = (state.config.contactEmail || '').trim();
    const isAdmin = state.currentUser && state.currentUser.role === 'admin';
    const brandName = getPortalBrandLabel();

    DOM.contactSection.innerHTML = `
      <div class="contact-hero-card">
        <h2>Contacto & Redacción — ${escapeHtml(brandName)}</h2>
        <p>Canal informativo para consultas editoriales, sugerencias de fuentes en castellano, avisos de rectificación y comunicación directa con la administración del diario.</p>
      </div>

      <div class="contact-grid">
        <div class="contact-info-card">
          <h3>Correo Electrónico de Contacto</h3>
          ${email ? `
            <p>Puedes escribir directamente a la redacción de ${escapeHtml(brandName)} a través de nuestra dirección oficial:</p>
            <div class="contact-email-box">
              <a href="mailto:${escapeHtml(email)}" class="contact-email-link">${escapeHtml(email)}</a>
              <button type="button" class="hud-btn hud-btn-outline" data-copy-email="${escapeHtml(email)}">Copiar correo</button>
            </div>
          ` : `
            <div class="contact-pending-pill">⏳ Correo de contacto en preparación (no habilitado todavía)</div>
            <p>Actualmente no hay una dirección de correo electrónico pública habilitada. El administrador puede activarla o modificarla en cualquier momento desde el Panel de Control.</p>
          `}
          ${isAdmin ? `
            <div style="margin-top: 4px;">
              <button type="button" class="hud-btn hud-btn-outline" data-contact-admin="1">⚙️ Personalizar correo en Admin</button>
            </div>
          ` : ''}
        </div>

        <div class="contact-info-card">
          <h3>Consultas Técnicas, Prensa y Comunidad</h3>
          <p>Para debates abiertos sobre vulnerabilidades, herramientas de seguridad informática o normativa tecnológica, participa en nuestro espacio comunitario.</p>
          <p>Si representas a un medio citado y deseas revisar la atribución de un titular o enlace, utiliza el canal oficial en cuanto esté activo o solicita revisión al administrador.</p>
          <div style="margin-top: auto;">
            <button type="button" class="hud-btn hud-btn-action" data-contact-forum="1">Ir al Foro & Debate 💬</button>
          </div>
        </div>
      </div>
    `;
  }

  function openLegalModal(docKey = 'aviso') {
    if (!DOM.legalModal || !DOM.legalModalBody) return;
    const validKeys = ['aviso', 'uso', 'privacidad', 'cookies'];
    const key = validKeys.includes(docKey) ? docKey : 'aviso';
    const brandName = getPortalBrandLabel(true);
    const contactEmail = (state.config.contactEmail || '').trim();
    const contactText = contactEmail
      ? `<a href="mailto:${escapeHtml(contactEmail)}" class="contact-email-link">${escapeHtml(contactEmail)}</a>`
      : 'la pestaña Contacto (pendiente de habilitación por el administrador)';

    document.querySelectorAll('.legal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.legalTab === key);
    });

    const docs = {
      aviso: {
        title: 'AVISO LEGAL Y DERECHOS',
        html: `
          <h4>1. Titularidad y Naturaleza del Portal</h4>
          <p><strong>${escapeHtml(brandName)}</strong> es un medio digital informativo especializado en ciberseguridad, vulnerabilidades, ingeniería de sistemas y geopolítica tecnológica en lengua española.</p>
          <h4>2. Propiedad Intelectual y Atribución de Fuentes</h4>
          <p>&copy; 2026 ${escapeHtml(brandName)}. El diseño, el código original, la marca y los textos propios están protegidos por la normativa de propiedad intelectual. Las noticias agregadas desde medios externos muestran extractos informativos citando expresamente su fuente y enlazando al artículo original completo.</p>
          <h4>3. Contacto y Reclamaciones</h4>
          <p>Para notificaciones legales o solicitudes sobre contenidos enlazados, puedes dirigirte a través de ${contactText}.</p>
        `
      },
      uso: {
        title: 'POLÍTICA DE USO Y NORMAS COMUNITARIAS',
        html: `
          <h4>1. Finalidad Informativa y Educativa</h4>
          <p>La información técnica, avisos CVE y debates publicados tienen fines estrictamente informativos, defensivos y de divulgación en ciberseguridad. Queda prohibido utilizar los contenidos o el foro para difundir malware, credenciales ilícitas o ataques contra sistemas de terceros.</p>
          <h4>2. Publicación y Participación en el Foro</h4>
          <p>La lectura de noticias y debates es libre y abierta. Para publicar hilos, responder en el foro o enviar artículos de análisis es necesario contar con una cuenta registrada.</p>
          <h4>3. Moderación</h4>
          <p>La administración podrá editar o retirar publicaciones o comentarios que contengan spam, suplantación de identidad, código malicioso o infracciones legales.</p>
        `
      },
      privacidad: {
        title: 'POLÍTICA DE PRIVACIDAD Y PROTECCIÓN DE DATOS',
        html: `
          <h4>1. Datos Tratados</h4>
          <p>Los lectores sin cuenta pueden navegar sin facilitar datos personales. Al registrarse voluntariamente, solo se almacenan el nombre público, identificador de usuario, rol y contraseña protegida mediante hash criptográfico seguro (Scrypt con sal aleatoria).</p>
          <h4>2. Finalidad y Conservación</h4>
          <p>Los datos de cuenta se emplean exclusivamente para gestionar tu acceso, tus publicaciones y tu participación en el foro. No cedemos ni vendemos datos personales a terceros.</p>
          <h4>3. Derechos del Usuario</h4>
          <p>Puedes solicitar información o la eliminación de tu cuenta a través de ${contactText}.</p>
        `
      },
      cookies: {
        title: 'POLÍTICA DE COOKIES Y ALMACENAMIENTO LOCAL',
        html: `
          <h4>1. Uso Técnico Esencial</h4>
          <p>Este portal no utiliza cookies publicitarias ni rastreadores de terceros para perfilado comercial.</p>
          <h4>2. Almacenamiento Local del Navegador</h4>
          <ul>
            <li><strong>Tema visual y marcadores:</strong> Preferencia entre modo claro editorial o modo oscuro y lista local de noticias guardadas.</li>
            <li><strong>Sesión autenticada:</strong> Token de sesión almacenado solo cuando decides iniciar sesión para mantener el acceso de forma segura.</li>
          </ul>
          <p>Puedes borrar estos datos en cualquier momento desde los ajustes de tu navegador o cerrando sesión.</p>
        `
      }
    };

    const selected = docs[key];
    if (DOM.legalModalTitle) DOM.legalModalTitle.textContent = selected.title;
    DOM.legalModalBody.innerHTML = selected.html;
    DOM.legalModal.style.display = 'flex';
  }

  function closeLegalModal() {
    if (DOM.legalModal) DOM.legalModal.style.display = 'none';
  }

  function updateSeoMeta(article = null) {
    const baseBrand = getPortalBrandLabel(true);
    const descEl = document.querySelector('meta[name="description"]');
    const canonicalEl = document.getElementById('canonicalLink');

    if (article && article.title) {
      document.title = `${article.title} | ${baseBrand}`;
      if (descEl && article.summary) descEl.setAttribute('content', String(article.summary).slice(0, 160));
      if (canonicalEl && window.location.origin.startsWith('http')) {
        canonicalEl.setAttribute('href', `${window.location.origin}/?article=${encodeURIComponent(article.id)}`);
      }
      return;
    }

    const sectionTitles = {
      all: `${baseBrand} | Noticias de Ciberseguridad y Hacking`,
      hacking: `Ciberseguridad y Hacking | ${baseBrand}`,
      politica: `Política y Geopolítica Tecnológica | ${baseBrand}`,
      tecnopolitica: `Tecnopolítica y Leyes Digitales | ${baseBrand}`,
      bookmarks: `Noticias Guardadas | ${baseBrand}`,
      forum: `Foro y Debate de Ciberseguridad | ${baseBrand}`,
      contact: `Contacto y Redacción | ${baseBrand}`
    };

    document.title = sectionTitles[state.currentCategory] || sectionTitles.all;
    if (descEl) {
      descEl.setAttribute('content', 'TU HACKNOTICIERO: Diario digital de ciberseguridad, vulnerabilidades CVE, hacking ético, geopolítica y tecnopolítica en castellano, con foro de debate comunitario.');
    }
    if (canonicalEl && window.location.origin.startsWith('http')) {
      const suffix = state.currentCategory !== 'all' ? `/?cat=${encodeURIComponent(state.currentCategory)}` : '/';
      canonicalEl.setAttribute('href', `${window.location.origin}${suffix}`);
    }
  }

  function handleUrlSeoParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const qParam = params.get('q');
      const catParam = params.get('cat');
      const articleParam = params.get('article');

      if (qParam && DOM.searchInput) {
        state.searchQuery = qParam;
        DOM.searchInput.value = qParam;
        DOM.clearSearchBtn.style.display = 'block';
        renderFeed();
      }
      if (catParam && ['all', 'hacking', 'politica', 'tecnopolitica', 'bookmarks', 'forum', 'contact'].includes(catParam)) {
        setCategory(catParam);
      }
      if (articleParam) {
        const exists = state.articles.some(a => a.id === articleParam);
        if (exists) openReaderModal(articleParam);
      }
    } catch (e) {}
  }

  // ==========================================
  // 16. Analítica de Visitas y Gestión de Usuarios (Admin)
  // ==========================================
  function trackClientVisit(page = '/', articleTitle = '') {
    if (!state.serverMode) return;
    try {
      apiFetch('/api/analytics/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          page: page || '/',
          articleTitle: articleTitle || '',
          referrer: document.referrer || ''
        })
      }).catch(() => {});
    } catch (e) {}
  }

  async function loadAdminMetrics() {
    if (!DOM.adminMetricsContent) return;
    if (!state.serverMode || !state.currentUser || state.currentUser.role !== 'admin') {
      DOM.adminMetricsContent.innerHTML = '<p class="admin-help-text">Inicia sesión como Administrador con el servidor online para ver las métricas.</p>';
      return;
    }
    DOM.adminMetricsContent.innerHTML = '<p class="admin-help-text">Cargando estadísticas de visitas...</p>';
    try {
      const res = await apiFetch('/api/admin/analytics');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        DOM.adminMetricsContent.innerHTML = `<p class="admin-help-text">${escapeHtml(err.error || 'No se pudieron cargar las métricas.')}</p>`;
        return;
      }
      state.adminMetrics = await res.json();
      renderAdminMetrics(state.adminMetrics);
    } catch (e) {
      DOM.adminMetricsContent.innerHTML = '<p class="admin-help-text">Error de conexión al consultar las métricas.</p>';
    }
  }

  function renderAdminMetrics(m) {
    if (!DOM.adminMetricsContent || !m) return;
    const series = Array.isArray(m.dailySeries) ? m.dailySeries : [];
    const maxViews = Math.max(1, ...series.map(d => d.views || 0));

    const renderMiniList = (items, emptyMsg) => {
      if (!Array.isArray(items) || items.length === 0) {
        return `<p class="admin-help-text" style="margin-top:8px;">${escapeHtml(emptyMsg)}</p>`;
      }
      return `<div class="admin-mini-list">${items.map(it => `
        <div class="admin-mini-row">
          <span class="admin-mini-name">${escapeHtml(it.name || it.title || '—')}</span>
          <span class="admin-mini-count">${escapeHtml(String(it.count ?? it.views ?? 0))}</span>
        </div>
      `).join('')}</div>`;
    };

    const visitors = Array.isArray(m.recentVisitors) ? m.recentVisitors : [];

    DOM.adminMetricsContent.innerHTML = `
      <div class="admin-metrics-kpis">
        <div class="admin-kpi-card">
          <span class="admin-kpi-label">Visitas Hoy</span>
          <span class="admin-kpi-val">${m.todayViews || 0}</span>
          <span class="admin-kpi-sub">+${m.todayBotViews || 0} rastreadores SEO hoy</span>
        </div>
        <div class="admin-kpi-card">
          <span class="admin-kpi-label">Únicos Hoy</span>
          <span class="admin-kpi-val">${m.uniqueToday || 0}</span>
          <span class="admin-kpi-sub">${m.uniqueLast7Days || 0} únicos últimos 7 días</span>
        </div>
        <div class="admin-kpi-card">
          <span class="admin-kpi-label">Visitas Totales</span>
          <span class="admin-kpi-val">${m.totalViews || 0}</span>
          <span class="admin-kpi-sub">${m.activeSessionsCount || 0} sesiones activas</span>
        </div>
        <div class="admin-kpi-card">
          <span class="admin-kpi-label">Comunidad & Contenido</span>
          <span class="admin-kpi-val">${m.registeredUsersCount || 0}</span>
          <span class="admin-kpi-sub">usuarios · ${m.articlesCount || 0} noticias · ${m.forumThreadsCount || 0} hilos</span>
        </div>
      </div>

      <div class="admin-chart-card">
        <h5 class="admin-chart-title">Tráfico humano últimos 7 días</h5>
        <div class="admin-bars-grid">
          ${series.map(d => {
            const pct = Math.round(((d.views || 0) / maxViews) * 100);
            return `
              <div class="admin-bar-col" title="${escapeHtml(d.date)}: ${d.views} visitas (${d.unique} únicos)">
                <span class="admin-bar-value">${d.views}</span>
                <div class="admin-bar-track">
                  <div class="admin-bar-fill" style="height: ${Math.max(4, pct)}%;"></div>
                </div>
                <span class="admin-bar-label">${escapeHtml(d.label)}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="admin-breakdown-grid">
        <div class="admin-mini-panel">
          <h5 class="admin-chart-title">Navegadores</h5>
          ${renderMiniList(m.topBrowsers, 'Sin datos todavía')}
        </div>
        <div class="admin-mini-panel">
          <h5 class="admin-chart-title">Dispositivos</h5>
          ${renderMiniList(m.topDevices, 'Sin datos todavía')}
        </div>
        <div class="admin-mini-panel">
          <h5 class="admin-chart-title">Orígenes / Referrers</h5>
          ${renderMiniList(m.topReferrers, 'Sin datos todavía')}
        </div>
      </div>

      <div class="admin-mini-panel" style="margin-bottom: 18px;">
        <h5 class="admin-chart-title">Noticias más leídas</h5>
        ${renderMiniList(m.topArticles, 'Aún no hay lecturas registradas')}
      </div>

      <h5 class="admin-chart-title">Visitantes Recientes (últimos ${visitors.length})</h5>
      <div class="admin-visitors-table-wrap">
        <table class="admin-visitors-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>IP</th>
              <th>Usuario / Tipo</th>
              <th>Navegador / SO</th>
              <th>Dispositivo</th>
              <th>Origen</th>
              <th>Página / Noticia</th>
            </tr>
          </thead>
          <tbody>
            ${visitors.length === 0
              ? '<tr><td colspan="7" style="text-align:center;">Sin visitas registradas todavía.</td></tr>'
              : visitors.map(v => {
                const timeStr = v.timestamp ? new Date(v.timestamp).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
                const who = v.displayName
                  ? `<span class="visitor-user-pill">@${escapeHtml(v.username)}</span>`
                  : (v.isBot ? '<span class="visitor-user-pill visitor-bot-pill">Bot SEO</span>' : '<span>Visitante</span>');
                const dest = v.articleTitle ? `📰 ${v.articleTitle}` : (v.page || '/');
                return `
                  <tr>
                    <td style="white-space:nowrap;">${escapeHtml(timeStr)}</td>
                    <td><code class="visitor-ip-code">${escapeHtml(v.ip || '-')}</code>${v.country ? ` <small>(${escapeHtml(v.country)})</small>` : ''}</td>
                    <td>${who}</td>
                    <td>${escapeHtml(v.browser || '-')} · ${escapeHtml(v.os || '-')}</td>
                    <td>${escapeHtml(v.deviceType || '-')}</td>
                    <td>${escapeHtml(v.referrer || 'Directo')}</td>
                    <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(dest)}">${escapeHtml(dest)}</td>
                  </tr>
                `;
              }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function handleResetMetrics() {
    if (!DOM.resetMetricsBtn || !state.currentUser) return;
    if (DOM.resetMetricsBtn.dataset.armed !== '1') {
      DOM.resetMetricsBtn.dataset.armed = '1';
      DOM.resetMetricsBtn.textContent = '¿Seguro? Pulsa otra vez para limpiar';
      setTimeout(() => {
        if (DOM.resetMetricsBtn) {
          DOM.resetMetricsBtn.dataset.armed = '';
          DOM.resetMetricsBtn.textContent = '🗑️ Limpiar métricas';
        }
      }, 4000);
      return;
    }
    DOM.resetMetricsBtn.dataset.armed = '';
    DOM.resetMetricsBtn.textContent = '🗑️ Limpiar métricas';
    try {
      const res = await apiFetch('/api/admin/analytics', {
        method: 'DELETE'
      });
      if (res.ok) {
        showToast('Métricas reiniciadas correctamente.');
        loadAdminMetrics();
      } else {
        showToast('No se pudieron limpiar las métricas.', 'error');
      }
    } catch (e) {
      showToast('Error al limpiar métricas.', 'error');
    }
  }

  async function loadAdminUsers() {
    if (!DOM.adminUsersManageList) return;
    if (!state.serverMode || !state.currentUser || state.currentUser.role !== 'admin') {
      DOM.adminUsersManageList.innerHTML = '<p class="admin-help-text">Inicia sesión como Administrador con el servidor online para administrar usuarios.</p>';
      return;
    }
    DOM.adminUsersManageList.innerHTML = '<p class="admin-help-text">Cargando lista de usuarios...</p>';
    try {
      const res = await apiFetch('/api/admin/users');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        DOM.adminUsersManageList.innerHTML = `<p class="admin-help-text">${escapeHtml(err.error || 'Error cargando usuarios.')}</p>`;
        return;
      }
      state.adminUsers = await res.json();
      renderAdminUsers();
    } catch (e) {
      DOM.adminUsersManageList.innerHTML = '<p class="admin-help-text">Error de red al cargar los usuarios.</p>';
    }
  }

  function renderAdminUsers() {
    if (!DOM.adminUsersManageList) return;
    const q = (state.adminUserSearch || '').toLowerCase().trim();
    const list = (state.adminUsers || []).filter(u =>
      !q ||
      (u.username || '').toLowerCase().includes(q) ||
      (u.displayName || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );

    if (list.length === 0) {
      DOM.adminUsersManageList.innerHTML = '<p class="admin-help-text">No hay usuarios que coincidan con el filtro.</p>';
      return;
    }

    DOM.adminUsersManageList.innerHTML = list.map(u => {
      const isSelf = state.currentUser && state.currentUser.id === u.id;
      const isSuspended = u.status === 'suspended';
      const lastLogin = u.lastLoginAt
        ? new Date(u.lastLoginAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : 'Sin acceso reciente';
      const created = u.createdAt
        ? new Date(u.createdAt).toLocaleDateString('es-ES')
        : '—';
      const showReset = state.resetPasswordUserId === u.id;
      const showDelConfirm = state.confirmDeleteUserId === u.id;

      return `
        <div class="admin-user-card" data-user-card="${escapeHtml(u.id)}">
          <div class="admin-user-card-top">
            <div class="admin-user-identity">
              <div class="admin-user-title-row">
                <span class="admin-user-name">${escapeHtml(u.displayName || u.username)}</span>
                <span class="admin-user-handle">@${escapeHtml(u.username)}</span>
                <span class="user-role-badge ${u.role === 'admin' ? 'admin' : 'analyst'}">${u.role === 'admin' ? 'ADMIN' : 'USUARIO'}</span>
                <span class="user-status-badge ${isSuspended ? 'suspended' : 'active'}">${isSuspended ? 'SUSPENDIDO' : 'ACTIVO'}</span>
                ${isSelf ? '<span class="user-status-badge active">TÚ</span>' : ''}
              </div>
              <div class="admin-user-meta">
                ${u.email ? `${escapeHtml(u.email)} · ` : ''}Alta: ${escapeHtml(created)} · Último acceso: ${escapeHtml(lastLogin)} · ${u.articlesCount || 0} noticias · ${u.forumThreadsCount || 0} hilos · ${u.activeSessions || 0} sesiones
              </div>
            </div>

            <div class="admin-user-controls">
              <select class="admin-role-select" data-user-role-id="${escapeHtml(u.id)}" ${isSelf ? 'disabled title="No puedes cambiar tu propio rol"' : ''}>
                <option value="analyst" ${u.role !== 'admin' ? 'selected' : ''}>Usuario</option>
                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
              </select>
              <button type="button" class="hud-btn hud-btn-outline" data-user-reset-toggle="${escapeHtml(u.id)}">🔑 Resetear clave</button>
              ${!isSelf ? `
                <button type="button" class="hud-btn hud-btn-outline" data-user-status-toggle="${escapeHtml(u.id)}" data-next-status="${isSuspended ? 'active' : 'suspended'}">
                  ${isSuspended ? '▶️ Reactivar' : '⏸️ Suspender'}
                </button>
                <button type="button" class="hud-btn hud-btn-danger" data-user-delete-ask="${escapeHtml(u.id)}">🗑️ Eliminar</button>
              ` : ''}
            </div>
          </div>

          ${showReset ? `
            <form class="admin-reset-inline" data-user-id="${escapeHtml(u.id)}">
              <input type="text" class="hud-input admin-reset-pass-input" minlength="10" required placeholder="Mínimo 10 car. (mayús, minús, número, símbolo)">
              <button type="button" class="hud-btn hud-btn-outline" data-user-gen-pass="${escapeHtml(u.id)}">🎲 Generar</button>
              <button type="submit" class="hud-btn hud-btn-action">Guardar clave</button>
              <button type="button" class="hud-btn hud-btn-outline" data-user-reset-cancel="${escapeHtml(u.id)}">Cancelar</button>
            </form>
          ` : ''}

          ${showDelConfirm ? `
            <div class="admin-reset-inline">
              <span style="font-size: 0.82rem; color: var(--text-primary); flex: 1;">¿Eliminar definitivamente a <strong>@${escapeHtml(u.username)}</strong> y cerrar sus sesiones?</span>
              <button type="button" class="hud-btn hud-btn-danger" data-user-delete-confirm="${escapeHtml(u.id)}">Sí, eliminar</button>
              <button type="button" class="hud-btn hud-btn-outline" data-user-delete-cancel="${escapeHtml(u.id)}">Cancelar</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  async function handleAdminCreateUser(e) {
    e.preventDefault();
    if (!state.currentUser || state.currentUser.role !== 'admin') return;
    const username = DOM.admNewUsername ? DOM.admNewUsername.value.trim() : '';
    const displayName = DOM.admNewDisplayName ? DOM.admNewDisplayName.value.trim() : '';
    const email = DOM.admNewEmail ? DOM.admNewEmail.value.trim() : '';
    const role = DOM.admNewRole ? DOM.admNewRole.value : 'analyst';
    const password = DOM.admNewPassword ? DOM.admNewPassword.value : '';

    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, email, role, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo crear el usuario.', 'error');
        return;
      }
      if (DOM.adminCreateUserForm) {
        DOM.adminCreateUserForm.reset();
        DOM.adminCreateUserForm.style.display = 'none';
      }
      showToast(`Usuario @${data.user.username} creado correctamente.`);
      loadAdminUsers();
    } catch (err) {
      showToast('Error al crear usuario.', 'error');
    }
  }

  async function handleAdminResetPassword(userId, newPassword) {
    if (!state.currentUser || state.currentUser.role !== 'admin') return;
    if (!newPassword || newPassword.length < 10) {
      showToast('La nueva contraseña debe tener mínimo 10 caracteres.', 'error');
      return;
    }
    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo restablecer la contraseña.', 'error');
        return;
      }
      state.resetPasswordUserId = null;
      const toCopy = data.tempPassword || newPassword;
      if (navigator.clipboard && navigator.clipboard.writeText && toCopy) {
        navigator.clipboard.writeText(toCopy).catch(() => {});
      }
      showToast(`${data.message} (copiada al portapapeles).`);
      loadAdminUsers();
    } catch (err) {
      showToast('Error al restablecer contraseña.', 'error');
    }
  }

  async function handleAdminChangeRole(userId, role) {
    if (!state.currentUser || state.currentUser.role !== 'admin') return;
    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo cambiar el rol.', 'error');
        loadAdminUsers();
        return;
      }
      showToast(`Rol actualizado a ${role === 'admin' ? 'Administrador' : 'Usuario'}.`);
      loadAdminUsers();
    } catch (err) {
      showToast('Error al cambiar rol.', 'error');
    }
  }

  async function handleAdminToggleStatus(userId, nextStatus) {
    if (!state.currentUser || state.currentUser.role !== 'admin') return;
    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo actualizar el estado.', 'error');
        return;
      }
      showToast(nextStatus === 'suspended' ? 'Cuenta suspendida y sesiones cerradas.' : 'Cuenta reactivada.');
      loadAdminUsers();
    } catch (err) {
      showToast('Error al cambiar estado.', 'error');
    }
  }

  async function handleAdminDeleteUser(userId) {
    if (!state.currentUser || state.currentUser.role !== 'admin') return;
    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo eliminar el usuario.', 'error');
        return;
      }
      state.confirmDeleteUserId = null;
      showToast('Usuario eliminado correctamente.');
      loadAdminUsers();
    } catch (err) {
      showToast('Error al eliminar usuario.', 'error');
    }
  }

  // ==========================================
  // 17. Diagnóstico de Persistencia y Seguridad (Admin v7)
  // ==========================================
  async function loadAdminSystemStatus() {
    if (!DOM.adminSystemStatusContent) return;
    if (!state.serverMode || !state.currentUser || state.currentUser.role !== 'admin') {
      DOM.adminSystemStatusContent.innerHTML = '<p class="admin-help-text">Inicia sesión como Administrador con el servidor online para revisar la persistencia y seguridad.</p>';
      return;
    }
    DOM.adminSystemStatusContent.innerHTML = '<p class="admin-help-text">Analizando almacenamiento y controles de seguridad...</p>';
    try {
      const res = await apiFetch('/api/admin/system-status');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        DOM.adminSystemStatusContent.innerHTML = `<p class="admin-help-text">${escapeHtml(err.error || 'No se pudo obtener el diagnóstico.')}</p>`;
        return;
      }
      const status = await res.json();
      renderAdminSystemStatus(status);
    } catch (e) {
      DOM.adminSystemStatusContent.innerHTML = '<p class="admin-help-text">Error de red al consultar el estado del sistema.</p>';
    }
  }

  function renderAdminSystemStatus(st) {
    if (!DOM.adminSystemStatusContent || !st) return;
    const storage = st.storage || {};
    const sec = st.security || {};
    const isPerm = !!storage.persistent;
    const syncTime = storage.lastRemoteSyncAt
      ? new Date(storage.lastRemoteSyncAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—';
    const passRotatedText = sec.passwordUpdatedAt
      ? `Actualizada el ${new Date(sec.passwordUpdatedAt).toLocaleString('es-ES')}`
      : 'Pendiente de rotación tras la versión inicial';

    const secRow = (label, enabled) => `
      <div class="admin-security-item">
        <span>${escapeHtml(label)}</span>
        <span class="admin-security-badge ${enabled ? 'ok' : 'warn'}">${enabled ? 'ACTIVO' : 'REVISAR'}</span>
      </div>
    `;

    DOM.adminSystemStatusContent.innerHTML = `
      <div class="admin-storage-banner ${isPerm ? 'banner-ok' : 'banner-warn'}">
        ${isPerm ? `
          <strong>✅ Almacenamiento Persistente Activo: ${escapeHtml(storage.label || storage.mode)}</strong><br>
          Tus usuarios, métricas de visitas, foro y diseño del portal se conservan automáticamente tras cada actualización o reinicio del servidor.
        ` : `
          <strong>⚠️ Modo Efímero Detectado (Sin base de datos externa)</strong><br>
          Render Free borra los archivos locales del contenedor en cada despliegue o suspensión. Para que <strong>visitas, usuarios y configuración perduren para siempre</strong> sin pagar plan, añade una de estas variables de entorno en Render → <em>Environment</em>:
          <div class="admin-code-box">
            <strong>Opción 1 (Recomendada - PostgreSQL gratuito sin caducidad, ej. Neon.tech / Supabase):</strong><br>
            DATABASE_URL=postgres://usuario:clave@host/neondb?sslmode=require<br><br>
            <strong>Opción 2 (Respaldo automático cifrado en GitHub Gist privado):</strong><br>
            PERSIST_GIST_ID=id_de_tu_gist_privado<br>
            PERSIST_GH_TOKEN=github_pat_con_permiso_gist<br>
            PERSIST_SECRET=clave_aes_256_opcional
          </div>
          Mientras lo conectas, puedes descargar y restaurar todo con un clic desde <strong>💾 Backup → Respaldo Integral</strong>.
        `}
      </div>

      ${sec.recommendPasswordRotation ? `
        <div class="admin-storage-banner banner-warn">
          <strong>🔐 Acción de Seguridad Urgente: Cambia tu contraseña de Administrador</strong><br>
          La cuenta <code>admin</code> nunca ha rotado su contraseña en servidor desde el despliegue inicial. Usa el botón <strong>"🔑 Cambiar mi contraseña Admin"</strong> justo encima o desde tu menú de perfil.
        </div>
      ` : ''}

      <div class="admin-system-grid">
        <div class="admin-system-card">
          <h5>Base de Datos & Estado</h5>
          <div class="admin-security-list">
            <div class="admin-security-item">
              <span>Motor de almacenamiento</span>
              <strong>${escapeHtml(storage.label || 'efímero')}</strong>
            </div>
            <div class="admin-security-item">
              <span>Supervivencia ante deploys</span>
              <span class="admin-security-badge ${isPerm ? 'ok' : 'warn'}">${isPerm ? 'PERMANENTE' : 'EFÍMERO'}</span>
            </div>
            <div class="admin-security-item">
              <span>Última sincronización remota</span>
              <span>${escapeHtml(syncTime)}</span>
            </div>
            <div class="admin-security-item">
              <span>Sesiones activas en memoria/BD</span>
              <strong>${Number(st.activeSessionsCount || 0)}</strong>
            </div>
            ${storage.lastError ? `
              <div class="admin-security-item">
                <span style="color:#dc2626;">Último error de sync</span>
                <span style="color:#dc2626;">${escapeHtml(storage.lastError)}</span>
              </div>
            ` : ''}
          </div>
        </div>

        <div class="admin-system-card">
          <h5>Controles de Seguridad Activos</h5>
          <div class="admin-security-list">
            ${secRow('Sesiones en Cookie HttpOnly + SameSite=Lax', sec.httpOnlyCookie)}
            ${secRow('Tokens hasheados con SHA-256 en servidor', sec.hashedSessionTokens)}
            ${secRow('Cabeceras CSP strict (script-src self) + HSTS', sec.strictCsp)}
            ${secRow('Protección anti-SSRF en proxy e ingesta RSS', sec.ssrfProtection)}
            ${secRow('Bloqueo de /data/*.json, dotfiles y código', sec.staticDataBlocked)}
            ${secRow('Anti fuerza bruta (bloqueo tras 6 fallos)', sec.bruteForceLockout)}
            <div class="admin-security-item">
              <span>Rotación clave Admin</span>
              <span class="admin-security-badge ${sec.passwordUpdatedAt ? 'ok' : 'warn'}">${escapeHtml(passRotatedText)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // 12. Chat IRC Lateral en Vivo (Estilo mIRC32)
  // ==========================================
  function sanitizeGuestIrcNick(raw) {
    const cleaned = String(raw || '')
      .replace(/^[@+%~&\s]+/, '')
      .replace(/[^a-zA-Z0-9_.-]/g, '')
      .slice(0, 18);
    return cleaned.length >= 2 ? cleaned : getDefaultGuestNick();
  }

  function getDefaultGuestNick() {
    if (!state.chat.guestNick) {
      const rnd = Math.floor(1000 + Math.random() * 9000);
      state.chat.guestNick = `guest_${rnd}`;
      try { localStorage.setItem('cyberpolis_irc_nick', state.chat.guestNick); } catch (e) {}
    }
    return state.chat.guestNick;
  }

  function getEffectiveIrcNick() {
    if (state.currentUser) {
      return state.currentUser.username || state.currentUser.displayName || 'usuario';
    }
    return sanitizeGuestIrcNick(state.chat.guestNick || getDefaultGuestNick());
  }

  function formatIrcTimestamp(iso) {
    try {
      const d = iso ? new Date(iso) : new Date();
      return d.toTimeString().slice(0, 5);
    } catch (e) {
      return '--:--';
    }
  }

  function scrollIrcLogToBottom() {
    if (!DOM.ircMessagesList) return;
    DOM.ircMessagesList.scrollTop = DOM.ircMessagesList.scrollHeight;
  }

  function getIrcCacheKey(channel) {
    return `cyberpolis_irc_cache_${String(channel || '#cyberpolis').toLowerCase()}`;
  }

  function saveCachedIrcMessages() {
    try {
      const list = Array.isArray(state.chat.messages) ? state.chat.messages.slice(-250) : [];
      localStorage.setItem(getIrcCacheKey(state.chat.channel), JSON.stringify(list));
    } catch (e) {}
  }

  function loadCachedIrcMessages() {
    try {
      const raw = localStorage.getItem(getIrcCacheKey(state.chat.channel));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && state.chat.messages.length === 0) {
        state.chat.messages = parsed.slice(-250);
        for (const m of state.chat.messages) {
          if (m && m.id) state.chat.seenIds.add(m.id);
        }
        renderChatMessages();
      }
    } catch (e) {}
  }

  function updateIrcShellLayout() {
    const enabled = !!state.chat.enabled;
    const isMobile = window.innerWidth <= 1180;
    const collapsed = !!state.chat.collapsed;
    if (DOM.portalChatShell) {
      DOM.portalChatShell.classList.toggle('chat-disabled', !enabled);
      DOM.portalChatShell.classList.toggle('chat-collapsed', collapsed);
      DOM.portalChatShell.classList.toggle('mobile-chat-open', !collapsed);
    }
    if (DOM.ircLateralPanel) {
      DOM.ircLateralPanel.style.display = (enabled && !collapsed) ? 'block' : 'none';
    }
    const showReopen = enabled && collapsed;
    if (DOM.ircReopenTab) {
      DOM.ircReopenTab.style.display = showReopen ? 'inline-flex' : 'none';
    }
    if (DOM.ircReopenLabel) {
      DOM.ircReopenLabel.textContent = 'IRC';
    }
    if (DOM.ircHeaderToggleBtn) {
      DOM.ircHeaderToggleBtn.style.display = enabled ? 'inline-flex' : 'none';
      DOM.ircHeaderToggleBtn.classList.toggle('is-active', !collapsed);
      DOM.ircHeaderToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    document.body.classList.toggle('has-lateral-chat', enabled && !isMobile && !collapsed);
  }

  function setIrcCollapsed(collapsed) {
    state.chat.collapsed = !!collapsed;
    if (state.chat.collapsed) closeIrcContextMenu();
    updateIrcShellLayout();
  }

  function openIrcDrawer() {
    setIrcCollapsed(false);
    markIrcMessagesRead();
    scrollIrcLogToBottom();
    if (DOM.ircChatInput && !DOM.ircChatInput.disabled) {
      DOM.ircChatInput.focus();
    }
  }

  function toggleIrcDrawer() {
    if (state.chat.collapsed) {
      openIrcDrawer();
    } else {
      setIrcCollapsed(true);
    }
  }

  function isNickInList(list, nick) {
    const clean = String(nick || '').trim().toLowerCase();
    return Boolean(clean && Array.isArray(list) && list.some(item => String(item || '').trim().toLowerCase() === clean));
  }

  function isCurrentUserIrcOp() {
    if (state.currentUser && state.currentUser.role === 'admin') return true;
    return Boolean(state.chat.isChannelOp || isNickInList(state.chat.opNickNames, getEffectiveIrcNick()));
  }

  function hasCurrentUserIrcVoice() {
    if (isCurrentUserIrcOp() || state.currentUser) return true;
    return Boolean(state.chat.identityPrefix === '+' || isNickInList(state.chat.voiceNickNames, getEffectiveIrcNick()));
  }

  function syncIrcIdentityUi(reconnectIfChanged = false) {
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    const isOp = isCurrentUserIrcOp();
    const hasVoice = hasCurrentUserIrcVoice();
    const isLoggedIn = !!state.currentUser;
    const nick = getEffectiveIrcNick();
    const sessionKey = `${isLoggedIn ? state.currentUser.role : 'guest'}:${nick}`;

    if (DOM.ircAdminShortcutBtn) {
      DOM.ircAdminShortcutBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (DOM.ircIdentityBadge) {
      DOM.ircIdentityBadge.className = 'mirc-nick-badge';
      if (isOp) {
        DOM.ircIdentityBadge.classList.add('is-op');
        DOM.ircIdentityBadge.textContent = `@${nick} · OP`;
      } else if (hasVoice) {
        DOM.ircIdentityBadge.classList.add('is-voice');
        DOM.ircIdentityBadge.textContent = `+${nick}`;
      } else {
        DOM.ircIdentityBadge.textContent = 'Nick:';
      }
    }
    if (DOM.ircGuestNickInput) {
      DOM.ircGuestNickInput.style.display = isLoggedIn ? 'none' : 'inline-block';
      if (!isLoggedIn && document.activeElement !== DOM.ircGuestNickInput) {
        DOM.ircGuestNickInput.value = nick;
      }
    }

    if (DOM.ircChatInput && DOM.ircSendBtn) {
      let placeholder = `Mensaje en ${state.chat.channel || '#cyberpolis'} o /help...`;
      let disabled = false;
      if (state.chat.isBanned) {
        placeholder = 'Baneado del canal (+b)';
        disabled = true;
      } else if (state.chat.isMuted) {
        placeholder = 'Silenciado por @op (+q)';
        disabled = true;
      } else if (!isLoggedIn && !state.chat.allowGuests) {
        placeholder = 'Inicia sesión para chatear';
        disabled = true;
      } else if (state.chat.moderatedMode && !isOp && !hasVoice) {
        placeholder = 'Modo +m: solo usuarios +v / registrados / @ops';
        disabled = true;
      }
      DOM.ircChatInput.placeholder = placeholder;
      DOM.ircChatInput.disabled = disabled;
      DOM.ircSendBtn.disabled = disabled;
    }

    const changed = state.chat.lastSessionKey && state.chat.lastSessionKey !== sessionKey;
    state.chat.lastSessionKey = sessionKey;
    if (reconnectIfChanged && changed && state.serverMode && state.chat.enabled) {
      connectChatStream();
    }
  }

  function renderChatHeaderAndTheme() {
    const ch = state.chat.channel || '#cyberpolis';
    const modeStr = state.chat.moderatedMode ? '[+ntm]' : '[+nt]';
    const unread = state.chat.unreadIds.size;
    if (DOM.ircTitlebarText) {
      const unreadPrefix = unread > 0 ? `(${unread}) ` : '';
      DOM.ircTitlebarText.textContent = `${unreadPrefix}mIRC32 - [${ch}] ${modeStr}`;
    }
    if (DOM.ircChannelBadge) {
      DOM.ircChannelBadge.textContent = ch;
    }
    if (DOM.ircTopicText) {
      DOM.ircTopicText.textContent = state.chat.topic || '';
      DOM.ircTopicText.title = isCurrentUserIrcOp()
        ? `${state.chat.topic || ''} (Doble clic o clic derecho para editar topic)`
        : (state.chat.topic || '');
    }
    if (DOM.mircWindow) {
      DOM.mircWindow.classList.remove('mirc-classic', 'mirc-dark');
      DOM.mircWindow.classList.add(state.chat.theme === 'mirc-dark' ? 'mirc-dark' : 'mirc-classic');
    }
    if (DOM.ircContextMenu) {
      DOM.ircContextMenu.classList.remove('mirc-classic', 'mirc-dark');
      DOM.ircContextMenu.classList.add(state.chat.theme === 'mirc-dark' ? 'mirc-dark' : 'mirc-classic');
    }
    syncIrcPopupToggleUi();
    updateIrcShellLayout();
    syncIrcIdentityUi(false);
    updateIrcUnreadIndicators();
  }

  function syncIrcPopupToggleUi() {
    if (!DOM.ircPopupToggleBtn) return;
    const on = !!state.chat.popupsEnabled;
    DOM.ircPopupToggleBtn.textContent = on ? '🔔' : '🔕';
    DOM.ircPopupToggleBtn.classList.toggle('is-muted-bell', !on);
    DOM.ircPopupToggleBtn.title = on
      ? 'Popups de mensajes no leídos: Activos (clic para silenciar)'
      : 'Popups de mensajes no leídos: Silenciados (clic para activar)';
  }

  function isAnyBlockingModalOpen() {
    const modalIds = ['readerModal', 'adminControlModal', 'authModal', 'createModal', 'backupModal', 'changePasswordModal', 'linkedInModal', 'legalModal'];
    return modalIds.some(id => {
      const el = document.getElementById(id);
      return el && el.style.display && el.style.display !== 'none';
    });
  }

  function isUserReadingIrcNow() {
    if (document.hidden) return false;
    if (!state.chat.enabled) return false;
    const isMobile = window.innerWidth <= 1180;
    const chatVisible = isMobile
      ? !!(DOM.portalChatShell && DOM.portalChatShell.classList.contains('mobile-chat-open'))
      : !state.chat.collapsed;
    if (!chatVisible) return false;
    if (isAnyBlockingModalOpen()) return false;

    const nearBottom = !DOM.ircMessagesList || (DOM.ircMessagesList.scrollHeight - DOM.ircMessagesList.scrollTop - DOM.ircMessagesList.clientHeight) < 60;
    if (!nearBottom) return false;

    const focusedInChat = !!(DOM.mircWindow && DOM.mircWindow.contains(document.activeElement));
    const hoveredInChat = !!(DOM.mircWindow && DOM.mircWindow.matches(':hover'));
    const recentlyActive = (Date.now() - (state.chat.lastReadActivityAt || 0)) < 8000;
    return focusedInChat || hoveredInChat || recentlyActive;
  }

  function updateIrcUnreadIndicators() {
    const count = state.chat.unreadIds.size;
    const badgeText = count > 99 ? '99+' : String(count);
    if (DOM.ircReopenBadge) {
      DOM.ircReopenBadge.textContent = badgeText;
      DOM.ircReopenBadge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    if (DOM.ircHeaderBadge) {
      DOM.ircHeaderBadge.textContent = badgeText;
      DOM.ircHeaderBadge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    if (DOM.ircReopenTab) {
      DOM.ircReopenTab.classList.toggle('has-unread', count > 0);
    }
    const ch = state.chat.channel || '#cyberpolis';
    const modeStr = state.chat.moderatedMode ? '[+ntm]' : '[+nt]';
    if (DOM.ircTitlebarText) {
      DOM.ircTitlebarText.textContent = `${count > 0 ? `(${count}) ` : ''}mIRC32 - [${ch}] ${modeStr}`;
    }
    const baseTitle = getPortalBrandLabel(true);
    document.title = count > 0 ? `(${count}) Nuevo en ${ch} — ${baseTitle}` : baseTitle;
  }

  function markIrcMessagesRead() {
    state.chat.lastReadActivityAt = Date.now();
    const hadUnread = state.chat.unreadIds.size > 0;
    state.chat.unreadIds.clear();
    if (DOM.ircPopupContainer) {
      DOM.ircPopupContainer.innerHTML = '';
    }
    updateIrcUnreadIndicators();
    if (hadUnread) {
      renderChatMessages();
    }
  }

  function focusIrcFromPopup() {
    const readerModal = document.getElementById('readerModal');
    if (readerModal && readerModal.style.display !== 'none') {
      readerModal.style.display = 'none';
    }
    openIrcDrawer();
  }

  function showIrcMessagePopup(msg) {
    if (!DOM.ircPopupContainer || !state.chat.popupsEnabled || !msg) return;
    const isDark = state.chat.theme === 'mirc-dark';
    const prefix = msg.prefix === '@' ? '@' : (msg.prefix === '+' ? '+' : '');
    const fullNick = `${prefix}${msg.nick || 'anon'}`;
    const nickCls = prefix === '@' ? 'mirc-nick-op' : (prefix === '+' ? 'mirc-nick-voice' : 'mirc-nick-guest');
    const ts = formatIrcTimestamp(msg.ts);
    const unreadTotal = state.chat.unreadIds.size;

    const existingSame = DOM.ircPopupContainer.querySelector(`[data-irc-popup-id="${CSS.escape(String(msg.id || ''))}"]`);
    if (existingSame) return;

    while (DOM.ircPopupContainer.children.length >= 3) {
      DOM.ircPopupContainer.removeChild(DOM.ircPopupContainer.firstElementChild);
    }

    let bodyHtml = '';
    if (msg.type === 'system') {
      bodyHtml = `<span class="mirc-ts">[${ts}]</span> <span class="mirc-line-system">${escapeHtml(msg.text)}</span>`;
    } else if (msg.type === 'action') {
      bodyHtml = `<span class="mirc-ts">[${ts}]</span> <span class="mirc-line-action">* <span class="mirc-nick ${nickCls}">${escapeHtml(fullNick)}</span> ${escapeHtml(msg.text)}</span>`;
    } else {
      bodyHtml = `<span class="mirc-ts">[${ts}]</span> <span class="mirc-nick ${nickCls}">&lt;${escapeHtml(fullNick)}&gt;</span> <span>${escapeHtml(msg.text)}</span>`;
    }

    const card = document.createElement('div');
    card.className = `irc-popup-card ${isDark ? 'mirc-dark' : 'mirc-classic'}`;
    card.dataset.ircPopupId = String(msg.id || '');
    card.innerHTML = `
      <div class="irc-popup-head">
        <div class="irc-popup-title">
          <span>⚡ mIRC32 · ${escapeHtml(state.chat.channel || '#cyberpolis')}</span>
          <span class="irc-popup-unread-tag">${unreadTotal} sin leer</span>
        </div>
        <button type="button" class="irc-popup-close" data-irc-popup-close="1" aria-label="Cerrar aviso" title="Cerrar este aviso">&times;</button>
      </div>
      <div class="irc-popup-body">${bodyHtml}</div>
      <div class="irc-popup-foot">
        <span>Clic para abrir e ir al chat</span>
        <span>${escapeHtml(fullNick)}</span>
      </div>
    `;
    DOM.ircPopupContainer.appendChild(card);
  }

  function handleIncomingChatMessages(msgs) {
    if (!Array.isArray(msgs) || msgs.length === 0) return;
    if (!state.chat.bootstrapped) {
      for (const m of msgs) {
        if (m && m.id) state.chat.seenIds.add(m.id);
      }
      state.chat.bootstrapped = true;
      return;
    }

    const myNick = getEffectiveIrcNick().toLowerCase();
    for (const m of msgs) {
      if (!m || !m.id || state.chat.seenIds.has(m.id)) continue;
      state.chat.seenIds.add(m.id);

      const isOwn = m.type !== 'system' && String(m.nick || '').toLowerCase() === myNick;
      if (isOwn || isUserReadingIrcNow()) {
        state.chat.lastReadActivityAt = Date.now();
        continue;
      }

      state.chat.unreadIds.add(m.id);
      updateIrcUnreadIndicators();
      showIrcMessagePopup(m);
    }
  }

  function renderChatMessages() {
    if (!DOM.ircMessagesList) return;
    const isOpActor = isCurrentUserIrcOp();
    const list = (Array.isArray(state.chat.messages) ? state.chat.messages : [])
      .filter(m => m.type === 'system' || !state.chat.ignoredNicks.has(String(m.nick || '').toLowerCase()));

    if (list.length === 0) {
      DOM.ircMessagesList.innerHTML = `<div class="mirc-line mirc-line-system"><span class="mirc-ts">[--:--]</span> *** Esperando mensajes en ${escapeHtml(state.chat.channel || '#cyberpolis')}</div>`;
      return;
    }

    const wasNearBottom = (DOM.ircMessagesList.scrollHeight - DOM.ircMessagesList.scrollTop - DOM.ircMessagesList.clientHeight) < 80;
    DOM.ircMessagesList.innerHTML = list.map(m => {
      const ts = formatIrcTimestamp(m.ts);
      const prefix = m.prefix === '@' ? '@' : (m.prefix === '+' ? '+' : '');
      const fullNick = `${prefix}${m.nick || 'anon'}`;
      const nickCls = prefix === '@' ? 'mirc-nick-op' : (prefix === '+' ? 'mirc-nick-voice' : 'mirc-nick-guest');
      const unreadCls = state.chat.unreadIds.has(m.id) ? ' is-unread' : '';
      const canModerateMsg = isOpActor && m.role !== 'admin' && m.role !== 'system';
      const modBtns = isOpActor ? `
        <span class="mirc-inline-mod">
          <button type="button" class="mirc-mod-mini-btn" data-irc-del="${escapeHtml(m.id)}" title="Borrar mensaje">🗑️</button>
          ${canModerateMsg ? `<button type="button" class="mirc-mod-mini-btn" data-irc-mod-action="mute" data-irc-target-nick="${escapeHtml(m.nick)}" title="Silenciar (+q)">🔇</button>` : ''}
          ${canModerateMsg ? `<button type="button" class="mirc-mod-mini-btn" data-irc-mod-action="ban" data-irc-target-nick="${escapeHtml(m.nick)}" title="Banear (+b)">🚫</button>` : ''}
        </span>
      ` : '';

      if (m.type === 'system') {
        return `<div class="mirc-line mirc-line-system${unreadCls}">${modBtns}<span class="mirc-ts">[${ts}]</span> ${escapeHtml(m.text)}</div>`;
      }
      if (m.type === 'action') {
        return `<div class="mirc-line mirc-line-action${unreadCls}">${modBtns}<span class="mirc-ts">[${ts}]</span> * <span class="mirc-nick ${nickCls}" data-irc-nick="${escapeHtml(m.nick)}" title="Clic derecho para opciones mIRC32">${escapeHtml(fullNick)}</span> ${escapeHtml(m.text)}</div>`;
      }
      return `<div class="mirc-line${unreadCls}">${modBtns}<span class="mirc-ts">[${ts}]</span> <span class="mirc-nick ${nickCls}" data-irc-nick="${escapeHtml(m.nick)}" title="Clic derecho para opciones mIRC32">&lt;${escapeHtml(fullNick)}&gt;</span> <span>${escapeHtml(m.text)}</span></div>`;
    }).join('');

    if (wasNearBottom || list.length <= 20) {
      scrollIrcLogToBottom();
    }
  }

  function renderChatNicklist() {
    if (!DOM.ircNickList) return;
    const online = Array.isArray(state.chat.onlineUsers) ? state.chat.onlineUsers : [];
    if (DOM.ircOnlineCount) {
      DOM.ircOnlineCount.textContent = `${online.length} online`;
    }
    const itemsHtml = online.map(u => {
      const pfx = u.prefix === '@' ? '@' : (u.prefix === '+' ? '+' : '');
      const cls = pfx === '@' ? 'is-op' : (pfx === '+' ? 'is-voice' : '');
      return `<button type="button" class="mirc-nick-item ${cls}" data-irc-nick="${escapeHtml(u.nick)}" title="${escapeHtml(pfx + u.nick)} · Clic: mencionar | Clic derecho: menú mIRC32">${escapeHtml(pfx + u.nick)}</button>`;
    }).join('');
    DOM.ircNickList.innerHTML = `<div class="mirc-nicklist-head">Nicks (${online.length})</div>${itemsHtml || '<div class="mirc-ts" style="padding:3px;">Conectando...</div>'}`;
  }

  function appendLocalSystemNotice(text) {
    state.chat.messages.push({
      id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type: 'system',
      nick: 'mIRC32',
      prefix: '@',
      role: 'system',
      text,
      ts: new Date().toISOString()
    });
    renderChatMessages();
    scrollIrcLogToBottom();
  }

  function applyChatPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.channel) state.chat.channel = payload.channel;
    if (payload.topic !== undefined) state.chat.topic = payload.topic;
    if (payload.enabled !== undefined) state.chat.enabled = !!payload.enabled;
    if (payload.allowGuests !== undefined) state.chat.allowGuests = !!payload.allowGuests;
    if (payload.moderatedMode !== undefined) state.chat.moderatedMode = !!payload.moderatedMode;
    if (payload.theme) state.chat.theme = payload.theme;
    if (Array.isArray(payload.opNickNames)) state.chat.opNickNames = payload.opNickNames;
    if (Array.isArray(payload.voiceNickNames)) state.chat.voiceNickNames = payload.voiceNickNames;
    if (Array.isArray(payload.mutedNickNames)) state.chat.mutedNickNames = payload.mutedNickNames;
    if (payload.identity && typeof payload.identity === 'object') {
      state.chat.isChannelOp = !!payload.identity.isChannelOp;
      state.chat.identityPrefix = payload.identity.prefix || '';
    }
    if (Array.isArray(payload.messages)) {
      state.chat.messages = payload.messages.slice(-300);
      saveCachedIrcMessages();
      handleIncomingChatMessages(state.chat.messages);
    }
    if (Array.isArray(payload.onlineUsers)) state.chat.onlineUsers = payload.onlineUsers;
    if (payload.isBanned !== undefined) state.chat.isBanned = !!payload.isBanned;
    if (payload.isMuted !== undefined) state.chat.isMuted = !!payload.isMuted;

    renderChatHeaderAndTheme();
    renderChatMessages();
    renderChatNicklist();
  }

  function connectChatStream() {
    if (state.chat.sse) {
      try { state.chat.sse.close(); } catch (e) {}
      state.chat.sse = null;
    }
    if (!state.serverMode || !state.chat.enabled || typeof window.EventSource !== 'function') return;

    const nick = getEffectiveIrcNick();
    const es = new EventSource(`/api/chat/stream?nick=${encodeURIComponent(nick)}`);
    state.chat.sse = es;

    const setLiveStatus = (live) => {
      if (!DOM.ircLiveBadge) return;
      DOM.ircLiveBadge.textContent = live ? '● EN VIVO' : '○ RECONECT.';
      DOM.ircLiveBadge.classList.toggle('is-offline', !live);
    };

    es.onopen = () => setLiveStatus(true);
    es.onerror = () => setLiveStatus(false);

    es.addEventListener('init', ev => {
      try {
        setLiveStatus(true);
        applyChatPayload(JSON.parse(ev.data));
        scrollIrcLogToBottom();
      } catch (e) {}
    });

    es.addEventListener('message', ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (!state.chat.messages.some(x => x.id === msg.id)) {
          state.chat.messages.push(msg);
          if (state.chat.messages.length > 300) state.chat.messages = state.chat.messages.slice(-300);
          saveCachedIrcMessages();
          handleIncomingChatMessages([msg]);
          renderChatMessages();
        }
      } catch (e) {}
    });

    es.addEventListener('delete', ev => {
      try {
        const { id } = JSON.parse(ev.data);
        state.chat.messages = state.chat.messages.filter(m => m.id !== id);
        saveCachedIrcMessages();
        if (state.chat.unreadIds.delete(id)) updateIrcUnreadIndicators();
        if (DOM.ircPopupContainer) {
          const card = DOM.ircPopupContainer.querySelector(`[data-irc-popup-id="${CSS.escape(String(id))}"]`);
          if (card) card.remove();
        }
        renderChatMessages();
      } catch (e) {}
    });

    es.addEventListener('clear', ev => {
      try {
        const data = JSON.parse(ev.data);
        state.chat.messages = Array.isArray(data.messages) ? data.messages : [];
        saveCachedIrcMessages();
        markIrcMessagesRead();
        renderChatMessages();
      } catch (e) {}
    });

    es.addEventListener('presence', ev => {
      try {
        const data = JSON.parse(ev.data);
        if (Array.isArray(data.onlineUsers)) {
          state.chat.onlineUsers = data.onlineUsers;
          renderChatNicklist();
        }
      } catch (e) {}
    });

    es.addEventListener('config', ev => {
      try {
        const cfg = JSON.parse(ev.data);
        const wasEnabled = state.chat.enabled;
        applyChatPayload(cfg);
        if (!wasEnabled && cfg.enabled) {
          connectChatStream();
        } else if (wasEnabled && cfg.enabled === false) {
          try { es.close(); } catch (e) {}
          state.chat.sse = null;
        }
      } catch (e) {}
    });

    es.addEventListener('kicked', ev => {
      try {
        const data = JSON.parse(ev.data);
        appendLocalSystemNotice(`*** Desconectado del canal: ${data.reason || 'Moderación @op'}`);
        es.close();
        state.chat.sse = null;
        loadChatStateFallback();
      } catch (e) {}
    });

    es.addEventListener('self_mode', ev => {
      try {
        const data = JSON.parse(ev.data);
        state.chat.isChannelOp = !!data.isChannelOp;
        state.chat.identityPrefix = data.prefix || '';
        if (data.isMuted !== undefined) state.chat.isMuted = !!data.isMuted;
        if (data.isBanned !== undefined) state.chat.isBanned = !!data.isBanned;
        syncIrcIdentityUi(false);
        renderChatMessages();
        renderChatNicklist();
      } catch (e) {}
    });
  }

  async function loadChatStateFallback() {
    if (!state.serverMode) return;
    try {
      const res = await fetch(`/api/chat/state?nick=${encodeURIComponent(getEffectiveIrcNick())}`);
      if (res.ok) {
        const data = await res.json();
        applyChatPayload(data);
      }
    } catch (e) {}
  }

  async function initLiveIrcChat() {
    loadCachedIrcMessages();
    updateIrcShellLayout();
    syncIrcIdentityUi(false);
    if (!state.serverMode) {
      renderChatHeaderAndTheme();
      appendLocalSystemNotice('*** Modo local sin servidor: el chat IRC requiere conexión con backend.');
      return;
    }

    await loadChatStateFallback();
    if (state.chat.enabled) {
      connectChatStream();
    }

    // Respaldo ligero cada 25s por si un proxy intermedio cierra SSE
    if (state.chat.pollTimer) clearInterval(state.chat.pollTimer);
    state.chat.pollTimer = setInterval(async () => {
      if (!state.chat.sse || state.chat.sse.readyState === 2) {
        await loadChatStateFallback();
        if (state.chat.enabled) connectChatStream();
      }
    }, 25000);
  }

  async function handleIrcChatSubmit(e) {
    e.preventDefault();
    if (!DOM.ircChatInput) return;
    const raw = DOM.ircChatInput.value.trim();
    if (!raw) return;

    if (raw.toLowerCase() === '/help') {
      DOM.ircChatInput.value = '';
      appendLocalSystemNotice('*** Comandos IRC: /me <acción> | /slap <nick> | /whois <nick> | /nick <nuevo_nick>');
      if (isCurrentUserIrcOp()) {
        appendLocalSystemNotice('*** Comandos @OP: /topic <texto> | /notice <aviso> | /op <nick> | /deop <nick> | /voice <nick> | /devoice <nick> | /mute <nick> | /unmute <nick> | /kick <nick> | /ban <nick> | /kickban <nick> | /unban <nick> | /mode +m|-m|+o|-o|+v|-v | /clear');
      }
      return;
    }

    if (raw.toLowerCase().startsWith('/whois ')) {
      DOM.ircChatInput.value = '';
      const target = raw.slice(7).trim();
      if (!target) {
        appendLocalSystemNotice('*** Uso: /whois <nick>');
        return;
      }
      performIrcWhois(target);
      return;
    }

    if (raw.toLowerCase().startsWith('/nick ')) {
      DOM.ircChatInput.value = '';
      if (state.currentUser) {
        appendLocalSystemNotice('*** Como usuario autenticado usas el nick de tu cuenta.');
        return;
      }
      const nextNick = sanitizeGuestIrcNick(raw.slice(6));
      state.chat.guestNick = nextNick;
      if (DOM.ircGuestNickInput) DOM.ircGuestNickInput.value = nextNick;
      try { localStorage.setItem('cyberpolis_irc_nick', nextNick); } catch (err) {}
      appendLocalSystemNotice(`*** Ahora eres conocido como ${nextNick}`);
      syncIrcIdentityUi(true);
      return;
    }

    if (!state.serverMode) {
      showToast('El chat IRC requiere conexión activa con el servidor.', 'error');
      return;
    }

    DOM.ircChatInput.value = '';
    try {
      const res = await apiFetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nick: getEffectiveIrcNick(),
          text: raw
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        appendLocalSystemNotice(`*** Error: ${data.error || 'No se pudo enviar el mensaje.'}`);
        if (res.status === 403) loadChatStateFallback();
      } else if (data.message && !state.chat.messages.some(x => x.id === data.message.id)) {
        state.chat.messages.push(data.message);
        renderChatMessages();
        scrollIrcLogToBottom();
      }
    } catch (err) {
      appendLocalSystemNotice('*** Error de red al enviar mensaje.');
    }
  }

  async function deleteChatMessageById(msgId) {
    if (!msgId || !state.serverMode) return;
    try {
      const actorNick = getEffectiveIrcNick();
      const res = await apiFetch(`/api/chat/messages/${encodeURIComponent(msgId)}?actorNick=${encodeURIComponent(actorNick)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo eliminar el mensaje.', 'error');
        return;
      }
      state.chat.messages = state.chat.messages.filter(m => m.id !== msgId);
      renderChatMessages();
      if (DOM.adminChatSection && DOM.adminChatSection.style.display === 'block') {
        loadAdminChatModeration();
      }
      showToast('Mensaje eliminado del canal IRC.');
    } catch (err) {
      showToast('Error al eliminar el mensaje.', 'error');
    }
  }

  function closeIrcContextMenu() {
    if (!DOM.ircContextMenu) return;
    DOM.ircContextMenu.style.display = 'none';
    DOM.ircContextMenu.innerHTML = '';
    state.chat.contextTargetNick = '';
    state.chat.contextTargetMode = '';
  }

  function positionIrcContextMenu(menuEl, clientX, clientY) {
    menuEl.style.display = 'block';
    menuEl.style.left = '0px';
    menuEl.style.top = '0px';
    const rect = menuEl.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(clientX, window.innerWidth - rect.width - pad));
    const y = Math.max(pad, Math.min(clientY, window.innerHeight - rect.height - pad));
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
  }

  function ctxMenuItem(action, label, hint = '', extraNick = '') {
    const nickAttr = extraNick ? ` data-ctx-nick="${escapeHtml(extraNick)}"` : '';
    const hintHtml = hint ? `<span class="mirc-ctx-hint">${escapeHtml(hint)}</span>` : '';
    return `<button type="button" class="mirc-ctx-item" role="menuitem" data-ctx-action="${escapeHtml(action)}"${nickAttr}><span>${label}</span>${hintHtml}</button>`;
  }

  function openIrcNickContextMenu(targetNick, clientX, clientY) {
    if (!DOM.ircContextMenu || !targetNick) return;
    const cleanNick = String(targetNick).trim();
    const lower = cleanNick.toLowerCase();
    const selfNick = getEffectiveIrcNick().toLowerCase();
    const isSelf = lower === selfNick;
    const isOpActor = isCurrentUserIrcOp();
    const onlineMatch = (state.chat.onlineUsers || []).find(u => String(u.nick || '').toLowerCase() === lower);
    const isTargetOp = (onlineMatch && onlineMatch.prefix === '@') || isNickInList(state.chat.opNickNames, cleanNick);
    const isTargetVoice = (onlineMatch && onlineMatch.prefix === '+') || isNickInList(state.chat.voiceNickNames, cleanNick);
    const isTargetMuted = isNickInList(state.chat.mutedNickNames, cleanNick);
    const isTargetIgnored = state.chat.ignoredNicks.has(lower);
    const displayPfx = isTargetOp ? '@' : (isTargetVoice ? '+' : '');

    state.chat.contextTargetNick = cleanNick;
    state.chat.contextTargetMode = 'nick';

    const sections = [
      `<div class="mirc-ctx-header">${escapeHtml(displayPfx + cleanNick)}${isSelf ? ' (tú)' : ''}</div>`,
      `<div class="mirc-ctx-sublabel">Opciones de usuario</div>`,
      ctxMenuItem('whois', '🔍 Info / Whois', '/whois', cleanNick),
      ctxMenuItem('mention', '💬 Mencionar en canal', 'Nick:', cleanNick),
      ctxMenuItem('slap', '🐟 Slap! (trucha)', '/slap', cleanNick),
      ctxMenuItem('copy-nick', '📋 Copiar nick', '', cleanNick)
    ];

    if (!isSelf) {
      sections.push(ctxMenuItem(
        'toggle-ignore',
        isTargetIgnored ? '👁️ Dejar de ignorar' : '🙈 Ignorar (local)',
        isTargetIgnored ? 'ON' : '',
        cleanNick
      ));
    }

    if (isOpActor) {
      sections.push('<div class="mirc-ctx-sep"></div>');
      sections.push('<div class="mirc-ctx-sublabel">Control @OP</div>');
      sections.push(ctxMenuItem(
        isTargetOp ? 'deop' : 'op',
        isTargetOp ? '🔻 Quitar @Op (-o)' : '👑 Elevar a @Op (+o)',
        isTargetOp ? '-o' : '+o',
        cleanNick
      ));
      sections.push(ctxMenuItem(
        isTargetVoice ? 'devoice' : 'voice',
        isTargetVoice ? '🔇 Quitar +Voz (-v)' : '🎙️ Dar +Voz (+v)',
        isTargetVoice ? '-v' : '+v',
        cleanNick
      ));
      if (!isSelf) {
        sections.push(ctxMenuItem(
          isTargetMuted ? 'unmute' : 'mute',
          isTargetMuted ? '🔊 Quitar silencio (-q)' : '🤫 Silenciar (+q)',
          isTargetMuted ? '-q' : '+q',
          cleanNick
        ));
        sections.push(ctxMenuItem('kick', '👢 Expulsar', '/kick', cleanNick));
        sections.push(ctxMenuItem('ban', '🚫 Banear', '+b', cleanNick));
        sections.push(ctxMenuItem('kickban', '⚡ Kick + Ban', '/kb', cleanNick));
      }
    }

    DOM.ircContextMenu.classList.remove('mirc-classic', 'mirc-dark');
    DOM.ircContextMenu.classList.add(state.chat.theme === 'mirc-dark' ? 'mirc-dark' : 'mirc-classic');
    DOM.ircContextMenu.innerHTML = sections.join('');
    positionIrcContextMenu(DOM.ircContextMenu, clientX, clientY);
  }

  function openIrcChannelContextMenu(clientX, clientY) {
    if (!DOM.ircContextMenu) return;
    const isOpActor = isCurrentUserIrcOp();
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    state.chat.contextTargetNick = '';
    state.chat.contextTargetMode = 'channel';

    const sections = [
      `<div class="mirc-ctx-header">Canal ${escapeHtml(state.chat.channel || '#cyberpolis')}</div>`,
      `<div class="mirc-ctx-sublabel">Ventana mIRC32</div>`,
      ctxMenuItem('copy-log', '📋 Copiar historial'),
      ctxMenuItem('toggle-nicks', state.chat.hideNicks ? '👥 Mostrar lista de nicks' : '🫥 Ocultar lista de nicks'),
      ctxMenuItem('toggle-popups', state.chat.popupsEnabled ? '🔕 Silenciar popups' : '🔔 Activar popups'),
      ctxMenuItem('local-clear', '🧽 Limpiar vista local')
    ];

    if (isOpActor) {
      sections.push('<div class="mirc-ctx-sep"></div>');
      sections.push('<div class="mirc-ctx-sublabel">Modos de canal (@OP)</div>');
      sections.push(ctxMenuItem('edit-topic', '📝 Cambiar Topic', '/topic'));
      sections.push(ctxMenuItem(
        'toggle_moderated',
        state.chat.moderatedMode ? '🔓 Desactivar Modo +m' : '🔒 Modo Moderado (+m)',
        '+m'
      ));
      sections.push(ctxMenuItem(
        'toggle_guests',
        state.chat.allowGuests ? '🛂 Bloquear invitados' : '🟢 Permitir invitados'
      ));
      sections.push(ctxMenuItem('clear', '🧹 Limpiar canal (todos)', '/clear'));
      if (isAdmin) {
        sections.push(ctxMenuItem('open-admin', '🛡️ Abrir Admin IRC'));
      }
    }

    DOM.ircContextMenu.classList.remove('mirc-classic', 'mirc-dark');
    DOM.ircContextMenu.classList.add(state.chat.theme === 'mirc-dark' ? 'mirc-dark' : 'mirc-classic');
    DOM.ircContextMenu.innerHTML = sections.join('');
    positionIrcContextMenu(DOM.ircContextMenu, clientX, clientY);
  }

  async function performIrcWhois(nick) {
    if (!nick || !state.serverMode) return;
    try {
      const res = await apiFetch(`/api/chat/whois?nick=${encodeURIComponent(nick)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        appendLocalSystemNotice(`*** Whois error: ${data.error || 'No disponible'}`);
        return;
      }
      const roles = [];
      if (data.isSiteAdmin) roles.push('Admin Portal');
      if (data.isChannelOp) roles.push('Operador (@)');
      if (data.isVoice && !data.isChannelOp) roles.push('Voz (+)');
      if (data.isMuted) roles.push('Silenciado (+q)');
      if (data.isBanned) roles.push('Baneado (+b)');
      const statusTxt = data.isOnline ? 'En línea' : 'Desconectado';
      const roleTxt = roles.length ? roles.join(', ') : 'Invitado';
      appendLocalSystemNotice(`*** [Whois ${data.prefix || ''}${data.nick}] Canal: ${data.channel || '#cyberpolis'} | Estado: ${statusTxt} | Rango: ${roleTxt} | Mensajes: ${Number(data.messageCount || 0)}`);
    } catch (err) {
      appendLocalSystemNotice('*** Error al consultar /whois.');
    }
  }

  function toggleIgnoreIrcNick(nick) {
    const clean = String(nick || '').trim().toLowerCase();
    if (!clean) return;
    if (state.chat.ignoredNicks.has(clean)) {
      state.chat.ignoredNicks.delete(clean);
      appendLocalSystemNotice(`*** Has dejado de ignorar a ${nick}.`);
    } else {
      state.chat.ignoredNicks.add(clean);
      appendLocalSystemNotice(`*** Ignorando mensajes locales de ${nick}.`);
    }
    try {
      localStorage.setItem('cyberpolis_irc_ignored', JSON.stringify(Array.from(state.chat.ignoredNicks)));
    } catch (e) {}
    renderChatMessages();
  }

  async function runIrcOpAction(action, nick = '', opts = {}) {
    if (!state.serverMode || !action) return false;
    try {
      const res = await apiFetch('/api/chat/op-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          actorNick: getEffectiveIrcNick(),
          nick,
          reason: opts.reason || '',
          text: opts.text || '',
          topic: opts.topic || '',
          id: opts.id || ''
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo ejecutar la acción IRC.', 'error');
        return false;
      }
      if (data.chat) applyChatPayload(data.chat);
      await loadChatStateFallback();
      if (DOM.adminChatSection && DOM.adminChatSection.style.display === 'block') {
        loadAdminChatModeration();
      }
      return true;
    } catch (err) {
      showToast('Error de red en acción IRC.', 'error');
      return false;
    }
  }

  function startInlineTopicEdit() {
    if (!DOM.ircTopicText || !DOM.ircTopicInlineInput) return;
    DOM.ircTopicText.style.display = 'none';
    DOM.ircTopicInlineInput.style.display = 'block';
    DOM.ircTopicInlineInput.value = state.chat.topic || '';
    DOM.ircTopicInlineInput.focus();
    DOM.ircTopicInlineInput.select();
  }

  function cancelInlineTopicEdit() {
    if (!DOM.ircTopicText || !DOM.ircTopicInlineInput) return;
    DOM.ircTopicInlineInput.style.display = 'none';
    DOM.ircTopicText.style.display = '';
  }

  async function commitInlineTopicEdit() {
    if (!DOM.ircTopicInlineInput) return;
    const nextTopic = DOM.ircTopicInlineInput.value.trim();
    cancelInlineTopicEdit();
    if (!nextTopic || nextTopic === state.chat.topic) return;
    const ok = await runIrcOpAction('topic', '', { topic: nextTopic });
    if (ok) showToast('Topic del canal actualizado.');
  }

  async function sendIrcSlap(nick) {
    if (!nick || !state.serverMode) return;
    try {
      const res = await apiFetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: getEffectiveIrcNick(), text: `/slap ${nick}` })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo enviar /slap.', 'error');
        return;
      }
      if (data.message && !state.chat.messages.some(x => x.id === data.message.id)) {
        state.chat.messages.push(data.message);
        renderChatMessages();
        scrollIrcLogToBottom();
      }
    } catch (e) {}
  }

  async function handleIrcContextMenuAction(action, nick = '') {
    closeIrcContextMenu();
    switch (action) {
      case 'whois':
        await performIrcWhois(nick);
        break;
      case 'mention':
        if (DOM.ircChatInput && nick) {
          DOM.ircChatInput.value = `${nick}: ${DOM.ircChatInput.value}`.trimStart();
          DOM.ircChatInput.focus();
        }
        break;
      case 'slap':
        await sendIrcSlap(nick);
        break;
      case 'copy-nick':
        if (nick && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(nick).then(() => showToast(`Nick "${nick}" copiado.`)).catch(() => {});
        }
        break;
      case 'toggle-ignore':
        toggleIgnoreIrcNick(nick);
        break;
      case 'op':
      case 'deop':
      case 'voice':
      case 'devoice':
      case 'mute':
      case 'unmute':
      case 'kick':
      case 'ban':
      case 'kickban':
        await runIrcOpAction(action, nick, { reason: 'Menú mIRC32' });
        break;
      case 'toggle_moderated':
      case 'toggle_guests':
      case 'clear':
        await runIrcOpAction(action);
        break;
      case 'edit-topic':
        startInlineTopicEdit();
        break;
      case 'copy-log':
        if (navigator.clipboard && navigator.clipboard.writeText) {
          const logText = (state.chat.messages || []).map(m => {
            const ts = formatIrcTimestamp(m.ts);
            if (m.type === 'system') return `[${ts}] ${m.text}`;
            const p = m.prefix === '@' || m.prefix === '+' ? m.prefix : '';
            return m.type === 'action'
              ? `[${ts}] * ${p}${m.nick} ${m.text}`
              : `[${ts}] <${p}${m.nick}> ${m.text}`;
          }).join('\n');
          navigator.clipboard.writeText(logText).then(() => showToast('Historial del canal copiado.')).catch(() => {});
        }
        break;
      case 'toggle-nicks':
        state.chat.hideNicks = !state.chat.hideNicks;
        if (DOM.ircBody) DOM.ircBody.classList.toggle('hide-nicks', state.chat.hideNicks);
        break;
      case 'toggle-popups':
        if (DOM.ircPopupToggleBtn) DOM.ircPopupToggleBtn.click();
        break;
      case 'local-clear':
        state.chat.messages = [];
        renderChatMessages();
        appendLocalSystemNotice('*** Historial local limpiado.');
        break;
      case 'open-admin':
        openAdminControl();
        switchAdminTab('chat');
        break;
    }
  }

  async function loadAdminChatModeration() {
    if (!state.serverMode || !state.currentUser || state.currentUser.role !== 'admin') return;
    try {
      const res = await apiFetch('/api/admin/chat/moderation');
      if (!res.ok) return;
      const data = await res.json();

      if (DOM.chatAdminEnabledToggle) DOM.chatAdminEnabledToggle.checked = !!data.enabled;
      if (DOM.chatAdminAllowGuestsToggle) DOM.chatAdminAllowGuestsToggle.checked = !!data.allowGuests;
      if (DOM.chatAdminModeratedToggle) DOM.chatAdminModeratedToggle.checked = !!data.moderatedMode;
      if (DOM.chatAdminChannelInput) DOM.chatAdminChannelInput.value = data.channel || '#cyberpolis';
      if (DOM.chatAdminThemeSelect) DOM.chatAdminThemeSelect.value = data.theme === 'mirc-dark' ? 'mirc-dark' : 'mirc-classic';
      if (DOM.chatAdminTopicInput) DOM.chatAdminTopicInput.value = data.topic || '';

      if (DOM.chatAdminMessagesList) {
        const msgs = (data.recentMessages || []).slice().reverse();
        DOM.chatAdminMessagesList.innerHTML = msgs.length
          ? msgs.map(m => {
              const pfx = m.prefix === '@' ? '@' : (m.prefix === '+' ? '+' : '');
              const canMod = m.role !== 'admin' && m.role !== 'system';
              return `
                <div class="admin-chat-mod-row">
                  <div class="admin-chat-mod-text">
                    <strong>${escapeHtml(pfx + m.nick)}</strong> <span class="mirc-ts">[${formatIrcTimestamp(m.ts)}]</span>: ${escapeHtml(m.text)}
                  </div>
                  <div class="admin-chat-mod-actions">
                    <button type="button" class="admin-chat-mini-btn" data-admin-chat-del="${escapeHtml(m.id)}" title="Borrar">🗑️</button>
                    ${canMod ? `<button type="button" class="admin-chat-mini-btn" data-admin-chat-act="mute" data-admin-chat-nick="${escapeHtml(m.nick)}" title="Silenciar">🔇</button>` : ''}
                    ${canMod ? `<button type="button" class="admin-chat-mini-btn" data-admin-chat-act="ban" data-admin-chat-nick="${escapeHtml(m.nick)}" title="Banear">🚫</button>` : ''}
                  </div>
                </div>
              `;
            }).join('')
          : '<p class="admin-help-text">Sin mensajes recientes en el canal.</p>';
      }

      if (DOM.chatAdminBansList) {
        const mutes = (data.mutedNicks || []).map(m => `
          <div class="admin-chat-mod-row">
            <div class="admin-chat-mod-text">
              <strong>🔇 ${escapeHtml(m.nick)}</strong> · <small>${escapeHtml(m.reason || 'Silenciado')}</small>
            </div>
            <button type="button" class="admin-chat-mini-btn" data-admin-chat-unmute="${escapeHtml(m.nick)}">✅ Quitar</button>
          </div>
        `);
        const bans = (data.bannedEntries || []).map(b => `
          <div class="admin-chat-mod-row">
            <div class="admin-chat-mod-text">
              <strong>🚫 ${escapeHtml(b.nick || b.ip || 'usuario')}</strong> · <small>${escapeHtml(b.reason || 'Baneado')}</small>
            </div>
            <button type="button" class="admin-chat-mini-btn" data-admin-chat-unban="${escapeHtml(b.id)}" data-admin-chat-nick="${escapeHtml(b.nick || '')}">✅ Desbanear</button>
          </div>
        `);
        const combined = [...bans, ...mutes];
        DOM.chatAdminBansList.innerHTML = combined.length
          ? combined.join('')
          : '<p class="admin-help-text">Sin silenciados ni baneados actualmente.</p>';
      }
    } catch (err) {
      showToast('No se pudo cargar la moderación del chat IRC.', 'error');
    }
  }

  async function handleSaveChatAdminConfig() {
    if (!state.serverMode || !state.currentUser || state.currentUser.role !== 'admin') return;
    try {
      const res = await apiFetch('/api/admin/chat/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: DOM.chatAdminEnabledToggle ? DOM.chatAdminEnabledToggle.checked : true,
          allowGuests: DOM.chatAdminAllowGuestsToggle ? DOM.chatAdminAllowGuestsToggle.checked : true,
          moderatedMode: DOM.chatAdminModeratedToggle ? DOM.chatAdminModeratedToggle.checked : false,
          channel: DOM.chatAdminChannelInput ? DOM.chatAdminChannelInput.value.trim() : '#cyberpolis',
          theme: DOM.chatAdminThemeSelect ? DOM.chatAdminThemeSelect.value : 'mirc-classic',
          topic: DOM.chatAdminTopicInput ? DOM.chatAdminTopicInput.value.trim() : ''
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'No se pudo guardar la configuración IRC.', 'error');
        return;
      }
      if (data.config) applyChatPayload(data.config);
      showToast('Configuración del chat IRC guardada y aplicada en vivo.');
      loadAdminChatModeration();
    } catch (err) {
      showToast('Error guardando ajustes del chat IRC.', 'error');
    }
  }

  async function handleAdminChatAction(action, nick = '', reason = '', text = '', id = '') {
    if (!state.serverMode || !state.currentUser || state.currentUser.role !== 'admin') return false;
    try {
      const res = await apiFetch('/api/admin/chat/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, nick, reason, text, id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Acción de moderación fallida.', 'error');
        return false;
      }
      if (data.chat) applyChatPayload(data.chat);
      await loadChatStateFallback();
      if (DOM.adminChatSection && DOM.adminChatSection.style.display === 'block') {
        loadAdminChatModeration();
      }
      showToast('Moderación IRC ejecutada.');
      return true;
    } catch (err) {
      showToast('Error al ejecutar moderación IRC.', 'error');
      return false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
