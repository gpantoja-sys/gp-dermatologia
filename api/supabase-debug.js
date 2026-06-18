// api/supabase-debug.js — DIAGNOSTICO TEMPORAL de la tabla patient_auth.
// ⚠️ BORRAR apenas terminemos.
// Uso: /api/supabase-debug?key=538e850b11783f3df4282ef366c0b48f&rut=8900518-3

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEBUG_KEY = '538e850b11783f3df4282ef366c0b48f';

module.exports = async function handler(req, res){
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.query.key !== DEBUG_KEY) return res.status(401).json({ error: 'No autorizado' });
  if (!KEY) return res.status(200).json({ service_role_configurado: false, conclusion: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel.' });

  const rut = (req.query.rut || '8900518-3').trim();
  const SB = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const out = { service_role_configurado: true, key_largo: KEY.length, rut: rut, pruebas: [] };

  // 1) ¿Existe la fila de la paciente?
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/patient_auth?rut=eq.' + encodeURIComponent(rut) + '&select=*', { headers: SB });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch(e){}
    out.pruebas.push({ prueba: '1) Buscar fila de la paciente', status: r.status, filas: Array.isArray(j) ? j.length : null, cuerpo: j || txt.slice(0, 400) });
  } catch(e){ out.pruebas.push({ prueba: '1) buscar fila', error: e.message }); }

  // 2) ¿Existe la tabla?
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/patient_auth?select=rut,nombre&limit=5', { headers: SB });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch(e){}
    out.pruebas.push({ prueba: '2) Listar tabla patient_auth', status: r.status, cuerpo: j || txt.slice(0, 400) });
  } catch(e){ out.pruebas.push({ prueba: '2) listar tabla', error: e.message }); }

  // 3) Inserción de prueba (revela el error real) y limpieza
  const testRut = '00000000-DEBUG';
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/patient_auth', {
      method: 'POST',
      headers: Object.assign({}, SB, { Prefer: 'return=representation' }),
      body: JSON.stringify({ rut: testRut, clave_hash: 'x', nombre: 'PRUEBA', attempts: 0, locked_until: null })
    });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch(e){}
    out.pruebas.push({ prueba: '3) Insertar fila de prueba', status: r.status, ok: r.ok, cuerpo: j || txt.slice(0, 500) });
    await fetch(SUPABASE_URL + '/rest/v1/patient_auth?rut=eq.' + encodeURIComponent(testRut), { method: 'DELETE', headers: Object.assign({}, SB, { Prefer: 'return=minimal' }) });
  } catch(e){ out.pruebas.push({ prueba: '3) insertar prueba', error: e.message }); }

  // Conclusion
  const fila = out.pruebas[0];
  const tabla = out.pruebas[1];
  const insert = out.pruebas.find(function(p){ return p.prueba.indexOf('3)') === 0; });
  const msgTabla = (tabla && typeof tabla.cuerpo === 'object' && tabla.cuerpo && tabla.cuerpo.message) ? tabla.cuerpo.message : '';
  if (tabla && (tabla.status >= 400 || /relation|does not exist|no existe|not exist/i.test(msgTabla))) {
    out.conclusion = 'La tabla patient_auth NO existe (o no es accesible). Por eso la clave nunca se guarda. Hay que crearla en Supabase.';
  } else if (fila && fila.filas === 0) {
    if (insert && insert.ok) out.conclusion = 'La tabla existe y la insercion de prueba FUNCIONO, pero la fila de la paciente NO esta. La clave no se grabo al registrarse (authUpsert fallo en ese momento, probablemente por una columna que no calza). Revisa el cuerpo de la prueba 3.';
    else out.conclusion = 'La tabla existe pero la INSERCION FALLA: ' + JSON.stringify(insert ? insert.cuerpo : null) + '. Por eso la clave no se guarda. Hay que corregir esquema o permisos.';
  } else if (fila && fila.filas > 0) {
    out.conclusion = 'La fila de la paciente SI existe. Entonces el login falla por otra razon (coincidencia de RUT o clave). Mira el cuerpo de la prueba 1.';
  } else {
    out.conclusion = 'Resultado inesperado, revisa las pruebas.';
  }
  return res.status(200).json(out);
};
