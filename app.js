/* =========================================================================
 * RENFE LIVE — visualización de trenes de Renfe sobre un mapa
 *
 * FASE 2: el popup enriquece la información del tren con los datos
 * resueltos por el backend (nombres de estaciones, origen, destino,
 * recorrido y servicio), obtenidos del GTFS estático oficial de Renfe.
 *
 * Estructura del fichero:
 *   1. Configuración y estado
 *   2. Inicialización del mapa
 *   3. Consulta al backend local
 *   4. Procesamiento de los datos
 *   5. Creación de marcadores
 *   6. Actualización de marcadores
 *   7. Eliminación de trenes antiguos
 *   8. Formateo de datos para el popup
 *   9. Interfaz (panel superior)
 *  10. Gestión de errores
 *  11. Arranque y temporizador de refresco
 *  12. Búsqueda de trenes
 *  13. Filtros por servicio y retraso
 *  14. Colores de servicio y leyenda
 *  15. Panel lateral de trenes
 *  16. Modo seguir tren
 *  17. Ficha del tren en móvil (bottom sheet)
 *  18. Acciones de la ficha y atajos de teclado
 * ========================================================================= */

"use strict";

/* -----------------------------------------------------------------------
 * 1. Configuración y estado
 * -------------------------------------------------------------------- */

// El navegador consulta SIEMPRE a nuestro backend local, que es quien
// habla con Renfe (los feeds no permiten CORS) y quien resuelve los IDs
// con el GTFS estático.
const TRAINS_ENDPOINT = "/api/trains";

const REFRESH_INTERVAL_MS = 15000; // 15 segundos

// Centro y zoom del mapa: España peninsular.
const MAP_CENTER = [40.2, -3.7];
const MAP_ZOOM = 6;

// Etiqueta legible para los valores reales de "currentStatus".
const STATUS_LABELS = {
  IN_TRANSIT_TO: "En movimiento",
  STOPPED_AT: "Detenido",
};

// Color de relleno para trenes sin servicio publicado en el GTFS.
const DEFAULT_MARKER_COLOR = "#64748b";

// Clave de filtro para trenes cuyo campo "service" no existe en los datos.
const SIN_SERVICIO = "Sin servicio";

// Marcadores del mapa indexados por trip.tripId (identificador único y
// estable de cada tren en el feed, verificado con datos reales).
const trainMarkers = new Map();

// Último conjunto de trenes procesado. Es la MISMA referencia del array que
// se pasa a syncMarkers(), no una copia: el buscador trabaja sobre los datos
// ya cargados en memoria, sin duplicarlos ni volver a pedirlos a Renfe.
let currentTrains = [];

// Índice trainId -> datos (acceso O(1) para seleccionar/seguir/actualizar
// la ficha sin recorrer el array en cada actualización).
const trainsById = new Map();

// Estado del buscador de trenes.
let searchResults = []; // trenes coincidentes de la última consulta
let searchSelectedIndex = -1; // resultado resaltado con el teclado (-1 = ninguno)

/* --- FASE 3: filtros --- */

// Servicios desactivados por el usuario (vacío = todos activos).
// La lista de servicios se genera SIEMPRE de los datos reales cargados.
const disabledServices = new Set();

// Umbral de retraso activo: "all" | "ontime" | "5" | "15" | "30" | "none".
let delayFilter = "all";

// tripIds que superan los filtros activos (marcadores visibles).
let visibleTripIds = new Set();

// Umbrales de retraso (segundos), ver categoriaRetraso() en la sección 13.
const DELAY_THRESHOLD_5_MIN = 300; // 5 min
const DELAY_THRESHOLD_15_MIN = 900; // 15 min
const DELAY_THRESHOLD_30_MIN = 1800; // 30 min

/* --- FASE 3: panel lateral de trenes --- */

let panelTrenesAbierto = false;
let panelSort = "number"; // criterio de ordenación del panel

/* --- FASE 3: modo seguir tren --- */

let followingTripId = null; // tren que se está siguiendo (null = ninguno)
let zoomInternoPendiente = false; // distingue nuestro setView del zoom del usuario
let zoomInternoTimer = null;

/* --- FASE 3: ficha del tren en móvil --- */

let fichaAbiertaTripId = null; // tren mostrado en el bottom sheet
let recorridoAbiertoTripId = null; // recorrido expandido con "Ver recorrido"

let map = null;

/* -----------------------------------------------------------------------
 * 2. Inicialización del mapa
 * -------------------------------------------------------------------- */

function initMap() {
  map = L.map("map", { zoomControl: true }).setView(MAP_CENTER, MAP_ZOOM);

  // Mapa base: tiles de OSM Alemania (tile.openstreetmap.de).
  // Es el fork alemán de OpenStreetMap Carto, operado por FOSSGIS e.V.,
  // gratuito y financiado por donaciones. A diferencia de
  // tile.openstreetmap.org (que bloquea a las apps de terceros y devuelve
  // 403 "osm.wiki/Blocked") ni de CARTO (que exige API key), este servidor
  // sí permite el uso normal desde una aplicación web sin registro.
  // Su única restricción es el uso comercial o de alto tráfico.
  // No usa subdominios, por eso no se pasa parámetro {s}.
  L.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
    maxZoom: 19,
    // Atribución exigida: datos de OpenStreetMap + operador del servidor de tiles.
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Tiles: <a href="https://openstreetmap.de/">FOSSGIS / OpenStreetMap Deutschland</a>',
  }).addTo(map);
}

/* -----------------------------------------------------------------------
 * 3. Consulta al backend local
 * -------------------------------------------------------------------- */

async function fetchTrains() {
  let response;

  try {
    response = await fetch(TRAINS_ENDPOINT, { cache: "no-store" });
  } catch (networkError) {
    console.error("[diagnóstico] fetch() lanzó un error de red:", {
      mensaje: networkError.message,
      endpoint: TRAINS_ENDPOINT,
      origen: window.location.href,
    });
    throw new Error(
      `No se ha podido contactar con el backend local (${TRAINS_ENDPOINT}): ${networkError.message}`
    );
  }

  console.log("[diagnóstico] Respuesta del backend:", {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
  });

  if (!response.ok) {
    throw new Error(`El backend respondió con estado HTTP ${response.status}`);
  }

  const rawText = await response.text();

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (parseError) {
    console.error(
      "[diagnóstico] La respuesta NO es JSON válido. Primeros 300 caracteres:",
      rawText.slice(0, 300)
    );
    throw new Error("La respuesta del backend no es JSON válido");
  }

  // Diagnóstico: muestra real de la estructura recibida.
  console.log(
    "[diagnóstico] Muestra de trenes recibidos (el primero):",
    JSON.stringify(payload.trains?.[0] ?? null, null, 2)
  );

  return payload;
}

/* -----------------------------------------------------------------------
 * 4. Procesamiento de los datos
 *
 * El backend devuelve cada tren ya enriquecido y relacionado:
 *   tripId           -> identificador del viaje (clave única del marcador)
 *   trainNumber      -> número de tren (GTFS estático)
 *   service          -> servicio/linea, ej. "MD", "AVLO" (GTFS estático)
 *   origin/destination -> { stopId, name } (GTFS estático, nombre real)
 *   nextStop         -> { stopId, name } proxima parada (feed en tiempo real)
 *   nextStopArrival  -> timestamp epoch de la llegada prevista
 *   delaySeconds     -> retraso en segundos
 *   currentStatus    -> "IN_TRANSIT_TO" | "STOPPED_AT"
 *   latitude/longitude -> posición GPS
 *   route            -> recorrido [{ stopId, name, scheduledArrival,
 *                        liveArrival, skipped }]
 * -------------------------------------------------------------------- */

function isValidTrain(train) {
  return (
    train &&
    typeof train.latitude === "number" &&
    typeof train.longitude === "number" &&
    Number.isFinite(train.latitude) &&
    Number.isFinite(train.longitude) &&
    Math.abs(train.latitude) <= 90 &&
    Math.abs(train.longitude) <= 180
  );
}

