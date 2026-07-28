// api/bsale-emitir.js — Vercel serverless (CommonJS, Node 18+)
// ─────────────────────────────────────────────────────────────────────────────
// Emite boleta(s) electrónica(s) REAL(ES) en Bsale (Producción, sin sandbox) y
// deja el registro correspondiente en la tabla `boletas` de Supabase.
//
// DOS MODOS DE ENTRADA:
//
//  A) Automático (WebPay) — se pasa `presupuesto_id`:
//     Lee presupuesto_items (con su prestación embebida), toma el monto que
//     corresponde a la empresa de este leg (honorario_monto → skintouch,
//     insumo_monto → lasertouch), y arma UNA línea de detalle por ítem.
//     La glosa de cada línea es:
//       · reembolsable = true  → glosa_fonasa exacta del catálogo (exigida
//         para que la Isapre reconozca el reembolso)
//       · reembolsable = false → glosa_boleta (o el nombre si no hay glosa)
//     Si el presupuesto mezcla ítems reembolsables y no reembolsables para
//     la misma empresa, se agrupan y se emite una boleta separada por grupo
//     (nunca se mezcla reembolsable + no reembolsable en un mismo documento).
//
//  B) Manual (Efectivo / Transferencia) — se pasa `items` directamente:
//     [{ monto, comment, reembolsable }], ya resuelto por quien llama
//     (gp-cola.html, con la prestación elegida del catálogo).
//
// Idempotencia: si se pasa `cobro_id` y ya existe una boleta emitida para
// ese cobro, se devuelve esa boleta sin volver a llamar a Bsale (evita
// emitir el mismo documento dos veces ante un reintento).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

const BSALE_BASE = 'https://api.bsale.cl/v1';
const { emitirCertificado } = require('./_certificado');
const CODE_SII = { skintouch: 41, lasertouch: 39 }; // 41 = Boleta Exenta Electrónica · 39 = Boleta Electrónica (afecta)
const EMPRESA_ID = { skintouch: 1, lasertouch: 2 }; // mapeo canónico string → empresa_id (para la fila en `boletas`)

