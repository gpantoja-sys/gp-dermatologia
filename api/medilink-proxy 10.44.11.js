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
      // Probar formatos del RUT: con guión, sin guión, sin puntos
      const formatos = [
        valor,
        valor.toUpperCase(),
        valor.toLowerCase(),
        valor.replace(/\./g, ''),
        valor.replace(/\./g, '').replace(/-/g, ''),
      ];

      for (const rut of [...new Set(formatos)]) {
        const url = `${MEDILINK_BASE}/pacientes?q=${encodeURIComponent(JSON.stringify({ rut: { eq: rut } }))}`;
        const r = await fetch(url, { headers: { Authorization: `Token ${MEDILINK_TOKEN}` } });
        if (r.ok) {
          const json = await r.json();
          data = json.data || [];
          if (data.length > 0) break;
        }
      }

    } else if (tipo === 'tel') {
      const digits = valor.replace(/\D/g, '');
      const formatos = [digits, digits.slice(-9), digits.slice(-8)];

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
