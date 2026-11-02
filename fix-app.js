const fs = require('fs');
let c = fs.readFileSync('C:\\Users\\43437262Z\\GITHUB\\renfe\\app.js', 'utf8');
const viejo = '  updateTrains(); // primera carga inmediata\n  setInterval(updateTrains, REFRESH_INTERVAL_MS); // refresco cada 15 s\n\n  // El "hace X" de la última actualización sigue corriendo aunque\n  // falla una carga: el ancla solo se mueve con un timestamp nuevo.\n  setInterval(refrescarUltimaActualizacion, REFRESH_INTERVAL_MS);\n}';
const nuevo = '  updateTrains(); // primera carga inmediata\n  setInterval(updateTrains, REFRESH_INTERVAL_MS); // refresco cada 15 s\n\n  // El "hace X" de la última actualización sigue corriendo aunque\n  // falla una carga: el ancla solo se mueve con un timestamp nuevo.\n  setInterval(refrescarUltimaActualizacion, REFRESH_INTERVAL_MS);\n\n  // Nueva sección: refresco periódico del GTFS estático cada 30 min.\n  // Evita que los trenes de fechas recién publicadas por Renfe se queden\n  // sin origen/destino por tener un GTFS viejo en memoria.\n  setInterval(recargarDatosEstaticos, GTFS_REFRESH_INTERVAL_MS);\n}';
if (c.includes(viejo)) {
  c = c.replace(viejo, nuevo);
  fs.writeFileSync('C:\\Users\\43437262Z\\GITHUB\\renfe\\app.js', c);
  console.log('SUCCESS: reemplazo hecho');
} else {
  console.log('NO ENCONTRADO el string viejo');
  // imprimir un fragmento para depurar
  const idx = c.indexOf('updateTrains');
  console.log('primer updateTrains en:', idx);
  console.log('contexto viejo:', JSON.stringify(c.substring(idx, idx+100)));
}