// api/transbank-crear.js — Vercel serverless (CommonJS, Node 18+)
// ─────────────────────────────────────────────────────────────────────────────
// Crea una transacción Webpay Plus y la registra en transbank_transacciones.
//   · SANDBOX (por defecto): usa las credenciales PÚBLICAS de integración.
//   · PRODUCCIÓN: define en Vercel TBK_ENV=production y, por empresa,
//     TBK_SKINTOUCH_COMMERCE_CODE / TBK_SKINTOUCH_API_KEY (y LASERTOUCH).
// La URL de retorno se arma sola desde el dominio que llama (no requiere variable).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

// Credenciales públicas de integración (Webpay Plus). Válidas solo para pruebas.
const PUB = {
  code: '597055555532',
  key:  '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C'
};

// skintouch → honorarios (SkinTouch SpA) · lasertouch → insumos (LaserTouch Ltda.)
const EMPRESA_TIPO = { skintouch: 'honorarios', lasertouch: 'insumos' };

function tbkBase(){
  return process.env.TBK_ENV === 'production'
    ? 'https://webpay3g.transbank.cl'
    : 'https://webpay3gint.transbank.cl';
}
function creds(empresa){
  const E = String(empresa || 'skintouch').toUpperCase();
  return {
    code: process.env['TBK_' + E + '_COMMERCE_CODE'] || PUB.code,
    key:  process.env['TBK_' + E + '_API_KEY']        || PUB.key
  };
}
function sbFetch(path, opts){
  opts = opts || {};
  return fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    }, opts.headers || {})
  }));
}
async function empresaId(empresa){
  const tipo = EMPRESA_TIPO[empresa] || 'honorarios';
  try {
    const r = await sbFetch('empresas?tipo=eq.' + tipo + '&select=id&limit=1');
    const arr = await r.json();
    return (arr && arr[0]) ? arr[0].id : null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const empresa = String(body.empresa || 'skintouch').toLowerCase();
    const monto = parseInt(body.monto, 10);
    const paciente_rut = body.paciente_rut || null;
    const concepto = body.concepto || 'Reserva de hora';
    if (!monto || monto < 1) { res.status(400).json({ error: 'monto inválido' }); return; }

    const buyOrder  = 'GP-' + Date.now();
    const sessionId = String(paciente_rut || 'anon').replace(/[^0-9kK-]/g, '') + '-' + Date.now();
    const host      = req.headers['x-forwarded-host'] || req.headers.host;
    const returnUrl = 'https://' + host + '/api/transbank-retorno';
    const { code, key } = creds(empresa);

    // 1) Crear transacción en Transbank (Webpay Plus REST v1.2)
    const r = await fetch(tbkBase() + '/rswebpaytransaction/api/webpay/v1.2/transactions', {
      method: 'POST',
      headers: { 'Tbk-Api-Key-Id': code, 'Tbk-Api-Key-Secret': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ buy_order: buyOrder, session_id: sessionId, amount: monto, return_url: returnUrl })
    });
    const tbk = await r.json();
    if (!r.ok || !tbk.token) { res.status(502).json({ error: 'transbank', detalle: tbk }); return; }

    // 2) Registrar en transbank_transacciones (estado 'iniciada')
    const emp_id = await empresaId(empresa);
    await sbFetch('transbank_transacciones', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        proveedor: 'webpay',
        ref: buyOrder,
        monto: monto,
        empresa_id: emp_id,
        estado: 'iniciada',
        payload: { empresa, concepto, token: tbk.token, session_id: sessionId, paciente_rut, return_url: returnUrl }
      })
    });

    // 3) Devolver token + url para redirigir el navegador a Webpay
    res.status(200).json({ token: tbk.token, url: tbk.url, buy_order: buyOrder });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
