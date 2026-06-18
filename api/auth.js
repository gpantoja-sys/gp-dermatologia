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
const ADMIN_PIN      = process.env.ADMIN_RESET_PIN;           // PIN para resetear claves desde el CRM

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
// Genera TODAS las variantes de formato de un RUT chileno, para que el match
// exacto de Medilink no falle por puntos, guión o ceros a la izquierda.
function formatosRut(rut){
  const limpio = (rut||'').replace(/\./g,'').replace(/\s/g,'').replace(/-/g,'').trim().toUpperCase(); // "89005183" ó "12345678K"
  if(limpio.length < 2) return [rut];
  const cuerpo    = limpio.slice(0, -1);        // "8900518"
  const dv        = limpio.slice(-1);           // "3"
  const cuerpoPad = cuerpo.padStart(8, '0');    // "08900518"
  const conPuntos = c => c.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const out = new Set();
  for(const c of [cuerpo, cuerpoPad]){
    out.add(c + '-' + dv);             // 8900518-3   / 08900518-3
    out.add(c + dv);                   // 89005183    / 089005183
    out.add(conPuntos(c) + '-' + dv);  // 8.900.518-3 / 08.900.518-3
  }
  // variantes mayúscula/minúscula del dígito verificador (caso K)
  for(const v of [...out]){ out.add(v.toLowerCase()); out.add(v.toUpperCase()); }
  return [...out];
}

