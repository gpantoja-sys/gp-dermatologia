// api/_certificado.js — módulo emisor del Certificado de Atención para Reembolso.
// Lo invoca bsale-emitir.js cuando se emite bien una boleta REEMBOLSABLE de
// SkinTouch. Genera el código de validación, arma las líneas con su glosa, y
// guarda el registro en `certificados_reembolso`. Es idempotente por boleta_id.
// No lanza excepciones hacia afuera: si algo falla, lo registra y sigue —
// nunca debe romper la emisión de la boleta ni el pago.

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

function sb(path, opts){
  opts = opts || {};
  return fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    }, opts.headers || {})
  }));
}

// Código tipo GP-7K3M-9QX2. Sin caracteres ambiguos (0/O, 1/I) para que se
// pueda dictar por teléfono sin confusión.
function generarCodigo(){
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let b1 = '', b2 = '';
  for (let i=0;i<4;i++) b1 += abc[Math.floor(Math.random()*abc.length)];
  for (let i=0;i<4;i++) b2 += abc[Math.floor(Math.random()*abc.length)];
  return 'GP-' + b1 + '-' + b2;
}

async function codigoUnico(){
  for (let intento=0; intento<6; intento++){
    const c = generarCodigo();
    const r = await sb('certificados_reembolso?codigo=eq.' + encodeURIComponent(c) + '&select=id');
    const arr = await r.json().catch(function(){ return []; });
    if (!arr || !arr.length) return c;
  }
  return 'GP-' + Date.now().toString(36).toUpperCase();  // respaldo: siempre único
}

// Emite el certificado para una boleta ya guardada. Recibe el contexto que
// bsale-emitir ya tiene en memoria, para no re-consultar de más.
// params: { boleta, empresa, reembolsable, paciente_rut, presupuesto_id }
async function emitirCertificado(params){
  try {
    const { boleta, empresa, reembolsable, paciente_rut, presupuesto_id } = params || {};

    // Guardas: solo SkinTouch, solo reembolsable, solo boleta efectivamente emitida.
    if (empresa !== 'skintouch') return { ok:false, motivo:'no-skintouch' };
    if (!reembolsable)           return { ok:false, motivo:'no-reembolsable' };
    if (!boleta || boleta.bsale_estado !== 'emitida' || !boleta.id)
      return { ok:false, motivo:'boleta-no-emitida' };

    // Idempotencia: si ya hay certificado para esta boleta, devolver ese.
    const ya = await sb('certificados_reembolso?boleta_id=eq.' + boleta.id + '&select=codigo,id');
    const yaArr = await ya.json().catch(function(){ return []; });
    if (yaArr && yaArr.length) return { ok:true, ya_emitido:true, codigo: yaArr[0].codigo };

    // Líneas del presupuesto, solo las reembolsables (que son las que van al
    // certificado), con la glosa amigable si existe, si no la FONASA.
    let lineas = [];
    if (presupuesto_id){
      // NOTA: glosa_certificado y parametros_tecnicos AÚN NO existen como columnas
      // en `prestaciones` (pendiente: cargar las 40 glosas amigables). Pedirlas en
      // el select hace que PostgREST devuelva 400 y el certificado se caiga en
      // silencio. Se omiten hasta que las columnas existan; el mapeo de abajo ya
      // hace fallback a nombre/glosa_fonasa, así que al agregarlas basta con volver
      // a sumarlas aquí. Mientras tanto el certificado usa glosa_fonasa.
      const q = await sb('presupuesto_items?presupuesto_id=eq.' + presupuesto_id
        + '&reembolsable=eq.true&excluido=eq.false'
        + '&select=honorario_monto,prestaciones(nombre,codigo_dx,glosa_fonasa)');
      const its = await q.json().catch(function(){ return []; });
      // Blindaje: si vuelve un objeto de error (400) en vez de un arreglo, no reventar.
      const itsArr = Array.isArray(its) ? its : [];
      lineas = itsArr.map(function(i){
        const p = i.prestaciones || {};
        return {
          nombre: p.nombre || 'Prestación',
          glosa_certificado: p.glosa_certificado || p.nombre || '',
          parametros: p.parametros_tecnicos || '',
          codigo_dx: p.codigo_dx || '',
          glosa_fonasa: p.glosa_fonasa || '',
          monto: i.honorario_monto || 0
        };
      });
    }

    // Nombre de la paciente (para mostrar en el certificado, no en la verificación pública).
    let nombre = null;
    if (paciente_rut){
      const pr = await sb('pacientes?rut=eq.' + encodeURIComponent(paciente_rut) + '&select=nombre,apellido,apellido2');
      const pa = await pr.json().catch(function(){ return []; });
      if (pa && pa[0]) nombre = [pa[0].nombre, pa[0].apellido, pa[0].apellido2].filter(Boolean).join(' ');
    }

    const codigo = await codigoUnico();
    const row = {
      codigo: codigo,
      boleta_id: boleta.id,
      cobro_id: boleta.cobro_id || null,
      paciente_rut: paciente_rut || boleta.paciente_rut || '',
      paciente_nombre: nombre,
      bsale_folio: boleta.bsale_folio || null,
      total: boleta.total || lineas.reduce(function(s,l){ return s + l.monto; }, 0),
      lineas: JSON.stringify(lineas)
    };
    const ins = await sb('certificados_reembolso', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row)
    });
    const out = await ins.json().catch(function(){ return null; });
    if (out && out[0]) return { ok:true, codigo: out[0].codigo, id: out[0].id };
    return { ok:false, motivo:'insert-fallo' };

  } catch (e) {
    console.warn('[certificado] error:', e && e.message);
    return { ok:false, motivo: String((e && e.message) || e) };
  }
}

module.exports = { emitirCertificado };
