// api/transbank-retorno.js — Vercel serverless (CommonJS, Node 18+)
// ─────────────────────────────────────────────────────────────────────────────
// Webpay devuelve aquí tras cada pago. Confirma (commit) el leg, lo registra,
// y si quedan 'pendientes' redirige automáticamente al siguiente formulario.
// Al terminar (o si algo falla) muestra el resumen del grupo, siempre trazable.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

const PUB = {
  code: '597055555532',
  key:  '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C'
};
const EMPRESA_LABEL = { skintouch: 'SkinTouch', lasertouch: 'LaserTouch' };

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

function shell(titulo, inner, ok){
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>' + titulo + '</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500&family=Inter:wght@400;500&display=swap" rel="stylesheet">'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#f4efe4;font-family:Inter,sans-serif;color:#1c2b1e;padding:24px}'
    + '.card{background:#fbf8f2;border:1px solid #e3dccf;border-radius:20px;padding:38px 30px;'
    + 'max-width:430px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.04)}'
    + '.ic{width:70px;height:70px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
    + 'margin:0 auto 18px;font-size:32px;background:' + (ok ? 'rgba(47,125,91,.12)' : 'rgba(178,59,59,.1)') + '}'
    + 'h1{font-family:Playfair Display,serif;font-weight:500;font-size:25px;'
    + 'color:' + (ok ? '#1f3d34' : '#b23b3b') + ';margin:0 0 14px}'
    + 'p{font-size:14.5px;color:#7a8c7c;line-height:1.55;margin:0 0 6px}'
    + '.legs{border:1px solid #e3dccf;border-radius:12px;overflow:hidden;margin:16px 0 4px;text-align:left}'
    + '.leg{display:flex;justify-content:space-between;align-items:center;padding:11px 15px;border-bottom:1px solid #e3dccf;font-size:14px}'
    + '.leg:last-child{border-bottom:none}.leg .emp{font-weight:600;color:#1c2b1e}'
    + '.leg .mo{font-family:ui-monospace,monospace;color:#1c2b1e}'
    + '.pill{font-size:11px;font-weight:600;border-radius:99px;padding:2px 9px;margin-left:8px}'
    + '.pill.ok{background:#e7efe9;color:#2f7d5b}.pill.no{background:#f5eaea;color:#b23b3b}'
    + '</style></head><body><div class="card"><div class="ic">' + (ok ? '\u2713' : '\u00d7') + '</div>'
    + '<h1>' + titulo + '</h1>' + inner + '</div></body></html>';
}

function redirectShell(url, token){
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#f4efe4;font-family:Inter,sans-serif;color:#7a8c7c}</style></head><body>'
    + '<p>Falta un pago. Te llevamos al siguiente\u2026</p>'
    + '<form id="f" method="POST" action="' + url + '"><input type="hidden" name="token_ws" value="' + token + '"></form>'
    + '<script>document.getElementById("f").submit();<\/script></body></html>';
}

