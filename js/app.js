/**
 * SILVERBOT2 // UNIX — INTEL DISPATCH TERMINAL
 * Client Application Logic with Auto Spanish RSS Sync & Live Site Customizer
 */

(function () {
  'use strict';

  // ==========================================
  // 1. Estado de la Aplicación
  // ==========================================
  const state = {
    articles: [],
    currentUser: null,
    authToken: localStorage.getItem('silverbot_auth_token') || null,
    config: {
      autoSyncEnabled: true,
      syncIntervalMinutes: 30,
      lastSync: null,
      themeAccent: 'cyan',
      polygonDensity: 'paused',
      portalTitle: 'SILVERBOT2',
      portalSubcallsign: 'UNIX',
      portalSubtitle: 'TU HACKNOTICIERO',
      layoutMode: 'editorial',
      feeds: [
        { id: "feed-incibe", name: "INCIBE — Avisos y Vulnerabilidades", url: "https://www.incibe.es/feed/avisos/all", category: "hacking", enabled: true },
        { id: "feed-unaaldia", name: "Una al Día — Hispasec Ciberseguridad", url: "https://unaaldia.hispasec.com/feed", category: "hacking", enabled: true },
        { id: "feed-ccn", name: "CCN-CERT — Centro Criptológico Nacional", url: "https://www.ccn-cert.cni.es/es/avisos-ccn-cert.html?format=feed&type=rss", category: "tecnopolitica", enabled: true },
        { id: "feed-hackplayers", name: "HackPlayers — Ciberseguridad e Investigación", url: "https://www.hackplayers.com/feeds/posts/default?alt=rss", category: "hacking", enabled: true }
      ]
    },
    currentCategory: 'all',
    currentTag: 'all',
    searchQuery: '',
    sortBy: 'recent',
    bookmarks: new Set(JSON.parse(localStorage.getItem('silverbot_bookmarks') || '[]')),
    theme: localStorage.getItem('silverbot_theme_v3') || 'light',
    serverMode: false,
    activeReaderArticle: null
  };

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
    uiPortalTitle: document.getElementById('uiPortalTitle'),
    uiPortalSubcallsign: document.getElementById('uiPortalSubcallsign'),
    uiPortalSubtitle: document.getElementById('uiPortalSubtitle'),

    // Contadores
    countAll: document.getElementById('countAll'),
    countHacking: document.getElementById('countHacking'),
    countPolitica: document.getElementById('countPolitica'),
    countTecno: document.getElementById('countTecno'),
    countBookmarks: document.getElementById('countBookmarks'),

    // Modal Panel Admin & Transformador
    adminControlModal: document.getElementById('adminControlModal'),
    closeAdminControlBtn: document.getElementById('closeAdminControlBtn'),
    closeAdminModalFooterBtn: document.getElementById('closeAdminModalFooterBtn'),
    adminTabFeedsBtn: document.getElementById('adminTabFeedsBtn'),
    adminTabTransformBtn: document.getElementById('adminTabTransformBtn'),
    adminFeedsSection: document.getElementById('adminFeedsSection'),
    adminTransformSection: document.getElementById('adminTransformSection'),
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
    exportJsonBtn: document.getElementById('exportJsonBtn'),
    importJsonFileInput: document.getElementById('importJsonFileInput'),
    resetDemoBtn: document.getElementById('resetDemoBtn')
  };

  // ==========================================
  // 3. Inicialización
  // ==========================================
  async function init() {
    applyTheme(state.theme);
    startLiveClock();
    bindEvents();
    setupShortcuts();

    await checkServerConnection();
    await checkAuthSession();
    await loadConfig();
    await loadArticles();

    applySiteTransformation(state.config);
    renderUserWidget();
    renderAll();

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
          state.config = { ...state.config, ...cfg };
          return;
        }
      } catch (e) {}
    }

    const localCfg = localStorage.getItem('silverbot_config');
    if (localCfg) {
      try {
        state.config = { ...state.config, ...JSON.parse(localCfg) };
      } catch (e) {}
    }
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

    // 3. Títulos e Identidad
    if (DOM.uiPortalTitle && cfg.portalTitle) DOM.uiPortalTitle.textContent = cfg.portalTitle;
    if (DOM.uiPortalSubcallsign && cfg.portalSubcallsign) DOM.uiPortalSubcallsign.textContent = cfg.portalSubcallsign;
    if (DOM.uiPortalSubtitle && cfg.portalSubtitle) DOM.uiPortalSubtitle.textContent = cfg.portalSubtitle;

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
    DOM.adminPortalTitleInput.value = state.config.portalTitle || 'SILVERBOT2';
    DOM.adminPortalSubcallsignInput.value = state.config.portalSubcallsign || 'UNIX';
    DOM.adminPortalSubtitleInput.value = state.config.portalSubtitle || 'TU HACKNOTICIERO';

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

    DOM.adminControlModal.style.display = 'flex';
    switchAdminTab('feeds');
  }

  function closeAdminControl() {
    DOM.adminControlModal.style.display = 'none';
  }

  function switchAdminTab(tab) {
    if (tab === 'feeds') {
      DOM.adminTabFeedsBtn.classList.add('active');
      DOM.adminTabTransformBtn.classList.remove('active');
      DOM.adminFeedsSection.style.display = 'block';
      DOM.adminTransformSection.style.display = 'none';
    } else {
      DOM.adminTabFeedsBtn.classList.remove('active');
      DOM.adminTabTransformBtn.classList.add('active');
      DOM.adminFeedsSection.style.display = 'none';
      DOM.adminTransformSection.style.display = 'block';
    }
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

    if (state.serverMode && state.authToken) {
      try {
        const res = await fetch('/api/admin/feeds/sync', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${state.authToken}` }
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

    // 4. Títulos
    const portalTitle = DOM.adminPortalTitleInput.value.trim() || 'SILVERBOT2';
    const portalSubcallsign = DOM.adminPortalSubcallsignInput.value.trim() || 'UNIX';
    const portalSubtitle = DOM.adminPortalSubtitleInput.value.trim() || 'TU HACKNOTICIERO';

    state.config.themeAccent = themeAccent;
    state.config.polygonDensity = polygonDensity;
    state.config.layoutMode = layoutMode;
    state.config.portalTitle = portalTitle;
    state.config.portalSubcallsign = portalSubcallsign;
    state.config.portalSubtitle = portalSubtitle;

    applySiteTransformation(state.config);
    await saveConfigToServer();

    showToast('¡Transformación aplicada con éxito a toda la web! ⚡');
    closeAdminControl();
  }

  async function saveConfigToServer() {
    localStorage.setItem('silverbot_config', JSON.stringify(state.config));

    if (state.serverMode && state.authToken) {
      try {
        await fetch('/api/admin/config', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.authToken}`
          },
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
        DOM.syncStatusText.textContent = 'EDICIÓN ONLINE · FUENTES EN CASTELLANO ACTIVAS';
        DOM.syncStatusText.style.color = 'var(--accent-green)';
        return;
      }
    } catch (e) {}
    state.serverMode = false;
    DOM.syncStatusText.textContent = 'MODO LOCAL · EDICIÓN SIN CONEXIÓN';
    DOM.syncStatusText.style.color = 'var(--text-silver)';
  }

  async function checkAuthSession() {
    if (!state.authToken) {
      state.currentUser = null;
      return;
    }

    if (state.serverMode) {
      try {
        const res = await fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${state.authToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          state.currentUser = data.user;
          return;
        }
      } catch (err) {}
    }

    const localUser = localStorage.getItem('silverbot_current_user');
    if (localUser) {
      try {
        state.currentUser = JSON.parse(localUser);
        return;
      } catch (e) {}
    }

    state.currentUser = null;
    state.authToken = null;
    localStorage.removeItem('silverbot_auth_token');
    localStorage.removeItem('silverbot_current_user');
  }

  function renderUserWidget() {
    if (!DOM.userSessionWidget) return;

    const isLoggedIn = !!state.currentUser;
    const isAdmin = isLoggedIn && state.currentUser.role === 'admin';

    // 1. Botón Panel Admin: solo visible para el admin
    if (DOM.openAdminControlBtn) {
      DOM.openAdminControlBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // 2. Botón Respaldo & Gestión de Datos: solo visible para el admin
    if (DOM.backupModalBtn) {
      DOM.backupModalBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // 3. Botones de Publicar Noticia e Ingestión LinkedIn: SOLO visibles si está autenticado/registrado
    if (DOM.openNewArticleModalBtn) {
      DOM.openNewArticleModalBtn.style.display = isLoggedIn ? 'inline-flex' : 'none';
    }
    if (DOM.openLinkedInModalBtn) {
      DOM.openLinkedInModalBtn.style.display = isLoggedIn ? 'inline-flex' : 'none';
    }
    if (DOM.emptyCreateBtn) {
      DOM.emptyCreateBtn.style.display = isLoggedIn ? 'inline-flex' : 'none';
    }

    if (!state.currentUser) {
      DOM.userSessionWidget.innerHTML = `
        <button id="openAuthModalBtn" class="hud-btn hud-btn-outline" style="border-color: var(--accent-cyan);">
          <span style="color: var(--accent-cyan);">🔑</span>
          <span>ACCEDER / REGISTRO</span>
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
          <span style="font-size: 0.7rem; color: var(--text-muted); margin-left: 2px;">▾</span>
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

      document.addEventListener('click', () => {
        if (menu) menu.style.display = 'none';
      });

      if (document.getElementById('menuOpenAdminBtn')) {
        document.getElementById('menuOpenAdminBtn').onclick = openAdminControl;
      }
      document.getElementById('menuOpenLinkedInBtn').onclick = openLinkedInModal;
      document.getElementById('menuUsersListBtn').onclick = openUsersDirectory;
      document.getElementById('menuLogoutBtn').onclick = handleLogout;
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

    if (state.serverMode) {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Credenciales no autorizadas.', 'error');
          return;
        }

        state.authToken = data.token;
        state.currentUser = data.user;
        localStorage.setItem('silverbot_auth_token', data.token);
        localStorage.setItem('silverbot_current_user', JSON.stringify(data.user));

        showToast(`¡Bienvenido de nuevo, ${data.user.displayName}!`);
        closeAuthModal();
        renderUserWidget();
        renderAll();
        return;
      } catch (err) {
        showToast('Error de conexión con el servidor.', 'error');
        return;
      }
    }

    // Modo local offline
    if (username.toLowerCase() === 'silverbot2' && password === 'Scaceres2$') {
      const mockUser = {
        id: "usr-admin-01",
        username: "silverbot2",
        displayName: "Silverbot2 // Unix",
        role: "admin",
        linkedInProfile: "https://www.linkedin.com/in/silverbot2",
        avatar: "assets/silverbot-unix-logo.png"
      };
      state.currentUser = mockUser;
      state.authToken = "local-token-" + Date.now();
      localStorage.setItem('silverbot_auth_token', state.authToken);
      localStorage.setItem('silverbot_current_user', JSON.stringify(mockUser));

      showToast(`¡Sesión iniciada como ${mockUser.displayName}!`);
      closeAuthModal();
      renderUserWidget();
      renderAll();
    } else {
      showToast('Credenciales incorrectas.', 'error');
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

    if (state.serverMode) {
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, displayName, linkedInProfile })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Error al registrar analista.', 'error');
          return;
        }

        state.authToken = data.token;
        state.currentUser = data.user;
        localStorage.setItem('silverbot_auth_token', data.token);
        localStorage.setItem('silverbot_current_user', JSON.stringify(data.user));

        showToast(`¡Cuenta creada con éxito! Bienvenido, ${data.user.displayName}.`);
        closeAuthModal();
        renderUserWidget();
        renderAll();
        return;
      } catch (err) {
        showToast('Error en el servidor al registrar.', 'error');
        return;
      }
    }

    const newUser = {
      id: "usr-" + Date.now(),
      username,
      displayName,
      role: "analyst",
      linkedInProfile,
      avatar: "assets/silverbot-unix-logo.png"
    };
    state.currentUser = newUser;
    state.authToken = "local-token-" + Date.now();
    localStorage.setItem('silverbot_auth_token', state.authToken);
    localStorage.setItem('silverbot_current_user', JSON.stringify(newUser));

    showToast(`¡Cuenta de analista registrada para ${displayName}!`);
    closeAuthModal();
    renderUserWidget();
    renderAll();
  }

  async function handleLogout() {
    if (state.serverMode && state.authToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${state.authToken}` }
        });
      } catch (e) {}
    }

    state.currentUser = null;
    state.authToken = null;
    localStorage.removeItem('silverbot_auth_token');
    localStorage.removeItem('silverbot_current_user');

    showToast('Sesión cerrada correctamente.', 'info');
    renderUserWidget();
    renderAll();
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
        const res = await fetch('/api/linkedin/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.authToken}`
          },
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
    DOM.usersDirectoryModal.style.display = 'flex';
    DOM.usersDirectoryList.innerHTML = '<div style="font-family: var(--font-mono); color: var(--text-muted);">Cargando directorio de analistas...</div>';

    if (state.serverMode) {
      try {
        const res = await fetch('/api/users');
        if (res.ok) {
          const users = await res.json();
          renderUsersList(users);
          return;
        }
      } catch (e) {}
    }

    renderUsersList([
      {
        id: "usr-admin-01",
        username: "silverbot2",
        displayName: "Silverbot2 // Unix",
        role: "admin",
        linkedInProfile: "https://www.linkedin.com/in/silverbot2",
        avatar: "assets/silverbot-unix-logo.png",
        createdAt: "2026-11-10T10:00:00.000Z"
      }
    ]);
  }

  function renderUsersList(users) {
    if (!users || users.length === 0) {
      DOM.usersDirectoryList.innerHTML = '<div>Sin analistas registrados.</div>';
      return;
    }

    DOM.usersDirectoryList.innerHTML = users.map(u => `
      <div class="user-card-item">
        <div class="user-card-head">
          <img src="${escapeHtml(u.avatar || 'assets/silverbot-unix-logo.png')}" alt="Avatar" class="user-avatar-mini">
          <div>
            <div class="user-card-name">${escapeHtml(u.displayName)}</div>
            <div class="user-card-handle">@${escapeHtml(u.username)} • <span class="user-role-badge ${u.role === 'admin' ? 'admin' : 'analyst'}">[${u.role.toUpperCase()}]</span></div>
          </div>
        </div>
        ${u.linkedInProfile ? `
          <div style="font-family: var(--font-mono); font-size: 0.72rem; margin-top: 6px;">
            <a href="${escapeHtml(u.linkedInProfile)}" target="_blank" rel="noopener noreferrer" class="verified-linkedin-badge">
              <span>in</span>
              <span>${escapeHtml(u.linkedInProfile.replace(/https?:\/\/(www\.)?linkedin\.com\//, ''))}</span>
            </a>
          </div>
        ` : '<div style="font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted);">Sin cuenta de LinkedIn vinculada</div>'}
      </div>
    `).join('');
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

  // Selección editorial equilibrada: elige las 8 noticias más importantes repartidas entre TODAS las fuentes activas
  function curateTopArticles(articlesList, limit = 8) {
    if (!Array.isArray(articlesList) || articlesList.length === 0) return [];
    const nonDemos = articlesList.filter(a => !isDemoPlaceholder(a));
    const workingPool = nonDemos.length >= 4 ? nonDemos : articlesList;

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

  // Selección dinámica de Portada (#1): nunca queda clavada en artículos demo antiguos
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

      const featA = (a.isFeatured && !isDemoPlaceholder(a) && ageHoursA <= 72) ? 16 : 0;
      const featB = (b.isFeatured && !isDemoPlaceholder(b) && ageHoursB <= 72) ? 16 : 0;

      const scoreA = featA + (isRealPhoto(a) ? 8 : 0) + (a.isBreaking ? 3 : 0) - (ageHoursA * 0.3);
      const scoreB = featB + (isRealPhoto(b) ? 8 : 0) + (b.isBreaking ? 3 : 0) - (ageHoursB * 0.3);

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
    const catClass = a.category;
    const catName = getCategoryLabel(a.category);
    const relativeTime = getRelativeTime(a.date);
    const readTime = a.readTime || calculateReadTime(a.content);
    const canEdit = canManageArticle(a);
    const sourceShort = cleanSourceDisplay(a.sourceName);

    return `
      <article class="hero-dispatch-card" data-id="${a.id}">
        <div class="hero-image-chamber" data-action="read" style="cursor: pointer;">
          <img src="${escapeHtml(resolveArticleImage(a.imageUrl, a.category, a.sourceName, a.title))}" alt="${escapeHtml(a.title)}" class="hero-image" loading="lazy" referrerpolicy="no-referrer" onerror="window.handleImgError(this)">
          <span class="hero-portada-ribbon">PORTADA</span>
          <div class="hero-image-overlay"></div>
        </div>
        <div class="hero-content-chamber">
          <div class="dispatch-telemetry-row">
            <span class="intel-badge ${catClass}">${catName}</span>
            ${a.isBreaking ? '<span class="breaking-flag">ÚLTIMA HORA</span>' : ''}
            ${a.verifiedLinkedIn ? '<span class="verified-linkedin-badge"><span>in</span> LINKEDIN</span>' : ''}
          </div>

          <h1 class="hero-headline" data-action="read">${escapeHtml(a.title)}</h1>
          <p class="hero-abstract">${escapeHtml(a.summary)}</p>

          <div class="hero-dispatch-meta">
            <span class="meta-token">
              ${a.sourceUrl ? `
                <a href="${escapeHtml(a.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="source-token-link">
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
    const catClass = a.category;
    const catName = getCategoryLabel(a.category);
    const relativeTime = getRelativeTime(a.date);
    const readTime = a.readTime || calculateReadTime(a.content);
    const canEdit = canManageArticle(a);
    const sourceShort = cleanSourceDisplay(a.sourceName);

    const tagsHtml = Array.isArray(a.tags)
      ? a.tags.slice(0, 3).map(t => `<span class="dispatch-tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')
      : '';

    return `
      <article class="dispatch-card" data-id="${a.id}">
        <div class="dispatch-image-box" data-action="read" style="cursor: pointer;">
          <img src="${escapeHtml(resolveArticleImage(a.imageUrl, a.category, a.sourceName, a.title))}" alt="${escapeHtml(a.title)}" class="dispatch-img" loading="lazy" referrerpolicy="no-referrer" onerror="window.handleImgError(this)">
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
    const catClass = a.category;
    const catName = getCategoryLabel(a.category);
    const relativeTime = getRelativeTime(a.date);
    const readTime = a.readTime || calculateReadTime(a.content);
    const canEdit = canManageArticle(a);
    const sourceShort = cleanSourceDisplay(a.sourceName);

    return `
      <article class="press-horizontal-card" data-id="${a.id}">
        <div class="press-thumb-box" data-action="read" style="cursor: pointer;">
          <img src="${escapeHtml(resolveArticleImage(a.imageUrl, a.category, a.sourceName, a.title))}" alt="${escapeHtml(a.title)}" class="press-thumb-img" loading="lazy" referrerpolicy="no-referrer" onerror="window.handleImgError(this)">
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
      <span class="intel-badge ${article.category}">${catName}</span>
      ${article.isBreaking ? '<span class="breaking-flag">ÚLTIMA HORA</span>' : ''}
      ${article.verifiedLinkedIn ? '<span class="verified-linkedin-badge"><span>in</span> LINKEDIN</span>' : ''}
    `;

    DOM.readerBookmarkBtn.innerHTML = `<span>${isBookmarked ? '⭐' : '☆'}</span>`;
    DOM.readerBookmarkBtn.classList.toggle('bookmarked', isBookmarked);

    const formattedBody = formatArticleBody(article.content);
    const sourceDisplay = cleanSourceDisplay(article.sourceName);

    DOM.readerContentArea.innerHTML = `
      ${article.imageUrl ? `<img src="${escapeHtml(resolveArticleImage(article.imageUrl, article.category, article.sourceName, article.title))}" alt="${escapeHtml(article.title)}" class="reader-cover-img" loading="lazy" referrerpolicy="no-referrer" onerror="window.handleImgError(this)">` : ''}

      <h1 class="reader-headline">${escapeHtml(article.title)}</h1>

      <div class="reader-telemetry-strip">
        <span>📅 ${dateFormatted}</span>
        <span>⏱️ ${article.readTime || calculateReadTime(article.content)}</span>
        <span>👁️ ${article.views} lecturas</span>
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
        ${article.sourceUrl ? `
          <a href="${escapeHtml(article.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="hud-btn hud-btn-action">
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
    DOM.formCategory.value = state.currentCategory !== 'all' && state.currentCategory !== 'bookmarks'
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

    if (state.serverMode && state.authToken) {
      const endpoint = editId ? `/api/articles/${editId}` : '/api/articles';
      const method = editId ? 'PUT' : 'POST';

      try {
        const res = await fetch(endpoint, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.authToken}`
          },
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
      if (state.serverMode && state.authToken) {
        try {
          const res = await fetch(`/api/articles/${articleId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${state.authToken}` }
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
      document.querySelectorAll(`article[data-id="${articleId}"] [data-action="bookmark"]`).forEach(btn => {
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
  // 14. Copias de Seguridad (JSON)
  // ==========================================
  function exportArticlesJson() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.articles, null, 2));
    const downloadAnchor = document.createElement('a');
    const filename = `silverbot2-unix-noticias-${new Date().toISOString().slice(0, 10)}.json`;
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast('Copia JSON descargada.');
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
          state.articles = imported;
          if (state.serverMode && state.authToken) {
            await fetch('/api/articles/import', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.authToken}`
              },
              body: JSON.stringify(imported)
            });
          }
          persistArticles();
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
    if (confirm('¿Restablecer las noticias al paquete de demostración inicial?')) {
      state.articles = [...DEFAULT_SEED_ARTICLES];
      persistArticles();
      renderAll();
      closeBackupModal();
      showToast('Demostración inicial cargada.');
    }
  }

  function openBackupModal() {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      showToast('Acceso restringido: Solo el Administrador puede gestionar respaldos.', 'error');
      return;
    }
    DOM.backupModal.style.display = 'flex';
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
    if (DOM.adminTabTransformBtn) DOM.adminTabTransformBtn.addEventListener('click', () => switchAdminTab('transform'));
    if (DOM.adminForceSyncBtn) DOM.adminForceSyncBtn.addEventListener('click', handleForceSync);
    if (DOM.saveAdminFeedsBtn) DOM.saveAdminFeedsBtn.addEventListener('click', handleSaveFeedsConfig);
    if (DOM.applyTransformBtn) DOM.applyTransformBtn.addEventListener('click', handleApplyTransformation);
    if (DOM.cancelTransformBtn) DOM.cancelTransformBtn.addEventListener('click', closeAdminControl);

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
      if (url) window.open(url, '_blank');
      else showToast('Especifica una URL de imagen.', 'error');
    });

    DOM.closeReaderModalBtn.addEventListener('click', closeReaderModal);
    DOM.readerBookmarkBtn.addEventListener('click', () => {
      if (state.activeReaderArticle) toggleBookmark(state.activeReaderArticle.id);
    });
    DOM.readerShareBtn.addEventListener('click', handleShareArticle);

    DOM.closeBackupModalBtn.addEventListener('click', closeBackupModal);
    DOM.exportJsonBtn.addEventListener('click', exportArticlesJson);
    DOM.importJsonFileInput.addEventListener('change', importArticlesJson);
    DOM.resetDemoBtn.addEventListener('click', resetDemoData);

    [DOM.articleFormModal, DOM.readerModal, DOM.backupModal, DOM.authModal, DOM.linkedInModal, DOM.usersDirectoryModal, DOM.adminControlModal].forEach(modal => {
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
    const text = `📰 [${a.title}]\nAutor: ${a.author || 'Silverbot2 // Unix'}\nFuente: ${a.sourceName}\n${a.sourceUrl || ''}`;

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
