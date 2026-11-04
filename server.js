/**
 * Backend local de RENFE LIVE.
 *
 * Arquitectura:
 *   Navegador  ->  este servidor Node.js  ->  Renfe GTFS-Realtime
 *                                       \->  Renfe GTFS estatico
 *
 * El servidor de Renfe no envia la cabecera "Access-Control-Allow-Origin",
 * por lo que el navegador no puede leer los feeds directamente. Quien
 * consulta a Renfe es este backend, que devuelve los datos ya resueltos.
 *
 * FASE 2: ademas de vehicle_positions, se consulta trip_updates y se
 * resuelven los identificadores (stopId, tripId, routeId) con el GTFS
 * estatico oficial de Renfe, para poder mostrar nombres de estaciones,
 * origen, destino y recorrido sin inventar nada.
 *
 * No usa dependencias externas: solo modulos nativos de Node.js (>= 18).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// Lógica de formatos GTFS compartida con scripts/build-gtfs.js (GitHub Actions),
// para que local y producción lean el zip de Renfe con EXACTAMENTE el mismo parser.
const { parseGtfsCsv, listZipEntries, extractZipEntryText } = require("./lib/gtfs-format");

const PORT = process.env.PORT || 3000;

// --- Fuentes de datos oficiales de Renfe ---
const RENFE_VEHICLE_POSITIONS_URL =
  "https://gtfsrt.renfe.com/vehicle_positions_LD.json";
const RENFE_TRIP_UPDATES_URL =
  "https://gtfsrt.renfe.com/trip_updates_LD.json";
// GTFS estatico oficial (portal data.renfe.com, licencia CC-BY-4.0).
const RENFE_GTFS_STATIC_URL =
  "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip";

const FEED_TIMEOUT_MS = 10000;
const GTFS_REFRESH_MS = 24 * 60 * 60 * 1000; // el GTFS estatico se actualiza a diario

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const STATIC_ROOT = __dirname;

/* =========================================================================
 * 1. Utilidades generales
 * ====================================================================== */

