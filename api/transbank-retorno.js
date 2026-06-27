// api/transbank-retorno.js — Vercel serverless (CommonJS, Node 18+)
// ─────────────────────────────────────────────────────────────────────────────
// Webpay devuelve aquí tras cada pago. Confirma (commit) el leg, lo registra,
// y si quedan 'pendientes' muestra un BOTÓN para ir al siguiente pago
// (Safari/iPad bloquea el auto-envío a dominio externo por ITP).
// Al quedar el grupo COMPLETO y autorizado, cierra el enganche:
//   · clarita_acciones  → aprobado   (desaparece de la cola de Clarita)
//   · presupuestos      → pagado
//   · totem_sesiones    → pagado
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

function head(titulo){
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>' + titulo + '</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#f4efe4;font-family:Inter,sans-serif;color:#1c2b1e;padding:24px}'
    + '.card{background:#fbf8f2;border:1px solid #e3dccf;border-radius:20px;padding:38px 30px;'
    + 'max-width:430px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.04)}'
    + '.ic{width:70px;height:70px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
    + 'margin:0 auto 18px;font-size:32px}'
    + 'h1{font-family:Playfair Display,serif;font-weight:500;font-size:25px;margin:0 0 14px}'
    + 'p{font-size:14.5px;color:#7a8c7c;line-height:1.55;margin:0 0 6px}'
    + '.legs{border:1px solid #e3dccf;border-radius:12px;overflow:hidden;margin:16px 0 4px;text-align:left}'
    + '.leg{display:flex;justify-content:space-between;align-items:center;padding:11px 15px;border-bottom:1px solid #e3dccf;font-size:14px}'
    + '.leg:last-child{border-bottom:none}.leg .emp{font-weight:600;color:#1c2b1e}'
    + '.leg .mo{font-family:ui-monospace,monospace;color:#1c2b1e}'
    + '.pill{font-size:11px;font-weight:600;border-radius:99px;padding:2px 9px;margin-left:8px}'
    + '.pill.ok{background:#e7efe9;color:#2f7d5b}.pill.no{background:#f5eaea;color:#b23b3b}'
    + 'button{width:100%;font-family:inherit;font-size:15px;font-weight:600;border-radius:12px;'
    + 'padding:15px;border:1px solid #1f3d34;background:#1f3d34;color:#fff;cursor:pointer;margin-top:18px}'
    + 'button:active{background:#2c5446}.amt{font-family:Playfair Display,serif;font-size:30px;color:#1c2b1e;margin:2px 0 0}'
    + '</style></head><body>';
}
function shell(titulo, inner, ok){
  return head(titulo)
    + '<div class="card"><div class="ic" style="background:' + (ok ? 'rgba(47,125,91,.12)' : 'rgba(178,59,59,.1)') + '">'
    + (ok ? '\u2713' : '\u00d7') + '</div>'
    + '<h1 style="color:' + (ok ? '#1f3d34' : '#b23b3b') + '">' + titulo + '</h1>'
    + inner + '</div></body></html>';
}
function continuarShell(empresaLabel, monto, url, token){
  return head('Falta un pago')
    + '<div class="card"><div class="ic" style="background:rgba(47,125,91,.12)">\u2713</div>'
    + '<h1 style="color:#1f3d34">Primer pago listo</h1>'
    + '<p>Ahora falta el pago de <b>' + empresaLabel + '</b>.</p>'
    + '<p class="amt">' + fmtCLP(monto) + '</p>'
    + '<form id="f" method="POST" action="' + url + '">'
    + '<input type="hidden" name="token_ws" value="' + token + '">'
    + '<button type="submit">Continuar al pago de ' + empresaLabel + '</button>'
    + '</form></div></body></html>';
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

// Crea el cobro de un pago WebPay autorizado → aparece solo en la caja.
// medio 'WebPay'; proveedor_ref = código de autorización (para conciliar).
async function crearCobroWebpay(empresaId, pay, tx){
  try {
    const ref = tx.authorization_code || tx.buy_order || null;
    const r = await sbFetch('cobros', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        paciente_rut: pay.paciente_rut || null,
        empresa_id: empresaId,
        monto: tx.amount,
        medio_pago: 'WebPay',
        proveedor_ref: ref,
        estado: 'pagado'
      })
    });
    const arr = await r.json();
    return (arr && arr[0]) ? arr[0].id : null;
  } catch (e) { return null; }
}

