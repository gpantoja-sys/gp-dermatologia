// api/transbank-retorno.js — Vercel serverless (CommonJS, Node 18+)
// ─────────────────────────────────────────────────────────────────────────────
// Webpay devuelve aquí tras cada pago. Confirma (commit) el leg, VALIDA EL MONTO,
// lo registra, y si quedan 'pendientes' muestra un BOTÓN para ir al siguiente pago
// (Safari/iPad bloquea el auto-envío a dominio externo por ITP).
// Al quedar el grupo COMPLETO y válido, cierra el enganche:
//   · clarita_acciones  → aprobado   (desaparece de la cola de Clarita)
//   · presupuestos      → pagado
//   · totem_sesiones    → pagado
// El comprobante final cumple los requisitos de Transbank (orden, comercio, monto,
// autorización, tipo de pago, cuotas, últimos 4 dígitos, fecha).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

// Credenciales PÚBLICAS de integración (sandbox), publicadas por Transbank en su
// documentación. NO son secretas. Solo se usan cuando NO estamos en producción.
const SANDBOX = {
  code: '597055555532',
  key:  '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C'
};
const EMPRESA_LABEL = { skintouch: 'SkinTouch', lasertouch: 'LaserTouch' };
const COMERCIO = 'Dr. Gonzalo Pantoja';

function tbkBase(){
  return process.env.TBK_ENV === 'production'
    ? 'https://webpay3g.transbank.cl'
    : 'https://webpay3gint.transbank.cl';
}

