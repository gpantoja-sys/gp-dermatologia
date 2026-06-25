// api/transbank-retorno.js — Vercel serverless (CommonJS, Node 18+)
// ─────────────────────────────────────────────────────────────────────────────
// Webpay devuelve el control aquí (vía POST con token_ws) tras el pago.
// Confirmamos la transacción (commit), actualizamos transbank_transacciones y
// mostramos una pantalla de resultado al paciente.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

const PUB = {
  code: '597055555532',
  key:  '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C'
};

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
function fmtCLP(n){ return '$' + (n || 0).toLocaleString('es-CL'); }
function page(titulo, msg, ok){
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>' + titulo + '</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500&family=Inter:wght@400;500&display=swap" rel="stylesheet">'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#f4efe4;font-family:Inter,sans-serif;color:#1c2b1e;padding:24px}'
    + '.card{background:#fbf8f2;border:1px solid #e3dccf;border-radius:20px;padding:40px 32px;'
    + 'max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.04)}'
    + '.ic{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
    + 'margin:0 auto 20px;font-size:34px;background:' + (ok ? 'rgba(47,125,91,.12)' : 'rgba(178,59,59,.1)') + '}'
    + 'h1{font-family:Playfair Display,serif;font-weight:500;font-size:26px;'
    + 'color:' + (ok ? '#1f3d34' : '#b23b3b') + ';margin:0 0 10px}'
    + 'p{font-size:15px;color:#7a8c7c;line-height:1.55;margin:0}</style></head>'
    + '<body><div class="card"><div class="ic">' + (ok ? '\u2713' : '\u00d7') + '</div>'
    + '<h1>' + titulo + '</h1><p>' + msg + '</p></div></body></html>';
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const src = Object.assign({}, req.query || {}, (req.body && typeof req.body === 'object') ? req.body : {});
    const token = src.token_ws;

    // El paciente abortó el formulario o expiró la sesión: Webpay no manda token_ws
    if (!token) {
      res.status(200).send(page('Pago no completado',
        'La transacción fue cancelada o expiró. Puedes intentarlo de nuevo o acercarte a recepción.', false));
      return;
    }

    // Recuperar la empresa de la transacción para usar las credenciales correctas
    let empresa = 'skintouch';
    try {
      const q = await sbFetch('transbank_transacciones?payload->>token=eq.' + encodeURIComponent(token) + '&select=payload&limit=1');
      const rows = await q.json();
      if (rows && rows[0] && rows[0].payload && rows[0].payload.empresa) empresa = rows[0].payload.empresa;
    } catch (e) { /* default skintouch */ }

    const { code, key } = creds(empresa);

    // Commit de la transacción
    const r = await fetch(tbkBase() + '/rswebpaytransaction/api/webpay/v1.2/transactions/' + encodeURIComponent(token), {
      method: 'PUT',
      headers: { 'Tbk-Api-Key-Id': code, 'Tbk-Api-Key-Secret': key, 'Content-Type': 'application/json' }
    });
    const tx = await r.json();
    const aprobado = (tx.response_code === 0) && (tx.status === 'AUTHORIZED');

    // Actualizar la fila (por ref = buy_order), conservando empresa y token + el resultado
    if (tx.buy_order) {
      await sbFetch('transbank_transacciones?ref=eq.' + encodeURIComponent(tx.buy_order), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          estado: aprobado ? 'autorizada' : 'rechazada',
          payload: { empresa: empresa, token: token, resultado: tx }
        })
      });
    }

    if (aprobado) {
      res.status(200).send(page('Reserva confirmada',
        'Tu reserva de ' + fmtCLP(tx.amount) + ' quedó registrada y se abonará a tu atención. Ya puedes cerrar esta pantalla.', true));
    } else {
      res.status(200).send(page('Pago no aprobado',
        'El pago no fue aprobado por el banco. Intenta nuevamente o acércate a recepción.', false));
    }
  } catch (e) {
    res.status(200).send(page('Error',
      'Ocurrió un problema al confirmar el pago. Acércate a recepción y lo resolvemos.', false));
  }
};