async function medilinkBuscarRut(rut){
  // Medilink FILTRA por 'numero_documento' (lo confirma medilink-sync.js, que sí
  // funciona). 'rut' solo viene en la respuesta, no sirve para filtrar. Probamos
  // numero_documento primero y rut como respaldo, sobre todas las variantes.
  const campos = ['numero_documento', 'rut'];
  for(const campo of campos){
    for(const r of formatosRut(rut)){
      const filtro = {}; filtro[campo] = { eq: r };
      const url = `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify(filtro))}`;
      let resp;
      try{ resp = await fetch(url, { headers: { Authorization: `Token ${MEDILINK_TOKEN}` } }); }
      catch(e){ continue; }
      if(resp && resp.ok){
        const j = await resp.json().catch(()=>({}));
        const data = j.data || [];
        if(data.length) return data[0];
      }
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

// ── WhatsApp (Whaticket) — envío del código de verificación ──
const WHATICKET_TOKEN = process.env.WHATICKET_TOKEN;
const WHATSAPP_ID = '3c28baaa-9e97-4392-8398-188b6520b262';
async function enviarWhatsApp(numero, texto, nombre){
  if(!WHATICKET_TOKEN) throw new Error('WhatsApp no configurado');
  let dig = String(numero || '').replace(/\D/g, '');
  if(dig.length === 9 && dig.startsWith('9')) dig = '56' + dig;
  if(dig && !dig.startsWith('56')) dig = '56' + dig;
  const resp = await fetch('https://api.whaticket.com/api/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WHATICKET_TOKEN}` },
    body: JSON.stringify({ whatsappId: WHATSAPP_ID, messages: [{ number: dig, body: texto, name: nombre || '' }] })
  });
  if(!resp.ok){ const d = await resp.json().catch(()=>({})); throw new Error(d.message || 'Error WhatsApp'); }
  return true;
}

// ── OTP: códigos temporales de verificación (tabla otp_codes) ──
async function otpGet(rut){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/otp_codes?rut=eq.${encodeURIComponent(rut)}&select=*`, { headers: SB });
  const arr = await r.json();
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}
async function otpUpsert(row){
  await fetch(`${SUPABASE_URL}/rest/v1/otp_codes`, {
    method: 'POST', headers: { ...SB, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
}
async function otpPatch(rut, fields){
  await fetch(`${SUPABASE_URL}/rest/v1/otp_codes?rut=eq.${encodeURIComponent(rut)}`, {
    method: 'PATCH', headers: { ...SB, 'Prefer': 'return=minimal' }, body: JSON.stringify(fields)
  });
}
async function otpDelete(rut){
  await fetch(`${SUPABASE_URL}/rest/v1/otp_codes?rut=eq.${encodeURIComponent(rut)}`, { method: 'DELETE', headers: { ...SB, 'Prefer': 'return=minimal' } });
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

    // ── 1b) SEND_OTP: enviar código de verificación por WhatsApp (primera vez) ──
    if(action === 'send_otp'){
      const rut = normalizaRut(body.rut);
      if(!rut || !body.nombre) return res.status(400).json({ error: 'Nombre y RUT requeridos' });
      const pac = await medilinkBuscarRut(rut);
      if(!pac) return res.status(200).json({ ok: false, reason: 'no_encontrado' });
      if(!nombreCoincide(body.nombre, pac)) return res.status(200).json({ ok: false, reason: 'nombre_no_coincide' });
      if(await authGet(rut)) return res.status(200).json({ ok: false, reason: 'ya_registrado' });
      const tel = pac.celular || pac.telefono || '';
      if(!tel) return res.status(200).json({ ok: false, reason: 'sin_telefono' });
      const codigo = String(Math.floor(100000 + Math.random() * 900000));
      const expira = new Date(Date.now() + 10 * 60000).toISOString();
      await otpUpsert({ rut, codigo_hash: hashClave(codigo, rut), expira, intentos: 0 });
      try{
        await enviarWhatsApp(tel, `Tu código de acceso a la app del Dr. Gonzalo Pantoja es: ${codigo}\n\nVálido por 10 minutos. No lo compartas con nadie.`, nombreCompleto(pac));
      }catch(e){
        return res.status(200).json({ ok: false, reason: 'envio_fallido' });
      }
      const ult = tel.replace(/\D/g, '').slice(-4);
      return res.status(200).json({ ok: true, tel_masked: '•••• ' + ult });
    }

    // ── 2) REGISTER: crear clave (requiere código OTP verificado) ──
    if(action === 'register'){
      const rut = normalizaRut(body.rut);
      const clave = String(body.clave || '');
      const otp = String(body.otp || '');
      if(!rut || !body.nombre || clave.length < 6) return res.status(400).json({ error: 'Datos incompletos (clave mínimo 6 dígitos)' });
      if(!otp) return res.status(400).json({ error: 'Falta el código de verificación' });
      const pac = await medilinkBuscarRut(rut);
      if(!pac) return res.status(200).json({ ok: false, reason: 'no_encontrado' });
      if(!nombreCoincide(body.nombre, pac)) return res.status(200).json({ ok: false, reason: 'nombre_no_coincide' });
      if(await authGet(rut)) return res.status(200).json({ ok: false, reason: 'ya_registrado' });
      const oc = await otpGet(rut);
      if(!oc) return res.status(200).json({ ok: false, reason: 'codigo_no_solicitado' });
      if(new Date(oc.expira).getTime() < Date.now()){ await otpDelete(rut); return res.status(200).json({ ok: false, reason: 'codigo_expirado' }); }
      if((oc.intentos || 0) >= 6){ await otpDelete(rut); return res.status(200).json({ ok: false, reason: 'codigo_bloqueado' }); }
      if(hashClave(otp, rut) !== oc.codigo_hash){
        await otpPatch(rut, { intentos: (oc.intentos || 0) + 1 });
        return res.status(200).json({ ok: false, reason: 'codigo_incorrecto' });
      }
      await otpDelete(rut);
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

    // ── 6) STATUS: ¿el paciente ya tiene clave en la app? (panel admin) ──
    if(action === 'status'){
      const rut = normalizaRut(body.rut);
      if(!rut) return res.status(400).json({ error: 'RUT requerido' });
      const row = await authGet(rut);
      return res.status(200).json({ ok: true, registered: !!row });
    }

    // ── 5) RESET: el administrador borra la clave de un paciente (desde el CRM) ──
    if(action === 'reset'){
      const rut = normalizaRut(body.rut);
      if(!rut) return res.status(400).json({ error: 'RUT requerido' });
      if(!ADMIN_PIN || String(body.pin || '') !== String(ADMIN_PIN)) return res.status(200).json({ ok: false, reason: 'pin' });
      await fetch(`${SUPABASE_URL}/rest/v1/patient_auth?rut=eq.${encodeURIComponent(rut)}`, {
        method: 'DELETE', headers: { ...SB, 'Prefer': 'return=minimal' }
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción inválida' });

  }catch(e){
    return res.status(500).json({ error: e.message });
  }
};
