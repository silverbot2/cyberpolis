// Capa de Persistencia Unificada para CYBERPOLIS
// Soporta:
//   1. PostgreSQL (DATABASE_URL) — Recomendado en producción (Neon / Supabase / Render PG / Railway)
//   2. Disco Persistente (DATA_DIR distinto de ./data) — ej. Render Persistent Disk /var/data
//   3. Gist Privado de GitHub (PERSIST_GIST_ID + PERSIST_GH_TOKEN) — Persistencia gratuita usando GitHub
//   4. Almacenamiento JSON local (./data) — Desarrollo local / respaldo efímero

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudOneDrive = require('./cloudOneDrive');
const cloudGoogle = require('./cloudGoogle');

const SEED_DATA_DIR = path.join(__dirname, 'data');

const STORE_DEFS = {
  articles: { filename: 'articles.json', fallback: [] },
  users: { filename: 'users.json', fallback: [] },
  sessions: { filename: 'sessions.json', fallback: [] },
  config: { filename: 'config.json', fallback: {} },
  forum: { filename: 'forum.json', fallback: [] },
  analytics: { filename: 'analytics.json', fallback: { totalViews: 0, dailyStats: {}, visitors: [] } },
  audit: { filename: 'audit.json', fallback: [] },
  transfers: { filename: 'transfers.json', fallback: [] },
  cloud: { filename: 'cloud.json', fallback: { tenants: [], backupHistory: [] } },
  chat: {
    filename: 'chat.json',
    fallback: {
      channel: '#cyberpolis',
      topic: 'Bienvenidos a #cyberpolis — Hacknoticiero & Chat IRC en vivo',
      enabled: true,
      allowGuests: true,
      moderatedMode: false,
      theme: 'mirc-classic',
      messages: [],
      opNicks: [],
      voiceNicks: [],
      mutedNicks: [],
      bannedEntries: []
    }
  }
};

const STORE_KEYS = Object.keys(STORE_DEFS);

function cloneValue(val) {
  if (val === undefined) return undefined;
  return JSON.parse(JSON.stringify(val));
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return cloneValue(fallback);
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return cloneValue(fallback);
    return JSON.parse(raw);
  } catch (err) {
    return cloneValue(fallback);
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function encryptSnapshotIfConfigured(jsonStr, secret) {
  if (!secret) return jsonStr;
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(jsonStr, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    encrypted: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    payload: enc.toString('base64')
  });
}

