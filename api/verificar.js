// api/verificar.js — página pública de verificación de certificados.
// La Isapre (o cualquiera con el código del QR) entra a
//   drgonzalopantoja.cl/api/verificar?c=GP-XXXX-XXXX
// y ve los datos NO SENSIBLES del certificado: profesional, fecha,
// prestaciones con su código FONASA, folio y total. Nunca el RUT completo.

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function clp(n){ return '$' + (Number(n)||0).toLocaleString('es-CL'); }
function fecha(iso){ try { return new Date(iso).toLocaleDateString('es-CL',
  { day:'numeric', month:'long', year:'numeric' }); } catch(e){ return '—'; } }

// Muestra solo los últimos dígitos del RUT: 12.****.**8-9 → protege identidad.
function rutParcial(rut){
  const r = String(rut||'').replace(/\./g,'');
  const m = r.match(/^(\d{1,2})\d*(-?[\dkK])$/);
  return m ? (m[1] + '.···.··' + m[2]) : '···';
}

function pagina(titulo, cuerpo, ok){
  const color = ok ? '#1f3d34' : '#9b2c2c';
  return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">'
   + '<meta name="viewport" content="width=device-width, initial-scale=1">'
   + '<meta name="robots" content="noindex">'
   + '<title>' + esc(titulo) + ' · Dr. Gonzalo Pantoja</title>'
   + '<style>'
   + '*{box-sizing:border-box;margin:0;padding:0}'
   + 'body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
   + 'background:#f4efe7;color:#26201a;line-height:1.5;padding:24px 16px;min-height:100vh}'
   + '.card{max-width:560px;margin:0 auto;background:#fff;border-radius:18px;'
   + 'border:1px solid #e3dccf;overflow:hidden}'
   + '.top{background:' + color + ';color:#fff;padding:22px 26px}'
   + '.top .marca{font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.85}'
   + '.top h1{font-size:22px;font-weight:600;margin-top:5px}'
   + '.body{padding:24px 26px}'
   + '.row{display:flex;justify-content:space-between;gap:14px;padding:11px 0;'
   + 'border-bottom:1px solid #efeae0;font-size:14px}'
   + '.row .k{color:#8a8076;text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:600}'
   + '.row .v{text-align:right}'
   + '.pres{margin-top:20px}'
   + '.pres-t{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8a8076;margin-bottom:10px}'
   + '.li{padding:11px 0;border-top:1px solid #efeae0}'
   + '.li .n{font-size:14px}'
   + '.li .f{font-size:11px;color:#8a8076;text-transform:uppercase;letter-spacing:.03em;margin-top:4px;line-height:1.5}'
   + '.li .f b{color:#5f5a52}'
   + '.tot{display:flex;justify-content:space-between;padding-top:14px;margin-top:6px;'
   + 'border-top:2px solid #26201a;font-size:16px;font-weight:700}'
   + '.sello{margin-top:20px;padding:13px 15px;border-radius:12px;font-size:13px;line-height:1.5}'
   + '.sello.ok{background:#e8f0ec;color:#1f3d34;border:1px solid #bcd4c7}'
   + '.sello.no{background:#fdeceb;color:#9b2c2c;border:1px solid #e3b3ae}'
   + '.pie{text-align:center;font-size:11px;color:#8a8076;margin-top:18px;line-height:1.6}'
   + '</style></head><body><div class="card">' + cuerpo + '</div>'
   + '<div class="pie">Verificación oficial · Dr. Gonzalo Pantoja Ackermann<br>'
   + 'Reg. Superintendencia de Salud N° 85125</div></body></html>';
}

module.exports = async (req, res) => {
  const codigo = String((req.query && (req.query.c || req.query.codigo)) || '').trim().toUpperCase();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!codigo){
    res.status(200).send(pagina('Verificación',
      '<div class="top"><div class="marca">Certificado de atención</div><h1>Verificación</h1></div>'
      + '<div class="body"><p>Escanea el código QR del certificado o ingresa su código de validación '
      + 'para confirmar su autenticidad.</p></div>', false));
    return;
  }

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/certificados_reembolso?codigo=eq.'
      + encodeURIComponent(codigo) + '&select=*', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
    });
    const arr = await r.json().catch(function(){ return []; });
    const cert = arr && arr[0];

    if (!cert){
      res.status(200).send(pagina('No encontrado',
        '<div class="top" style="background:#9b2c2c"><div class="marca">Certificado de atención</div>'
        + '<h1>Código no encontrado</h1></div>'
        + '<div class="body"><div class="sello no">El código <b>' + esc(codigo) + '</b> no corresponde '
        + 'a ningún certificado emitido. Verifica que esté bien escrito.</div></div>', false));
      return;
    }

    if (cert.anulado){
      res.status(200).send(pagina('Anulado',
        '<div class="top" style="background:#9b2c2c"><div class="marca">Certificado de atención</div>'
        + '<h1>Certificado anulado</h1></div>'
        + '<div class="body"><div class="sello no">Este certificado (' + esc(cert.codigo) + ') '
        + 'fue anulado y no es válido para reembolso.</div></div>', false));
      return;
    }

    let lineas = [];
    try { lineas = typeof cert.lineas === 'string' ? JSON.parse(cert.lineas) : (cert.lineas || []); }
    catch(e){ lineas = []; }

    let presHtml = '';
    if (lineas.length){
      presHtml = '<div class="pres"><div class="pres-t">Prestaciones</div>'
        + lineas.map(function(l){
            const fon = l.codigo_dx ? ('FONASA ' + esc(l.codigo_dx) + ' — ' + esc(l.glosa_fonasa || '')) : '';
            const par = l.parametros ? (' · ' + esc(l.parametros)) : '';
            return '<div class="li"><div class="n">' + esc(l.glosa_certificado || l.nombre) + par + '</div>'
                 + (fon ? '<div class="f">' + fon + '</div>' : '') + '</div>';
          }).join('')
        + '<div class="tot"><span>Total honorarios</span><span>' + clp(cert.total) + '</span></div></div>';
    }

    res.status(200).send(pagina('Certificado válido',
      '<div class="top"><div class="marca">Certificado de atención para reembolso</div>'
      + '<h1>Certificado válido</h1></div>'
      + '<div class="body">'
      + '<div class="row"><span class="k">Código</span><span class="v">' + esc(cert.codigo) + '</span></div>'
      + '<div class="row"><span class="k">Profesional</span><span class="v">Dr. Gonzalo Pantoja Ackermann</span></div>'
      + '<div class="row"><span class="k">Paciente</span><span class="v">' + esc(cert.paciente_nombre || '—')
      + '<br><span style="font-size:11px;color:#8a8076">RUT ' + rutParcial(cert.paciente_rut) + '</span></span></div>'
      + '<div class="row"><span class="k">Fecha de atención</span><span class="v">' + fecha(cert.fecha_atencion) + '</span></div>'
      + (cert.bsale_folio ? '<div class="row"><span class="k">Boleta N°</span><span class="v">' + esc(cert.bsale_folio) + '</span></div>' : '')
      + presHtml
      + '<div class="sello ok">Este certificado es auténtico y fue emitido por el Dr. Gonzalo Pantoja. '
      + 'Los honorarios corresponden a prestaciones efectivamente realizadas.</div>'
      + '</div>', true));

  } catch (e) {
    res.status(200).send(pagina('Error',
      '<div class="top" style="background:#9b2c2c"><h1>No se pudo verificar</h1></div>'
      + '<div class="body"><div class="sello no">Ocurrió un error al consultar. Intenta nuevamente '
      + 'en unos minutos.</div></div>', false));
  }
};
