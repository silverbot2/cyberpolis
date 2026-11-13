# ENVIOX — Plataforma Corporativa Independiente de Transferencia Segura (5 TB)

**ENVIOX** es una plataforma de transferencia segura de archivos inspirada en la arquitectura empresarial de envío y recepción confidencial, diseñada para funcionar tanto integrada dentro de **CYBERPOLIS** (en `/enviox/`) como de forma **100% independiente** en su propio servidor o repositorio dedicado (ej: `https://enviox.tuempresa.com`).

---

## 📁 Estructura del Módulo

- `index.html`: Aplicación web moderna (SPA) que replica todas las pantallas:
  - **Enviar archivos**: Selección de destinatarios con opción *Añadir varios*, prefijo telefónico (+34), idioma, asunto con contador (0/100), mensaje, drag&drop con cálculo de tamaño, acuse de recibo, caducidad, etiquetas y botón *Enviar de forma segura*.
  - **Recibir archivos**: Buzón seguro para solicitar documentación y ficheros a terceros con enlace directo.
  - **Enviox link**: Generación de enlaces rápidos de envío y recepción con código QR.
  - **Registros**: Trazabilidad forense completa con filtros laterales (Todos, Enviados, Recibidos, Activos, Caducados, Cancelados, Pendientes...), búsqueda en tiempo real, cancelación de envíos y exportación de evidencias en CSV.
  - **Contactos y Grupos**: Libreta corporativa de direcciones.
  - **Área de administración**: Panel en cuadrícula con accesos directos a Ajustes, Usuarios, Roles, Políticas de seguridad e Informes.
  - **Ajustes**: Configuración en 3 columnas (Transferencia, Seguridad, Conectividad con Correo y Nubes 5 TB).
  - **Usuarios y Roles**: Gestión de usuarios y plantillas de permisos SAML.
- `enviox.css`: Estilos visuales exactos a la plataforma corporativa (tarjetas limpias, azul marino, botones redondeados pill, conmutadores y diseño responsivo).
- `enviox.js`: Lógica del cliente, modales de trazabilidad y acuses de recibo.
- `standalone-server.js`: Servidor Node.js ligero sin dependencias npm externas para arrancarlo de forma autónoma.
- `envioxBackend.js` *(en raíz de CYBERPOLIS)*: Router de backend conectado a Google Drive 5 TB, OneDrive 5 TB y la Pasarela de Correo.

---

## 🚀 Cómo ejecutarlo como Web Independiente

Si deseas separar ENVIOX en otro servidor o dominio dedicado:

1. Copia toda esta carpeta `enviox/` a cualquier servidor (Render, VPS, Docker, AWS, etc.).
2. Ejecuta con Node.js (cero dependencias externas):
   ```bash
   node standalone-server.js
   ```
3. O personalizando el puerto y la marca:
   ```bash
   PORT=8080 BRAND_NAME="ENVIOX" node standalone-server.js
   ```
4. Abre `http://localhost:8080` en tu navegador.
