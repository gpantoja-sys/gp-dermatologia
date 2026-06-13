// api/medilink-proxy.js — GP Dermatología
// Proxy seguro para consultas a Medilink desde el frontend
// Evita CORS y mantiene el token fuera del navegador

const MEDILINK_BASE = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;
const MEDILINK_ID_PROFESIONAL = 1;

module.exports = async function handler(req, res) {
  // CORS — permitir llamadas desde el CRM
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!MEDILINK_TOKEN) {
    return res.status(500).json({ error: 'Token no configurado' });
  }

  const { tipo, valor } = req.query;

  if (!tipo || !valor) {
    return res.status(400).json({ error: 'Faltan parámetros: tipo y valor' });
  }

  try {
    let params = {};

    if (tipo === 'rut') {
      params = { numero_documento: { eq: valor } };
    } else if (tipo === 'tel') {
      // Últimos 9 dígitos del celular
      const soloDigitos = valor.replace(/\D/g, '');
      params = { celular: { eq: soloDigitos } };
    } else {
      return res.status(400).json({ error: 'tipo debe ser rut o tel' });
    }

    const url = new URL(`${MEDILINK_BASE}/pacientes`);
    url.searchParams.set('q', JSON.stringify(params));
    url.searchParams.set('id_profesional', MEDILINK_ID_PROFESIONAL);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Token ${MEDILINK_TOKEN}` }
    });

    if (!response.ok) {
      const txt = await response.text();
      return res.status(response.status).json({ error: `Medilink ${response.status}`, detail: txt });
    }

    const json = await response.json();
    const data = json.data || [];

    if (data.length === 0) {
      return res.status(200).json({ encontrado: false, paciente: null });
    }

    const p = data[0];

    // Devolver solo los campos necesarios — no exponer datos sensibles
    return res.status(200).json({
      encontrado: true,
      paciente: {
        id_medilink: String(p.id),
        nombre: p.nombre || '',
        apellido: (p.apellidos || '').split(' ')[0] || '',
        apellido2: (p.apellidos || '').split(' ').slice(1).join(' ') || '',
        rut: p.numero_documento || '',
        tel: p.celular || p.telefono || '',
        email: p.email || '',
        comuna: p.comuna || '',
        direccion: p.direccion || '',
        sexo: p.sexo || '',
        nac: p.fecha_nacimiento || null
      }
    });

  } catch (e) {
    console.error('[medilink-proxy] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