/** Descarga una URL con timeout. Devuelve el Buffer de la respuesta. */
async function fetchBuffer(url, timeoutMs = FEED_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "*/*" },
    });

    if (!response.ok) {
      throw new Error(`${url} respondio con estado HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

/** Descarga y parsea un feed GTFS-RT JSON. */
async function fetchGtfsRt(url, timeoutMs = FEED_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`${url} respondio con estado HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================================
 * 3. GTFS estatico: carga y construccion de indices
 *
 * Se resuelven los identificadores que los feeds GTFS-RT NO incluyen:
 *   stopId   -> nombre real de la estacion   (stops.txt)
 *   tripId   -> route_id y numero de tren     (trips.txt)
 *   routeId  -> servicio/linea                (routes.txt)
 *   tripId   -> recorrido y horarios          (stop_times.txt)
 *
 * El parser CSV/ZIP vive en lib/gtfs-format.js (compartido con el build
 * de GitHub Actions).
 * ====================================================================== */

let gtfs = null; // { stops, trips, routes, stopTimes, loadedAt } o null

/** Descarga, descomprime e indexa el GTFS estatico oficial de Renfe. */
async function loadGtfsStatic() {
  console.log("[gtfs] Descargando GTFS estatico de Renfe...");
  const startedAt = Date.now();

  const zipBuffer = await fetchBuffer(RENFE_GTFS_STATIC_URL, 60000);
  const entries = listZipEntries(zipBuffer);
  const byName = new Map(entries.map((e) => [e.name, e]));

  for (const needed of ["stops.txt", "trips.txt", "routes.txt", "stop_times.txt"]) {
    if (!byName.has(needed)) {
      throw new Error(`GTFS estatico sin ${needed}`);
    }
  }

  // --- stops.txt: stop_id -> nombre y coordenadas ---
  const stops = new Map();
  const stopsCsv = parseGtfsCsv(extractZipEntryText(zipBuffer, byName.get("stops.txt")));
  for (const row of stopsCsv.rows) {
    const id = row[stopsCsv.index["stop_id"]];
    if (!id) continue;
    stops.set(id, {
      name: row[stopsCsv.index["stop_name"]],
      lat: row[stopsCsv.index["stop_lat"]],
      lon: row[stopsCsv.index["stop_lon"]],
    });
  }

  // --- trips.txt: trip_id -> route_id y numero de tren (trip_short_name) ---
  const trips = new Map();
  const tripsCsv = parseGtfsCsv(extractZipEntryText(zipBuffer, byName.get("trips.txt")));
  for (const row of tripsCsv.rows) {
    const id = row[tripsCsv.index["trip_id"]];
    if (!id) continue;
    trips.set(id, {
      routeId: row[tripsCsv.index["route_id"]],
      shortName: row[tripsCsv.index["trip_short_name"]],
    });
  }

  // --- routes.txt: route_id -> servicio (route_short_name) y tipo ---
  const routes = new Map();
  const routesCsv = parseGtfsCsv(extractZipEntryText(zipBuffer, byName.get("routes.txt")));
  for (const row of routesCsv.rows) {
    const id = row[routesCsv.index["route_id"]];
    if (!id) continue;
    routes.set(id, {
      shortName: row[routesCsv.index["route_short_name"]],
      longName: row[routesCsv.index["route_long_name"]],
      type: row[routesCsv.index["route_type"]],
    });
  }

  // --- stop_times.txt: trip_id -> recorrido ordenado con horarios ---
  const stopTimes = new Map();
  const stCsv = parseGtfsCsv(extractZipEntryText(zipBuffer, byName.get("stop_times.txt")));
  const iTrip = stCsv.index["trip_id"];
  const iStop = stCsv.index["stop_id"];
  const iSeq = stCsv.index["stop_sequence"];
  const iArr = stCsv.index["arrival_time"];
  const iDep = stCsv.index["departure_time"];

  for (const row of stCsv.rows) {
    const tripId = row[iTrip];
    if (!tripId) continue;

    if (!stopTimes.has(tripId)) stopTimes.set(tripId, []);
    stopTimes.get(tripId).push({
      stopId: row[iStop],
      sequence: row[iSeq],
      arrival: row[iArr],
      departure: row[iDep],
    });
  }

  // Cada recorrido queda ordenado por secuencia.
  for (const list of stopTimes.values()) {
    list.sort((a, b) => String(a.sequence).localeCompare(String(b.sequence)));
  }

  gtfs = { stops, trips, routes, stopTimes, loadedAt: new Date().toISOString() };

  console.log(
    `[gtfs] Cargado en ${Date.now() - startedAt} ms -> ` +
      `${stops.size} estaciones, ${trips.size} viajes, ${routes.size} lineas, ` +
      `${stopTimes.size} recorridos`
  );
}

/* =========================================================================
 * 4. Construccion de la respuesta enriquecida de trenes
 * ====================================================================== */

/** Valida que una posicion GPS sea utilizable. */
function isValidPosition(position) {
  if (!position) return false;

  const { latitude, longitude } = position;

  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/** Devuelve el nombre real de una estacion si el GTFS lo conoce. */
function resolveStopName(stopId) {
  if (!gtfs || !stopId) return null;
  return gtfs.stops.get(stopId)?.name ?? null;
}

/* ------------------------------------------------------------------------
 * 4b. Hora de llegada "buena": GTFS + delay (arreglo del feed RT de Renfe)
 *
 * Espejo de la seccion 4b de app.js. El arrival.time de trip_updates llega
 * roto (74% de trenes con hora ya pasada); el delay es fiable y el GTFS es
 * correcto, asi que la hora buena es: hora GTFS + delay. El arrival.time
 * del RT solo se usa de fallback cuando el GTFS no conoce la parada.
 * --------------------------------------------------------------------- */

// Delay fuera de estos limites = dato corrupto del feed: se ignora.
const DELAY_MAXIMO_S = 6 * 3600; // mas de 6 h: imposible
const DELAY_MINIMO_S = -30 * 60; // mas de 30 min de adelanto: imposible

/** Offset (ms) de Europe/Madrid para un instante epoch (ms). */
function offsetMadridMs(epochMs) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const partes = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) partes[part.type] = part.value;
  const comoUtc = Date.UTC(
    +partes.year,
    +partes.month - 1,
    +partes.day,
    partes.hour === "24" ? 0 : +partes.hour,
    +partes.minute,
    +partes.second
  );
  return comoUtc - epochMs;
}

/**
 * Hora GTFS local ("HH:MM:SS", puede ser >=24 = dia siguiente) -> epoch
 * segundos en la fecha de servicio indicada (YYYY-MM-DD, del tripId),
 * con offset Europe/Madrid (CET/CEST). Devuelve null si falta algun dato.
 */
function gtfsHoraAEpoch(horaGtfs, fechaServicio) {
  if (!horaGtfs || !fechaServicio) return null;

  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(String(horaGtfs).trim());
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaServicio);
  if (!m || !f) return null;

  let horas = +m[1];
  const minutos = +m[2];
  const diasExtra = Math.floor(horas / 24);
  horas -= diasExtra * 24;

  const naive = Date.UTC(+f[1], +f[2] - 1, +f[3] + diasExtra, horas, minutos, +(m[3] ?? 0));
  // Dos pasadas por si el instante cae cerca del cambio de hora (DST).
  const off1 = offsetMadridMs(naive);
  const cand1 = naive - off1;
  const off2 = offsetMadridMs(cand1);
  const epochMs = off2 === off1 ? cand1 : naive - off2;
  return Math.floor(epochMs / 1000);
}

