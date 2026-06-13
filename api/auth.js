// api/auth.js — Autenticación de pacientes por clave (GP Dermatología)
// Identidad verificada EN VIVO contra Medilink. Clave cifrada en tabla protegida.
// Sin dependencia de WhatsApp: funciona 24/7.
// Acciones (query ?action=): check | register | login | session

const crypto = require('crypto');

const MEDILINK_BASE = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;
const SUPABASE_URL   = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY; // clave secreta de Supabase
const AUTH_SECRET    = SERVICE_KEY || 'no-secret';            // secreto para cifrar clave y firmar tokens

const SESSION_DAYS = 180;  // dispositivo de confianza: 6 meses
const MAX_ATTEMPTS = 8;    // intentos de clave fallidos antes de bloqueo temporal
const LOCK_MIN     = 15;   // minutos de bloqueo tras superar los intentos

// ── Helpers ──────────────────────────────────────────────────
function normalizaRut(r){ return (r||'').replace(/\./g,'').replace(/\s/g,'').trim(); }
function normalizar(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
function hashClave(clave, rut){ return crypto.createHmac('sha256', AUTH_SECRET).update(clave + ':' + rut).digest('hex'); }

function signToken(payload){
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(b).digest('base64url');
  return b + '.' + sig;
}
function verifyToken(token){
  if(!token || token.indexOf('.') < 0) return null;
  const [b, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(b).digest('base64url');
  if(sig !== expected) return null;
  let p; try{ p = JSON.parse(Buffer.from(b,'base64url').toString()); }catch(e){ return null; }
  if(!p.exp || Date.now() > p.exp) return null;
  return p;
}

// ── Medilink: buscar paciente por RUT ──
async function medilinkBuscarRut(rut){
  const formatos = [rut, rut.toUpperCase(), rut.toLowerCase(), rut.replace(/-/g,'')];
  for(const r of [...new Set(formatos)]){
    const url = `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify({ rut: { eq: r } }))}`;
    const resp = await fetch(url, { headers: { Authorization: `Token ${MEDILINK_TOKEN}` } });
    if(resp.ok){
      const j = await resp.json();
      const data = j.data || [];
      if(data.length) return data[0];
    }
  }
  return null;
}
function nombreCompleto(pac){ return [pac.nombre, pac.apellidos].filter(Boolean).join(' ').trim(); }
function nombreCoincide(input, pac){
  const words = normalizar(nombreCompleto(pac)).split(' ').filter(Boolean);
  const inw = normalizar(input).split(' ').filter(Boolean);
  return inw.length > 0 && inw.some(w => w.length >= 2 && words.includes(w));
}

// ── Supabase (service_role) — tabla protegida patient_auth ──
const SB = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};
async function authGet(rut){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/patient_auth?rut=eq.${encodeURIComponent(rut)}&select=*`, { headers: SB });
  const arr = await r.json();
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}
async function authUpsert(row){
  await fetch(`${SUPABASE_URL}/rest/v1/patient_auth`, {
    method: 'POST',
    headers: { ...SB, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
}
async function authPatch(rut, fields){
  await fetch(`${SUPABASE_URL}/rest/v1/patient_auth?rut=eq.${encodeURIComponent(rut)}`, {
    method: 'PATCH', headers: { ...SB, 'Prefer': 'return=minimal' },
    body: JSON.stringify(fields)
  });
}

function sesion(rut, nombre, idml){
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return signToken({ rut, nombre, idml: idml || null, exp });
}

// ── Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if(!SERVICE_KEY)            return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY' });

  const action = req.query.action;
  const body = req.body || {};

  try{
    // ── 1) CHECK: ¿existe el paciente y ya tiene clave? (primera vez) ──
    if(action === 'check'){
      const rut = normalizaRut(body.rut);
      if(!rut || !body.nombre) return res.status(400).json({ error: 'Nombre y RUT requeridos' });
      const pac = await medilinkBuscarRut(rut);
      if(!pac) return res.status(200).json({ ok: false, reason: 'no_encontrado' });
      if(!nombreCoincide(body.nombre, pac)) return res.status(200).json({ ok: false, reason: 'nombre_no_coincide' });
      const row = await authGet(rut);
      return res.status(200).json({ ok: true, registered: !!row, nombre: nombreCompleto(pac) });
    }

    // ── 2) REGISTER: crear clave (solo si no existe ya una) ──
    if(action === 'register'){
      const rut = normalizaRut(body.rut);
      const clave = String(body.clave || '');
      if(!rut || !body.nombre || clave.length < 6) return res.status(400).json({ error: 'Datos incompletos (clave mínimo 6 dígitos)' });
      const pac = await medilinkBuscarRut(rut);
      if(!pac) return res.status(200).json({ ok: false, reason: 'no_encontrado' });
      if(!nombreCoincide(body.nombre, pac)) return res.status(200).json({ ok: false, reason: 'nombre_no_coincide' });
      const existente = await authGet(rut);
      if(existente) return res.status(200).json({ ok: false, reason: 'ya_registrado' }); // ya tiene clave → debe iniciar sesión
      const nombre = nombreCompleto(pac);
      await authUpsert({ rut, clave_hash: hashClave(clave, rut), nombre, attempts: 0, locked_until: null });
      return res.status(200).json({
        ok: true, token: sesion(rut, nombre, pac.id),
        paciente: { rut, nombre, tel: pac.celular || '', email: pac.email || '', id_medilink: pac.id }
      });
    }

    // ── 3) LOGIN: clave (sin depender de WhatsApp) ──
    if(action === 'login'){
      const rut = normalizaRut(body.rut);
      const clave = String(body.clave || '');
      if(!rut || !clave) return res.status(400).json({ error: 'RUT y clave requeridos' });
      const row = await authGet(rut);
      if(!row) return res.status(200).json({ ok: false, reason: 'sin_clave' }); // nunca se registró
      if(row.locked_until && new Date(row.locked_until).getTime() > Date.now()){
        return res.status(200).json({ ok: false, reason: 'bloqueado_temporal' });
      }
      if(hashClave(clave, rut) !== row.clave_hash){
        const intentos = (row.attempts || 0) + 1;
        const fields = { attempts: intentos };
        if(intentos >= MAX_ATTEMPTS) fields.locked_until = new Date(Date.now() + LOCK_MIN * 60000).toISOString();
        await authPatch(rut, fields);
        return res.status(200).json({ ok: false, reason: 'clave_incorrecta', restantes: Math.max(0, MAX_ATTEMPTS - intentos) });
      }
      // Clave correcta
      await authPatch(rut, { attempts: 0, locked_until: null });
      const pac = await medilinkBuscarRut(rut);
      const nombre = pac ? nombreCompleto(pac) : (row.nombre || 'Paciente');
      return res.status(200).json({
        ok: true, token: sesion(rut, nombre, pac ? pac.id : null),
        paciente: { rut, nombre, tel: pac ? pac.celular : '', email: pac ? pac.email : '', id_medilink: pac ? pac.id : null }
      });
    }

    // ── 4) SESSION: validar dispositivo de confianza al abrir la app ──
    if(action === 'session'){
      const p = verifyToken(body.token);
      if(!p) return res.status(200).json({ ok: false });
      return res.status(200).json({ ok: true, paciente: { rut: p.rut, nombre: p.nombre, id_medilink: p.idml || null } });
    }

    return res.status(400).json({ error: 'Acción inválida' });

  }catch(e){
    return res.status(500).json({ error: e.message });
  }
};
