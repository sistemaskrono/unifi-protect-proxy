const axios = require("axios");
const https = require("https");

const UNIFI_API_KEY  = process.env.UNIFI_API_KEY;
const N8N_WEBHOOK    = process.env.N8N_WEBHOOK_URL;
const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL_MS || "15000");

if (!UNIFI_API_KEY || !N8N_WEBHOOK) {
  console.error("ERROR: Faltan variables de entorno: UNIFI_API_KEY, N8N_WEBHOOK_URL");
  process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });

const api = axios.create({
  baseURL: "https://api.ui.com",
  headers: {
    "X-API-KEY": process.env.UNIFI_API_KEY || "",
    "Accept": "application/json",
    "Content-Type": "application/json"
  },
  httpsAgent: agent,
  timeout: 15000
});

const lastEventPerSite = {};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getSites() {
  try {
    const res = await api.get("/v1/consoles");
    const data = res.data;
    const consoles = Array.isArray(data) ? data : (data.data || []);
    console.log(`[INFO] Consolas encontradas: ${consoles.length}`);
    return consoles.map(c => ({
      id:   c.id || c.hardwareId,
      name: c.name || c.hostname || c.id
    }));
  } catch (err) {
    console.error("[ERROR] No se pudo obtener la lista de consolas:", err.message);
    return [];
  }
}

async function getLastLineCrossing(siteId, siteName) {
  try {
    const res = await api.get(`/v1/consoles/${siteId}/protect/events`, {
      params: {
        type:           "smartDetectLine",
        limit:          5,
        orderDirection: "DESC"
      }
    });

    const body   = res.data;
    let eventos  = [];

    if (Array.isArray(body))             eventos = body;
    else if (Array.isArray(body.data))   eventos = body.data;
    else if (Array.isArray(body.events)) eventos = body.events;

    if (eventos.length === 0) return;

    const ev   = eventos[0];
    const evId = ev.id || ev.start || "";

    if (lastEventPerSite[siteId] === evId) return;
    lastEventPerSite[siteId] = evId;

    const ts    = ev.start ? new Date(ev.start) : new Date();
    const pad   = n => String(n).padStart(2, "0");
    const fecha = `${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())}`;
    const hora  = `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

    const tipos  = ev.smartDetectTypes || ev.metadata?.smartDetectTypes || ["person"];
    const camara = ev.camera || ev.cameraName || ev.deviceName || "G6 Turret";
    const zona   = ev.metadata?.zoneName || ev.zoneName || ev.zone || "cruce de linea";

    const payload = {
      type:            "smartDetectLine",
      site_id:         siteId,
      site_name:       siteName,
      camera:          camara,
      zone:            zona,
      fecha,
      hora,
      smart_detect_types: Array.isArray(tipos) ? tipos : [tipos],
      score:           ev.score || 0,
      timestamp_raw:   ev.start || ""
    };

    console.log(`[EVENT] ${siteName} — cruce detectado ${fecha} ${hora}`);

    await axios.post(N8N_WEBHOOK, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000
    });

    console.log(`[OK] Evento enviado a n8n — ${siteName}`);

  } catch (err) {
    if (err.response?.status === 404) {
      console.warn(`[WARN] ${siteName}: endpoint no disponible (404)`);
    } else {
      console.error(`[ERROR] ${siteName}:`, err.message);
    }
  }
}

async function pollAllSites(sites) {
  await Promise.allSettled(
    sites.map(s => getLastLineCrossing(s.id, s.name))
  );
}

async function main() {
  console.log("[START] UniFi Protect Proxy iniciando...");
  console.log(`[CONFIG] Intervalo de polling: ${POLL_INTERVAL}ms`);
  console.log(`[CONFIG] Webhook n8n: ${N8N_WEBHOOK}`);

  let sites = await getSites();

  if (sites.length === 0) {
    console.warn("[WARN] No se encontraron consolas. Reintentando en 60s...");
    await sleep(60000);
    sites = await getSites();
  }

  console.log(`[INFO] Monitoreando ${sites.length} entornos:`);
  sites.forEach(s => console.log(`  - ${s.name} (${s.id})`));

  while (true) {
    await pollAllSites(sites);
    await sleep(POLL_INTERVAL);
  }
}

main().catch(err => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