function decryptSnapshotIfNeeded(rawStr, secret) {
  const parsed = JSON.parse(rawStr);
  if (parsed && parsed.encrypted === 'aes-256-gcm') {
    if (!secret) {
      throw new Error('Los datos remotos están cifrados pero falta PERSIST_SECRET.');
    }
    const key = crypto.createHash('sha256').update(String(secret)).digest();
    const iv = Buffer.from(parsed.iv, 'base64');
    const tag = Buffer.from(parsed.tag, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(Buffer.from(parsed.payload, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf-8'));
  }
  return parsed;
}

class CyberpolisStore {
  constructor(options = {}) {
    this.options = options;
    this.seedDir = options.seedDir || SEED_DATA_DIR;
    this.dataDir = options.dataDir || (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : this.seedDir);
    this.databaseUrl = options.databaseUrl !== undefined ? options.databaseUrl : (process.env.DATABASE_URL || '').trim();
    this.gistId = options.gistId !== undefined ? options.gistId : (process.env.PERSIST_GIST_ID || '').trim();
    this.ghToken = options.ghToken !== undefined ? options.ghToken : (process.env.PERSIST_GH_TOKEN || '').trim();
    this.persistSecret = options.persistSecret !== undefined ? options.persistSecret : (process.env.PERSIST_SECRET || '').trim();

    this.mode = 'ephemeral';
    this.pool = null;
    this.cache = new Map();
    this.dirtyKeys = new Set();
    this.pgInFlight = new Map();
    this.pgDirty = new Set();
    this.gistTimer = null;
    this.gistFlushPromise = null;
    this.lastRemoteSyncAt = null;
    this.lastError = null;
    this.initialized = false;
  }

  getFilePath(key) {
    const def = STORE_DEFS[key];
    if (!def) throw new Error(`Clave de almacenamiento desconocida: ${key}`);
    return path.join(this.dataDir, def.filename);
  }

  ensureLocalDirectoriesAndSeedFiles() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    for (const key of STORE_KEYS) {
      const def = STORE_DEFS[key];
      const targetPath = this.getFilePath(key);
      if (!fs.existsSync(targetPath)) {
        const seedPath = path.join(this.seedDir, def.filename);
        const seedData = readJsonSafe(seedPath, def.fallback);
        writeJsonAtomic(targetPath, seedData);
      }
      this.cache.set(key, readJsonSafe(targetPath, def.fallback));
    }
  }

  async init() {
    if (this.initialized) return;
    this.ensureLocalDirectoriesAndSeedFiles();

    if (this.databaseUrl) {
      this.mode = 'postgres';
      await this.initPostgres();
    } else if (this.gistId && this.ghToken) {
      this.mode = 'github-gist';
      await this.initGist();
    } else if (this.getActiveOneDriveTenant()) {
      const activeCloud = this.getActiveOneDriveTenant();
      this.mode = activeCloud.providerType === 'google-drive' ? 'google-drive' : 'onedrive';
      await this.initOneDrive();
    } else if (path.resolve(this.dataDir) !== path.resolve(this.seedDir) || process.env.PERSISTENT_DISK === 'true') {
      this.mode = 'persistent-disk';
      this.lastRemoteSyncAt = new Date().toISOString();
    } else {
      this.mode = 'ephemeral';
    }

    this.initialized = true;
  }

  getActiveOneDriveTenant() {
    const cloudState = this.cache.get('cloud') || { tenants: [] };
    const resolved = cloudOneDrive.resolveActiveTenantConfig(cloudState);
    if (!resolved) return null;
    if (resolved.fromEnv || resolved.isDefaultForBackup) return resolved;
    return null;
  }

  getOneDriveCryptoSecret() {
    return this.persistSecret || process.env.SESSION_SECRET || 'cyberpolis-onedrive-backup-v8';
  }

  async initOneDrive() {
    const activeCloud = this.getActiveOneDriveTenant();
    const label = activeCloud && activeCloud.providerType === 'google-drive'
      ? 'Google Drive (5 TB)'
      : 'Microsoft OneDrive (5 TB)';
    try {
      const result = await this.restoreFromOneDriveSnapshot();
      if (!result.restored) {
        await this.pushOneDriveSnapshot();
      }
      this.lastRemoteSyncAt = new Date().toISOString();
      this.lastError = null;
      console.log(`☁️ Persistencia ${label} conectada y restaurada.`);
    } catch (err) {
      this.lastError = `${label} error: ${err.message}`;
      console.error(`⚠️ Error conectando ${label} (usando caché local):`, err.message);
    }
  }

  uploadSnapshotBufferToProvider(tenantCfg, relPath, buf, mime, fetchFn) {
    if (tenantCfg && tenantCfg.providerType === 'google-drive') {
      return cloudGoogle.uploadBufferToGoogleDrive(tenantCfg, relPath, buf, mime, fetchFn);
    }
    return cloudOneDrive.uploadBufferToOneDrive(tenantCfg, relPath, buf, mime, fetchFn);
  }

  downloadSnapshotBufferFromProvider(tenantCfg, relPath, fetchFn) {
    if (tenantCfg && tenantCfg.providerType === 'google-drive') {
      return cloudGoogle.downloadBufferFromGoogleDrive(tenantCfg, relPath, fetchFn);
    }
    return cloudOneDrive.downloadBufferFromOneDrive(tenantCfg, relPath, fetchFn);
  }

  async pushOneDriveSnapshot(tenantOverride = null) {
    if (this.oneDriveFlushPromise) {
      this.oneDriveDirtyDuringFlush = true;
      return this.oneDriveFlushPromise;
    }
    const tenantCfg = tenantOverride || this.getActiveOneDriveTenant();
    if (!tenantCfg) {
      throw new Error('No hay ninguna Nube (OneDrive o Google Drive) configurada.');
    }
    this.oneDriveFlushPromise = (async () => {
      let lastUpload = null;
      try {
        const fetchFn = this.options.fetch || fetch;
        do {
          this.oneDriveDirtyDuringFlush = false;
          const activeTenant = tenantOverride || this.getActiveOneDriveTenant() || tenantCfg;
          const payloadObj = {};
          for (const key of STORE_KEYS) {
            payloadObj[key] = this.cache.get(key);
          }
          const encryptedStr = encryptSnapshotIfConfigured(JSON.stringify(payloadObj), this.getOneDriveCryptoSecret());
          const buf = Buffer.from(encryptedStr, 'utf8');
          lastUpload = await this.uploadSnapshotBufferToProvider(
            activeTenant,
            'backups/cyberpolis-latest.enc.json',
            buf,
            'application/json',
            fetchFn
          );
          const dayKey = new Date().toISOString().slice(0, 10);
          if (this.lastDailyOneDriveDay !== dayKey) {
            this.lastDailyOneDriveDay = dayKey;
            await this.uploadSnapshotBufferToProvider(
              activeTenant,
              `backups/cyberpolis-${dayKey}.enc.json`,
              buf,
              'application/json',
              fetchFn
            ).catch(() => {});
          }
          this.lastRemoteSyncAt = new Date().toISOString();
          this.lastError = null;
        } while (this.oneDriveDirtyDuringFlush);
        return lastUpload;
      } catch (err) {
        this.lastError = `Cloud write: ${err.message}`;
        console.error('Error sincronizando backup Cloud:', err.message);
        throw err;
      } finally {
        this.oneDriveFlushPromise = null;
      }
    })();
    return this.oneDriveFlushPromise;
  }

  async restoreFromOneDriveSnapshot(tenantOverride = null) {
    const tenantCfg = tenantOverride || this.getActiveOneDriveTenant();
    if (!tenantCfg) {
      throw new Error('No hay ninguna Nube (OneDrive o Google Drive) configurada.');
    }
    const fetchFn = this.options.fetch || fetch;
    const buf = await this.downloadSnapshotBufferFromProvider(
      tenantCfg,
      'backups/cyberpolis-latest.enc.json',
      fetchFn
    );
    if (!buf) {
      return { restored: false, keys: [] };
    }
    const snapshot = decryptSnapshotIfNeeded(buf.toString('utf8'), this.getOneDriveCryptoSecret());
    const restoredKeys = [];
    for (const key of STORE_KEYS) {
      if (snapshot[key] !== undefined) {
        this.cache.set(key, snapshot[key]);
        restoredKeys.push(key);
        try {
          writeJsonAtomic(this.getFilePath(key), snapshot[key]);
        } catch (e) {}
      }
    }
    this.lastRemoteSyncAt = new Date().toISOString();
    this.lastError = null;
    return { restored: true, keys: restoredKeys };
  }

  scheduleOneDriveSync(immediate = false) {
    const tenant = this.getActiveOneDriveTenant();
    if (!tenant || tenant.autoBackupEnabled === false) return;
    if (this.oneDriveTimer) {
      clearTimeout(this.oneDriveTimer);
      this.oneDriveTimer = null;
    }
    if (immediate) {
      this.pushOneDriveSnapshot(tenant).catch(() => {});
      return;
    }
    this.oneDriveTimer = setTimeout(() => {
      this.oneDriveTimer = null;
      this.pushOneDriveSnapshot(tenant).catch(() => {});
    }, 12000);
    if (typeof this.oneDriveTimer.unref === 'function') this.oneDriveTimer.unref();
  }

  async initPostgres() {
    try {
      const PoolClass = this.options.PgPool || require('pg').Pool;
      const lowerUrl = this.databaseUrl.toLowerCase();
      const disableSsl = lowerUrl.includes('sslmode=disable') || lowerUrl.includes('@localhost') || lowerUrl.includes('@127.0.0.1');
      this.pool = new PoolClass({
        connectionString: this.databaseUrl,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ssl: disableSsl ? false : { rejectUnauthorized: false }
      });

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS cyberpolis_store (
          store_key TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const { rows } = await this.pool.query('SELECT store_key, data FROM cyberpolis_store');
      const existing = new Map(rows.map(r => [r.store_key, r.data]));

      for (const key of STORE_KEYS) {
        if (existing.has(key)) {
          const val = existing.get(key);
          this.cache.set(key, val);
          try {
            writeJsonAtomic(this.getFilePath(key), val);
          } catch (e) {}
        } else {
          const seedVal = this.cache.get(key);
          await this.pool.query(
            `INSERT INTO cyberpolis_store (store_key, data, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (store_key) DO NOTHING`,
            [key, JSON.stringify(seedVal)]
          );
        }
      }

      this.lastRemoteSyncAt = new Date().toISOString();
      this.lastError = null;
      console.log('🗄️ Persistencia PostgreSQL conectada y sincronizada.');
    } catch (err) {
      this.lastError = `PostgreSQL error: ${err.message}`;
      console.error('⚠️ Error conectando PostgreSQL (usando caché local):', err.message);
    }
  }

  async initGist() {
    try {
      const fetchFn = this.options.fetch || fetch;
      const res = await fetchFn(`https://api.github.com/gists/${encodeURIComponent(this.gistId)}`, {
        headers: {
          'Authorization': `Bearer ${this.ghToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'CYBERPOLIS-Store'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const gist = await res.json();
      const file = gist.files && gist.files['cyberpolis-store.json'];
      if (file && file.content) {
        const snapshot = decryptSnapshotIfNeeded(file.content, this.persistSecret);
        for (const key of STORE_KEYS) {
          if (snapshot[key] !== undefined) {
            this.cache.set(key, snapshot[key]);
            try {
              writeJsonAtomic(this.getFilePath(key), snapshot[key]);
            } catch (e) {}
          }
        }
      } else {
        await this.pushGistSnapshot();
      }
      this.lastRemoteSyncAt = new Date().toISOString();
      this.lastError = null;
      console.log('☁️ Persistencia en GitHub Gist privado conectada y sincronizada.');
    } catch (err) {
      this.lastError = `GitHub Gist error: ${err.message}`;
      console.error('⚠️ Error sincronizando Gist privado (usando caché local):', err.message);
    }
  }

  read(key, fallback) {
    if (!STORE_DEFS[key]) throw new Error(`Clave desconocida: ${key}`);
    if (!this.cache.has(key)) {
      this.ensureLocalDirectoriesAndSeedFiles();
    }
    const val = this.cache.get(key);
    return val !== undefined ? val : cloneValue(fallback !== undefined ? fallback : STORE_DEFS[key].fallback);
  }

  write(key, data, opts = {}) {
    if (!STORE_DEFS[key]) throw new Error(`Clave desconocida: ${key}`);
    this.cache.set(key, data);

    try {
      writeJsonAtomic(this.getFilePath(key), data);
    } catch (err) {
      console.error('Error al escribir caché JSON local:', key, err.message);
      return false;
    }

    if (this.mode === 'postgres' && this.pool) {
      this.schedulePostgresUpsert(key);
      if (key !== 'analytics' && key !== 'sessions') this.scheduleOneDriveSync(false);
    } else if (this.mode === 'github-gist') {
      this.scheduleGistSync(!!opts.critical);
      if (key !== 'analytics' && key !== 'sessions') this.scheduleOneDriveSync(false);
    } else if (this.mode === 'onedrive' || this.getActiveOneDriveTenant()) {
      this.scheduleOneDriveSync(!!opts.critical);
    }
    return true;
  }

  schedulePostgresUpsert(key) {
    this.pgDirty.add(key);
    if (this.pgInFlight.has(key)) return;

    const runner = (async () => {
      while (this.pgDirty.has(key)) {
        this.pgDirty.delete(key);
        const snapshot = this.cache.get(key);
        try {
          await this.pool.query(
            `INSERT INTO cyberpolis_store (store_key, data, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (store_key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [key, JSON.stringify(snapshot)]
          );
          this.lastRemoteSyncAt = new Date().toISOString();
          this.lastError = null;
        } catch (err) {
          this.lastError = `PostgreSQL write (${key}): ${err.message}`;
          console.error(`Error escribiendo ${key} en PostgreSQL:`, err.message);
          break;
        }
      }
    })().finally(() => {
      this.pgInFlight.delete(key);
    });

    this.pgInFlight.set(key, runner);
  }

  scheduleGistSync(immediate = false) {
    if (this.gistTimer) {
      clearTimeout(this.gistTimer);
      this.gistTimer = null;
    }
    if (immediate) {
      this.pushGistSnapshot().catch(() => {});
      return;
    }
    this.gistTimer = setTimeout(() => {
      this.gistTimer = null;
      this.pushGistSnapshot().catch(() => {});
    }, 10000);
  }

  async pushGistSnapshot() {
    if (this.gistFlushPromise) return this.gistFlushPromise;
    this.gistFlushPromise = (async () => {
      try {
        const fetchFn = this.options.fetch || fetch;
        const payloadObj = {};
        for (const key of STORE_KEYS) {
          payloadObj[key] = this.cache.get(key);
        }
        const content = encryptSnapshotIfConfigured(JSON.stringify(payloadObj), this.persistSecret);
        const res = await fetchFn(`https://api.github.com/gists/${encodeURIComponent(this.gistId)}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${this.ghToken}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'CYBERPOLIS-Store'
          },
          body: JSON.stringify({
            files: {
              'cyberpolis-store.json': { content }
            }
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.lastRemoteSyncAt = new Date().toISOString();
        this.lastError = null;
      } catch (err) {
        this.lastError = `GitHub Gist write: ${err.message}`;
        console.error('Error sincronizando Gist privado:', err.message);
      } finally {
        this.gistFlushPromise = null;
      }
    })();
    return this.gistFlushPromise;
  }

  async flush() {
    if (this.mode === 'postgres' && this.pool) {
      const promises = [...this.pgInFlight.values()];
      await Promise.allSettled(promises);
    } else if (this.mode === 'github-gist') {
      if (this.gistTimer) {
        clearTimeout(this.gistTimer);
        this.gistTimer = null;
      }
      await this.pushGistSnapshot();
    } else if (this.mode === 'onedrive' || this.mode === 'google-drive') {
      if (this.oneDriveTimer) {
        clearTimeout(this.oneDriveTimer);
        this.oneDriveTimer = null;
      }
      await this.pushOneDriveSnapshot().catch(() => {});
    }
    if (this.oneDriveTimer) {
      clearTimeout(this.oneDriveTimer);
      this.oneDriveTimer = null;
      await this.pushOneDriveSnapshot().catch(() => {});
    }
  }

  async close() {
    await this.flush();
    if (this.pool && typeof this.pool.end === 'function') {
      await this.pool.end().catch(() => {});
    }
  }

  getStatus() {
    const persistent = this.mode !== 'ephemeral';
    const labels = {
      'postgres': 'PostgreSQL Externo (Persistente)',
      'persistent-disk': 'Disco Persistente (Montaje externo)',
      'github-gist': 'GitHub Gist Privado (Persistente)',
      'onedrive': 'Microsoft OneDrive 5 TB (Persistente Cifrado)',
      'google-drive': 'Google Drive 5 TB (Persistente Cifrado)',
      'ephemeral': 'Disco Efímero del Contenedor (Sin DB externa)'
    };
    const oneDriveTenant = this.getActiveOneDriveTenant();
    return {
      mode: this.mode,
      persistent,
      label: labels[this.mode] || this.mode,
      dataDir: this.mode === 'persistent-disk' ? this.dataDir : undefined,
      oneDriveLinked: !!oneDriveTenant,
      oneDriveTenantName: oneDriveTenant ? oneDriveTenant.name : null,
      cloudProviderType: oneDriveTenant ? (oneDriveTenant.providerType || 'onedrive') : null,
      lastRemoteSyncAt: this.lastRemoteSyncAt,
      lastError: this.lastError
    };
  }

  exportFullSnapshot() {
    return {
      version: 8,
      exportedAt: new Date().toISOString(),
      storageMode: this.mode,
      config: cloneValue(this.read('config', {})),
      users: cloneValue(this.read('users', [])),
      articles: cloneValue(this.read('articles', [])),
      forum: cloneValue(this.read('forum', [])),
      analytics: cloneValue(this.read('analytics', { totalViews: 0, dailyStats: {}, visitors: [] })),
      transfers: cloneValue(this.read('transfers', [])),
      chat: cloneValue(this.read('chat', STORE_DEFS.chat.fallback))
    };
  }
}

module.exports = {
  CyberpolisStore,
  STORE_KEYS,
  encryptSnapshotIfConfigured,
  decryptSnapshotIfNeeded
};
