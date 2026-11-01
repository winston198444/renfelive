/**
 * Formatos GTFS compartidos por RENFE LIVE.
 *
 * Este módulo contiene la lógica PURA de lectura del GTFS estático de
 * Renfe (google_transit.zip): extractor de ZIP sin dependencias y parser
 * CSV con comillas. La comparten:
 *
 *   - server.js        -> desarrollo local (npm start)
 *   - scripts/build-gtfs.js -> preprocesado en GitHub Actions
 *
 * Así el parser de formatos existe en UN solo sitio y local/producción
 * leen exactamente lo mismo. Solo usa módulos nativos de Node (>= 18).
 */

const zlib = require("zlib");

/* -----------------------------------------------------------------------
 * CSV GTFS (campos entre comillas)
 * -------------------------------------------------------------------- */

/** Parser CSV que respeta campos entre comillas (formato GTFS). */
function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result;
}

/** Convierte el texto de un fichero GTFS en filas + índice de columnas. */
function parseGtfsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], header: [], index: {} };

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const index = {};
  header.forEach((name, i) => (index[name] = i));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    rows.push(parseCsvLine(lines[i]));
  }

  return { rows, header, index };
}

/* -----------------------------------------------------------------------
 * Extractor de ZIP (sin dependencias)
 *
 * Renfe publica el GTFS estatico como google_transit.zip. Node no trae
 * lector de ZIP integrado, por eso se parsea el directorio central del
 * contenedor y se descomprime cada entrada con zlib.
 * -------------------------------------------------------------------- */

const ZIP_EOCD_SIGNATURE = 0x06054b50; // fin del directorio central
const ZIP_CD_SIGNATURE = 0x02014b50; // entrada del directorio central
const ZIP_LOCAL_SIGNATURE = 0x04034b50; // cabecera local de un archivo

/** Lee el indice de archivos contenidos en un buffer ZIP. */
function listZipEntries(zipBuffer) {
  // El "End of Central Directory" esta siempre al final (ultimos 22+ bytes).
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error("ZIP: no se encontro el directorio final");
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let p = cdOffset;

  for (let n = 0; n < totalEntries; n++) {
    if (zipBuffer.readUInt32LE(p) !== ZIP_CD_SIGNATURE) break;

    const method = zipBuffer.readUInt16LE(p + 10);
    const compressedSize = zipBuffer.readUInt32LE(p + 20);
    const nameLength = zipBuffer.readUInt16LE(p + 28);
    const extraLength = zipBuffer.readUInt16LE(p + 30);
    const commentLength = zipBuffer.readUInt16LE(p + 32);
    const localOffset = zipBuffer.readUInt32LE(p + 42);
    const name = zipBuffer.toString("utf8", p + 46, p + 46 + nameLength);

    entries.push({ name, method, compressedSize, localOffset });

    p += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Extrae el contenido de texto de una entrada del ZIP. */
function extractZipEntryText(zipBuffer, entry) {
  const localOffset = entry.localOffset;

  if (zipBuffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error(`ZIP: cabecera local invalida en ${entry.name}`);
  }

  const nameLength = zipBuffer.readUInt16LE(localOffset + 26);
  const extraLength = zipBuffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const raw = zipBuffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return raw.toString("utf8"); // almacenado
  if (entry.method === 8) return zlib.inflateRawSync(raw).toString("utf8"); // deflate

  throw new Error(`ZIP: metodo de compresion no soportado (${entry.method})`);
}

module.exports = {
  parseCsvLine,
  parseGtfsCsv,
  listZipEntries,
  extractZipEntryText,
};
