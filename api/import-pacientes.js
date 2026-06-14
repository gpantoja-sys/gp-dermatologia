// api/import-pacientes.js — GP Dermatología
// Importa el padrón de pacientes desde Medilink hacia Supabase (tabla `pacientes`).
//
// Modos:
//   ?dry=1            → solo inspecciona una página de /pacientes (no escribe).
//   (sin dry)         → importación real: recorre TODAS las páginas (cursor) y hace upsert.
//   ?cursor=<url>     → reanuda la importación desde una página puntual (para cargas grandes).
//
// Reglas:
//   - sexo "F"/"M" de Medilink → "Femenino"/"Masculino".
//   - comuna/sexo: si ya hay un valor local (manual o previo), SE RESPETA; Medilink solo rellena lo vacío.
//   - Protección: CRON_SECRET por header (cron de Vercel) o ?key=...

const MEDILINK_BASE = 'https://api.medilink.healthatom.com/api/v1';
const TOKEN  = process.env.MEDILINK_TOKEN;
const SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SB = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function mapSexo(s){
  if(!s) return null;
  const u = String(s).trim().toUpperCase();
  if(u.startsWith('F')) return 'Femenino';
  if(u.startsWith('M')) return 'Masculino';
  return 'Otro';
}

// Lee comuna/sexo locales (paginado por Range) para no pisar lo manual
async function leerLocales(){
  const map = {};
  let desde = 0; const paso = 1000;
  for(let i=0;i<20;i++){
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pacientes?select=rut,comuna,sexo`, {
      headers: { ...SB, Range: `${desde}-${desde+paso-1}`, 'Range-Unit': 'items' }
    });
    let arr = [];
    try { arr = await r.json(); } catch(e){ arr = []; }
    if(!Array.isArray(arr) || arr.length === 0) break;
    arr.forEach(p => { if(p.rut) map[p.rut] = { comuna: p.comuna, sexo: p.sexo }; });
    if(arr.length < paso) break;
    desde += paso;
  }
  return map;
}

module.exports = async function handler(req, res){
  // ── Autorización ──
  const auth = req.headers.authorization || '';
  const cron = req.headers['x-vercel-cron'];
  const key  = req.query.key || '';
  const autorizado = cron || (SECRET && (auth === `Bearer ${SECRET}` || key === SECRET));
  if(!autorizado) return res.status(401).json({ error: 'No autorizado' });
  if(!TOKEN)      return res.status(500).json({ error: 'Falta MEDILINK_TOKEN' });

  const dry = req.query.dry === '1' || req.query.dry === 'true';

  // ── MODO PRUEBA ──
  if(dry){
    try{
      const r = await fetch(`${MEDILINK_BASE}/pacientes`, { headers: { Authorization: `Token ${TOKEN}` } });
      const status = r.status;
      let json = null; try { json = await r.json(); } catch(e){ json = null; }
      const out = { status, topKeys: json ? Object.keys(json) : null };
      if(json){
        const arr = json.data || [];
        out.dataLength = Array.isArray(arr) ? arr.length : 'no es array';
        out.links = json.links || null;
        if(Array.isArray(arr) && arr.length){
          out.primerPacienteCampos = Object.keys(arr[0]);
          out.primerPacienteEjemplo = arr[0];
        }
      }
      return res.status(200).json(out);
    }catch(e){ return res.status(500).json({ error: e.message }); }
  }

  // ── MODO REAL ──
  if(!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY' });

  const t0 = Date.now();
  const LIMITE_MS = 250000; // detenerse antes del tope de la función (300s)

  let locales = {};
  try { locales = await leerLocales(); } catch(e){ /* si falla, seguimos sin preservar */ }

  const LOTE = parseInt(req.query.lote, 10) || 999;
  let url = req.query.cursor ? req.query.cursor : `${MEDILINK_BASE}/pacientes`;
  let paginas = 0, totalLeidos = 0, upserted = 0, errores = 0, primerError = null;
  let siguienteCursor = null, terminado = false;

  while(url){
    if(Date.now() - t0 > LIMITE_MS){ siguienteCursor = url; break; }

    let r;
    try { r = await fetch(url, { headers: { Authorization: `Token ${TOKEN}` } }); }
    catch(e){ errores++; await sleep(1500); continue; }

    if(r.status === 429){ await sleep(2500); continue; } // rate limit → esperar y reintentar
    if(!r.ok){ errores++; break; }

    let json; try { json = await r.json(); } catch(e){ break; }
    const data = json.data || [];
    paginas++; totalLeidos += data.length;

    const filas = data.filter(p => p.rut).map(p => {
      const loc = locales[p.rut] || {};
      const comunaLocal = (loc.comuna && String(loc.comuna).trim() !== '') ? loc.comuna : null;
      const sexoLocal   = (loc.sexo   && String(loc.sexo).trim()   !== '') ? loc.sexo   : null;
      return {
        rut: p.rut,
        nombre: [p.nombre, p.apellidos].filter(Boolean).join(' ') || null,
        nac: p.fecha_nacimiento || null,
        tel: p.celular || p.telefono || null,
        email: p.email || null,
        id_medilink: p.id ? String(p.id) : null,
        comuna: comunaLocal || p.comuna || null,
        sexo:   sexoLocal   || mapSexo(p.sexo)
      };
    });

    if(filas.length){
      try{
        const ur = await fetch(`${SUPABASE_URL}/rest/v1/pacientes?on_conflict=rut`, {
          method: 'POST',
          headers: { ...SB, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(filas)
        });
        if(ur.ok){ upserted += filas.length; }
        else { errores++; if(!primerError){ primerError = `${ur.status}: ${(await ur.text()).slice(0,200)}`; } }
      }catch(e){ errores++; if(!primerError) primerError = e.message; }
    }

    url = (json.links && json.links.next) ? json.links.next : null;
    if(!url){ terminado = true; }
    else if(paginas >= LOTE){ siguienteCursor = url; url = null; }
    await sleep(250); // throttle anti rate-limit
  }

  const duracion = ((Date.now() - t0) / 1000).toFixed(1);
  return res.status(200).json({
    ok: true,
    terminado,
    paginas,
    pacientes_leidos: totalLeidos,
    upserted,
    errores,
    primerError,
    duracion_segundos: parseFloat(duracion),
    siguienteCursor: siguienteCursor || null,
    nota: terminado
      ? 'Importación completa.'
      : (siguienteCursor ? 'Se alcanzó el límite de tiempo. Reanuda con ?cursor=<siguienteCursor>.' : 'Se detuvo por errores.')
  });
};
