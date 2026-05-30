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

  // Limpiar número
  const soloDigitos = number.replace(/\D/g, '');
  let numeroFinal = soloDigitos;
  if (soloDigitos.length === 9 && soloDigitos.startsWith('9')) {
    numeroFinal = '56' + soloDigitos;
  }

  const payload = {
    whatsappId: '3c28baaa-9e97-4392-8398-188b6520b262',
    number: numeroFinal,
    body,
    name: name || ''
  };

  // Log para debugging
  console.log('Payload enviado a Whaticket:', JSON.stringify(payload));
  console.log('Token (primeros 20 chars):', token.substring(0, 20));

  try {
    const response = await fetch('https://api.whaticket.com/api/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log('Respuesta Whaticket status:', response.status);
    console.log('Respuesta Whaticket body:', JSON.stringify(data));

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: data.message || 'Error Whaticket', 
        detail: data,
        payload_sent: payload
      });
    }

    return res.status(200).json({ ok: true, data });

  } catch (err) {
    console.log('Error catch:', err.message);
    return res.status(500).json({ error: 'Error de conexión con Whaticket', detail: err.message });
  }
}
