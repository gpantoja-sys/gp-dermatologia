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
const CODE_SII = { skintouch: 41, lasertouch: 39 }; // 41 = Boleta Exenta Electrónica · 39 = Boleta Electrónica (afecta)

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

// Arma el body de Bsale para un grupo de líneas (todas mismo estado reembolsable)
function bodyBsale(empresa, lineas){
  const codeSii = CODE_SII[empresa];
  const officeId = bsaleOffice(empresa);
  const emissionDate = Math.floor(Date.now() / 1000);
  const details = lineas.map(function(l){
    const d = { netUnitValue: l.netoUnit, quantity: 1, comment: (l.comment || 'Atención médica').slice(0, 150) };
    if (empresa === 'lasertouch') d.taxes = [{ code: 14, percentage: 19 }];
    return d;
  });
  const body = { codeSii, emissionDate, details };
  if (officeId) body.officeId = Number(officeId);
  return body;
}

async function emitirEnBsale(empresa, lineas){
  const token = bsaleToken(empresa);
  if (!token) return { ok:false, error: 'Falta BSALE_' + empresa.toUpperCase() + '_TOKEN en Vercel' };
  const body = bodyBsale(empresa, lineas);
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

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const empresa = String(body.empresa || '').toLowerCase();
    if (!CODE_SII[empresa]) { res.status(400).json({ error: 'empresa debe ser skintouch o lasertouch' }); return; }

    const cobro_id = body.cobro_id || null;
    const paciente_rut = body.paciente_rut || null;

    // ── Idempotencia: si ya hay una boleta emitida para este cobro, no repetir ──
    if (cobro_id) {
      const q = await sbFetch('boletas?cobro_id=eq.' + encodeURIComponent(cobro_id) + '&bsale_estado=eq.emitida&select=*');
      const existentes = await q.json();
      if (existentes && existentes.length) {
        res.status(200).json({ ok:true, ya_emitida:true, boletas: existentes });
        return;
      }
    }

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

      const bsaleResult = await emitirEnBsale(empresa, lineasBsale);
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

      resultados.push({ ok: bsaleResult.ok, error: bsaleResult.ok ? null : bsaleResult.error, boleta: boletaGuardada });
    }

    const huboError = resultados.some(function(r){ return !r.ok; });
    res.status(huboError ? 207 : 200).json({ ok: !huboError, resultados });

  } catch (e) {
    res.status(500).json({ ok:false, error: String((e && e.message) || e) });
  }
};