async function resumenGrupo(grupo){
  try {
    const q = await sbFetch('transbank_transacciones?payload->>grupo=eq.' + encodeURIComponent(grupo) + '&select=monto,estado,payload&order=id.asc');
    return await q.json();
  } catch (e) { return []; }
}
function legsHTML(rows){
  return '<div class="legs">' + rows.map(function(x){
    const emp = (x.payload && x.payload.empresa) || '';
    const label = EMPRESA_LABEL[emp] || emp || 'Empresa';
    const ok = x.estado === 'autorizada';
    return '<div class="leg"><span class="emp">' + label
      + '<span class="pill ' + (ok ? 'ok' : 'no') + '">' + (ok ? 'pagado' : x.estado) + '</span></span>'
      + '<span class="mo">' + fmtCLP(x.monto) + '</span></div>';
  }).join('') + '</div>';
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const src = Object.assign({}, req.query || {}, (req.body && typeof req.body === 'object') ? req.body : {});
    const token = src.token_ws;

    if (!token) {
      res.status(200).send(shell('Pago no completado',
        '<p>La transacción fue cancelada o expiró. Puedes intentarlo de nuevo o acercarte a recepción.</p>', false));
      return;
    }

    // Recuperar el leg por token (empresa, grupo, pendientes)
    let pay = {};
    try {
      const q = await sbFetch('transbank_transacciones?payload->>token=eq.' + encodeURIComponent(token) + '&select=payload&limit=1');
      const rows = await q.json();
      if (rows && rows[0] && rows[0].payload) pay = rows[0].payload;
    } catch (e) { /* sigue con defaults */ }
    const empresa = pay.empresa || 'skintouch';
    const grupo = pay.grupo || null;
    const pendientes = Array.isArray(pay.pendientes) ? pay.pendientes : [];
    const { code, key } = creds(empresa);

    // Commit del leg actual
    const r = await fetch(tbkBase() + '/rswebpaytransaction/api/webpay/v1.2/transactions/' + encodeURIComponent(token), {
      method: 'PUT',
      headers: { 'Tbk-Api-Key-Id': code, 'Tbk-Api-Key-Secret': key, 'Content-Type': 'application/json' }
    });
    const tx = await r.json();
    const aprobado = (tx.response_code === 0) && (tx.status === 'AUTHORIZED');

    if (tx.buy_order) {
      await sbFetch('transbank_transacciones?ref=eq.' + encodeURIComponent(tx.buy_order), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          estado: aprobado ? 'autorizada' : 'rechazada',
          payload: { empresa: empresa, grupo: grupo, token: token, resultado: tx }
        })
      });
    }

    // Si este leg fue aprobado y quedan pendientes → crear el siguiente y redirigir
    if (aprobado && pendientes.length > 0) {
      const next = pendientes[0];
      const rest = pendientes.slice(1);
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      try {
        const cr = await fetch('https://' + host + '/api/transbank-crear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            empresa: next.empresa, monto: next.monto, concepto: next.concepto || 'Insumos',
            paciente_rut: pay.paciente_rut || null, grupo: grupo, pendientes: rest
          })
        });
        const nd = await cr.json();
        if (nd && nd.url && nd.token) { res.status(200).send(redirectShell(nd.url, nd.token)); return; }
        // No se pudo crear el segundo → mostramos resumen con aviso
        const rows1 = await resumenGrupo(grupo);
        res.status(200).send(shell('Falta un pago',
          '<p>El primer pago quedó registrado, pero no pudimos iniciar el segundo. Acércate a recepción para completarlo.</p>'
          + legsHTML(rows1), false));
        return;
      } catch (e) {
        const rows1 = await resumenGrupo(grupo);
        res.status(200).send(shell('Falta un pago',
          '<p>El primer pago quedó registrado, pero no pudimos iniciar el segundo. Acércate a recepción para completarlo.</p>'
          + legsHTML(rows1), false));
        return;
      }
    }

    // Fin de la cadena (o un leg rechazado): resumen del grupo
    const rows = grupo ? await resumenGrupo(grupo) : [];
    const todoOk = rows.length > 0 && rows.every(function(x){ return x.estado === 'autorizada'; });
    if (todoOk) {
      res.status(200).send(shell('Pago completo',
        '<p>Tu atención quedó pagada. Ya puedes cerrar esta pantalla.</p>' + legsHTML(rows), true));
    } else if (rows.length > 0) {
      res.status(200).send(shell('Pago incompleto',
        '<p>Quedó un pago sin completar. Acércate a recepción y lo resolvemos.</p>' + legsHTML(rows), false));
    } else if (aprobado) {
      res.status(200).send(shell('Pago confirmado',
        '<p>Tu pago de ' + fmtCLP(tx.amount) + ' quedó registrado. Ya puedes cerrar esta pantalla.</p>', true));
    } else {
      res.status(200).send(shell('Pago no aprobado',
        '<p>El pago no fue aprobado por el banco. Intenta nuevamente o acércate a recepción.</p>', false));
    }
  } catch (e) {
    res.status(200).send(shell('Error',
      '<p>Ocurrió un problema al confirmar el pago. Acércate a recepción y lo resolvemos.</p>', false));
  }
};
