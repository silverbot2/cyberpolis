# ⬡ SILVERBOT2 // UNIX — Intel Terminal, Auto-Feeds ES & Site Transformer

Terminal de ciberseguridad y geopolítica con **ingestión automática de fuentes de ciberseguridad en castellano (INCIBE, Hispasec, CCN-CERT)**, **autenticación criptográfica segura (Scrypt + RBAC)** y un **Panel de Control Admin para transformar la web en tiempo real**.

---

## ⚡ Cómo Abrir la Web al Instante (1 Solo Clic)

👉 **Haz doble clic en el acceso directo de tu Escritorio de Windows:**
**`CyberPolis - Silverbot2.bat`**  
*(Se abrirá directamente en tu navegador preferido).*

O bien ejecuta el servidor en consola:
```powershell
node server.js
```
*(Inicia en `http://localhost:3000` y auto-abre tu navegador de inmediato).*

---

## 📡 1. Noticias Automáticas de Ciberseguridad en Castellano

El sistema cuenta con un **motor de sincronización en segundo plano** que consulta y analiza periódicamente las principales fuentes oficiales y especializadas en español:

- 🇪🇸 **INCIBE (Instituto Nacional de Ciberseguridad)**: Avisos de seguridad, smishing, troyanos bancarios y vulnerabilidades en castellano.
- 🇪🇸 **Una al Día (Hispasec)**: Informes técnicos diarios sobre malware, exploits de día cero y fallos en sistemas operativos y software.
- 🇪🇸 **CCN-CERT (Centro Criptológico Nacional - CNI)**: Directivas de ciberdefensa gubernamental, guías NIS2 y ciberamenazas estatales (APTs).
- 🇪🇸 **HackPlayers**: Investigaciones de la comunidad de hacking ético y pentesting en español.

### Características del Motor de Feeds:
- **Sin duplicados**: Compara enlaces y títulos antes de añadir despachos.
- **Auto-etiquetado y categorización inteligente**: Detecta palabras clave en español para clasificar en *Hacking*, *Política* o *Tecnopolítica*.
- **Distintivo en portada**: Los despachos automáticos lucen la insignia `[🇪🇸 AUTO_FEED_ES]` y atribución a la fuente original.

---

## ⚙️ 2. Panel de Control Admin & Transformador de la Web

Al iniciar sesión como Administrador (`silverbot2`), aparece en la cabecera el botón:
👉 **`⚙️ PANEL ADMIN`** (y en el menú de usuario).

Desde este panel tienes dos pestañas de control total:

### Pestaña A: Fuentes en Castellano (Auto-Sync)
- **Switch Maestro**: Activa o desactiva la sincronización periódica en segundo plano.
- **Frecuencia**: Elige cada cuánto comprobar novedades (15 min, 30 min, 1 hora, 6 horas).
- **Botón `⚡ SINCRONIZAR AHORA`**: Fuerza una descarga inmediata de despachos españoles frescos.
- **Interruptores Individuales**: Puedes pausar o activar cualquiera de las fuentes (INCIBE, Hispasec, CCN-CERT, HackPlayers) de forma independiente.

### Pestaña B: Transformar Web (Live Theme Customizer)
Puedes cambiar la estética de todo el portal en vivo y guardarlo para todos los visitantes:
- 🎨 **Paleta de Acento Neón**:
  - 💎 **Cian Láser** (Estilo Cyber Intelligence)
  - 🟢 **Matrix Verde** (Estilo Hacker Terminal)
  - 🟡 **Ámbar 2077** (Estilo Ciberpunk)
  - 🔴 **Carmesí Táctico** (Estilo Alerta Crítica)
  - ⚪ **Plata Titanio** (Monocromo Brutalista)
  - 🟣 **Índigo Real** (Diplomático)
- 🌐 **Malla de Polígonos 3D de Fondo**:
  - Ajusta la densidad entre *Equilibrado*, *Malla Compleja*, *Minimalista Sutil* o *Pausar Movimiento*.
- ✍️ **Identidad & Textos del Portal**:
  - Modifica tu callsign (`SILVERBOT2`), sub-callsign (`UNIX`) o el subtítulo en tiempo real.
- 📐 **Disposición de Cuadrícula (Layout)**:
  - *Malla 3 Columnas (Biselado estándar)*
  - *Modo Consola Compacto (Alta densidad de datos)*
  - *Editorial Panorámico (2 Columnas grandes)*

---

## 👤 Credenciales del Usuario Administrador
- **Usuario**: `silverbot2`
- **Contraseña**: `Silverbot2@2026!`
- **Criptografía**: Hashing Scrypt con salt de 16 bytes y comparación en tiempo constante (protegido contra timing attacks y fuerza bruta).
