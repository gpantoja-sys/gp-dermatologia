// api/_cert-test.js — ENDPOINT TEMPORAL DE DIAGNÓSTICO. Borrar después de usar.
// Re-ejecuta emitirCertificado sobre una boleta YA emitida (por folio), sin
// generar un pago ni una boleta nueva. Abrir en el navegador:
//   https://drgonzalopantoja.cl/api/_cert-test?folio=14604
// Devuelve el resultado exacto de emitirCertificado (incluido status/respuesta
// de Supabase si el insert falla), para ver por qué el certificado no se crea.

const { emitirCertificado } = require('./_certificado');

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

function sb(path){
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const folio = (req.query && req.query.folio) ? String(req.query.folio) : '14604';

    // 1. Traer la boleta por folio (mismo objeto que recibe emitirCertificado en el flujo real).
    const rb = await sb('boletas?bsale_folio=eq.' + encodeURIComponent(folio) + '&select=*&limit=1');
    const barr = await rb.json().catch(function(){ return []; });
    const boleta = (barr && barr[0]) ? barr[0] : null;
    if (!boleta) { res.status(404).json({ error: 'No se encontró boleta con folio ' + folio }); return; }

    // 2. Recuperar el presupuesto_id desde el cobro (para armar las líneas).
    let presupuesto_id = null;
    if (boleta.cobro_id) {
      const rc = await sb('cobros?id=eq.' + encodeURIComponent(boleta.cobro_id) + '&select=presupuesto_id&limit=1');
      const carr = await rc.json().catch(function(){ return []; });
      presupuesto_id = (carr && carr[0]) ? carr[0].presupuesto_id : null;
    }

    // 3. Re-ejecutar emitirCertificado con el mismo contexto que el flujo real.
    const result = await emitirCertificado({
      boleta: boleta,
      empresa: 'skintouch',
      reembolsable: true,
      paciente_rut: boleta.paciente_rut,
      presupuesto_id: presupuesto_id
    });

    res.status(200).json({
      diagnostico: true,
      folio: folio,
      boleta_id: boleta.id,
      boleta_bsale_estado: boleta.bsale_estado,
      boleta_reembolsable: boleta.reembolsable,
      cobro_id: boleta.cobro_id,
      presupuesto_id: presupuesto_id,
      resultado_emitirCertificado: result
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