/** Extrae del payload únicamente los trenes con coordenadas válidas. */
function extractTrains(payload) {
  const trains = [];
  const list = Array.isArray(payload?.trains) ? payload.trains : [];

  for (const train of list) {
    if (!train?.tripId || !isValidTrain(train)) {
      console.warn("Tren descartado por falta de tripId o coordenadas válidas:", train);
      continue;
    }
    trains.push(train);
  }

  return trains;
}

/* -----------------------------------------------------------------------
 * 5. Creación de marcadores
 *
 * Estilo FASE 3: el RELLENO indica el servicio (color principal) y el
 * BORDE indica la categoría de retraso, de modo que el retraso nunca
 * impide identificar el servicio. El estado textual sigue estando en el
 * popup/ficha. El color nunca es la única vía: servicio y retraso se
 * muestran también con texto (popup, panel, buscador, leyenda).
 * -------------------------------------------------------------------- */

/** Estilo completo de un marcador a partir de sus datos reales. */
function markerStyleFor(train) {
  const borde = delayBorderFor(train.delaySeconds);

  return {
    radius: 7,
    color: borde.color,
    weight: borde.weight,
    opacity: 1,
    fillColor: getServiceColor(train.service),
    fillOpacity: 0.95,
  };
}

function createTrainMarker(train) {
  const marker = L.circleMarker(
    [train.latitude, train.longitude],
    markerStyleFor(train)
  );

  // En escritorio se mantiene el popup de Leaflet (estructura actual).
  // En móvil la ficha se muestra como bottom sheet (sección 17).
  if (!esMovil()) marker.bindPopup(buildPopupContent(train));

  marker.on("click", () => {
    if (esMovil()) {
      // Si el marcador tiene popup (se creó en escritorio), popupopen ya
      // se encarga de redirigirlo a la ficha inferior.
      if (!marker.getPopup()) abrirFichaMovil(train.tripId);
    } else if (!marker.getPopup()) {
      // Marcador creado en móvil y ahora visible en escritorio: se crea
      // su popup aquí con los datos ACTUALES (no los del cierre).
      const datos = trainsById.get(train.tripId) ?? train;
      marker.bindPopup(buildPopupContent(datos));
      marker.openPopup();
    }
  });

  return marker;
}

/* -----------------------------------------------------------------------
 * 6. Actualización de marcadores
 * -------------------------------------------------------------------- */

function syncMarkers(trains) {
  const seenTripIds = new Set();

  for (const train of trains) {
    seenTripIds.add(train.tripId);

    const existingMarker = trainMarkers.get(train.tripId);

    if (existingMarker) {
      // Tren ya conocido: se mueve el marcador y se refrescan estilo y
      // popup con los datos nuevos (posición, retraso, servicio...) sin
      // recrear el marcador ni sus listeners.
      existingMarker.setLatLng([train.latitude, train.longitude]);
      existingMarker.setStyle(markerStyleFor(train));
      if (existingMarker.getPopup()) {
        existingMarker.setPopupContent(buildPopupContent(train));
      }
    } else {
      // Tren nuevo: se crea el marcador.
      const marker = createTrainMarker(train);
      marker.addTo(map);
      trainMarkers.set(train.tripId, marker);
    }
  }

  removeStaleMarkers(seenTripIds);
}

/* -----------------------------------------------------------------------
 * 7. Eliminación de trenes antiguos
 * -------------------------------------------------------------------- */

function removeStaleMarkers(seenTripIds) {
  for (const [tripId, marker] of trainMarkers) {
    if (!seenTripIds.has(tripId)) {
      map.removeLayer(marker);
      trainMarkers.delete(tripId);
    }
  }
}

/* -----------------------------------------------------------------------
 * 8. Formateo de datos para el popup
 *
 * Solo se muestran campos disponibles en los datos oficiales. Si un dato
 * no existe, simplemente no se añade la línea correspondiente.
 * -------------------------------------------------------------------- */

