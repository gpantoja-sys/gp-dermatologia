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

    let data = [];

    if (tipo === 'rut') {
      // Probar múltiples formatos del RUT
      const rutFormatos = [
        valor,                                    // tal como viene: 10238928-k
        valor.replace(/-/g, ''),                  // sin guión: 10238928k
        valor.replace(/\./g, '').replace(/-/g,'') // sin puntos ni guión: 10238928k
      ];

      for (const rut of rutFormatos) {
        const params = { numero_documento: { eq: rut } };
        const url = new URL(`${MEDILINK_BASE}/pacientes`);
        url.searchParams.set('q', JSON.stringify(params));
        const response = await fetch(url.toString(), {
          headers: { Authorization: `Token ${MEDILINK_TOKEN}` }
        });
        if (response.ok) {
          const json = await response.json();
          data = json.data || [];
          if (data.length > 0) break;
        }
      }

    } else if (tipo === 'tel') {
      const soloDigitos = valor.replace(/\D/g, '');
      // Probar con y sin código de país
      const telFormatos = [
        soloDigitos,
        soloDigitos.slice(-9),
        soloDigitos.slice(-8)
      ];

      for (const tel of telFormatos) {
        const params = { celular: { eq: tel } };
        const url = new URL(`${MEDILINK_BASE}/pacientes`);
        url.searchParams.set('q', JSON.stringify(params));
        const response = await fetch(url.toString(), {
          headers: { Authorization: `Token ${MEDILINK_TOKEN}` }
        });
        if (response.ok) {
          const json = await response.json();
          data = json.data || [];
          if (data.length > 0) break;
        }
      }

    } else {
      return res.status(400).json({ error: 'tipo debe ser rut o tel' });
    }

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
