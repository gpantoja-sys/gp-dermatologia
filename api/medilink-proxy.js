// api/medilink-proxy.js — GP Dermatología
// Proxy seguro para consultas a Medilink desde el frontend

const MEDILINK_BASE = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!MEDILINK_TOKEN) return res.status(500).json({ error: 'Token no configurado' });

  const { tipo, valor } = req.query;
  if (!tipo || !valor) return res.status(400).json({ error: 'Faltan parámetros' });

  try {
    let data = [];

    if (tipo === 'rut') {
      // Medilink FILTRA por 'numero_documento' (no por 'rut'; 'rut' solo viene en
      // la respuesta). Probamos numero_documento primero, rut de respaldo, y
      // todas las variantes de formato (puntos, guión, cero a la izquierda).
      const limpio = valor.replace(/\./g,'').replace(/\s/g,'').replace(/-/g,'').trim().toUpperCase();
      const cuerpo = limpio.slice(0,-1), dv = limpio.slice(-1);
      const conPuntos = c => c.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      const variantes = new Set();
      for (const c of [cuerpo, cuerpo.padStart(8,'0')]) {
        variantes.add(c + '-' + dv);
        variantes.add(c + dv);
        variantes.add(conPuntos(c) + '-' + dv);
      }
      for (const v of [...variantes]) { variantes.add(v.toLowerCase()); variantes.add(v.toUpperCase()); }

      outer:
      for (const campo of ['numero_documento', 'rut']) {
        for (const rut of variantes) {
          const filtro = {}; filtro[campo] = { eq: rut };
          const url = `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify(filtro))}`;
          const r = await fetch(url, { headers: { Authorization: `Token ${MEDILINK_TOKEN}` } });
          if (r.ok) {
            const json = await r.json();
            data = json.data || [];
            if (data.length > 0) break outer;
          }
        }
      }

    } else if (tipo === 'tel') {
      // Medilink guarda el celular en formato internacional: +56998724055
      // Antes se buscaba SIN el +56, por eso nunca calzaba.
      // Ahora probamos primero el formato con +56 (el que usa Medilink).
      const digits = valor.replace(/\D/g, '');   // ej: "56998724055"
      const nueve  = digits.slice(-9);            // ej: "998724055"
      const formatos = [
        `+${digits}`,      // +56998724055  <- formato real en Medilink
        `+56${nueve}`,     // +56998724055  (canónico Chile, por si acaso)
        valor,             // tal cual llegó (ya viene con +)
        digits,            // 56998724055
        nueve,             // 998724055
        digits.slice(-8),  // 98724055
      ];

      for (const tel of [...new Set(formatos)]) {
        const url = `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify({ celular: { eq: tel } }))}`;
        const r = await fetch(url, { headers: { Authorization: `Token ${MEDILINK_TOKEN}` } });
        if (r.ok) {
          const json = await r.json();
          data = json.data || [];
          if (data.length > 0) break;
        }
      }

    } else {
      return res.status(400).json({ error: 'tipo debe ser rut o tel' });
    }

    if (data.length === 0) return res.status(200).json({ encontrado: false, paciente: null });

    const p = data[0];
    return res.status(200).json({
      encontrado: true,
      paciente: {
        id_medilink: String(p.id),
        nombre: p.nombre || '',
        apellido: (p.apellidos || '').split(' ')[0] || '',
        apellido2: (p.apellidos || '').split(' ').slice(1).join(' ') || '',
        rut: p.rut || '',
        tel: p.celular || p.telefono || '',
        email: p.email || '',
        comuna: p.comuna || '',
        direccion: p.direccion || '',
        sexo: p.sexo || '',
        nac: p.fecha_nacimiento || null
      }
    });

  } catch (e) {
    console.error('[medilink-proxy]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