// En PRODUCCIÓN las credenciales vienen SIEMPRE de variables de entorno.
// Nunca se usa un valor escrito en el código. Si falta, devuelve null (y se aborta).
function creds(empresa){
  const E = String(empresa || 'skintouch').toUpperCase();
  const code = process.env['TBK_' + E + '_COMMERCE_CODE'];
  const key  = process.env['TBK_' + E + '_API_KEY'];
  if (process.env.TBK_ENV === 'production') {
    return { code: code || null, key: key || null };
  }
  return { code: code || SANDBOX.code, key: key || SANDBOX.key };
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
function fmtFecha(iso){
  try { return new Date(iso).toLocaleString('es-CL', { timeZone: 'America/Santiago' }); }
  catch (e) { return '—'; }
}
// Traduce el código de tipo de pago de Transbank a etiqueta legible
function tipoPagoLabel(code){
  if (code === 'VD') return 'Débito';
  if (code === 'VP') return 'Prepago';
  return 'Crédito'; // VN, VC, SI, S2, NC, etc.
}

function head(titulo){
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>' + titulo + '</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#f4efe4;font-family:Inter,sans-serif;color:#1c2b1e;padding:24px}'
    + '.card{background:#fbf8f2;border:1px solid #e3dccf;border-radius:20px;padding:38px 30px;'
    + 'max-width:440px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.04)}'
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
    + '.comp{border:1px solid #e3dccf;border-radius:14px;padding:15px 16px;margin:14px 0 4px;text-align:left;background:#fff}'
    + '.comp-emp{font-size:12px;font-weight:600;letter-spacing:.03em;color:#1c2b1e}'
    + '.comp-amt{font-family:Playfair Display,serif;font-size:27px;color:#1c2b1e;margin:2px 0 10px}'
    + '.comp-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}'
    + '.comp-grid .k{color:#7a8c7c}.comp-grid .v{text-align:right;font-family:ui-monospace,monospace;color:#1c2b1e}'
    + '.desc{font-size:12px;color:#a39c8f;margin-top:10px;text-align:left}'
    + 'button{width:100%;font-family:inherit;font-size:15px;font-weight:600;border-radius:12px;'
    + 'padding:15px;border:1px solid #1f3d34;background:#1f3d34;color:#fff;cursor:pointer;margin-top:18px}'
    + 'button:active{background:#2c5446}.amt{font-family:Playfair Display,serif;font-size:30px;color:#1c2b1e;margin:2px 0 0}'
    + '.causas{background:#faf7f1;border:1px solid #e3dccf;border-radius:12px;padding:12px 15px;text-align:left;font-size:12.5px;color:#7a8c7c;margin-top:14px;line-height:1.6}'
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

// Comprobante detallado de un pago (cumple requisitos Transbank)
function kv(k, v){ return '<div class="k">' + k + '</div><div class="v">' + v + '</div>'; }
function detalleLeg(d){
  const label = COMERCIO + ' · ' + (EMPRESA_LABEL[d.empresa] || d.empresa || '');
  const cuotas = (d.installments_number != null && d.installments_number > 0) ? d.installments_number : 1;
  return '<div class="comp">'
    + '<div class="comp-emp">' + label + '</div>'
    + '<div class="comp-amt">' + fmtCLP(d.monto) + '</div>'
    + '<div class="comp-grid">'
    +   kv('N° orden', d.buy_order || '—')
    +   kv('Autorización', d.authorization_code || '—')
    +   kv('Tipo', tipoPagoLabel(d.payment_type_code))
    +   kv('Cuotas', cuotas)
    +   kv('Tarjeta', d.card_final ? ('•••• ' + d.card_final) : '—')
    +   kv('Fecha', fmtFecha(d.date))
    + '</div>'
    + (d.concepto ? '<div class="desc">' + d.concepto + '</div>' : '')
    + '</div>';
}
function detalleDesdeTx(empresa, tx, concepto){
  const cd = tx.card_detail || {};
  return detalleLeg({
    empresa: empresa, monto: tx.amount, buy_order: tx.buy_order,
    authorization_code: tx.authorization_code, payment_type_code: tx.payment_type_code,
    installments_number: tx.installments_number, card_final: cd.card_number,
    date: tx.transaction_date, concepto: concepto
  });
}
function detallesGrupo(rows){
  return rows.map(function(x){
    const r = (x.payload && x.payload.resultado) || {};
    const cd = r.card_detail || {};
    return detalleLeg({
      empresa: (x.payload && x.payload.empresa) || '',
      monto: x.monto,
      buy_order: r.buy_order,
      authorization_code: r.authorization_code,
      payment_type_code: r.payment_type_code,
      installments_number: r.installments_number,
      card_final: cd.card_number,
      date: r.transaction_date || r.accounting_date,
      concepto: (x.payload && x.payload.concepto) || ''
    });
  }).join('');
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

// Crea el cobro de un pago WebPay VÁLIDO → aparece solo en la caja.
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

    // ── Pago ABORTADO por la paciente (botón "Anular compra") ──────────────
    // Webpay devuelve TBK_TOKEN (no token_ws). NO se debe confirmar la compra
    // (no llamar a commit). Solo registramos el abandono y mostramos pantalla.
    const tbkToken = src.TBK_TOKEN;
    if (tbkToken && !token) {
      try {
        await sbFetch('transbank_transacciones?payload->>token=eq.' + encodeURIComponent(tbkToken), {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ estado: 'abortada' })
        });
      } catch (e) { /* no bloquear la pantalla */ }
      res.status(200).send(shell('Pago cancelado',
        '<p>Cancelaste el pago y no se realizó ningún cargo. Si quieres, puedes intentarlo de nuevo o acercarte a recepción.</p>', false));
      return;
    }

    // ── TIMEOUT en el formulario de Webpay ─────────────────────────────────
    // Llega TBK_ID_SESION y TBK_ORDEN_COMPRA, sin token. Tampoco se confirma.
    if (!token && (src.TBK_ID_SESION || src.TBK_ORDEN_COMPRA)) {
      res.status(200).send(shell('Pago no completado',
        '<p>Se agotó el tiempo para pagar y no se realizó ningún cargo. Puedes intentarlo de nuevo o acercarte a recepción.</p>', false));
      return;
    }

    if (!token) {
      res.status(200).send(shell('Pago no completado',
        '<p>La transacción fue cancelada o expiró. Puedes intentarlo de nuevo o acercarte a recepción.</p>', false));
      return;
    }

    // Recuperar el leg por token: empresa, grupo, pendientes, enganche, empresa_id
    // y el MONTO esperado (el que enviamos al crear la transacción).
    let pay = {};
    let empresaId = null;
    let montoEsperado = null;
    try {
      const q = await sbFetch('transbank_transacciones?payload->>token=eq.' + encodeURIComponent(token) + '&select=payload,empresa_id,monto&limit=1');
      const rows = await q.json();
      if (rows && rows[0]) {
        if (rows[0].payload) pay = rows[0].payload;
        empresaId = rows[0].empresa_id;
        montoEsperado = rows[0].monto;
      }
    } catch (e) { /* defaults */ }
    const empresa = pay.empresa || 'skintouch';
    const grupo = pay.grupo || null;
    const concepto = pay.concepto || '';
    const pendientes = Array.isArray(pay.pendientes) ? pay.pendientes : [];
    const { code, key } = creds(empresa);

    // Guard de producción: si falta la credencial productiva, no cobramos.
    if (process.env.TBK_ENV === 'production' && (!code || !key)) {
      res.status(200).send(shell('Pago no disponible',
        '<p>El sistema de pago no está configurado correctamente. Acércate a recepción para completar tu pago.</p>', false));
      return;
    }

    // Commit del leg actual
    const r = await fetch(tbkBase() + '/rswebpaytransaction/api/webpay/v1.2/transactions/' + encodeURIComponent(token), {
      method: 'PUT',
      headers: { 'Tbk-Api-Key-Id': code, 'Tbk-Api-Key-Secret': key, 'Content-Type': 'application/json' }
    });
    const tx = await r.json();
    const aprobado = (tx.response_code === 0) && (tx.status === 'AUTHORIZED');

    // VALIDACIÓN DE MONTO (exigida por Transbank): el monto autorizado debe
    // coincidir con el que enviamos. Si no, no se da por pagado.
    const montoOk = (montoEsperado == null) || (Number(tx.amount) === Number(montoEsperado));
    const valido = aprobado && montoOk;

    // Si Transbank autorizó pero el monto NO coincide → registrar y detener.
    if (aprobado && !montoOk) {
      if (tx.buy_order) {
        await sbFetch('transbank_transacciones?ref=eq.' + encodeURIComponent(tx.buy_order), {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            estado: 'rechazada',
            payload: Object.assign({}, pay, {
              token: token, resultado: tx,
              monto_alerta: true, monto_esperado: montoEsperado, monto_recibido: tx.amount
            })
          })
        });
      }
      res.status(200).send(shell('Pago en revisión',
        '<p>El monto autorizado no coincide con el de tu atención. Por seguridad, no lo dimos por pagado. Acércate a recepción y lo resolvemos.</p>', false));
      return;
    }

    // Si quedó válido, crear el cobro de WebPay → entra solo a la caja
    let cobroId = null;
    if (valido && empresaId) {
      cobroId = await crearCobroWebpay(empresaId, pay, tx);
    }

    if (tx.buy_order) {
      const cd = tx.card_detail || {};
      await sbFetch('transbank_transacciones?ref=eq.' + encodeURIComponent(tx.buy_order), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          estado: valido ? 'autorizada' : 'rechazada',
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

    // Válido con pendientes → crear el siguiente leg y mostrar BOTÓN
    if (valido && pendientes.length > 0) {
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
      await cerrarLoop(pay);   // cierra cola de Clarita + presupuesto + sesión
      res.status(200).send(shell('Pago completo',
        '<p>Tu atención quedó pagada. Guarda este comprobante.</p>' + detallesGrupo(rows), true));
    } else if (rows.length > 0) {
      res.status(200).send(shell('Pago incompleto',
        '<p>Quedó un pago sin completar. Acércate a recepción y lo resolvemos.</p>' + legsHTML(rows), false));
    } else if (valido) {
      await cerrarLoop(pay);   // grupo de un solo leg
      res.status(200).send(shell('Pago confirmado',
        '<p>Tu pago quedó registrado. Guarda este comprobante.</p>' + detalleDesdeTx(empresa, tx, concepto), true));
    } else {
      res.status(200).send(shell('Pago no aprobado',
        '<p>El pago no fue aprobado por el banco. Intenta nuevamente o acércate a recepción.</p>'
        + '<div class="causas">Posibles causas:<br>· Datos de la tarjeta mal ingresados (fecha o código).<br>· Saldo o cupo insuficiente.<br>· Tarjeta no habilitada para compras por internet.</div>', false));
    }
  } catch (e) {
    res.status(200).send(shell('Error',
      '<p>Ocurrió un problema al confirmar el pago. Acércate a recepción y lo resolvemos.</p>', false));
  }
};
