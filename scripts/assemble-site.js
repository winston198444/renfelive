/**
 * Ensambla el artefacto estático _site/ para GitHub Pages.
 *
 * Copia el frontend (index.html, style.css, app.js) y los datos
 * preprocesados (data/*.json, generados por scripts/build-gtfs.js).
 *
 * Se ejecuta en GitHub Actions justo antes de desplegar y también en
 * local con `npm run site` (útil para revisar el artefacto completo).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SITE_DIR = path.join(ROOT, "_site");

const FRONTEND_FILES = ["index.html", "style.css", "app.js"];

function copyFile(from, toDir) {
  const target = path.join(toDir, path.basename(from));
  fs.copyFileSync(from, target);
  return fs.statSync(target).size;
}

function fail(message) {
  console.error(`\n✘ ENSAMBLADO CANCELADO: ${message}`);
  process.exit(1);
}

(function main() {
  console.log("=== RENFE LIVE · ensamblado de _site/ ===\n");

  // 1. Frontend.
  for (const file of FRONTEND_FILES) {
    const source = path.join(ROOT, file);
    if (!fs.existsSync(source)) fail(`falta el fichero ${file}`);
  }

  // 2. Datos preprocesados: obligatorios y no vacíos (build correcto).
  const dataDir = path.join(ROOT, "data");
  const requiredData = ["stops.json", "routes.json", "trips.json", "stop_times.json", "meta.json"];
  for (const file of requiredData) {
    const source = path.join(dataDir, file);
    if (!fs.existsSync(source)) {
      fail(`falta data/${file}. Ejecuta primero "npm run data" (build-gtfs.js).`);
    }
    if (fs.statSync(source).size === 0) {
      fail(`data/${file} está vacío; el preprocesado no es válido.`);
    }
  }

  // 3. Copiar todo a _site/ (limpio de sesiones anteriores).
  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE_DIR, "data"), { recursive: true });

  let total = 0;
  console.log("Frontend:");
  for (const file of FRONTEND_FILES) {
    total += copyFile(path.join(ROOT, file), SITE_DIR);
  }
  console.log(`  ${FRONTEND_FILES.join(", ")}`);

  console.log("Datos:");
  for (const file of requiredData) {
    total += copyFile(path.join(dataDir, file), path.join(SITE_DIR, "data"));
  }
  console.log(`  data/{${requiredData.join(", ")}}`);

  console.log(`\n✔ _site/ listo: ${(total / 1024).toFixed(1)} KB (sin comprimir).`);
})();
