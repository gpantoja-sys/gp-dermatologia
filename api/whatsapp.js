export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { number, body, name } = req.body;

  if (!number || !body) {
    return res.status(400).json({ error: 'Faltan campos requeridos: number, body' });
  }

  const token = process.env.WHATICKET_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Token no configurado en servidor' });
  }

  // Limpiar número: quitar todo excepto dígitos
  const soloDigitos = number.replace(/\D/g, '');

  // Whaticket espera formato: 56912345678 (sin + ni espacios)
  // Si ya empieza con 56 y tiene 11 dígitos → correcto
  // Si empieza con 9 y tiene 9 dígitos → agregar 56
  let numeroFinal = soloDigitos;
  if (soloDigitos.length === 9 && soloDigitos.startsWith('9')) {
    numeroFinal = '56' + soloDigitos;
  } else if (soloDigitos.length === 11 && soloDigitos.startsWith('569')) {
    numeroFinal = soloDigitos; // ya correcto
  } else if (soloDigitos.startsWith('56')) {
    numeroFinal = soloDigitos;
  }

  try {
    const response = await fetch('https://api.whaticket.com/api/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        whatsappId: '56966453801',
        number: numeroFinal,
        body,
        name: name || ''
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'Error Whaticket', detail: data });
    }

    return res.status(200).json({ ok: true, data });

  } catch (err) {
    return res.status(500).json({ error: 'Error de conexión con Whaticket', detail: err.message });
  }
}
