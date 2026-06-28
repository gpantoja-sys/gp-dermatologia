// api/pagar.js — Vercel serverless (CommonJS, Node 18+)
// ─────────────────────────────────────────────────────────────────────────────
// Página puente que abre el QR en el TELÉFONO de la paciente.
// El QR codifica  https://drgonzalopantoja.cl/api/pagar?tk=TOKEN
// Aquí mostramos "Pagar $X" y, al tocar, hacemos el POST real a WebPay
// (un toque = gesto del usuario, evita el bloqueo de auto-envío de Safari).
// WebPay vuelve luego a /api/transbank-retorno, que cierra el enganche.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

const EMPRESA_LABEL = { skintouch: 'SkinTouch', lasertouch: 'LaserTouch' };

function tbkBase(){
  return process.env.TBK_ENV === 'production'
    ? 'https://webpay3g.transbank.cl'
    : 'https://webpay3gint.transbank.cl';
}
function fmtCLP(n){ return '$' + (n || 0).toLocaleString('es-CL'); }

function page(inner){
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>Pago · Dr. Gonzalo Pantoja</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">'
    + '<style>*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4efe4;'
    + 'font-family:Inter,sans-serif;color:#1c2b1e;padding:24px}'
    + '.card{background:#fbf8f2;border:1px solid #e3dccf;border-radius:22px;padding:34px 26px;max-width:400px;'
    + 'width:100%;text-align:center;box-shadow:0 2px 14px rgba(0,0,0,.05)}'
    + '.emp{font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#7a8c7c}'
    + 'h1{font-family:Playfair Display,serif;font-weight:500;font-size:22px;margin:8px 0 4px;color:#1f3d34}'
    + '.amt{font-family:Playfair Display,serif;font-size:42px;color:#1c2b1e;margin:10px 0 4px}'
    + 'p{font-size:14px;color:#7a8c7c;line-height:1.55;margin:8px 0 0}'
    + 'button{width:100%;font-family:inherit;font-size:17px;font-weight:600;border-radius:14px;padding:17px;'
    + 'border:none;background:#1f3d34;color:#fff;cursor:pointer;margin-top:24px}'
    + 'button:active{background:#2c5446}.note{font-size:12px;color:#a39c8f;margin-top:16px}'
    + '</style></head><body>' + inner + '</body></html>';
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const tk = (req.query && req.query.tk) ? String(req.query.tk) : null;

  if (!tk) {
    res.status(400).send(page('<div class="card"><h1>Enlace inválido</h1>'
      + '<p>No se encontró el pago. Acércate a recepción y lo resolvemos.</p></div>'));
    return;
  }

  // Buscar el monto y la empresa para mostrarlos (solo lectura)
  let monto = null, empresa = '';
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/transbank_transacciones?payload->>token=eq.'
      + encodeURIComponent(tk) + '&select=monto,estado,payload&limit=1',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } });
    const rows = await r.json();
    if (rows && rows[0]) {
      monto = rows[0].monto;
      empresa = (rows[0].payload && rows[0].payload.empresa) || '';
      if (rows[0].estado === 'autorizada') {
        res.status(200).send(page('<div class="card"><div class="emp">'
          + (EMPRESA_LABEL[empresa] || '') + '</div><h1>Este pago ya fue realizado</h1>'
          + '<p>Puedes cerrar esta pantalla.</p></div>'));
        return;
      }
    }
  } catch (e) { /* seguimos con lo que haya */ }

  const action = tbkBase() + '/webpayserver/initTransaction';
  const label = EMPRESA_LABEL[empresa] || 'Atención médica';

  res.status(200).send(page(
    '<div class="card">'
    + '<div class="emp">' + label + '</div>'
    + '<h1>Pago con WebPay</h1>'
    + (monto ? '<div class="amt">' + fmtCLP(monto) + '</div>' : '')
    + '<p>Vas a pagar de forma segura a través de Transbank.</p>'
    + '<form method="POST" action="' + action + '">'
    + '<input type="hidden" name="token_ws" value="' + tk + '">'
    + '<button type="submit">Pagar' + (monto ? ' ' + fmtCLP(monto) : '') + '</button>'
    + '</form>'
    + '<div class="note">Al tocar Pagar se abre el portal seguro de Transbank.</div>'
    + '</div>'
  ));
};
