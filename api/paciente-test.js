// api/paciente-test.js  ·  DIAGNÓSTICO TEMPORAL — BORRAR DESPUÉS DE USAR
// Trae la ficha de UN paciente de Medilink por su id y devuelve el JSON crudo,
// para ver los nombres reales de los campos (RUT, nombre, teléfono, email…).
//
// Uso:  https://www.drgonzalopantoja.cl/api/paciente-test?id=26211
//
// Seguridad: solo lee (GET a Medilink). No escribe nada. No expone el token.

const MEDILINK_BASE  = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!MEDILINK_TOKEN){
    return res.status(500).json({ error: 'Falta MEDILINK_TOKEN en Vercel.' });
  }

  const id = String((req.query && req.query.id) || '').trim();
  if (!/^\d+$/.test(id)){
    return res.status(400).json({ error: 'Indica el id de Medilink así: ?id=26211' });
  }

  try {
    const r = await fetch(MEDILINK_BASE + '/pacientes/' + id, {
      headers: { Authorization: 'Token ' + MEDILINK_TOKEN }
    });
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch(e){ json = { _raw: txt }; }

    // La ficha suele venir dentro de json.data
    const ficha = (json && json.data) ? json.data : json;

    return res.status(200).json({
      ok: true,
      id_consultado: id,
      http_status_medilink: r.status,
      campos_de_la_ficha: (ficha && typeof ficha === 'object' && !Array.isArray(ficha)) ? Object.keys(ficha) : [],
      ficha: ficha,
      _nota: 'Pega este JSON completo en el chat. Luego borra este archivo.'
    });
  } catch (e){
    return res.status(500).json({ error: 'Fallo la consulta a Medilink', detalle: String(e && e.message || e) });
  }
};