/** Convierte un timestamp epoch (segundos) a "HH:MM" de forma determinista. */
function formatHour(epochSeconds) {
  const numeric = Number(epochSeconds);
  if (!numeric || !Number.isFinite(numeric)) return null;

  const date = new Date(numeric * 1000);
  if (Number.isNaN(date.getTime())) return null;

  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${hours}:${minutes}`;
}

/** Convierte una hora GTFS ("8:30:00") a "HH:MM". */
function formatGtfsTime(gtfsTime) {
  if (!gtfsTime) return null;

  const parts = String(gtfsTime).split(":");
  if (parts.length < 2) return null;

  const hour = String(parts[0]).padStart(2, "0");
  return `${hour}:${parts[1]}`;
}

/** Formatea el retraso en segundos como "+X min" / "-X min". */
function formatDelay(delaySeconds) {
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds)) return null;
  if (delaySeconds === 0) return null; // sin retraso: no se muestra

  const minutes = Math.round(Math.abs(delaySeconds) / 60);
  const sign = delaySeconds > 0 ? "+" : "-";

  return `${sign}${minutes} min`;
}

/** Añade una fila al popup solo si hay contenido que mostrar. */
function addRow(rows, key, value) {
  if (value === null || value === undefined || value === "") return;
  rows.push([key, value]);
}

/**
 * Texto y clase del retraso a partir de los datos reales:
 *   null      -> "Sin información" (no se inventa ningún valor)
 *   0         -> "En hora"
 *   resto     -> "+X min" / "-X min" (formatDelay)
 * Las clases ok/warn/danger corresponden a los umbrales de categoriaRetraso().
 */
function retrasoTextoYClase(delaySeconds) {
  const categoria = categoriaRetraso(delaySeconds);

  if (categoria === "none") return { texto: "Sin información", clase: "none" };
  if (delaySeconds === 0) return { texto: "En hora", clase: "ok" };

  const clase =
    categoria === "30" ? "danger" : categoria === "5" || categoria === "15" ? "warn" : "ok";

  return { texto: formatDelay(delaySeconds), clase };
}

/** Badge de retraso (popup y ficha móvil). */
function badgeRetrasoHtml(delaySeconds) {
  const { texto, clase } = retrasoTextoYClase(delaySeconds);
  const claseBadge = clase === "none" ? "muted" : clase;
  return `<span class="train-popup__badge train-popup__badge--${claseBadge}">${escapeHtml(
    texto
  )}</span>`;
}

/**
 * Construye el contenido del popup/ficha SOLO con campos reales de los feeds.
 *
 * Orden FASE 3: servicio + número (protagonista) -> origen → destino ->
 * próxima parada + retraso -> estado -> acciones -> recorrido/timeline ->
 * información técnica (lat/lon) plegable.
 */
function buildPopupContent(train) {
  const titulo = [train.service, train.trainNumber]
    .filter(Boolean)
    .join(" ")
    .trim();
  const tituloFinal = titulo || `Viaje ${train.tripId}`;

  // --- Origen → destino (protagonista) ---
  const origen = train.origin?.name;
  const destino = train.destination?.name;
  const odHtml =
    origen || destino
      ? `<div class="train-popup__od">` +
        (origen
          ? `<span class="train-popup__od-endpoint">${escapeHtml(String(origen))}</span>`
          : "") +
        (origen && destino
          ? `<span class="train-popup__od-arrow" aria-hidden="true">↓</span>`
          : "") +
        (destino
          ? `<span class="train-popup__od-endpoint">${escapeHtml(String(destino))}</span>`
          : "") +
        `</div>`
      : "";

  // --- Próxima parada con llegada prevista + retraso ---
  let destacadoHtml = "";
  if (train.nextStop?.name) {
    const llegada = formatHour(train.nextStopArrival);
    const valor = llegada
      ? `${train.nextStop.name} · ${llegada}`
      : train.nextStop.name;

    destacadoHtml =
      `<div class="train-popup__highlight">` +
      `<div class="train-popup__row">` +
      `<span class="train-popup__key">Próxima parada</span>` +
      `<span class="train-popup__value">${escapeHtml(valor)}</span>` +
      `</div>` +
      badgeRetrasoHtml(train.delaySeconds) +
      `</div>`;
  } else {
    destacadoHtml = `<div class="train-popup__highlight">${badgeRetrasoHtml(
      train.delaySeconds
    )}</div>`;
  }

  // --- Filas secundarias (solo si hay contenido) ---
  const rows = [];
  addRow(rows, "Estado", STATUS_LABELS[train.currentStatus] ?? train.currentStatus);

  const rowsHtml = rows
    .map(
      ([key, value]) => `
      <div class="train-popup__row">
        <span class="train-popup__key">${escapeHtml(key)}</span>
        <span class="train-popup__value">${escapeHtml(String(value))}</span>
      </div>`
    )
    .join("");

  // --- Acciones: seguir tren / ver recorrido (delegadas, ver sección 18) ---
  const siguiendo = followingTripId === train.tripId;
  const recorridoAbierto = recorridoAbiertoTripId === train.tripId;
  const accionesHtml =
    `<div class="train-popup__actions">` +
    `<button type="button" class="train-popup__btn${siguiendo ? " train-popup__btn--active" : ""}"` +
    ` data-action="follow" data-trip-id="${escapeAttr(train.tripId)}"` +
    ` aria-pressed="${siguiendo}">${siguiendo ? "⏹ Dejar de seguir" : "📍 Seguir tren"}</button>` +
    `<button type="button" class="train-popup__btn train-popup__btn--secondary train-popup__btn--route"` +
    ` data-action="route" data-trip-id="${escapeAttr(train.tripId)}"` +
    ` aria-expanded="${recorridoAbierto}">Ver recorrido</button>` +
    `</div>`;

  // --- Recorrido / timeline de paradas ---
  const timelineHtml = buildTimelineHtml(train);

  // --- Información técnica (posición GPS): plegable, sin protagonismo ---
  const techHtml =
    `<details class="train-popup__tech">` +
    `<summary>Información técnica</summary>` +
    `<div class="train-popup__row"><span class="train-popup__key">Latitud</span>` +
    `<span class="train-popup__value">${train.latitude.toFixed(5)}</span></div>` +
    `<div class="train-popup__row"><span class="train-popup__key">Longitud</span>` +
    `<span class="train-popup__value">${train.longitude.toFixed(5)}</span></div>` +
    `<div class="train-popup__row"><span class="train-popup__key">Identificador de viaje</span>` +
    `<span class="train-popup__value">${escapeHtml(String(train.tripId))}</span></div>` +
    `</details>`;

  const claseRecorrido = recorridoAbierto ? " train-popup--show-route" : "";

  return (
    `<div class="train-popup${claseRecorrido}">` +
    `<p class="train-popup__title">🚄 ${escapeHtml(tituloFinal)}</p>` +
    odHtml +
    destacadoHtml +
    rowsHtml +
    accionesHtml +
    timelineHtml +
    techHtml +
    `</div>`
  );
}

/**
 * Timeline de paradas (FASE 3):
 *   ✓ parada pasada   ● próxima parada   ○ parada futura
 *
 * Los estados se derivan SOLO del feed real: vehicle.stopId (próxima parada
 * del tren) localizada en el recorrido programado. Si esa vinculación no es
 * posible, no se atribuye ningún estado (no se inventa).
 *
 * Los retrasos por parada se muestran únicamente cuando el feed aporta datos
 * reales de esa parada (en los datos actuales: la próxima parada).
 */
function buildTimelineHtml(train) {
  const route = train.route;
  if (!Array.isArray(route) || route.length === 0) return "";

  // Índice de la próxima parada dentro del recorrido (-1 = indeterminado).
  let idxNext = -1;
  if (train.nextStop?.stopId) {
    idxNext = route.findIndex((stop) => stop.stopId === train.nextStop.stopId);
  }

  const items = route
    .map((stop, index) => {
      const estado =
        idxNext >= 0
          ? index < idxNext
            ? "passed"
            : index === idxNext
              ? "next"
              : "future"
          : null;

      const name = stop.name ?? stop.stopId; // si no hay nombre, el ID técnico
      const skipped = stop.skipped ? " train-popup__stop--skipped" : "";
      const skippedMark = stop.skipped
        ? ' <span class="train-popup__skipped">(no para)</span>'
        : "";

      // Hora: la estimada en vivo si existe; si no, la programada (GTFS).
      const hora = stop.liveArrival
        ? formatHour(stop.liveArrival)
        : formatGtfsTime(stop.scheduledArrival);

      // Retraso real de la próxima parada (delaySeconds del propio feed).
      let delayHtml = "";
      if (estado === "next" && typeof train.delaySeconds === "number" && train.delaySeconds !== 0) {
        const { clase } = retrasoTextoYClase(train.delaySeconds);
        delayHtml =
          `<span class="train-popup__stop-delay train-popup__stop-delay--${clase}">` +
          `${escapeHtml(formatDelay(train.delaySeconds))}</span>`;
      }

      // Símbolo visual + equivalente textual (accesibilidad: no sólo color).
      const estadoHtml =
        estado === "passed"
          ? '<span class="train-popup__stop-state" aria-hidden="true">✓</span><span class="sr-only">Parada realizada:</span>'
          : estado === "next"
            ? '<span class="train-popup__stop-state" aria-hidden="true">●</span><span class="sr-only">Próxima parada:</span>'
            : estado === "future"
              ? '<span class="train-popup__stop-state" aria-hidden="true">○</span><span class="sr-only">Parada pendiente:</span>'
              : "";

      const claseEstado = estado ? ` train-popup__stop--${estado}` : "";
      const timeHtml = hora
        ? `<span class="train-popup__stop-time">${escapeHtml(hora)}</span>`
        : "";

      return `
        <li class="train-popup__stop${claseEstado}${skipped}">
          ${estadoHtml}
          <span class="train-popup__stop-main"><span class="train-popup__stop-name">${escapeHtml(
            String(name)
          )}${skippedMark}</span>${delayHtml}</span>
          ${timeHtml}
        </li>`;
    })
    .join("");

  return `
    <div class="train-popup__route">
      <p class="train-popup__route-title">Recorrido (${route.length} paradas)</p>
      <ol class="train-popup__stops">${items}</ol>
    </div>`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** Escapa también comillas, para usar dentro de atributos HTML. */
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* -----------------------------------------------------------------------
 * 9. Interfaz (panel superior)
 *
 * El contador de trenes lo actualiza actualizarContadorVisibles()
 * (sección 13) para reflejar también la cifra de trenes VISIBLES.
 * -------------------------------------------------------------------- */

function showLastUpdate(timestampSeconds) {
  const element = document.getElementById("last-update");

  // El feed envía el timestamp como texto (ej. "1793351779").
  const numericTimestamp = Number(timestampSeconds);

  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
    element.textContent = new Date().toLocaleTimeString("es-ES");
    return;
  }

  element.textContent = new Date(numericTimestamp * 1000).toLocaleTimeString("es-ES");
}

// Estados de conexión FASE 3: dependen del RESULTADO REAL de cada
// actualización de datos, no de que la interfaz esté "funcionando".
const CONNECTION_STATES = {
  connected: { dot: "panel__dot--connected", label: "conectado" },
  updating: { dot: "panel__dot--updating", label: "actualizando" },
  stale: { dot: "panel__dot--stale", label: "datos antiguos" },
  error: { dot: "panel__dot--error", label: "error" },
};

const CONNECTION_DOT_CLASSES = [
  "panel__dot--connected",
  "panel__dot--updating",
  "panel__dot--stale",
  "panel__dot--error",
];

function showConnectionStatus(state, message = "") {
  const config = CONNECTION_STATES[state];
  if (!config) return;

  const statusElement = document.getElementById("connection-status");
  const dotElement = document.getElementById("connection-dot");
  const errorElement = document.getElementById("error-message");

  dotElement.classList.remove(...CONNECTION_DOT_CLASSES);
  dotElement.classList.add(config.dot);

  statusElement.textContent = config.label;
  statusElement.classList.toggle("stat__value--error", state === "error");
  statusElement.classList.toggle("stat__value--stale", state === "stale");

  errorElement.textContent = message;
  errorElement.hidden = !message;
}

/* -----------------------------------------------------------------------
 * 10. Gestión de errores
 * -------------------------------------------------------------------- */

function handleFetchError(error, hayDatosPrevios = false) {
  // Detalle completo en consola para depuración.
  console.error("[RENFE LIVE] Error al consultar los trenes:", error);

  // Mensaje sencillo en la interfaz, pero específico según el fallo real,
  // para que se distinga sin abrir la consola.
  let uiMessage = "No se han podido obtener los datos de Renfe. Reintentando…";

  if (error.message.includes("backend local")) {
    uiMessage =
      "No se llega al backend local. Ejecuta 'npm start' y abre http://localhost:3000 " +
      "(no el archivo index.html). Reintentando…";
  } else if (error.message.includes("estado HTTP")) {
    uiMessage = "El backend local ha respondido con un error. Reintentando…";
  } else if (error.message.includes("JSON")) {
    uiMessage = "El backend ha devuelto una respuesta que no es JSON válido. Reintentando…";
  }

  if (hayDatosPrevios) {
    // Falló la actualización PERO hay datos anteriores: se conservan los
    // marcadores y se avisa de que los datos pueden estar desactualizados.
    const hora = document.getElementById("last-update").textContent;
    showConnectionStatus(
      "stale",
      `${uiMessage} Se siguen mostrando los últimos datos recibidos (${hora}).`
    );
  } else {
    showConnectionStatus("error", uiMessage);
  }
}

/* -----------------------------------------------------------------------
 * 11. Arranque y temporizador de refresco
 * -------------------------------------------------------------------- */

// Aviso claro cuando la página se abre directamente desde el disco (file://).
// En ese caso no hay backend local, así que la consulta a Renfe es imposible
// y los tiles del mapa se bloquean por falta de cabecera Referer.
function isOpenedFromFileProtocol() {
  return window.location.protocol === "file:";
}

async function updateTrains() {
  // Si ya había datos y esta actualización falla, se conservan (stale).
  const hayDatosPrevios = currentTrains.length > 0;
  showConnectionStatus("updating");

  try {
    const payload = await fetchTrains();
    const trains = extractTrains(payload);

    // El buscador y los filtros trabajan siempre sobre los datos más
    // recientes: se guarda la MISMA referencia del array sincronizado.
    currentTrains = trains;

    // Índice trainId -> datos (acceso directo, sin recorrer el array).
    trainsById.clear();
    for (const train of trains) trainsById.set(train.tripId, train);

    syncMarkers(trains);

    // Filtros/leyenda/contador/búsqueda con los datos nuevos.
    renderizarFiltrosServicio();
    aplicarFiltros();

    showLastUpdate(payload.feedTimestamp);
    showConnectionStatus("connected");

    // Seguimiento: se actualiza la posición (sin re-hacer zoom) o se
    // detiene si el tren ha desaparecido de los datos.
    actualizarSeguimiento();

    // Ficha móvil abierta: se refresca o se cierra si el tren desapareció.
    if (fichaAbiertaTripId) actualizarFichaSiAbierta();

    console.log(
      `[RENFE LIVE] ${trains.length} trenes · última actualización del feed: ${payload.feedTimestamp}` +
        (payload.gtfsLoadedAt ? ` · GTFS estático: ${payload.gtfsLoadedAt}` : "")
    );
  } catch (error) {
    handleFetchError(error, hayDatosPrevios);
  }
}

function start() {
  initMap();
  initSearch(); // el buscador se inicializa siempre (funciona con o sin datos)
  initFiltros(); // filtros de servicio y retraso
  initLeyenda(); // leyenda desplegable de colores
  initPanelTrenes(); // panel lateral "☰ Trenes"
  initSeguimiento(); // modo seguir tren + botón de la barra
  initFichaMovil(); // bottom sheet de móvil
  initAccionesFicha(); // botones Seguir tren / Ver recorrido (delegación)
  initAtajosTeclado(); // Escape cierra panel/ficha/leyenda

  if (isOpenedFromFileProtocol()) {
    const message =
      "Estás abriendo index.html directamente (file://). " +
      "Ejecuta 'npm start' en la carpeta del proyecto y abre http://localhost:3000 en el navegador.";

    console.error("[RENFE LIVE] " + message);
    showConnectionStatus("error", message);
    return; // sin backend local no tiene sentido refrescar
  }

  updateTrains(); // primera carga inmediata
  setInterval(updateTrains, REFRESH_INTERVAL_MS); // refresco cada 15 s
}

/* -----------------------------------------------------------------------
 * 12. Búsqueda de trenes
 *
 * Trabaja SIEMPRE sobre currentTrains (los datos ya cargados en memoria),
 * sin volver a pedir nada a Renfe al escribir. Reutiliza trainMarkers para
 * localizar el marcador y su popup existente.
 * -------------------------------------------------------------------- */

// Límite de resultados visibles y comportamiento de selección.
const SEARCH_MAX_RESULTS = 10;
const SEARCH_ZOOM_LEVEL = 12; // zoom al centrar sobre un tren
const SEARCH_HIGHLIGHT_MS = 1500; // duración del resaltado del marcador

let searchHighlightTimer = null; // temporizador del resaltado

/**
 * Normaliza texto para comparar ignorando mayúsculas/minúsculas y acentos.
 * (NFD separa el acento del carácter base y se eliminan los diacríticos.)
 */
function normalizarTexto(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Busca trenes por número, servicio, origen, destino o estación del recorrido.
 * Devuelve como máximo SEARCH_MAX_RESULTS trenes, ordenados por prioridad:
 *   1) número exacto  2) número parcial  3) origen/destino
 *   4) estación del recorrido  5) servicio
 *
 * Sólo se buscan trenes que superan los FILTROS ACTIVOS (servicio/retraso).
 * Se trabaja sobre currentTrains en memoria: sin peticiones al backend.
 */
function buscarTrenes(consulta) {
  const query = normalizarTexto(consulta).trim();
  if (!query) return [];

  const coincidencias = [];

  for (const train of currentTrains) {
    if (!pasaFiltros(train)) continue; // el buscador respeta los filtros

    let categoria = null; // 1..5, cuanto menor mayor prioridad

    // 1 y 2) Número de tren: exacto tiene prioridad sobre parcial.
    const numero = normalizarTexto(train.trainNumber);
    if (numero) {
      if (numero === query) categoria = 1;
      else if (numero.includes(query)) categoria = 2;
    }

    // 3) Origen o destino.
    const origen = normalizarTexto(train.origin?.name);
    const destino = normalizarTexto(train.destination?.name);
    if ((origen && origen.includes(query)) || (destino && destino.includes(query))) {
      categoria = categoria === null ? 3 : Math.min(categoria, 3);
    }

    // 4) Cualquier estación/parada del recorrido.
    const enRecorrido = (train.route ?? []).some((stop) => {
      const nombre = normalizarTexto(stop.name);
      return nombre && nombre.includes(query);
    });
    if (enRecorrido) {
      categoria = categoria === null ? 4 : Math.min(categoria, 4);
    }

    // 5) Tipo de servicio.
    const servicio = normalizarTexto(train.service);
    if (servicio && servicio.includes(query)) {
      categoria = categoria === null ? 5 : Math.min(categoria, 5);
    }

    if (categoria !== null) {
      coincidencias.push({ train, categoria });
    }
  }

  // Orden por prioridad y, dentro de la misma, por número de tren.
  coincidencias.sort((a, b) => {
    if (a.categoria !== b.categoria) return a.categoria - b.categoria;
    return String(a.train.trainNumber ?? "").localeCompare(String(b.train.trainNumber ?? ""));
  });

  return coincidencias.slice(0, SEARCH_MAX_RESULTS).map((c) => c.train);
}

/** Construye el HTML de un resultado SOLO con datos reales del tren. */
function buildSearchItemHtml(train) {
  const titulo = train.trainNumber
    ? `🚄 ${escapeHtml(String(train.trainNumber))}`
    : `🚄 Viaje ${escapeHtml(String(train.tripId))}`;

  const servicio = train.service
    ? `<div class="search__item-service">${escapeHtml(String(train.service))}</div>`
    : "";

  // Origen → destino (solo si están disponibles).
  const origen = train.origin?.name ?? "";
  const destino = train.destination?.name ?? "";
  const trayecto =
    origen || destino
      ? `<div class="search__item-route">${escapeHtml(String(origen))}${
          origen && destino ? " → " : ""
        }${escapeHtml(String(destino))}</div>`
      : "";

  // Retraso (solo si lo hay).
  const retraso = formatDelay(train.delaySeconds);
  const retrasoHtml = retraso
    ? `<div class="search__item-delay">${escapeHtml(retraso)}</div>`
    : "";

  return `<div class="search__item-main">${titulo}</div>${servicio}${trayecto}${retrasoHtml}`;
}

/** Pinta la lista de sugerencias bajo el campo de búsqueda. */
function renderizarResultadosBusqueda(resultados) {
  const lista = document.getElementById("search-results");
  const input = document.getElementById("search-input");
  const consulta = input.value;

  lista.innerHTML = "";

  // Sin consulta: se oculta la lista.
  if (!normalizarTexto(consulta).trim()) {
    searchResults = [];
    searchSelectedIndex = -1;
    lista.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }

  searchResults = resultados;
  searchSelectedIndex = -1; // se resetea el resaltado al re-renderizar

  // Sin coincidencias: mensaje solicitado.
  if (resultados.length === 0) {
    const item = document.createElement("li");
    item.className = "search__empty";
    item.setAttribute("role", "option");
    item.setAttribute("aria-disabled", "true");
    item.textContent = "No se encontraron trenes";
    lista.appendChild(item);
    lista.hidden = false;
    input.setAttribute("aria-expanded", "true");
    return;
  }

  resultados.forEach((train, index) => {
    const item = document.createElement("li");
    item.className = "search__item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.innerHTML = buildSearchItemHtml(train);

    // Ratón: al pasar por encima se resalta; al pulsar se selecciona.
    item.addEventListener("mouseenter", () => {
      searchSelectedIndex = index;
      marcarSeleccionVisual();
    });
    item.addEventListener("mousedown", (event) => {
      // mousedown (no click) para que el blur del input no cierre la
      // lista antes de procesar la selección.
      event.preventDefault();
      seleccionarTren(train.tripId);
    });

    lista.appendChild(item);
  });

  lista.hidden = false;
  document.getElementById("search-input").setAttribute("aria-expanded", "true");
}

/** Selecciona un tren: centra el mapa, abre su ficha/popup y resalta el marcador. */
function seleccionarTren(tripId) {
  const train = trainsById.get(tripId) ?? currentTrains.find((t) => t.tripId === tripId);
  const marker = trainMarkers.get(tripId);

  // Si el tren ya no está (desapareció del feed), solo se cierra la lista.
  if (!train || !marker) {
    cerrarResultadosBusqueda();
    return;
  }

  centrarEnTren(train);
  resaltarMarcador(marker, train);

  // Se abre el popup EXISTENTE del marcador (escritorio) o la ficha
  // inferior (móvil); no se crea ningún popup nuevo.
  if (esMovil()) {
    abrirFichaMovil(train.tripId);
  } else {
    abrirPopupDelMarcador(marker, train.tripId);
  }

  cerrarResultadosBusqueda();
}

/** Abre el popup existente del marcador; si no lo tiene, lo crea aquí. */
function abrirPopupDelMarcador(marker, tripId) {
  if (!marker.getPopup()) {
    const train = trainsById.get(tripId);
    if (train) marker.bindPopup(buildPopupContent(train));
  }
  marker.openPopup();
}

/** Centra y hace zoom en la posición actual del tren. */
function centrarEnTren(train) {
  // Se marca como movimiento interno para que el zoom del usuario siga
  // distinguiéndose del nuestro (no se cancela el seguimiento por esto).
  zoomInternoPendiente = true;
  map.setView([train.latitude, train.longitude], SEARCH_ZOOM_LEVEL, { animate: true });
  clearTimeout(zoomInternoTimer);
  zoomInternoTimer = setTimeout(() => {
    zoomInternoPendiente = false;
  }, 800);
}

/** Resalta temporalmente el marcador y luego restaura su estilo original. */
function resaltarMarcador(marker, train) {
  if (searchHighlightTimer) {
    clearTimeout(searchHighlightTimer);
    searchHighlightTimer = null;
  }

  const estiloOriginal = markerStyleFor(train); // estilo base (servicio + retraso)

  marker.setStyle({ radius: 12, color: "#0f172a", weight: 3, fillOpacity: 1 });
  marker.bringToFront();

  searchHighlightTimer = setTimeout(() => {
    marker.setStyle(estiloOriginal);
    searchHighlightTimer = null;
  }, SEARCH_HIGHLIGHT_MS);
}

/** Mueve el resaltado con las flechas del teclado. */
function navegarResultados(paso) {
  const lista = document.getElementById("search-results");

  // Si la lista no está visible aún, se abre con la consulta actual.
  if (lista.hidden) {
    renderizarResultadosBusqueda(buscarTrenes(document.getElementById("search-input").value));
  }

  if (searchResults.length === 0) return;

  searchSelectedIndex += paso;

  // Navegación circular.
  if (searchSelectedIndex < 0) searchSelectedIndex = searchResults.length - 1;
  if (searchSelectedIndex >= searchResults.length) searchSelectedIndex = 0;

  marcarSeleccionVisual();
}

/** Aplica la clase visual al resultado resaltado por el teclado/ratón. */
function marcarSeleccionVisual() {
  const lista = document.getElementById("search-results");
  const items = lista.querySelectorAll(".search__item");

  items.forEach((item, index) => {
    const seleccionado = index === searchSelectedIndex;
    item.classList.toggle("search__item--selected", seleccionado);
    item.setAttribute("aria-selected", String(seleccionado));
  });

  // Asegura que el elemento resaltado sea visible dentro del scroll.
  const seleccionado = lista.querySelector(".search__item--selected");
  if (seleccionado) seleccionado.scrollIntoView({ block: "nearest" });
}

/** Cierra la lista de sugerencias. */
function cerrarResultadosBusqueda() {
  document.getElementById("search-results").hidden = true;
  searchSelectedIndex = -1;
}

/** Refresca la búsqueda abierta cuando llegan datos nuevos (cada 15 s). */
function refrescarBusquedaSiActiva() {
  const input = document.getElementById("search-input");
  if (!input) return;

  if (!normalizarTexto(input.value).trim()) return; // sin consulta, nada que refrescar

  renderizarResultadosBusqueda(buscarTrenes(input.value));
}

/** Conecta los eventos del campo de búsqueda (ratón y teclado). */
function initSearch() {
  const input = document.getElementById("search-input");
  const lista = document.getElementById("search-results");

  // Mientras el usuario escribe: se muestran sugerencias.
  input.addEventListener("input", () => {
    renderizarResultadosBusqueda(buscarTrenes(input.value));
  });

  // Navegación y acciones con teclado.
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navegarResultados(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      navegarResultados(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Si hay un resultado resaltado se toma ese; si no, el primero.
      const index = searchSelectedIndex >= 0 ? searchSelectedIndex : 0;
      if (searchResults[index]) seleccionarTren(searchResults[index].tripId);
    } else if (event.key === "Escape") {
      cerrarResultadosBusqueda();
    }
  });

  // Se cierra al perder el foco (por ejemplo, al pulsar en el mapa),
  // con un pequeño retardo para permitir el mousedown de los resultados.
  input.addEventListener("blur", () => {
    setTimeout(cerrarResultadosBusqueda, 150);
  });

  // Al volver a enfocar con texto ya escrito, se reabren las sugerencias.
  input.addEventListener("focus", () => {
    if (input.value.trim()) {
      renderizarResultadosBusqueda(buscarTrenes(input.value));
    }
  });

  // Evita que el mousedown dentro de la lista mueva el foco del input.
  lista.addEventListener("mousedown", (event) => event.preventDefault());
}

/* -----------------------------------------------------------------------
 * 13. Filtros por servicio y por retraso (FASE 3)
 *
 * - Los servicios se generan SIEMPRE de los datos reales cargados
 *   (nada de listas fijas AVE/ALVIA...): ver renderizarFiltrosServicio().
 * - Umbrales de retraso (segundos), interpretación documentada:
 *     "Sin información" -> delaySeconds null (dato no disponible; no se inventa)
 *     "En hora"         -> retraso < 5 min (incluye 0 y adelantos negativos)
 *     "+5 min"          -> 5 min <= retraso < 15 min
 *     "+15 min"         -> 15 min <= retraso < 30 min
 *     "+30 min"         -> retraso >= 30 min
 * -------------------------------------------------------------------- */

/** ¿Estamos en pantalla de móvil? (la ficha pasa a ser bottom sheet) */
function esMovil() {
  return window.matchMedia("(max-width: 640px)").matches;
}

/** Categoría de retraso de un tren según los umbrales documentados arriba. */
function categoriaRetraso(delaySeconds) {
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds)) {
    return "none"; // sin información fiable: no se inventa el valor
  }
  if (delaySeconds < DELAY_THRESHOLD_5_MIN) return "ontime";
  if (delaySeconds < DELAY_THRESHOLD_15_MIN) return "5";
  if (delaySeconds < DELAY_THRESHOLD_30_MIN) return "15";
  return "30";
}

/** Clave de filtro de servicio: el nombre real o "Sin servicio" si no existe. */
function claveServicio(train) {
  return train.service || SIN_SERVICIO;
}

/** ¿Pasa el tren los filtros activos (servicio y retraso)? */
function pasaFiltros(train) {
  if (disabledServices.has(claveServicio(train))) return false;
  if (delayFilter !== "all" && categoriaRetraso(train.delaySeconds) !== delayFilter) {
    return false;
  }
  return true;
}

// Clave del último conjunto de servicios renderizado (evita reconstruir
// el DOM de los chips si la lista de servicios no ha cambiado).
let serviciosRenderizados = "";

/** Genera los chips de servicio a partir de los datos reales cargados. */
function renderizarFiltrosServicio() {
  const servicios = [...new Set(currentTrains.map(claveServicio))].sort((a, b) =>
    normalizarTexto(a).localeCompare(normalizarTexto(b))
  );

  const clave = servicios.join("|");
  if (clave === serviciosRenderizados) return; // sin cambios: no se toca el DOM
  serviciosRenderizados = clave;

  // Servicios que han desaparecido de los datos se limpian del filtro.
  for (const servicio of [...disabledServices]) {
    if (!servicios.includes(servicio)) disabledServices.delete(servicio);
  }

  const contenedor = document.getElementById("service-filters");
  contenedor.innerHTML = "";

  // Chip "TODOS": activa todos los servicios.
  const todos = document.createElement("button");
  todos.type = "button";
  todos.className = "chip";
  todos.dataset.service = "__todos__";
  todos.textContent = "TODOS";
  todos.addEventListener("click", () => {
    disabledServices.clear();
    refrescarChipsServicio();
    aplicarFiltros();
  });
  contenedor.appendChild(todos);

  for (const servicio of servicios) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.service = servicio;
    chip.textContent = servicio;
    chip.addEventListener("click", () => {
      if (disabledServices.has(servicio)) disabledServices.delete(servicio);
      else disabledServices.add(servicio);
      refrescarChipsServicio();
      aplicarFiltros();
    });
    contenedor.appendChild(chip);
  }

  refrescarChipsServicio();
}

/** Actualiza el estado (aria-pressed) de los chips sin reconstruirlos. */
function refrescarChipsServicio() {
  document.querySelectorAll("#service-filters .chip").forEach((chip) => {
    const servicio = chip.dataset.service;
    const activo =
      servicio === "__todos__" ? disabledServices.size === 0 : !disabledServices.has(servicio);
    chip.setAttribute("aria-pressed", String(activo));
  });
}

/** Conecta los controles de filtros (botón desplegable + radios de retraso). */
function initFiltros() {
  const toggle = document.getElementById("filters-toggle");
  const panel = document.getElementById("filters");

  toggle.addEventListener("click", () => {
    const seAbre = panel.hidden;
    panel.hidden = !seAbre;
    toggle.setAttribute("aria-expanded", String(seAbre));
  });

  // Retraso: selección única (radios).
  document.getElementById("delay-filters").addEventListener("change", (event) => {
    if (event.target.name !== "delay-filter") return;
    delayFilter = event.target.value;
    aplicarFiltros();
  });

  // Arranque: visibles en pantallas >=768 px; ocultos en móvil (la barra
  // superior móvil no admite todo en una sola fila).
  if (window.innerWidth >= 768) {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
  }
}

/**
 * Aplica los filtros activos: visibilidad de marcadores, contador,
 * leyenda, panel lateral y refresco de la búsqueda abierta.
 * Los marcadores NO se recrean: sólo se añaden o se quitan del mapa.
 */
function aplicarFiltros() {
  visibleTripIds = new Set();
  for (const train of currentTrains) {
    if (pasaFiltros(train)) visibleTripIds.add(train.tripId);
  }

  for (const [tripId, marker] of trainMarkers) {
    const debeVerse = visibleTripIds.has(tripId);
    const enMapa = map.hasLayer(marker);
    if (debeVerse && !enMapa) marker.addTo(map);
    else if (!debeVerse && enMapa) map.removeLayer(marker);
  }

  // Un tren filtrado deja de verse: si era el que se seguía o el de la
  // ficha abierta, se deja de seguir / se cierra para no apuntar a un
  // marcador invisible (el usuario puede volver a seleccionarlo a mano).
  if (followingTripId && !visibleTripIds.has(followingTripId)) detenerSeguimiento();
  if (fichaAbiertaTripId && !visibleTripIds.has(fichaAbiertaTripId)) cerrarFichaMovil();

  actualizarContadorVisibles();
  renderizarLeyenda();
  if (panelTrenesAbierto) renderizarPanelTrenes();
  refrescarBusquedaSiActiva(); // el buscador respeta los filtros activos
}

/** Contador: visibles / total cuando hay filtros, total cuando no. */
function actualizarContadorVisibles() {
  const total = currentTrains.length;
  const visibles = visibleTripIds.size;
  const filtrando = visibles !== total;

  document.getElementById("train-count-label").textContent = filtrando
    ? "Trenes visibles"
    : "Trenes detectados";
  document.getElementById("train-count").textContent = filtrando
    ? `${visibles} / ${total}`
    : String(total);
}

/* -----------------------------------------------------------------------
 * 14. Colores de servicio y leyenda desplegable
 *
 * Color PRINCIPAL (relleno) = servicio. Color/ grosor del BORDE =
 * retraso. La paleta se asigna en orden de primera aparición y es
 * estable: un servicio no cambia de color entre actualizaciones.
 * -------------------------------------------------------------------- */

const SERVICE_PALETTE = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#ca8a04",
  "#db2777",
  "#65a30d",
  "#7c3aed",
  "#0d9488",
  "#4f46e5",
];

const serviceColors = new Map(); // servicio -> color asignado

/** Color de relleno (servicio). Sin servicio publicado -> gris neutro. */
function getServiceColor(service) {
  if (!service) return DEFAULT_MARKER_COLOR;

  let color = serviceColors.get(service);
  if (!color) {
    color = SERVICE_PALETTE[serviceColors.size % SERVICE_PALETTE.length];
    serviceColors.set(service, color);
  }
  return color;
}

/** Borde del marcador según la categoría de retraso (sin información = gris). */
function delayBorderFor(delaySeconds) {
  switch (categoriaRetraso(delaySeconds)) {
    case "ontime":
      return { color: "#ffffff", weight: 1.5 };
    case "5":
      return { color: "#fde047", weight: 2.5 };
    case "15":
      return { color: "#fb923c", weight: 3 };
    case "30":
      return { color: "#ef4444", weight: 3.5 };
    default:
      return { color: "#94a3b8", weight: 1.5 }; // sin información
  }
}

// Clave del último conjunto de servicios mostrados en la leyenda.
let leyendaServiciosClave = "";

/** Pinta la parte dinámica de la leyenda: servicios presentes y sus recuentos. */
function renderizarLeyenda() {
  const conteos = new Map();
  for (const train of currentTrains) {
    const clave = claveServicio(train);
    conteos.set(clave, (conteos.get(clave) ?? 0) + 1);
  }

  const servicios = [...conteos.keys()].sort((a, b) =>
    normalizarTexto(a).localeCompare(normalizarTexto(b))
  );

  // La clave incluye los RECUENTOS: si cambia el nº de trenes de un servicio
  // (se actualiza cada 15 s), la leyenda se repinta aunque no cambie la lista.
  const clave = servicios.map((s) => `${s}:${conteos.get(s)}`).join("|");
  if (clave === leyendaServiciosClave) return; // sin cambios: no se toca el DOM
  leyendaServiciosClave = clave;

  document.getElementById("legend-services").innerHTML = servicios
    .map((servicio) => {
      // El color debe coincidir con el del marcador: "Sin servicio" es gris.
      const color = getServiceColor(servicio === SIN_SERVICIO ? null : servicio);
      return (
        `<li class="legend__item">` +
        `<span class="legend__dot legend__dot--service" style="background:${color}"></span>` +
        `${escapeHtml(servicio)} <span class="legend__count">${conteos.get(servicio) ?? 0}</span>` +
        `</li>`
      );
    })
    .join("");
}

/** Conecta el botón de la leyenda desplegable. */
function initLeyenda() {
  const toggle = document.getElementById("legend-toggle");
  const leyenda = document.getElementById("legend");

  toggle.addEventListener("click", () => {
    const seAbre = leyenda.hidden;
    leyenda.hidden = !seAbre;
    toggle.setAttribute("aria-expanded", String(seAbre));
  });
}

/* -----------------------------------------------------------------------
 * 15. Panel lateral de trenes ("☰ Trenes")
 *
 * Lista los trenes VISIBLES según los filtros, con ordenación. Al pulsar
 * un tren: se cierra el panel, se centra el mapa, se abre el popup/ficha
 * existente y se resalta el marcador (reutiliza seleccionarTren()).
 * -------------------------------------------------------------------- */

function initPanelTrenes() {
  const toggle = document.getElementById("trains-panel-toggle");

  toggle.addEventListener("click", () => {
    if (panelTrenesAbierto) cerrarPanelTrenes(true);
    else abrirPanelTrenes();
  });

  document.getElementById("trains-panel-close").addEventListener("click", () =>
    cerrarPanelTrenes(true)
  );
  document.getElementById("trains-panel-backdrop").addEventListener("click", () =>
    cerrarPanelTrenes(true)
  );

  document.getElementById("trains-sort").addEventListener("change", (event) => {
    panelSort = event.target.value;
    renderizarPanelTrenes();
  });

  // Selección delegada: la lista se repinta y los listeners NO se duplican.
  document.getElementById("trains-panel-list").addEventListener("click", (event) => {
    const item = event.target.closest("[data-trip-id]");
    if (!item) return;
    seleccionarTren(item.dataset.tripId);
    cerrarPanelTrenes(true);
  });
}

function abrirPanelTrenes() {
  panelTrenesAbierto = true;
  const panel = document.getElementById("trains-panel");

  panel.classList.add("trains-panel--open");
  panel.setAttribute("aria-hidden", "false");
  document.getElementById("trains-panel-toggle").setAttribute("aria-expanded", "true");
  document.getElementById("trains-panel-backdrop").hidden = false;

  renderizarPanelTrenes();
  document.getElementById("trains-panel-close").focus();
}

function cerrarPanelTrenes(devolverFoco = false) {
  if (!panelTrenesAbierto) return;
  panelTrenesAbierto = false;
  const panel = document.getElementById("trains-panel");

  panel.classList.remove("trains-panel--open");
  panel.setAttribute("aria-hidden", "true");
  document.getElementById("trains-panel-toggle").setAttribute("aria-expanded", "false");
  document.getElementById("trains-panel-backdrop").hidden = true;

  if (devolverFoco) document.getElementById("trains-panel-toggle").focus();
}

/** Ordena los trenes del panel por el criterio seleccionado. */
function ordenarTrenes(trenes, criterio) {
  const copia = [...trenes];
  const cmpNum = (a, b) =>
    String(a.trainNumber ?? "").localeCompare(String(b.trainNumber ?? ""));
  const texto = (valor) => normalizarTexto(valor);

  switch (criterio) {
    case "service":
      return copia.sort(
        (a, b) =>
          texto(claveServicio(a)).localeCompare(texto(claveServicio(b))) || cmpNum(a, b)
      );

    case "delay":
      // Mayor retraso primero; los "sin información" al final.
      return copia.sort((a, b) => {
        const da = typeof a.delaySeconds === "number" ? a.delaySeconds : -Infinity;
        const db = typeof b.delaySeconds === "number" ? b.delaySeconds : -Infinity;
        if (db !== da) return db - da;
        return cmpNum(a, b);
      });

    case "origin":
      return copia.sort(
        (a, b) => texto(a.origin?.name).localeCompare(texto(b.origin?.name)) || cmpNum(a, b)
      );

    case "destination":
      return copia.sort(
        (a, b) =>
          texto(a.destination?.name).localeCompare(texto(b.destination?.name)) || cmpNum(a, b)
      );

    default: // número de tren
      return copia.sort(cmpNum);
  }
}

/** Origen → destino con los nombres reales (o "—" si faltan). */
function trayectoTexto(train) {
  const origen = train.origin?.name ?? "";
  const destino = train.destination?.name ?? "";
  if (origen && destino) return `${origen} → ${destino}`;
  return origen || destino || "—";
}

/** Pinta la lista del panel (sólo cuando el panel está abierto). */
function renderizarPanelTrenes() {
  const lista = document.getElementById("trains-panel-list");
  const trenes = currentTrains.filter((train) => visibleTripIds.has(train.tripId));

  document.getElementById("trains-panel-count").textContent = `(${trenes.length})`;

  if (trenes.length === 0) {
    lista.innerHTML =
      '<li class="trains-panel__empty">No hay trenes que superen los filtros activos</li>';
    return;
  }

  const ordenados = ordenarTrenes(trenes, panelSort);

  lista.innerHTML = ordenados
    .map((train) => {
      const { texto, clase } = retrasoTextoYClase(train.delaySeconds);
      const color = getServiceColor(train.service);

      return (
        `<li>` +
        `<button type="button" class="trains-panel__item" data-trip-id="${escapeAttr(
          train.tripId
        )}">` +
        `<span class="trains-panel__num">${escapeHtml(
          String(train.trainNumber ?? train.tripId)
        )}</span>` +
        `<span class="trains-panel__svc">` +
        `<span class="trains-panel__svc-dot" style="background:${color}"></span>` +
        `${escapeHtml(String(train.service ?? "—"))}</span>` +
        `<span class="trains-panel__delay trains-panel__delay--${clase}">${escapeHtml(
          texto
        )}</span>` +
        `<span class="trains-panel__route">${escapeHtml(trayectoTexto(train))}</span>` +
        `</button>` +
        `</li>`
      );
    })
    .join("");
}

