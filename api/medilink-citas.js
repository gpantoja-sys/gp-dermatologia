// api/medilink-citas.js
// Devuelve las citas de un día para el Dr. Pantoja (id_profesional = 1),
// sin anuladas, ordenadas por hora, cruzando el RUT con la base de GP.
// Lo usa el panel "Preparar día" para que Clarita arme el tótem.
//
// v2 — FIX citas incompletas: la API de Medilink pagina con cursores
// (links.next). Antes se leía SOLO la primera página de las citas de toda la
// clínica y de ahí se filtraban las del Dr. → llegaban 8 de 15. Ahora:
//   a) el filtro id_profesional va en la consulta misma (solo SUS citas), y
//   b) se recorren TODAS las páginas siguiendo links.next.
//
// Uso:  /api/medilink-citas?fecha=2026-07-27

const MEDILINK_BASE  = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

const ID_PROFESIONAL_GONZALO = 1;

// Trae TODAS las páginas de un endpoint de Medilink (paginación por cursor:
// la respuesta trae links.next mientras queden páginas). Tope de seguridad
// de 30 páginas para nunca quedar en un loop infinito.
async function medilinkTodas(endpoint, params){
  let url = new URL(MEDILINK_BASE + '/' + endpoint);
  if (params && Object.keys(params).length){
    url.searchParams.set('q', JSON.stringify(params));
  }
  const out = [];
  let guard = 0;
  while (url && guard < 30){
    guard++;
    const res = await fetch(url.toString(), { headers: { Authorization: 'Token ' + MEDILINK_TOKEN } });
    const json = await res.json().catch(function(){ return {}; });
    const data = (json && Array.isArray(json.data)) ? json.data : [];
    for (const d of data) out.push(d);
    const next = json && json.links && json.links.next;
    url = next ? new URL(next) : null;
  }
  return out;
}

async function sbPacientesPorMedilink(ids){
  if (!ids.length) return {};
  // Trae rut/nombre/tel de los pacientes cuyos id_medilink están en la lista
  const lista = ids.join(',');
  const url = SUPABASE_URL + '/rest/v1/pacientes?id_medilink=in.(' + encodeURIComponent(lista) + ')'
            + '&select=rut,id_medilink,nombre,apellido,apellido2,tel';
  const r = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } });
  const arr = await r.json().catch(function(){ return []; });
  const map = {};
  (Array.isArray(arr) ? arr : []).forEach(function(p){ map[String(p.id_medilink)] = p; });
  return map;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!MEDILINK_TOKEN){
    return res.status(500).json({ error: 'Falta MEDILINK_TOKEN en Vercel.' });
  }
  const fecha = String((req.query && req.query.fecha) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)){
    return res.status(400).json({ error: 'Indica la fecha así: ?fecha=2026-07-27' });
  }

  try {
    // 1) Traer las citas del día SOLO del Dr. Pantoja, todas las páginas.
    //    Respaldo: si el filtro combinado no devuelve nada, se pide el día
    //    completo (también paginado) y se filtra acá.
    let citas = await medilinkTodas('citas', {
      fecha: { eq: fecha },
      id_profesional: { eq: ID_PROFESIONAL_GONZALO }
    });
    if (!citas.length){
      citas = await medilinkTodas('citas', { fecha: { gte: fecha, lte: fecha } });
    }

    // 2) Solo las del Dr. Pantoja y no anuladas (doble seguro: aunque el
    //    filtro ya venga aplicado desde Medilink, esto no deja pasar nada).
    const mias = citas.filter(function(c){
      return Number(c.id_profesional) === ID_PROFESIONAL_GONZALO && Number(c.estado_anulacion) === 0;
    });

    // 3) Cruzar RUT con la base por id_medilink
    const ids = [];
    mias.forEach(function(c){ if (c.id_paciente && ids.indexOf(String(c.id_paciente)) === -1) ids.push(String(c.id_paciente)); });
    const map = await sbPacientesPorMedilink(ids);

    // 4) Armar salida limpia, ordenada por hora
    const filas = mias.map(function(c){
      const p = map[String(c.id_paciente)] || null;
      return {
        cita_id: c.id,
        id_paciente: c.id_paciente,
        hora_inicio: c.hora_inicio || '',
        hora_fin: c.hora_fin || '',
        nombre_paciente: c.nombre_paciente || '',
        nombre_atencion: c.nombre_atencion || '',
        estado_cita: c.estado_cita || '',
        id_estado: c.id_estado,
        comentarios: c.comentarios || '',
        en_base: !!p,
        rut: p ? p.rut : null,
        tel: p ? p.tel : null
      };
    }).sort(function(a,b){ return (a.hora_inicio || '').localeCompare(b.hora_inicio || ''); });

    return res.status(200).json({
      ok: true,
      fecha: fecha,
      total: filas.length,
      citas: filas
    });
  } catch (e){
    return res.status(500).json({ error: 'Fallo la consulta de citas', detalle: String(e && e.message || e) });
  }
};
