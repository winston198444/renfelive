# RENFE LIVE

Mapa en tiempo real de los trenes de Renfe sobre Leaflet/OpenStreetMap:
posición GPS de cada tren, número de tren, servicio, origen, destino,
próxima parada, retrasos y recorrido completo con horarios.

> **Proyecto no oficial.** Los datos proceden del portal de datos abiertos
> de Renfe (GTFS estático y feeds GTFS-Realtime). Este proyecto no está
> afiliado ni respaldado por Renfe Operadora.

---

## Arquitectura

```
GitHub Repository (main)
        |
        v
GitHub Actions  (push a main | manual | diario 04:17 UTC)
        |-- descarga google_transit.zip de Renfe
        |-- valida status HTTP + los 4 CSV necesarios
        |-- genera JSON optimizados en data/*.json
        |-- ensambla _site/ (frontend + data/)
        v
GitHub Pages    (frontend + JSON GTFS estáticos, ~160 KB gzip en total)
        |
        v
Navegador  (join realtime + estático en app.js, 1 vez los estáticos,
        |   y cada 15 s solo los dos feeds realtime)
        v
Cloudflare Worker (proxy CORS mínimo)  -->  feeds GTFS-Realtime de Renfe
```

| Pieza | Papel | Coste |
|---|---|---|
| GitHub Actions | Build + preprocesado + deploy (nunca realtime) | Free |
| GitHub Pages | Frontend + `data/*.json` estáticos | Free (repo público) |
| Cloudflare Worker | Proxy CORS de los 2 feeds realtime, caché edge 12 s | Free |
| `server.js` | Desarrollo local únicamente (`npm start`) | local |

Por qué hace falta el Worker: los feeds de Renfe **no envían la cabecera
`Access-Control-Allow-Origin`** (comprobado con datos reales en GET, HEAD y
OPTIONS, y con un `fetch()` fallido en Chrome), por lo que el navegador
bloquea la lectura directa desde GitHub Pages. El Worker reenvía esos dos
feeds con CORS configurado; **no procesa GTFS estático ni CSV**.

**Caché (tres capas distintas):**

| Capa | Duración | Qué cachea |
|---|---|---|
| Caché edge del Worker | 12 s (compartida entre visitantes) | Los 2 feeds; una sola petición a Renfe por intervalo |
| Caché del navegador/Pages | ~10 min (`max-age=600` + ETag) | `app.js`, `style.css`, `data/*.json` (una vez por sesión) |
| Actualización visual | 15 s (`REFRESH_INTERVAL_MS`) | El refresco de marcadores; solo descarga los feeds |

12 s de caché edge < 15 s de refresco: nunca se sirve información
excesivamente antigua (máximo ~12 s de retraso en el peor caso).

---

## Desarrollo local

Requisitos: Node.js >= 18 (sin dependencias npm).

```bash
npm run data     # genera data/*.json (descarga el GTFS de Renfe, ~30 s)
npm start        # servidor local en http://localhost:3000
```

`server.js` se conserva tal cual para desarrollo: sirve el frontend,
hace de proxy de los feeds (`/api/vehicle-positions`, `/api/trip-updates`)
y expone `/api/trains` (endpoint enriquecido de diagnóstico, ya no lo usa
el frontend). El parser ZIP/CSV está compartido en `lib/gtfs-format.js`
y lo usan igualmente `server.js` y el build de Actions.

La aplicación detecta `localhost` y usa las rutas del propio servidor;
en producción usa la URL del Worker. El frontend es el MISMO fichero
`app.js` en ambos entornos.

---

## Generación de datos (`data/*.json`)

```bash
npm run data     # scripts/build-gtfs.js
```

Descarga `https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip`
(portal de datos abiertos de Renfe, CC-BY-4.0) y genera:

| Fichero | Contenido | Tamaño (gzip) |
|---|---|---|
| `data/stops.json` | `stopId -> nombre de estación` | ~9,5 KB |
| `data/routes.json` | `routeId -> servicio (AVE, MD, …)` | ~3 KB |
| `data/trips.json` | `tripId -> [routeId, nº de tren]` | ~37 KB |
| `data/stop_times.json` | `tripId -> [[stopId, "HH:MM:SS"], …]` | ~110 KB |
| `data/meta.json` | fecha de build + recuentos | mín. |

Validaciones del build (cualquier fallo => `exit != 0` y **no se despliega**):

- status HTTP de la descarga del ZIP (con 3 reintentos),
- presencia de los 4 CSV necesarios (`stops`, `trips`, `routes`, `stop_times`),
- que ningún JSON de salida quede vacío,
- informe de tamaños por fichero.

`calendar.txt` y `calendar_dates.txt` (14 MB) se descartan: el `trip_id`
de Renfe embebe la fecha (`0019012026-10-30`), innecesario el calendario.

`data/` y `_site/` están en `.gitignore`: se generan, no se versionan.

---

## Despliegue en producción

### 1. Habilitar GitHub Pages (pasos exactos)

1. Hacer el repositorio **público**: *Settings → General → Danger Zone →
   Change visibility → Make public* (Pages Free solo funciona en repos
   públicos).
2. *Settings → Pages*.
3. En **Source** seleccionar **GitHub Actions** (no "Deploy from a branch").
4. Guardar.