/* -----------------------------------------------------------------------
 * 16. Modo seguir tren
 *
 * Al seguir: sólo se actualiza la POSICIÓN (panTo), nunca se re-hace zoom.
 * Se deja de seguir cuando el usuario lo pide, cuando cambia a otro tren,
 * cuando el tren desaparece de los datos o cuando el usuario mueve el mapa
 * manualmente (arrastre o zoom): así no se generan saltos constantes.
 * -------------------------------------------------------------------- */

function initSeguimiento() {
  document.getElementById("follow-stop").addEventListener("click", detenerSeguimiento);

  // Arrastre manual del mapa -> se deja de seguir (y no peleamos con él).
  map.on("dragstart", () => {
    zoomInternoPendiente = false;
    if (followingTripId) detenerSeguimiento();
  });

  // Zoom manual (rueda/pellizco) -> se deja de seguir. El zoom que hacemos
  // nosotros con setView queda marcado como interno y no cancela nada.
  map.on("zoomstart", () => {
    if (zoomInternoPendiente) {
      zoomInternoPendiente = false;
      return;
    }
    if (followingTripId) detenerSeguimiento();
  });
}

function iniciarSeguimiento(tripId) {
  const train = trainsById.get(tripId);
  if (!train) return;

  const anterior = followingTripId;
  followingTripId = tripId;

  // Centrado inicial sin cambiar el zoom (sólo pan).
  map.panTo([train.latitude, train.longitude], { animate: true });

  mostrarBarraSeguimiento(train);
  refrescarContenidoDelTren(tripId);
  if (anterior && anterior !== tripId) refrescarContenidoDelTren(anterior);
}

