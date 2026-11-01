/**
 * Preprocesado del GTFS estático de Renfe para RENFE LIVE.
 *
 * Ejecutado por GitHub Actions (build diario) y en local con `npm run data`.
 *
 *   1. Descarga google_transit.zip del portal de datos abiertos de Renfe
 *   2. Valida: status HTTP, presencia de los 4 CSV necesarios
 *   3. Parsea SOLO los campos que la aplicación usa (ver abajo)
 *   4. Genera data/*.json optimizados + data/meta.json
 *   5. Valida que los JSON no estén vacíos e informa de tamaños
 *
 * Cualquier fallo termina con exit != 0 => el build NO despliega y
 * GitHub Pages conserva el último artefacto correcto.
 *
 * Salida (data/):
 *   stops.json       stopId  -> nombre real
 *   routes.json      routeId -> servicio (route_short_name)
 *   trips.json       tripId  -> [routeId, número de tren]
 *   stop_times.json  tripId  -> [[stopId, "HH:MM:SS"], ...] ordenado
 *   meta.json        builtAt + recuentos (sustituye al gtfsLoadedAt del backend)
 *
 * Usa el MISMO parser ZIP/CSV que server.js (lib/gtfs-format.js).
 * Solo módulos nativos de Node (>= 18).
 */

const fs = require("fs");
const path = require("path");

const { parseGtfsCsv, listZipEntries, extractZipEntryText } = require("../lib/gtfs-format");

// GTFS estático oficial (portal data.renfe.com, licencia CC-BY-4.0).
const RENFE_GTFS_STATIC_URL = "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip";

const REQUIRED_CSV = ["stops.txt", "trips.txt", "routes.txt", "stop_times.txt"];

const OUT_DIR = path.join(__dirname, "..", "data");

const DOWNLOAD_TIMEOUT_MS = 120000;
const DOWNLOAD_RETRIES = 3;

/* ----------------------------- utilidades ----------------------------- */

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
  return (bytes / 1024).toFixed(1) + " KB";
}

