# 🚀 Plan de mejora y optimización — astrahopvt.online

> Estado: **propuesta pendiente de revisión**.
>
> ✅ Ya aplicado: referencias .webp, textos de fuego en el juego, countdown GMT-4, metadatos Open Graph/Twitter (P2-10), script muerto de avatares eliminado (P0-3), stream de Twitch solo en la sección Inicio (carga automática al entrar, se descarga al salir) con parent dinámico (P0-1), repeticiones de comandos (P0-5), galería con autodescubrimiento de webp numerados + paginación + autores por `fanarts.json` (P0-4 resuelto mejor que lo propuesto), cache busting en style.css/favicon (P2-11, manual por fecha).

---

## P0 — Rápido y de alto impacto (1 sesión)

### 1. Cargar el player de Twitch solo cuando hace falta
El iframe de Twitch (`player.twitch.tv`) pesa ~2 MB y se carga **siempre**, aunque el visitante entre a ver fanarts o donaciones.
- Opción A (simple): botón "▶ Cargar stream" que inserta el iframe al click.
- Opción B: `IntersectionObserver` que lo carga solo cuando la sección Inicio es visible.
- **Bonus crítico**: hoy `parent=www.astrahopvt.online` está fijo. Si alguien entra por `astrahopvt.online` (sin www) el player **no funciona**. Inyectar el parent con JS: `parent=${location.hostname}`.

### 2. Riesgo XSS en el carrusel de donadores
`cargarAstrosLeyenda()` inserta `donador.username` con `innerHTML` **sin escapar**. Los usernames de Twitch son seguros hoy, pero basta un cambio de API o un JSON manipulado. Escapar con la misma función `escapeHtml` que ya existe en `juego.html` (copiar 6 líneas).

### 3. Código muerto: avatares `donador/*.png`
El primer script de `index.html` busca `donador/${name}.png` y `donador/default.png`, pero **esa carpeta no existe** en el repo (los avatares reales vienen de `donadores.json` + CDN de Twitch). Genera peticiones 404 basura y confusión. Eliminar el bloque completo.

### 4. Fanarts: 404s en cada visita
`totalImgs = 50` pero hay **31 archivos**. Cada visita a la sección lanza 19 peticiones que fallan.
- Corto plazo: bajar a 31 y avisarme cuando subas fanarts nuevos.
- Mejor: un `fanarts.json` (lista de archivos) que actualizas al subir, y la galería se genera desde ahí. Cero 404s, orden garantizado.

### 5. Detalles de contenido
- `https://www.discord.gg/yGsj4kUTag` → formato válido es `https://discord.gg/yGsj4kUTag`.
- En Donaciones, la lista de comandos repite `!tts | !sr` dos veces.

---

## P1 — Rendimiento medible (1–2 sesiones)

### 6. Lazy loading y dimensiones de imágenes
- Añadir `loading="lazy"` a patrocinadores, modelo y fanarts.
- Añadir `width`/`height` (o `aspect-ratio`) para eliminar saltos de layout (CLS).
- Al iframe de Ko-fi darle `loading="lazy"` (está en la sección donaciones, no visible al inicio).

### 7. Miniaturas de fanarts
La galería carga las imágenes **completas** (probablemente 500 KB–2 MB cada una) para mostrarlas en un grid pequeño. Generar carpeta `fanarts/thumbs/` (p. ej. 400px de ancho, ~40 KB c/u) y usar la full solo en el lightbox. Ahorro estimado: **~90% de transferencia** en la sección más pesada. Se puede automatizar con un script de build (`sharp` en Node) o una GitHub Action.

### 8. Font Awesome → SVG inline
Se carga el CSS completo (~100 KB) para usar 8 iconos. Reemplazar por los SVG oficiales inline (mismo resultado visual, 0 requests).

### 9. Mover los scripts inline a archivos externos
`index.html` tiene ~500 líneas de JS embebidas que se re-descargan en cada visita (sin caché). Extraer a `main.js` con `defer`, y de paso queda más mantenible.

---

## P2 — SEO, social y robustez (1 sesión)

### 10. Metadatos sociales
No hay Open Graph ni Twitter Cards: al compartir el link en Discord/X no sale preview con imagen. Añadir:
- `og:title`, `og:description`, `og:image` (un banner 1200×630), `og:url`, `twitter:card`
- `canonical`, `theme-color`, favicon PNG 512 + `apple-touch-icon`
- Opcional: `robots.txt` + `sitemap.xml` (Google ya indexa Twitch/Ko-fi, conviene controlar la web).

### 11. Cache-busting
GitHub Pages cachea agresivamente. Al cambiar `style.css`/`main.js`, los visitantes pueden ver versión vieja días. Añadir `?v=fecha` a las referencias, o hash en un build.

### 12. Accesibilidad rápida
- Textos grises muy tenues (`rgba(255,150,170,0.45)`) fallan contraste en móvil con luz de día.
- Botones del nav con `onclick` inline: darles `type="button"` y listeners en JS.
- El lightbox ya tiene teclado y swipe 👍.

---

## P3 — Ambicioso (cuando haya ganas)

### 13. PWA / notificaciones
Ya existe la extensión Astra-hub para Firefox. Un `manifest.json` + service worker permitiría "instalar" la web en móvil y notificar inicios de stream (combinado con el workflow diario). Es el sustituto multiplataforma de la extensión.

### 14. Automatización de imágenes en CI
GitHub Action (p. ej. `calibreapp/image-actions`) que comprime/optimiza cualquier imagen que se suba al repo, y genera las thumbs del punto 7. Subes fanart → push → todo optimizado solo.

### 15. Lighthouse CI
Medir antes/después de todo esto con scores de Performance/SEO/Accessibility en cada push. Sin métrica no hay mejora comprobable.

---

## Lo que ya NO hay que hacer
- ~~Convertir fanarts/patros a .webp~~ ✅ hecho hoy
- ~~Textos "pinchos" → fuego en juego.html~~ ✅ hecho hoy
- ~~Countdown a GMT-4 fijo~~ ✅ hecho hoy (probado: calcula bien viernes→lunes 19:30 en cualquier zona)