function detenerSeguimiento() {
  if (!followingTripId) return;

  const anterior = followingTripId;
  followingTripId = null;
  document.getElementById("follow-bar").hidden = true;
  refrescarContenidoDelTren(anterior);

  console.log("[RENFE LIVE] Seguimiento detenido");
}

function mostrarBarraSeguimiento(train) {
  const etiqueta = [train.service, train.trainNumber].filter(Boolean).join(" ");
  document.getElementById("follow-label").textContent =
    `Siguiendo: ${etiqueta || `viaje ${train.tripId}`}`;
  document.getElementById("follow-bar").hidden = false;
}

/**
 * Se ejecuta con cada actualización de datos: mantiene el mapa centrado en
 * el tren seguido (sin re-hacer zoom) o detiene el seguimiento si el tren
 * ha desaparecido de los datos recibidos.
 */
function actualizarSeguimiento() {
  if (!followingTripId) return;

  const train = trainsById.get(followingTripId);
  if (!train) {
    followingTripId = null;
    document.getElementById("follow-bar").hidden = true;
    console.log("[RENFE LIVE] El tren seguido ha desaparecido: seguimiento detenido");
    return;
  }

  mostrarBarraSeguimiento(train);
  map.panTo([train.latitude, train.longitude], { animate: true, duration: 0.6 });
}