function bsaleToken(empresa){
  const E = String(empresa || '').toUpperCase();
  return process.env['BSALE_' + E + '_TOKEN'] || null;
}
function bsaleOffice(empresa){
  const E = String(empresa || '').toUpperCase();
  return process.env['BSALE_' + E + '_OFFICE_ID'] || null; // opcional
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

// Redondeo idéntico al que ya usa el resto del sistema (gp-cola.html) para
// que la contabilidad local coincida con lo que Bsale calcula.
function calcularNetoIva(empresa, montoTotal){
  if (empresa === 'lasertouch') {
    const neto = Math.round(montoTotal / 1.19);
    return { neto, iva: montoTotal - neto };
  }
  return { neto: montoTotal, iva: 0 }; // skintouch: exento
}

// ── Receptor (cliente) para la boleta ─────────────────────────────────────────
// Bsale acepta cliente en la boleta (es opcional) y con eso llena SEÑOR/RUT, que
// hoy salen en blanco. IMPORTANTE: para persona natural (companyOrPerson=0) Bsale
// lee el nombre de `firstName`/`lastName`, NO de `company`. Mandar el nombre en
// `company` con companyOrPerson=0 hace que Bsale rechace con "The client has no
// name". La ficha `pacientes` tiene nombre/apellido/apellido2, comuna y email; NO
// tiene dirección de calle, así que ese campo se omite hasta capturarlo.
// A prueba de fallos: si no hay RUT + nombre + apellido, devuelve null y la boleta
// se emite SIN receptor (como antes) en vez de caerse.
function construirCliente(pac){
  if (!pac) return null;
  const rut = (pac.rut || '').trim();
  const nomRaw    = (pac.nombre || '').trim();
  const lastName  = [pac.apellido, pac.apellido2].filter(Boolean).join(' ').trim();
  // Si 'nombre' ya termina con los apellidos (por la carga masiva), quitarlos
  // para que firstName sea solo el nombre de pila y no se duplique.
  let firstName = nomRaw;
  if (lastName && nomRaw.toLowerCase().endsWith(lastName.toLowerCase())){
    firstName = nomRaw.slice(0, nomRaw.length - lastName.length).trim();
  }
  // Respaldo para la carga masiva: si NO hay apellido separado pero `nombre`
  // trae el nombre completo, se derivan los apellidos de las últimas palabras
  // (2 si hay 3+ palabras, 1 si hay 2). Mejor una boleta nominada con esta
  // heurística que una boleta sin receptor que no le sirve a la paciente.
  if (!lastName && firstName){
    const t = firstName.split(/\s+/).filter(Boolean);
    if (t.length >= 3){ lastName = t.slice(-2).join(' '); firstName = t.slice(0, -2).join(' '); }
    else if (t.length === 2){ lastName = t[1]; firstName = t[0]; }
  }
  if (!rut || !firstName || !lastName) return null; // sin estos, no nominar (boleta sin receptor)
  const cli = {
    code: rut,
    companyOrPerson: 0,                       // persona natural
    firstName: firstName,                     // nombre
    lastName: lastName,                        // apellido(s)
    company: (firstName + ' ' + lastName)      // redundante pero inofensivo; algunos PDFs lo muestran
  };
  if (pac.comuna) cli.municipality = pac.comuna;
  if (pac.email)  cli.email = pac.email;
  return cli;
}

// ── Forma de pago ─────────────────────────────────────────────────────────────
// El "Transferencia Bancaria" por defecto aparece porque no mandamos el bloque
// `payments`; Bsale usa la forma de pago default de la cuenta. Para mostrar la
// correcta se manda `payments` con el paymentTypeId REAL de la cuenta. Como los
// IDs son propios de cada cuenta Bsale, se detecta por nombre. Si no se encuentra,
// devuelve null y NO se manda payments (se mantiene el comportamiento actual, sin
// romper la emisión). Para forzar un ID fijo, setea PAYMENT_TYPE_ID[empresa].
const PAYMENT_TYPE_ID = { skintouch: null, lasertouch: null }; // override manual opcional
const MEDIO_KEYWORDS = {
  tarjeta:       ['webpay','transbank','tarjeta de crédito','tarjeta de credito','crédito','credito','tarjeta'],
  webpay:        ['webpay','transbank','tarjeta de crédito','tarjeta de credito','crédito','credito','tarjeta'],
  debito:        ['tarjeta de débito','tarjeta de debito','débito','debito','redcompra'],
  efectivo:      ['efectivo','contado','cash'],
  transferencia: ['transferencia','transfer']
};
async function resolverPaymentTypeId(empresa, medio){
  try {
    if (PAYMENT_TYPE_ID[empresa]) return PAYMENT_TYPE_ID[empresa]; // override manual
    if (!medio) return null;
    const claves = MEDIO_KEYWORDS[String(medio).toLowerCase()] || MEDIO_KEYWORDS.tarjeta;
    const token = bsaleToken(empresa);
    if (!token) return null;
    const r = await fetch(BSALE_BASE + '/payment_types.json?limit=50', { headers: { access_token: token } });
    const data = await r.json().catch(function(){ return null; });
    const tipos = Array.isArray(data) ? data : ((data && Array.isArray(data.items)) ? data.items : []);
    // state 0 = activo en Bsale (si no viene el campo, se considera activo).
    const activos = tipos.filter(function(t){ return t && (t.state === 0 || t.state === '0' || typeof t.state === 'undefined'); });
    for (const clave of claves) {
      const hit = activos.find(function(t){ return String(t.name || '').toLowerCase().indexOf(clave) !== -1; });
      if (hit) return hit.id;
    }
    return null;
  } catch (e) { return null; }
}

// Arma el body de Bsale para un grupo de líneas (todas mismo estado reembolsable)
function bodyBsale(empresa, lineas, opts){
  const codeSii = CODE_SII[empresa];
  const officeId = bsaleOffice(empresa);
  const emissionDate = Math.floor(Date.now() / 1000);
  const details = lineas.map(function(l){
    const d = { netUnitValue: l.netoUnit, quantity: 1, comment: (l.comment || 'Atención médica').slice(0, 150) };
    if (empresa === 'lasertouch') d.taxes = [{ code: 14, percentage: 19 }];
    return d;
  });
  // declareSii: 1 → el documento se declara al SII y el PDF sale con su timbre
  // electrónico (TED). Sin este campo, Bsale generaba el documento SIN timbre
  // y la boleta no servía como documento tributario completo.
  const body = { codeSii, emissionDate, declareSii: 1, details };
  if (officeId) body.officeId = Number(officeId);
  opts = opts || {};
  if (opts.client) body.client = opts.client;
  if (opts.payments && opts.payments.length) body.payments = opts.payments;
  return body;
}

async function emitirEnBsale(empresa, lineas, opts){
  const token = bsaleToken(empresa);
  if (!token) return { ok:false, error: 'Falta BSALE_' + empresa.toUpperCase() + '_TOKEN en Vercel' };
  const body = bodyBsale(empresa, lineas, opts);
  try {
    const r = await fetch(BSALE_BASE + '/documents.json', {
      method: 'POST',
      headers: { access_token: token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok || !data || !data.id) {
      return { ok:false, error: (data && (data.error || JSON.stringify(data))) || ('HTTP ' + r.status) };
    }
    return { ok:true, data };
  } catch (e) {
    return { ok:false, error: String((e && e.message) || e) };
  }
}

// Guarda (o actualiza) la fila en `boletas` con el resultado de Bsale
async function guardarBoleta(params){
  const { empresa, cobro_id, paciente_rut, reembolsable, total, prestacion_id, concepto, bsaleResult } = params;
  const { neto, iva } = calcularNetoIva(empresa, total);
  const row = {
    empresa_id: EMPRESA_ID[empresa] || null,
    cobro_id: cobro_id || null,
    paciente_rut: paciente_rut || null,
    neto, iva, total,
    reembolsable: !!reembolsable,
    prestacion_id: prestacion_id || null,
    concepto: concepto || null,
    bsale_estado: bsaleResult.ok ? 'emitida' : 'error',
    bsale_document_id: bsaleResult.ok ? bsaleResult.data.id : null,
    bsale_folio: bsaleResult.ok ? String(bsaleResult.data.number || bsaleResult.data.id) : null,
    bsale_url: bsaleResult.ok ? (bsaleResult.data.urlPdf || bsaleResult.data.urlTimbre || null) : null,
    bsale_error: bsaleResult.ok ? null : bsaleResult.error
  };
  const r = await sbFetch('boletas', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  const arr = await r.json();
  return (arr && arr[0]) ? arr[0] : row;
}

// Agrupa un arreglo de items en buckets por reembolsable (true/false)
function agruparPorReembolsable(items){
  const grupos = { true: [], false: [] };
  items.forEach(function(i){ grupos[i.reembolsable ? 'true' : 'false'].push(i); });
  return Object.keys(grupos).filter(function(k){ return grupos[k].length > 0; }).map(function(k){
    return { reembolsable: k === 'true', items: grupos[k] };
  });
}

// Envía la boleta (y certificado si aplica) por WhatsApp vía Whaticket.
// No bloquea ni rompe la emisión si falla — es un "mejor esfuerzo".
async function enviarWhatsApp(host, paciente_rut, boleta, certificadoCodigo){
  if (!host || !paciente_rut || !boleta || !boleta.bsale_url) return;
  try {
    const q = await sbFetch('pacientes?rut=eq.' + encodeURIComponent(paciente_rut) + '&select=nombre,tel&limit=1');
    const arr = await q.json();
    const pac = (arr && arr[0]) ? arr[0] : null;
    if (!pac || !pac.tel) return;

    let msg = 'Hola ' + (pac.nombre || '') + ' 👋\n'
            + 'Tu atención con el Dr. Gonzalo Pantoja quedó pagada.\n\n'
            + '📄 Tu boleta: ' + boleta.bsale_url;
    if (certificadoCodigo) {
      msg += '\n\n🧾 Tu certificado de reembolso (PDF):\n'
           + 'https://www.drgonzalopantoja.cl/api/certificado-pdf?c=' + certificadoCodigo
           + '\n\nAdjúntalo junto a la boleta al pedir tu reembolso en la Isapre.'
           + '\nCódigo de validación: ' + certificadoCodigo;
    }
    msg += '\n\nGracias por confiar en nosotros.';

    await fetch('https://' + host + '/api/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: pac.tel, body: msg, name: pac.nombre || '' })
    });
  } catch (e) { /* no interrumpe la emisión */ }
}
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const _host = req.headers['x-forwarded-host'] || req.headers.host;
    const empresa = String(body.empresa || '').toLowerCase();
    if (!CODE_SII[empresa]) { res.status(400).json({ error: 'empresa debe ser skintouch o lasertouch' }); return; }
    // FIX: leer del `body` ya parseado (línea 166), NO de `req.body` crudo.
    // En el camino WebPay req.body llega como string, y `req.body.presupuesto_id`
    // daba undefined → el certificado se llamaba con presupuesto_id null y no emitía.
    const _presupuesto_id = body.presupuesto_id || null;

    const cobro_id = body.cobro_id || null;
    const paciente_rut = body.paciente_rut || null;
    const medio_pago = body.medio_pago || null; // 'tarjeta'|'webpay'|'efectivo'|'transferencia'|...

    // ── Idempotencia: si ya hay una boleta emitida para este cobro, no repetir ──
    if (cobro_id) {
      const q = await sbFetch('boletas?cobro_id=eq.' + encodeURIComponent(cobro_id) + '&bsale_estado=eq.emitida&select=*');
      const existentes = await q.json();
      if (existentes && existentes.length) {
        res.status(200).json({ ok:true, ya_emitida:true, boletas: existentes });
        return;
      }
    }

    // ── Receptor (cliente) para la boleta + forma de pago ──
    // Se resuelven una sola vez, no por cada grupo. Si algo falla, quedan en
    // null/null y la boleta sale igual que antes (sin receptor / forma default).
    let clienteBoleta = null;
    if (paciente_rut) {
      const pq = await sbFetch('pacientes?rut=eq.' + encodeURIComponent(paciente_rut) +
        '&select=rut,nombre,apellido,apellido2,comuna,email&limit=1');
      const parr = await pq.json().catch(function(){ return []; });
      clienteBoleta = construirCliente(parr && parr[0]);
    }
    const paymentTypeId = await resolverPaymentTypeId(empresa, medio_pago);

    // ── Resolver las líneas a facturar ──
    let lineasBase = []; // [{ monto, comment, reembolsable, prestacion_id }]

    if (body.presupuesto_id) {
      const q = await sbFetch(
        'presupuesto_items?presupuesto_id=eq.' + encodeURIComponent(body.presupuesto_id) +
        '&select=prestacion_id,honorario_monto,insumo_monto,reembolsable,prestaciones(nombre,glosa_fonasa,glosa_boleta)'
      );
      const items = await q.json();
      if (!items || !items.length) { res.status(400).json({ error: 'Ese presupuesto no tiene ítems.' }); return; }

      lineasBase = items
        .map(function(it){
          const monto = empresa === 'skintouch' ? (it.honorario_monto || 0) : (it.insumo_monto || 0);
          if (monto <= 0) return null;
          const pr = it.prestaciones || {};
          const comment = it.reembolsable
            ? (pr.glosa_fonasa || pr.nombre || 'Atención médica')
            : (pr.glosa_boleta || pr.nombre || 'Atención médica');
          return { monto, comment, reembolsable: !!it.reembolsable, prestacion_id: it.prestacion_id || null };
        })
        .filter(Boolean);

      if (!lineasBase.length) { res.status(400).json({ error: 'Ningún ítem tiene monto para ' + empresa + '.' }); return; }

    } else if (Array.isArray(body.items) && body.items.length) {
      lineasBase = body.items.map(function(i){
        return {
          monto: Number(i.monto) || 0,
          comment: i.comment || 'Atención médica',
          reembolsable: !!i.reembolsable,
          prestacion_id: i.prestacion_id || null
        };
      }).filter(function(i){ return i.monto > 0; });
      if (!lineasBase.length) { res.status(400).json({ error: 'Sin ítems con monto válido.' }); return; }

    } else {
      res.status(400).json({ error: 'Falta presupuesto_id o items.' });
      return;
    }

    // ── Agrupar por reembolsable: nunca se mezcla en un mismo documento ──
    const grupos = agruparPorReembolsable(lineasBase);
    const resultados = [];

    for (const grupo of grupos) {
      const totalGrupo = grupo.items.reduce(function(s, l){ return s + l.monto; }, 0);
      const { neto: netoTotal } = calcularNetoIva(empresa, totalGrupo);

      // Reparte el neto del grupo proporcionalmente entre las líneas (para
      // que Bsale calcule bien el IVA agregado de cada línea afecta).
      let acumulado = 0;
      const lineasBsale = grupo.items.map(function(l, idx){
        let netoUnit;
        if (empresa === 'lasertouch') {
          netoUnit = (idx === grupo.items.length - 1)
            ? (netoTotal - acumulado)
            : Math.round(l.monto / 1.19);
          acumulado += netoUnit;
        } else {
          netoUnit = l.monto; // exento: neto = monto
        }
        return { netoUnit, comment: l.comment };
      });

      const payments = paymentTypeId
        ? [{ paymentTypeId: paymentTypeId, amount: totalGrupo, recordDate: Math.floor(Date.now() / 1000) }]
        : null;
      const bsaleResult = await emitirEnBsale(empresa, lineasBsale, { client: clienteBoleta, payments: payments });
      const prestacion_id_repr = grupo.items.length === 1 ? grupo.items[0].prestacion_id : null;
      const concepto_repr = grupo.items.map(function(l){ return l.comment; }).join(' + ').slice(0, 250);

      const boletaGuardada = await guardarBoleta({
        empresa, cobro_id, paciente_rut,
        reembolsable: grupo.reembolsable,
        total: totalGrupo,
        prestacion_id: prestacion_id_repr,
        concepto: concepto_repr,
        bsaleResult
      });

      // Certificado de reembolso: solo para boleta reembolsable de SkinTouch,
      // efectivamente emitida. No bloquea ni rompe si falla.
      let certificado = null;
      if (bsaleResult.ok && empresa === 'skintouch' && grupo.reembolsable) {
        certificado = await emitirCertificado({
          boleta: boletaGuardada, empresa, reembolsable: true,
          paciente_rut, presupuesto_id: _presupuesto_id
        });
      }
      if (bsaleResult.ok) await enviarWhatsApp(_host, paciente_rut, boletaGuardada, certificado && certificado.ok ? certificado.codigo : null);
      
      resultados.push({
        ok: bsaleResult.ok, error: bsaleResult.ok ? null : bsaleResult.error,
        boleta: boletaGuardada,
        certificado: certificado && certificado.ok ? { codigo: certificado.codigo } : null
      });
    }

    const huboError = resultados.some(function(r){ return !r.ok; });
    res.status(huboError ? 207 : 200).json({ ok: !huboError, resultados });

  } catch (e) {
    res.status(500).json({ ok:false, error: String((e && e.message) || e) });
  }
};
