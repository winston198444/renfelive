/**
 * RENFE LIVE — proxy mínimo CORS para los feeds GTFS-Realtime de Renfe.
 *
 * Diseño: DOS endpoints proxy (passthrough), uno por feed:
 *   GET /api/vehicle-positions  -> https://gtfsrt.renfe.com/vehicle_positions_LD.json
 *   GET /api/trip-updates       -> https://gtfsrt.renfe.com/trip_updates_LD.json
 *
 * ¿Por qué existe este Worker? Los feeds de Renfe NO envían la cabecera
 * "Access-Control-Allow-Origin" (verificado con datos reales), por lo que
 * el navegador bloquea cualquier fetch() directo desde GitHub Pages.
 *
 * Principios de diseño:
 *   - Proxy MÍNIMO: reenvía el JSON tal cual; NO parsea, NO transforma,
 *     NO procesa GTFS estático ni CSV.
 *   - Endpoints de Renfe FIJOS en el código: no es un proxy genérico.
 *   - CORS con ALLOWLIST de orígenes (nunca "*").
 *   - Caché edge COMPARTIDA de 12 s: varios visitantes en el mismo
 *     intervalo generan UNA sola petición a Renfe.
 *   - Solo se cachean respuestas 200; los errores nunca se cachean.
 *
 * Configuración:
 *   ALLOWED_ORIGINS  variable/secret de la Worker, lista separada por
 *                    comas de orígenes permitidos, p. ej.
 *                    https://winston198444.github.io,https://renfe.example.com
 *                    Si no se define, se usa la lista por defecto.
 */

// Endpoints de Renfe: FIJOS. Este Worker no acepta URLs arbitrarias.
const RENFE_FEEDS = {
  "/api/vehicle-positions": "https://gtfsrt.renfe.com/vehicle_positions_LD.json",
  "/api/trip-updates": "https://gtfsrt.renfe.com/trip_updates_LD.json",
};

// Orígenes permitidos por defecto (allowlist). En producción se amplía con
// la variable ALLOWED_ORIGINS (URL de Pages y/o dominio personalizado).
// Localhost se incluye para desarrollo con `wrangler dev`.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://winston198444.github.io", // GitHub Pages (URL por defecto del repo)
  "http://localhost:3000", // desarrollo local
  "http://127.0.0.1:3000",
];

// Caché edge compartida (segundos). Debe ser MENOR que el intervalo de
// actualización visual (15 s) para no servir datos excesivamente antiguos:
// como máximo ~12 s de retraso en el peor caso.
const EDGE_CACHE_SECONDS = 12;

const UPSTREAM_TIMEOUT_MS = 8000;

function normalizeOrigin(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function allowedOrigins(env) {
  const extra = String(env?.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

function jsonResponse(payload, status, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = normalizeOrigin(request.headers.get("Origin"));
    const permitted = allowedOrigins(env);
    const originAllowed = !origin || permitted.has(origin);

    // Cabeceras CORS solo para orígenes permitidos (nunca "*").
    const corsHeaders = originAllowed && origin
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};

    // --- Preflight ---
    if (request.method === "OPTIONS") {
      if (!originAllowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    // --- Rutas: SOLO los dos endpoints de Renfe (proxy no genérico) ---
    const upstreamUrl = RENFE_FEEDS[url.pathname];
    if (!upstreamUrl) {
      return jsonResponse({ error: "Not Found" }, 404);
    }

    // Origen presente y NO permitido -> 403 explícito. (Sin cabecera CORS
    // el navegador no podría leer la respuesta de todos modos.)
    if (!originAllowed) {
      return jsonResponse({ error: "Origin not allowed" }, 403);
    }

    // --- Caché edge compartida (Cache API) ---
    // Misma clave para todos los visitantes => una sola petición a Renfe
    // por intervalo de EDGE_CACHE_SECONDS.
    const cacheKey = new Request(url.origin + url.pathname);
    const cache = caches.default;

    let cached = await cache.match(cacheKey);
    const wasHit = Boolean(cached);

    if (!cached) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

      let upstream;
      try {
        upstream = await fetch(upstreamUrl, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch {
        return jsonResponse({ error: "Upstream unreachable" }, 502);
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok) {
        // Nunca cachear errores: el siguiente visitante reintentará.
        return jsonResponse({ error: `Upstream HTTP ${upstream.status}` }, 502);
      }

      // El cuerpo se lee una sola vez: se envía al cliente y se guarda en
      // caché a partir de una copia en memoria. (Sin X-Edge-Cache: ese
      // valor se decide al servir, no al guardar.)
      const bodyText = await upstream.text();

      cached = new Response(bodyText, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${EDGE_CACHE_SECONDS}`,
        },
      });

      ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    }

    // --- Respuesta final + cabeceras CORS ---
    const headers = new Headers(cached.headers);
    headers.set("Cache-Control", `public, max-age=${EDGE_CACHE_SECONDS}`);
    headers.set("X-Edge-Cache", wasHit ? "HIT" : "MISS");
    for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);

    return new Response(cached.body, { status: 200, headers });
  },
};