// Cierre del enganche: marca acción/presupuesto/sesión cuando el grupo quedó pagado
async function cerrarLoop(pay){
  const now = new Date().toISOString();
  try {
    if (pay.accion_id) {
      await sbFetch('clarita_acciones?id=eq.' + encodeURIComponent(pay.accion_id), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'aprobado', resuelto_por: 'WebPay', resuelto_en: now })
      });
    }
    if (pay.presupuesto_id) {
      await sbFetch('presupuestos?id=eq.' + encodeURIComponent(pay.presupuesto_id), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'pagado' })
      });
    }
    if (pay.sesion_id) {
      await sbFetch('totem_sesiones?id=eq.' + encodeURIComponent(pay.sesion_id), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'pagado' })
      });
    }
  } catch (e) { /* el cierre no debe romper la pantalla del paciente */ }
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

    // Recuperar el leg por token (empresa, grupo, pendientes, enganche, empresa_id)
    let pay = {};
    let empresaId = null;
    try {
      const q = await sbFetch('transbank_transacciones?payload->>token=eq.' + encodeURIComponent(token) + '&select=payload,empresa_id&limit=1');
      const rows = await q.json();
      if (rows && rows[0]) { if (rows[0].payload) pay = rows[0].payload; empresaId = rows[0].empresa_id; }
    } catch (e) { /* defaults */ }
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

    // Si quedó autorizado, crear el cobro de WebPay → entra solo a la caja
    let cobroId = null;
    if (aprobado && empresaId) {
      cobroId = await crearCobroWebpay(empresaId, pay, tx);
    }

    if (tx.buy_order) {
      const cd = tx.card_detail || {};
      await sbFetch('transbank_transacciones?ref=eq.' + encodeURIComponent(tx.buy_order), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          estado: aprobado ? 'autorizada' : 'rechazada',
          autorizacion: tx.authorization_code || null,
          tipo_pago: tx.payment_type_code || null,
          tarjeta_final: cd.card_number || null,
          cuotas: (tx.installments_number != null ? tx.installments_number : null),
          fecha_contable: tx.accounting_date || null,
          cobro_id: cobroId,
          payload: Object.assign({}, pay, { token: token, resultado: tx, cobro_id: cobroId })
        })
      });
    }

    // Aprobado con pendientes → crear el siguiente leg (propagando el enganche) y mostrar BOTÓN
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
            paciente_rut: pay.paciente_rut || null, grupo: grupo, pendientes: rest,
            accion_id: pay.accion_id || null, presupuesto_id: pay.presupuesto_id || null, sesion_id: pay.sesion_id || null
          })
        });
        const nd = await cr.json();
        if (nd && nd.url && nd.token) {
          const label = EMPRESA_LABEL[next.empresa] || next.empresa;
          res.status(200).send(continuarShell(label, next.monto, nd.url, nd.token));
          return;
        }
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
      await cerrarLoop(pay);   // ← cierra la cola de Clarita + presupuesto + sesión
      res.status(200).send(shell('Pago completo',
        '<p>Tu atención quedó pagada. Ya puedes cerrar esta pantalla.</p>' + legsHTML(rows), true));
    } else if (rows.length > 0) {
      res.status(200).send(shell('Pago incompleto',
        '<p>Quedó un pago sin completar. Acércate a recepción y lo resolvemos.</p>' + legsHTML(rows), false));
    } else if (aprobado) {
      await cerrarLoop(pay);   // grupo de un solo leg
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
