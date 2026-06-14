// api/import-pacientes.js — GP Dermatología
// Sincroniza pacientes desde Medilink hacia Supabase.
// - Modo prueba (?dry=1): consulta UNA página de /pacientes y devuelve su estructura,
//   sin escribir nada. Sirve para ver cómo pagina Medilink antes de armar el sync completo.
// - Modo real: pendiente de configurar tras confirmar la estructura con el modo prueba.
//
// Protección: requiere el CRON_SECRET, ya sea como header (cron de Vercel) o ?key=...

const MEDILINK_BASE = 'https://api.medilink.healthatom.com/api/v1';
const TOKEN  = process.env.MEDILINK_TOKEN;
const SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  // ── Autorización ──
  const auth = req.headers.authorization || '';
  const key  = req.query.key || '';
  const autorizado = SECRET && (auth === `Bearer ${SECRET}` || key === SECRET);
  if (!autorizado) return res.status(401).json({ error: 'No autorizado' });
  if (!TOKEN)       return res.status(500).json({ error: 'Falta MEDILINK_TOKEN' });

  const dry = req.query.dry === '1' || req.query.dry === 'true';

  // ── MODO PRUEBA: inspeccionar la respuesta de /pacientes ──
  if (dry) {
    try {
      const url = `${MEDILINK_BASE}/pacientes`;
      const r = await fetch(url, { headers: { Authorization: `Token ${TOKEN}` } });
      const status = r.status;

      let json = null;
      try { json = await r.json(); } catch (e) { json = null; }

      const out = { status, topKeys: json ? Object.keys(json) : null };

      if (json) {
        const arr = json.data || json.results || json.pacientes || [];
        out.dataLength  = Array.isArray(arr) ? arr.length : 'no es array';
        out.meta        = json.meta || json.pagination || json.links || null;
        out.totalHint   = json.total || json.count ||
                          (json.meta && (json.meta.total || json.meta.count)) || null;
        if (Array.isArray(arr) && arr.length) {
          out.primerPacienteCampos = Object.keys(arr[0]);
          out.primerPacienteEjemplo = {
            id: arr[0].id,
            rut: arr[0].rut,
            nombre: arr[0].nombre,
            apellidos: arr[0].apellidos,
            comuna: arr[0].comuna,
            sexo: arr[0].sexo,
            fecha_nacimiento: arr[0].fecha_nacimiento,
            celular: arr[0].celular,
            email: arr[0].email
          };
        }
      } else {
        out.nota = 'La respuesta no fue JSON (posible error de la API).';
      }

      return res.status(200).json(out);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── MODO REAL: se configura tras confirmar la estructura con ?dry=1 ──
  return res.status(200).json({
    msg: 'Sync real aún no configurado. Ejecuta primero el modo prueba con ?dry=1 para ver la estructura de Medilink.'
  });
};
