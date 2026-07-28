// api/medilink-paciente-sync.js
// Trae la ficha de un paciente desde Medilink por su id y lo crea/actualiza en
// la base de GP. Lo usa el panel "Preparar día" cuando la paciente aparece
// "recién agendada" (está en Medilink pero todavía no en la base).
//
// Uso:  /api/medilink-paciente-sync?id=26211
// Devuelve { ok, rut, nombre } para que el panel abra el generador con esa paciente.
//
// v2 — DOS ARREGLOS:
//  1) APELLIDOS SEPARADOS: antes se guardaba todo pegado en `nombre` y
//     `apellido` quedaba vacío → la boleta Bsale salía SIN receptor (la
//     nominación exige nombre y apellido por separado). Ahora `nombre` guarda
//     el nombre de pila, `apellido` el primer apellido y `apellido2` el resto.
//  2) RUT CANÓNICO: sin puntos, con guión y dígito verificador en MAYÚSCULA
//     (antes entraba tal cual venía de Medilink y reaparecían las k minúsculas).
//
// Si el email es el genérico de la clínica, se guarda vacío para que el tótem
// obligue a la paciente a poner su correo real.

const MEDILINK_BASE = 'https://api.medilink.healthatom.com/api/v1';
const TOKEN         = process.env.MEDILINK_TOKEN;
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL_CLINICA = 'pacientes@dermatologia.cl';

const SB = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' };

function mapSexo(s){
  if(!s) return null;
  const u = String(s).trim().toUpperCase();
  if(u.startsWith('F')) return 'Femenino';
  if(u.startsWith('M')) return 'Masculino';
  return 'Otro';
}

// RUT canónico: sin puntos, con guión, DV en MAYÚSCULA (ej. 18020704-K).
function normRut(r){
  r = String(r || '').replace(/[.\s]/g, '').toUpperCase();
  if (!r) return null;
  if (r.indexOf('-') < 0 && r.length > 1) r = r.slice(0, -1) + '-' + r.slice(-1);
  return r;
}

// "Pérez Soto" → { a1:'Pérez', a2:'Soto' } · "Pérez" → { a1:'Pérez', a2:null }
function splitApellidos(s){
  const t = String(s || '').trim().split(/\s+/).filter(Boolean);
  if (!t.length) return { a1: null, a2: null };
  return { a1: t[0], a2: t.slice(1).join(' ') || null };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if(!TOKEN)       return res.status(500).json({ error: 'Falta MEDILINK_TOKEN' });
  if(!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY' });

  const id = String((req.query && req.query.id) || '').trim();
  if(!/^\d+$/.test(id)) return res.status(400).json({ error: 'Indica el id de Medilink: ?id=26211' });

  try {
    // 1) Traer la ficha desde Medilink
    const r = await fetch(MEDILINK_BASE + '/pacientes/' + id, { headers: { Authorization: 'Token ' + TOKEN } });
    const j = await r.json().catch(function(){ return {}; });
    const p = (j && j.data) ? j.data : j;

    const rut = normRut(p && p.rut);
    if(!p || !rut){
      return res.status(422).json({ error: 'La ficha de Medilink no tiene RUT; no se puede crear.', id_medilink: id });
    }

    // 2) Email: si viene vacío o es el genérico de la clínica, lo dejamos null
    const emailReal = (p.email && p.email.trim().toLowerCase() !== EMAIL_CLINICA) ? p.email.trim() : null;

    // 3) Armar la fila: nombre de pila y apellidos POR SEPARADO (así la boleta
    //    Bsale sale nominada y los paneles muestran el nombre sin duplicar).
    const ap = splitApellidos(p.apellidos);
    const fila = {
      rut: rut,
      nombre: (p.nombre || '').trim() || null,
      apellido: ap.a1,
      apellido2: ap.a2,
      nac: p.fecha_nacimiento || null,
      tel: p.celular || p.telefono || null,
      email: emailReal,
      id_medilink: p.id ? String(p.id) : null,
      comuna: p.comuna || null,
      sexo: mapSexo(p.sexo)
    };

    // 4) Upsert por rut (idempotente: si ya existe, la actualiza sin duplicar)
    const ur = await fetch(SUPABASE_URL + '/rest/v1/pacientes?on_conflict=rut', {
      method: 'POST',
      headers: { ...SB, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([fila])
    });
    if(!ur.ok){
      const txt = await ur.text();
      return res.status(500).json({ error: 'No se pudo guardar la paciente', detalle: txt.slice(0,200) });
    }

    return res.status(200).json({
      ok: true,
      rut: rut,
      nombre: [fila.nombre, fila.apellido, fila.apellido2].filter(Boolean).join(' '),
      email_pendiente: emailReal === null,   // true = el tótem debe pedir el correo real
      creado: true
    });
  } catch (e){
    return res.status(500).json({ error: 'Fallo la sincronización', detalle: String(e && e.message || e) });
  }
};
