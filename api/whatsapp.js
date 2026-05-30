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

  // Whaticket espera un array de mensajes
  const payload = {
    whatsappId: '3c28baaa-9e97-4392-8398-188b6520b262',
    messages: [
      {
        number: numeroFinal,
        body,
        name: name || ''
      }
    ]
  };

  console.log('Payload enviado:', JSON.stringify(payload));

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
    console.log('Respuesta status:', response.status);
    console.log('Respuesta body:', JSON.stringify(data));

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'Error Whaticket', detail: data });
    }

    return res.status(200).json({ ok: true, data });

  } catch (err) {
    return res.status(500).json({ error: 'Error de conexión', detail: err.message });
  }
}