/** Delay creible del feed; fuera de rango devuelve null (se ignora). */
function delayCreible(delay) {
  const d = Number(delay);
  if (!Number.isFinite(d) || d > DELAY_MAXIMO_S || d < DELAY_MINIMO_S) return null;
  return d;
}

/**
 * Llegada prevista de una parada: hora GTFS + delay (fiable).
 * Si el GTFS no conoce la parada, fallback al arrival.time del RT.
 */
function llegadaPrevista(horaGtfs, fechaServicio, delay, arrivalRt) {
  const epochGtfs = gtfsHoraAEpoch(horaGtfs, fechaServicio);
  if (epochGtfs !== null) {
    return epochGtfs + (delayCreible(delay) ?? 0);
  }
  return arrivalRt?.time ? Number(arrivalRt.time) : null;
}

/**
 * Combina vehicle_positions + trip_updates + GTFS estatico.
 * Relacion: tripId (vehicle) == tripId (tripUpdate).
 * El GTFS estatico aporta los nombres y el recorrido programado.
 */
async function buildEnrichedTrains() {
  const [vehicleFeed, tripFeed] = await Promise.all([
    fetchGtfsRt(RENFE_VEHICLE_POSITIONS_URL),
    fetchGtfsRt(RENFE_TRIP_UPDATES_URL),
  ]);

  // Indice de actualizaciones por tripId para relacionar con las posiciones.
  const updatesByTripId = new Map();
  for (const entity of tripFeed?.entity ?? []) {
    const update = entity.tripUpdate;
    const tripId = update?.trip?.tripId;
    if (tripId) updatesByTripId.set(tripId, update);
  }

  const trains = [];
  const entities = Array.isArray(vehicleFeed?.entity) ? vehicleFeed.entity : [];

  for (const entity of entities) {
    const vehicle = entity.vehicle;
    const tripId = vehicle?.trip?.tripId;

    if (!tripId || !isValidPosition(vehicle?.position)) continue;

    const update = updatesByTripId.get(tripId) ?? null;
    const stopTimeUpdates = update?.stopTimeUpdate ?? [];

    // Mapa de paradas del viaje segun el feed en tiempo real.
    const updateByStopId = new Map();
    const skippedStopIds = new Set();

    for (const stu of stopTimeUpdates) {
      if (stu?.stopId) updateByStopId.set(stu.stopId, stu);
      if (stu?.scheduleRelationship === "SKIPPED" && stu?.stopId) {
        skippedStopIds.add(stu.stopId);
      }
    }

    // --- GTFS estatico: servicio, numero de tren, origen, destino, recorrido ---
    const gtfsTrip = gtfs?.trips.get(tripId) ?? null;
    const service = gtfsTrip ? gtfs.routes.get(gtfsTrip.routeId) : null;
    const scheduledStops = gtfs?.stopTimes.get(tripId) ?? [];

    const originStopId = scheduledStops.length > 0 ? scheduledStops[0].stopId : null;
    const destinationStopId =
      scheduledStops.length > 0 ? scheduledStops[scheduledStops.length - 1].stopId : null;

    // --- Proxima parada: el stopId del feed en tiempo real ---
    const currentStopId = vehicle?.stopId ?? null;
    const currentUpdate = currentStopId ? updateByStopId.get(currentStopId) : null;

    // Llegada prevista y retraso: del stopTimeUpdate de la proxima parada.
    const liveArrival = currentUpdate?.arrival ?? null;
    const delaySeconds =
      typeof liveArrival?.delay === "number"
        ? liveArrival.delay
        : typeof update?.delay === "number"
          ? update.delay
          : null;

    // Fecha de servicio del viaje (el tripId termina en YYYY-MM-DD):
    // necesaria para convertir horas GTFS locales a timestamps epoch.
    const fechaServicio = /(\d{4}-\d{2}-\d{2})$/.exec(tripId)?.[1] ?? null;

    // Recorrido completo con nombres reales (solo si el GTFS lo conoce).
    const route = scheduledStops.map((stop) => {
      const liveUpdate = updateByStopId.get(stop.stopId) ?? null;
      const delayParada =
        typeof liveUpdate?.arrival?.delay === "number"
          ? liveUpdate.arrival.delay
          : delaySeconds;
      return {
        stopId: stop.stopId,
        name: resolveStopName(stop.stopId),
        scheduledArrival: stop.arrival || null,
        // Hora "buena": GTFS + delay creible (arrival.time del RT roto;
        // fallback al RT solo si el GTFS no conoce la parada).
        liveArrival: liveUpdate?.arrival
          ? llegadaPrevista(stop.arrival || null, fechaServicio, delayParada, liveUpdate.arrival)
          : null,
        skipped: skippedStopIds.has(stop.stopId),
      };
    });

    trains.push({
      // Identificadores tecnicos (se conservan internamente).
      tripId,
      stopId: currentStopId,

      // Numero de tren y servicio, del GTFS estatico cuando esta disponible.
      trainNumber: gtfsTrip?.shortName || vehicle?.vehicle?.id || null,
      service: service?.shortName || null,

      // Origen y destino resueltos con nombres reales del GTFS estatico.
      origin: originStopId ? { stopId: originStopId, name: resolveStopName(originStopId) } : null,
      destination: destinationStopId
        ? { stopId: destinationStopId, name: resolveStopName(destinationStopId) }
        : null,

      // Proxima parada y su llegada prevista: hora GTFS + delay creible
      // (el arrival.time del RT esta roto; fallback al RT solo si el GTFS
      // no conoce la parada).
      nextStop: currentStopId
        ? { stopId: currentStopId, name: resolveStopName(currentStopId) }
        : null,
      nextStopArrival: llegadaPrevista(
        currentStopId
          ? scheduledStops.find((stop) => stop.stopId === currentStopId)?.arrival ?? null
          : null,
        fechaServicio,
        delaySeconds,
        liveArrival
      ),
      delaySeconds,

      // Estado y posicion GPS.
      currentStatus: vehicle?.currentStatus ?? null,
      latitude: vehicle.position.latitude,
      longitude: vehicle.position.longitude,

      // Recorrido del viaje con nombres reales.
      route,
    });
  }

  return {
    trains,
    feedTimestamp: vehicleFeed?.header?.timestamp ?? null,
    gtfsLoadedAt: gtfs?.loadedAt ?? null,
  };
}

