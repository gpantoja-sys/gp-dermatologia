// api/medilink-debug.js — DIAGNÓSTICO TEMPORAL de la conexión con Medilink.
// ⚠️ BORRAR este archivo apenas terminemos de diagnosticar.
// Uso:  /api/medilink-debug?key=538e850b11783f3df4282ef366c0b48f&rut=8900518-3
//
// Protegido por una clave fija para que nadie más vea datos de pacientes.

const MEDILINK_BASE  = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;
const DEBUG_KEY      = '538e850b11783f3df4282ef366c0b48f';

module.exports = async function handler(req, res){
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Protección
  if (req.query.key !== DEBUG_KEY) {
    return res.status(401).json({ error: 'No autorizado. Falta o no coincide ?key=' });
  }

  // ¿Está el token configurado en Vercel?
  if (!MEDILINK_TOKEN) {
    return res.status(200).json({
      token_configurado: false,
      conclusion: 'MEDILINK_TOKEN NO está configurado en Vercel. Esa es la causa: sin token, ninguna búsqueda funciona. Hay que cargarlo en Settings → Environment Variables.'
    });
  }

  const rut = (req.query.rut || '8900518-3').trim();
  const rutSinGuion = rut.replace(/-/g, '');

  const pruebas = [
    { nombre: '1) Listar pacientes SIN filtro (¿el token sirve?)', url: `${MEDILINK_BASE}/pacientes` },
    { nombre: '2) Filtrar por rut con guión',                     url: `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify({ rut: { eq: rut } }))}` },
    { nombre: '3) Filtrar por rut sin guión',                     url: `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify({ rut: { eq: rutSinGuion } }))}` },
    { nombre: '4) Filtrar por numero_documento',                  url: `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify({ numero_documento: { eq: rut } }))}` },
    { nombre: '5) Listar con slash final',                        url: `${MEDILINK_BASE}/pacientes/` },
  ];

  const salida = {
    token_configurado: true,
    token_largo: MEDILINK_TOKEN.length,
    token_inicio: MEDILINK_TOKEN.slice(0, 4) + '…',
    rut_probado: rut,
    resultados: []
  };

  for (const p of pruebas) {
    try {
      const r = await fetch(p.url, { headers: { Authorization: `Token ${MEDILINK_TOKEN}` } });
      const txt = await r.text();
      let json = null; try { json = JSON.parse(txt); } catch (e) {}
      const data = json && Array.isArray(json.data) ? json.data : null;
      salida.resultados.push({
        prueba: p.nombre,
        status: r.status,
        ok: r.ok,
        cuantos: data ? data.length : null,
        muestra: data ? data.slice(0, 3).map(x => ({
          id: x.id, rut: x.rut, nombre: x.nombre, apellidos: x.apellidos,
          celular: x.celular, telefono: x.telefono
        })) : null,
        cuerpo_si_no_es_json: json ? undefined : txt.slice(0, 300)
      });
    } catch (e) {
      salida.resultados.push({ prueba: p.nombre, error: e.message });
    }
    await new Promise(r => setTimeout(r, 400)); // respeta el límite de 20 req/min
  }

  // Conclusión automática
  const listar = salida.resultados[0];
  if (listar.status === 401 || listar.status === 403) {
    salida.conclusion = 'El token NO sirve (status ' + listar.status + '). Está vencido, mal copiado, o la cuenta no tiene la API habilitada. Hay que regenerarlo en Medilink (Configuración API) y actualizarlo en Vercel.';
  } else if (listar.ok) {
    const porRut = salida.resultados[1].cuantos || salida.resultados[2].cuantos;
    const porNum = salida.resultados[3].cuantos;
    if (porRut) salida.conclusion = 'El token sirve y el filtro por "rut" encuentra al paciente. El código debe filtrar por rut.';
    else if (porNum) salida.conclusion = 'El token sirve y el filtro correcto es "numero_documento".';
    else salida.conclusion = 'El token sirve pero ningún filtro devuelve al paciente. Revisar el formato exacto del rut en la muestra de la prueba 1.';
  } else {
    salida.conclusion = 'Respuesta inesperada (status ' + listar.status + '). Revisar cuerpo_si_no_es_json.';
  }

  return res.status(200).json(salida);
};