function logValidation(ok, label, detail = "") {
  console.log(`${ok ? "  ✔" : "  ✘"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(message) {
  console.error(`\n✘ BUILD CANCELADO: ${message}`);
  console.error("El último despliegue correcto de GitHub Pages permanece publicado.");
  process.exit(1);
}

/** Descarga el ZIP con reintentos. Comprueba el status HTTP. */
async function downloadGtfsZip() {
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      console.log(`[gtfs] Descargando (intento ${attempt}/${DOWNLOAD_RETRIES}): ${RENFE_GTFS_STATIC_URL}`);
      const response = await fetch(RENFE_GTFS_STATIC_URL, {
        signal: controller.signal,
        headers: { Accept: "*/*" },
      });

      if (!response.ok) {
        throw new Error(`status HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      console.log(
        `[gtfs] Descarga OK: ${formatBytes(buffer.byteLength)} en ${Date.now() - startedAt} ms`
      );

      if (buffer.byteLength < 1024) {
        throw new Error(`ZIP sospechosamente pequeño (${formatBytes(buffer.byteLength)})`);
      }

      return buffer;
    } catch (error) {
      console.error(`[gtfs] Intento ${attempt} fallido: ${error.message}`);
      if (attempt === DOWNLOAD_RETRIES) {
        fail(`no se pudo descargar el GTFS de Renfe tras ${DOWNLOAD_RETRIES} intentos (${error.message})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/* --------------------------- construcción ----------------------------- */

function buildStops(stopsCsv) {
  const out = {};
  for (const row of stopsCsv.rows) {
    const id = row[stopsCsv.index["stop_id"]];
    if (!id) continue;
    out[id] = row[stopsCsv.index["stop_name"]] ?? null;
  }
  return out;
}

function buildRoutes(routesCsv) {
  const out = {};
  for (const row of routesCsv.rows) {
    const id = row[routesCsv.index["route_id"]];
    if (!id) continue;
    out[id] = row[routesCsv.index["route_short_name"]] ?? null;
  }
  return out;
}

function buildTrips(tripsCsv) {
  const out = {};
  for (const row of tripsCsv.rows) {
    const id = row[tripsCsv.index["trip_id"]];
    if (!id) continue;
    // [routeId, número de tren]; el resto de campos no se usan.
    out[id] = [row[tripsCsv.index["route_id"]] ?? null, row[tripsCsv.index["trip_short_name"]] ?? null];
  }
  return out;
}

function buildStopTimes(stCsv) {
  const iTrip = stCsv.index["trip_id"];
  const iStop = stCsv.index["stop_id"];
  const iSeq = stCsv.index["stop_sequence"];
  const iArr = stCsv.index["arrival_time"];

  const byTrip = {};
  for (const row of stCsv.rows) {
    const tripId = row[iTrip];
    if (!tripId) continue;
    (byTrip[tripId] ??= []).push([
      row[iStop],
      row[iArr],
      Number(row[iSeq]) || 0,
    ]);
  }

  // Orden por secuencia en el BUILD (el navegador no ordena nada).
  const out = {};
  for (const [tripId, list] of Object.entries(byTrip)) {
    list.sort((a, b) => a[2] - b[2]);
    out[tripId] = list.map(([stopId, arrival]) => [stopId, arrival]);
  }
  return out;
}

function writeJson(fileName, data) {
  const filePath = path.join(OUT_DIR, fileName);
  const json = JSON.stringify(data);
  fs.writeFileSync(filePath, json, "utf8");

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes === 0) fail(`${fileName} ha quedado vacío`);
  return { fileName, bytes };
}

/* -------------------------------- main -------------------------------- */

(async () => {
  console.log("=== RENFE LIVE · preprocesado GTFS ===\n");

  // 1. Descarga con validación de status HTTP (dentro de downloadGtfsZip).
  const zipBuffer = await downloadGtfsZip();

  // 2. Validar entradas del ZIP: deben existir los 4 CSV.
  console.log("\n[gtfs] Validando el contenido del ZIP...");
  let entries;
  try {
    entries = listZipEntries(zipBuffer);
  } catch (error) {
    fail(`el ZIP no es válido: ${error.message}`);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));

  const missing = REQUIRED_CSV.filter((name) => !byName.has(name));
  logValidation(missing.length === 0, "CSV presentes", REQUIRED_CSV.join(", "));
  if (missing.length > 0) {
    fail(`el ZIP no contiene: ${missing.join(", ")}`);
  }

  // 3. Parsear solo los 4 CSV (descartamos calendar*.txt y el resto).
  console.log("\n[gtfs] Parseando CSV...");
  const parsed = {};
  for (const name of REQUIRED_CSV) {
    const startedAt = Date.now();
    parsed[name] = parseGtfsCsv(extractZipEntryText(zipBuffer, byName.get(name)));
    console.log(
      `  ${name}: ${parsed[name].rows.length} filas (${Date.now() - startedAt} ms)`
    );
    if (parsed[name].rows.length === 0) fail(`${name} no contiene filas de datos`);
  }

  // 4. Construir los JSON optimizados.
  console.log("\n[gtfs] Generando JSON optimizados...");
  const stopsById = buildStops(parsed["stops.txt"]);
  const routesById = buildRoutes(parsed["routes.txt"]);
  const tripsById = buildTrips(parsed["trips.txt"]);
  const stopTimesByTrip = buildStopTimes(parsed["stop_times.txt"]);

  // 5. Validar contenido mínimo + informar de tamaños.
  console.log("\n[gtfs] Validaciones de salida:");
  const checks = [
    ["stops.json", Object.keys(stopsById).length, "estaciones"],
    ["routes.json", Object.keys(routesById).length, "líneas"],
    ["trips.json", Object.keys(tripsById).length, "viajes"],
    ["stop_times.json", Object.keys(stopTimesByTrip).length, "recorridos"],
  ];
  for (const [name, count, label] of checks) {
    logValidation(count > 0, name, `${count} ${label}`);
    if (count === 0) fail(`${name} estaría vacío (0 ${label})`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [
    writeJson("stops.json", stopsById),
    writeJson("routes.json", routesById),
    writeJson("trips.json", tripsById),
    writeJson("stop_times.json", stopTimesByTrip),
    writeJson("meta.json", {
      builtAt: new Date().toISOString(),
      source: RENFE_GTFS_STATIC_URL,
      counts: {
        stops: Object.keys(stopsById).length,
        routes: Object.keys(routesById).length,
        trips: Object.keys(tripsById).length,
        stopTimes: Object.keys(stopTimesByTrip).length,
      },
    }),
  ];

  console.log("\n[gtfs] Tamaños de salida:");
  let total = 0;
  for (const { fileName, bytes } of written) {
    total += bytes;
    console.log(`  ${fileName.padEnd(16)} ${formatBytes(bytes).padStart(10)}`);
  }
  console.log(`  ${"TOTAL".padEnd(16)} ${formatBytes(total).padStart(10)}`);
  console.log(
    "\n✔ Preprocesado completado. GitHub Pages servirá estos JSON con gzip" +
      " (~160 KB transferidos por visitante, una sola vez)."
  );
})().catch((error) => {
  fail(`error inesperado: ${error.stack || error.message}`);
});