/** Refresca el popup y la ficha móvil de un tren (botones y datos). */
function refrescarContenidoDelTren(tripId) {
  const train = trainsById.get(tripId);
  if (!train) return;

  const marker = trainMarkers.get(tripId);
  if (marker?.getPopup()) marker.setPopupContent(buildPopupContent(train));

  if (fichaAbiertaTripId === tripId) {
    document.getElementById("train-sheet-content").innerHTML = buildPopupContent(train);
  }
}

/* -----------------------------------------------------------------------
 * 17. Ficha del tren en móvil (bottom sheet)
 *
 * Sólo en móvil. Usa el MISMO contenido que el popup de escritorio
 * (buildPopupContent), así que no se duplica la información.
 * -------------------------------------------------------------------- */

function abrirFichaMovil(tripId) {
  if (!esMovil()) return;

  const train = trainsById.get(tripId);
  const marker = trainMarkers.get(tripId);
  if (!train || !marker) return;

  fichaAbiertaTripId = tripId;

  const ficha = document.getElementById("train-sheet");
  document.getElementById("train-sheet-content").innerHTML = buildPopupContent(train);
  ficha.classList.add("train-sheet--open");
  ficha.setAttribute("aria-hidden", "false");

  // Si el tren queda tapado por la hoja, se sube un poco el mapa.
  const punto = map.latLngToContainerPoint([train.latitude, train.longitude]);
  const alturaFicha = ficha.offsetHeight;
  const alturaMapa = map.getSize().y;
  const limite = alturaMapa - alturaFicha;

  if (limite > 0 && punto.y > limite - 12) {
    map.panBy([0, punto.y - (limite - 40)], { animate: true });
  }
}

