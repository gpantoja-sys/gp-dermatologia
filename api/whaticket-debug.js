// api/whaticket-debug.js — DIAGNÓSTICO TEMPORAL del envío por WhatsApp (Whaticket).
// ⚠️ BORRAR este archivo apenas terminemos.
// Uso (manda el código de prueba a TU propio WhatsApp para confirmar recepción):
//   /api/whaticket-debug?key=538e850b11783f3df4282ef366c0b48f&tel=569XXXXXXXX
// Si no pones tel, usa el de Mercedes (+56990560093).

const WHATICKET_TOKEN = process.env.WHATICKET_TOKEN;
const WHATSAPP_ID     = '3c28baaa-9e97-4392-8398-188b6520b262';
const DEBUG_KEY       = '538e850b11783f3df4282ef366c0b48f';

module.exports = async function handler(req, res){
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.query.key !== DEBUG_KEY) {
    return res.status(401).json({ error: 'No autorizado. Falta o no coincide ?key=' });
  }

  if (!WHATICKET_TOKEN) {
    return res.status(200).json({
      token_configurado: false,
      conclusion: 'WHATICKET_TOKEN NO esta configurado en Vercel. Hay que cargarlo en Settings -> Environment Variables.'
    });
  }

  const telEntrada = (req.query.tel || '+56990560093').toString();
  let dig = telEntrada.replace(/\D/g, '');
  if (dig.length === 9 && dig.startsWith('9')) dig = '56' + dig;
  if (dig && !dig.startsWith('56')) dig = '56' + dig;

  const salida = {
    token_configurado: true,
    token_largo: WHATICKET_TOKEN.length,
    token_inicio: WHATICKET_TOKEN.slice(0, 4) + '...',
    whatsappId: WHATSAPP_ID,
    numero_enviado: dig,
    pruebas: []
  };

  // PRUEBA A - listar conexiones (verifica si la sesion esta conectada)
  for (const path of ['/whatsapp', '/whatsapp/', '/connections']) {
    try {
      const r = await fetch('https://api.whaticket.com/api/v1' + path, {
        headers: { Authorization: 'Bearer ' + WHATICKET_TOKEN }
      });
      const txt = await r.text();
      let json = null; try { json = JSON.parse(txt); } catch (e) {}
      salida.pruebas.push({
        prueba: 'Listar conexiones (GET ' + path + ')',
        status: r.status,
        cuerpo: json ? json : txt.slice(0, 400)
      });
      if (r.ok) break;
    } catch (e) {
      salida.pruebas.push({ prueba: 'Listar conexiones (GET ' + path + ')', error: e.message });
    }
    await new Promise(rr => setTimeout(rr, 300));
  }

  // PRUEBA B - envio de prueba real
  const payload = {
    whatsappId: WHATSAPP_ID,
    messages: [{ number: dig, body: 'Mensaje de PRUEBA del sistema GP. Si lo recibiste, el envio funciona.', name: 'Prueba GP' }]
  };
  try {
    const r = await fetch('https://api.whaticket.com/api/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WHATICKET_TOKEN },
      body: JSON.stringify(payload)
    });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch (e) {}
    salida.pruebas.push({
      prueba: 'Envio de prueba (POST /messages)',
      status: r.status,
      ok: r.ok,
      cuerpo: json ? json : txt.slice(0, 600)
    });
  } catch (e) {
    salida.pruebas.push({ prueba: 'Envio de prueba (POST /messages)', error: e.message });
  }

  const envio = salida.pruebas.find(function(p){ return p.prueba.indexOf('Envio') === 0; });
  if (envio && envio.error) {
    salida.conclusion = 'No se pudo conectar con Whaticket: ' + envio.error;
  } else if (envio && (envio.status === 401 || envio.status === 403)) {
    salida.conclusion = 'El token de Whaticket NO sirve (status ' + envio.status + '): vencido o mal copiado. Regenerarlo en Whaticket y actualizarlo en Vercel.';
  } else if (envio && envio.ok) {
    salida.conclusion = 'El envio respondio OK. Revisa si llego el WhatsApp de prueba. Si llego, el problema ya esta resuelto.';
  } else if (envio) {
    salida.conclusion = 'Whaticket rechazo el envio (status ' + envio.status + '). Lo mas comun: la sesion de WhatsApp esta DESCONECTADA (reescanear QR en Whaticket) o el whatsappId cambio. Mira el campo cuerpo.';
  }

  return res.status(200).json(salida);
};
