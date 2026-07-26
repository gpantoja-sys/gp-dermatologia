// api/citas-test.js  ·  DIAGNÓSTICO TEMPORAL — BORRAR DESPUÉS DE USAR
// Trae las citas de Medilink para una fecha y devuelve el JSON crudo de las
// primeras citas, para ver los nombres reales de los campos de tu cuenta.
//
// Uso:  https://www.drgonzalopantoja.cl/api/citas-test?fecha=2026-07-27
//
// Seguridad: solo lee (GET a Medilink). No escribe nada. No expone el token.

const MEDILINK_BASE  = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;

async function medilink(endpoint, params){
  const url = new URL(MEDILINK_BASE + '/' + endpoint);
  if (params && Object.keys(params).length){
    url.searchParams.set('q', JSON.stringify(params));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: 'Token ' + MEDILINK_TOKEN }
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch(e){ json = { _raw: txt }; }
  return { status: res.status, json: json };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!MEDILINK_TOKEN){
    return res.status(500).json({ error: 'Falta MEDILINK_TOKEN en las variables de entorno de Vercel.' });
  }

  const fecha = String((req.query && req.query.fecha) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)){
    return res.status(400).json({ error: 'Indica la fecha así: ?fecha=2026-07-27' });
  }

  try {
    // Intento 1: filtrar citas por fecha exacta
    let r = await medilink('citas', { fecha: { eq: fecha } });
    let citas = (r.json && r.json.data) ? r.json.data : [];

    // Intento 2 (respaldo): rango del día, por si 'eq' no aplica
    if (!citas.length){
      const r2 = await medilink('citas', { fecha: { gte: fecha, lte: fecha } });
      if (r2.json && r2.json.data && r2.json.data.length){ r = r2; citas = r2.json.data; }
    }

    // Devolvemos: cuántas citas, TODOS los campos de la primera cita (las llaves),
    // y las primeras 3 citas completas para ver los valores reales.
    const primera = citas[0] || null;
    return res.status(200).json({
      ok: true,
      fecha: fecha,
      http_status_medilink: r.status,
      total_citas: citas.length,
      campos_de_una_cita: primera ? Object.keys(primera) : [],
      muestra_3_citas: citas.slice(0, 3),
      // También listamos los estados posibles que define tu Medilink:
      _nota: 'Pega este JSON completo en el chat. Luego borra este archivo.'
    });
  } catch (e){
    return res.status(500).json({ error: 'Fallo la consulta a Medilink', detalle: String(e && e.message || e) });
  }
};