function cerrarFichaMovil() {
  if (!fichaAbiertaTripId) return;

  const tripId = fichaAbiertaTripId;
  fichaAbiertaTripId = null;
  if (recorridoAbiertoTripId === tripId) recorridoAbiertoTripId = null;

  const ficha = document.getElementById("train-sheet");
  ficha.classList.remove("train-sheet--open");
  ficha.setAttribute("aria-hidden", "true");
}

/** Refresca la ficha abierta o la cierra si su tren ya no existe. */
function actualizarFichaSiAbierta() {
  const train = trainsById.get(fichaAbiertaTripId);
  if (!train) {
    cerrarFichaMovil();
    return;
  }
  document.getElementById("train-sheet-content").innerHTML = buildPopupContent(train);
}

function initFichaMovil() {
  document.getElementById("train-sheet-close").addEventListener("click", cerrarFichaMovil);

  // Un popup de Leaflet que se abra en móvil (p. ej. tras redimensionar
  // desde escritorio) se redirige a la ficha inferior.
  map.on("popupopen", (event) => {
    if (!esMovil()) return;
    const popup = event.popup;
    const entrada = [...trainMarkers].find(([, marker]) => marker.getPopup() === popup);
    if (!entrada) return;

    const [tripId] = entrada;
    map.closePopup(popup);
    abrirFichaMovil(tripId);
  });

  // Al cerrar un popup se olvida la expansión del recorrido.
  map.on("popupclose", () => {
    recorridoAbiertoTripId = null;
  });
}