/* =========================================================================
 * 5. Servidor HTTP: estaticos + endpoints de datos
 * ====================================================================== */

/** Sirve un archivo estatico del directorio de la aplicacion. */
function serveStaticFile(requestPath, response) {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.join(STATIC_ROOT, relativePath);

  // Proteccion basica: no salir del directorio de la aplicacion.
  if (!filePath.startsWith(STATIC_ROOT)) {
    response.writeHead(403);
    response.end("403 Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("404 Not Found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}

/** Envia una respuesta JSON con cabeceras adecuadas. */
function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method !== "GET") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("405 Method Not Allowed");
    return;
  }

  // Trenes enriquecidos: posiciones + viajes + nombres del GTFS estatico.
  if (url.pathname === "/api/trains") {
    try {
      const payload = await buildEnrichedTrains();
      sendJson(response, 200, payload);
    } catch (error) {
      console.error("[api] Error construyendo /api/trains:", error.message);
      sendJson(response, 502, { error: "No se pudieron obtener los datos de Renfe." });
    }
    return;
  }

  // Solo posiciones (util para diagnostico, sin enriquecer).
  if (url.pathname === "/api/vehicle-positions") {
    try {
      const data = await fetchGtfsRt(RENFE_VEHICLE_POSITIONS_URL);
      sendJson(response, 200, data);
    } catch (error) {
      console.error("[api] Error consultando vehicle_positions:", error.message);
      sendJson(response, 502, { error: "No se pudo consultar el feed de Renfe." });
    }
    return;
  }

  // Solo trip_updates (util para diagnostico y para el join del navegador).
  if (url.pathname === "/api/trip-updates") {
    try {
      const data = await fetchGtfsRt(RENFE_TRIP_UPDATES_URL);
      sendJson(response, 200, data);
    } catch (error) {
      console.error("[api] Error consultando trip_updates:", error.message);
      sendJson(response, 502, { error: "No se pudo consultar el feed de Renfe." });
    }
    return;
  }

  serveStaticFile(url.pathname, response);
});

/* =========================================================================
 * 6. Arranque
 * ====================================================================== */

server.listen(PORT, () => {
  console.log(`RENFE LIVE ejecutandose en http://localhost:${PORT}`);
  console.log(`Trenes enriquecidos en http://localhost:${PORT}/api/trains`);

  // El GTFS estatico se carga en segundo plano para no bloquear el arranque.
  loadGtfsStatic().catch((error) => {
    console.error("[gtfs] No se pudo cargar el GTFS estatico:", error.message);
    console.error("[gtfs] Se reintentara en 1 hora (los trenes se mostraran sin nombres).");
  });

  // Refresco periodico del GTFS estatico (se publica a diario).
  setInterval(() => {
    loadGtfsStatic().catch((error) => {
      console.error("[gtfs] Error al refrescar el GTFS estatico:", error.message);
    });
  }, GTFS_REFRESH_MS);
});