A partir de ahí, cada push a `main`, cada ejecución manual y la programada
diaria despliegan automáticamente. Si el build falla (p. ej. Renfe caído),
el job de deploy no se ejecuta y **permanece publicado el último artefacto
correcto**.

URL por defecto: `https://winston198444.github.io/renfelive/`.

### 2. Ejecución manual del workflow

*Actions → "Build y deploy GTFS" → Run workflow → rama `main` → Run*.

También se puede generar y probar el sitio en local:

```bash
npm run data     # data/*.json
npm run site     # ensambla _site/ completo
```

### 3. Nota sobre workflows programados

GitHub **desactiva automáticamente** los workflows con `schedule` tras
~60 días sin actividad en el repositorio. Si eso ocurre, los datos dejan
de refrescarse (la web seguirá funcionando con el último build). Para
reactivarlo: *Actions → Build y deploy GTFS → Enable workflow* (o
ejecutarlo manualmente), y mantener algo de actividad en el repo.

---

## Configuración del Worker (Cloudflare)

El Worker está en `worker/` (`renfe-proxy.js` + `wrangler.toml`).

### Despliegue con Wrangler (recomendado)

```bash
cd worker
npx wrangler login          # cuenta gratuita de Cloudflare
npx wrangler deploy         # publica y devuelve la URL del Worker
```

### Configuración manual en el dashboard (alternativa)

1. Dashboard de Cloudflare → *Workers & Pages → Create → Worker*.
2. Nombre sugerido: `renfe-live-proxy`.
3. Pegar el contenido de `worker/renfe-proxy.js` en el editor → *Deploy*.
4. *Settings → Variables and Secrets* → añadir la variable
   **`ALLOWED_ORIGINS`** (tipo *Plain text*) con la allowlist CORS,
   separada por comas. Ejemplo inicial:

   ```
   https://winston198444.github.io,https://renfe.example.com
   ```

### Variables a introducir manualmente

| Variable | Dónde | Valor | Obligatoria |
|---|---|---|---|
| `ALLOWED_ORIGINS` | Worker → Settings → Variables | Lista (coma) de orígenes permitidos: la URL de Pages y, cuando exista, el dominio personalizado | Recomendada |

**Nada más** es manual: los dos endpoints de Renfe están fijados en el
código (`RENFE_FEEDS`), no hay secretos de Renfe ni claves de API.

### CORS: allowlist, nunca `*`

- Por defecto el Worker ya acepta `https://winston198444.github.io` y
  `http://localhost:3000` / `http://127.0.0.1:3000` (desarrollo).
- Con un **domino personalizado** basta añadirlo a `ALLOWED_ORIGINS`
  (o al array `DEFAULT_ALLOWED_ORIGINS` del código).
- Cualquier otro origen recibe `403`; el Worker **no es un proxy abierto**
  y solo reenvía las dos URLs fijas de Renfe.

### URL del Worker en `app.js`

Ya configurada en este repositorio:

```js
const WORKER_BASE_URL = "https://renfe-live-proxy.198cuatro.workers.dev";
```

Si en el futuro se despliega el Worker con otro nombre/dominio, basta
sustituir esa constante (sección 1 de `app.js`) por la nueva URL y
hacer commit+push. No hay ninguna otra URL del Worker en el código.

---

## Limitaciones de CORS (por qué existe el Worker)

Los feeds `vehicle_positions_LD.json` y `trip_updates_LD.json` responden
**sin** `Access-Control-Allow-Origin` en GET, HEAD y OPTIONS (verificado).
Desde una página de origen distinto, `fetch()` lanza
`TypeError: Failed to fetch` y `no-cors` solo da respuestas opacas
ilegibles. GitHub Pages es 100 % estático (no ejecuta código servidor),
por lo que **sin un intermediario con CORS no hay forma de leer el feed**.
El GTFS-Realtime es lo único que necesita servidor; el GTFS estático se
preprocesa en Actions y se sirve desde Pages.

---

## Actualización diaria

- Renfe publica el GTFS estático a diario (aparecen viajes con fechas
  nuevas): el workflow se ejecuta cada día a las **04:17 UTC** y regenera
  `data/*.json`.
- Los feeds realtime se leen cada 15 s desde el navegador vía Worker,
  sin intervención de Actions.
- El límite gratuito de Cloudflare Workers (100.000 peticiones/día)
  alcanza para ~17 visitantes continuos (2 peticiones cada 15 s cada uno),
  de sobra para uso personal/demo.

---

## Estructura del repositorio

```
index.html                  Frontend (mismo fichero en local y producción)
style.css
app.js                      Lógica: mapa, join de datos, UI
server.js                   Desarrollo local (npm start)
lib/gtfs-format.js          Parser ZIP/CSV compartido (server ↔ Actions)
scripts/build-gtfs.js       Preprocesado GTFS (npm run data)
scripts/assemble-site.js    Ensamblado de _site/ (npm run site)
.github/workflows/deploy.yml  Actions: build + deploy Pages
worker/renfe-proxy.js       Cloudflare Worker (proxy CORS)
worker/wrangler.toml        Configuración del Worker
data/                       Generado (gitignored)
_site/                      Generado (gitignored)
```

## Licencia de los datos

GTFS estático y feeds GTFS-Realtime de Renfe Operadora, publicados en el
portal de datos abiertos bajo licencia CC-BY-4.0. Atribución requerida:
"Proyecto no oficial. Datos procedentes del portal de datos abiertos de
Renfe." (mostrada en la propia aplicación).