/* -----------------------------------------------------------------------
 * 18. Acciones de la ficha y atajos de teclado
 *
 * Un SOLO listener global para los botones del popup/ficha: su HTML se
 * repinta cada 15 s, por lo que listeners individuales se perderían.
 * -------------------------------------------------------------------- */

function initAccionesFicha() {
  document.addEventListener("click", (event) => {
    const boton = event.target.closest?.(".train-popup__btn");
    if (!boton) return;

    const tripId = boton.dataset.tripId;
    const accion = boton.dataset.action;

    if (accion === "follow") {
      if (followingTripId === tripId) detenerSeguimiento();
      else iniciarSeguimiento(tripId);
    } else if (accion === "route") {
      const raiz = boton.closest(".train-popup");
      if (!raiz) return;

      const abierto = raiz.classList.toggle("train-popup--show-route");
      recorridoAbiertoTripId = abierto ? tripId : null;
      boton.setAttribute("aria-expanded", String(abierto));

      if (abierto) {
        raiz.querySelector(".train-popup__route")?.scrollIntoView({ block: "nearest" });
      }
    }
  });
}

function initAtajosTeclado() {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    // El campo de búsqueda gestiona su propio Escape (cierra resultados).
    if (event.target === document.getElementById("search-input")) return;

    if (panelTrenesAbierto) {
      cerrarPanelTrenes(true);
      return;
    }
    if (fichaAbiertaTripId) {
      cerrarFichaMovil();
      return;
    }

    const leyenda = document.getElementById("legend");
    if (!leyenda.hidden) {
      leyenda.hidden = true;
      document.getElementById("legend-toggle").setAttribute("aria-expanded", "false");
      return;
    }

    const filtros = document.getElementById("filters");
    if (!filtros.hidden) {
      filtros.hidden = true;
      document.getElementById("filters-toggle").setAttribute("aria-expanded", "false");
    }
  });
}

document.addEventListener("DOMContentLoaded", start);
