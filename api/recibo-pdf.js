// api/recibo-pdf.js
// Genera al vuelo el RECIBO DE DINERO A CUENTA de un pack, en PDF, por empresa
// (SkinTouch honorarios / LaserTouch insumos), con firma y QR de verificación.
// Se llama /api/recibo-pdf?r=GPR-XXXX-XXXX. Mismo patrón que certificado-pdf.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';
const BASE = 'https://www.drgonzalopantoja.cl';
const FIRMA_URL = BASE + '/Firma-GP.png';

const TINTA = rgb(0.13,0.13,0.13);
const SUAVE = rgb(0.50,0.50,0.50);
const TENUE = rgb(0.62,0.62,0.62);
const LINEA = rgb(0.85,0.85,0.85);

function clp(n){ return '$' + Math.round(n||0).toLocaleString('es-CL'); }

function fechaLarga(d){
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const dt = d ? new Date(d) : new Date();
  const x = isNaN(dt.getTime()) ? new Date() : dt;
  return x.getDate() + ' de ' + meses[x.getMonth()] + ' de ' + x.getFullYear();
}

function wrap(text, font, size, maxW){
  const words = String(text).split(/\s+/);
  const lines = []; let line = '';
  for (const w of words){
    const t = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) > maxW && line){ lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function drawSpaced(page, text, cx, y, size, font, color, sp){
  const chars = String(text).split('');
  let total = 0;
  chars.forEach(c => total += font.widthOfTextAtSize(c, size) + sp);
  total -= sp;
  let x = cx - total/2;
  chars.forEach(c => { page.drawText(c, { x, y, size, font, color }); x += font.widthOfTextAtSize(c, size) + sp; });
}

async function buildPdf(rec, emp, firmaBytes){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const { width } = page.getSize();
  const R = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const M = 54, RX = width - M, cx = width/2;
  let y = 792;

  const razon = (emp && (emp.razon_social || emp.nombre)) || 'GP Dermatología';
  const rutEmp = (emp && emp.rut) ? ('RUT ' + emp.rut) : null;
  const componente = (rec.detalle && rec.detalle.componente) || 'honorarios';

  // Encabezado: la empresa emisora
  page.drawText(String(razon).toUpperCase(), { x:M, y, size:11.5, font:B, color:TINTA });
  y -= 14;
  const sub = [ 'GP DERMATOLOGÍA · DR. GONZALO PANTOJA ACKERMANN' ];
  if (rutEmp) sub.push(rutEmp);
  sub.push(componente === 'insumos' ? 'COMPONENTE: INSUMOS Y EQUIPAMIENTO' : 'COMPONENTE: HONORARIOS MÉDICOS');
  sub.forEach(t => { page.drawText(t, { x:M, y, size:7.5, font:R, color:SUAVE }); y -= 10; });

  // QR arriba derecha (reabre este mismo recibo)
  const qrPng = await pdf.embedPng(await QRCode.toDataURL(BASE + '/api/recibo-pdf?r=' + encodeURIComponent(rec.codigo), { margin:1, width:200 }));
  const qs = 62;
  page.drawText('VALIDACIÓN', { x: RX-qs + (qs - B.widthOfTextAtSize('VALIDACIÓN',6))/2, y:792, size:6, font:B, color:TENUE });
  page.drawImage(qrPng, { x:RX-qs, y:792-qs-4, width:qs, height:qs });
  drawSpaced(page, rec.codigo, RX-qs/2, 792-qs-16, 6.5, B, TINTA, 0.4);

  y -= 14;
  page.drawLine({ start:{x:M,y}, end:{x:RX,y}, thickness:0.8, color:LINEA });
  y -= 30;

  // Título
  drawSpaced(page, 'RECIBO DE DINERO A CUENTA', cx, y, 15, B, TINTA, 2.2);
  y -= 13;
  drawSpaced(page, 'PROGRAMA DE TRATAMIENTOS PREPAGADOS', cx, y, 6.5, R, TENUE, 1.2);
  y -= 26;

  // Párrafo
  const par = razon + ' declara haber recibido de la persona individualizada a continuación la suma que se indica, a cuenta de las prestaciones que se detallan. Este documento acredita la recepción del dinero y el saldo a favor del paciente; por cada sesión efectivamente realizada se emitirá en ese momento la boleta electrónica correspondiente, imputándose su valor a este anticipo.';
  wrap(par, R, 9.5, RX-M).forEach(l => { page.drawText(l, { x:M, y, size:9.5, font:R, color:TINTA }); y -= 14; });
  y -= 16;

  // Datos
  const fila = (k, v) => {
    page.drawText(k, { x:M, y, size:7.5, font:R, color:TENUE });
    page.drawText(String(v), { x:M+150, y, size:10.5, font:R, color:TINTA });
    y -= 8;
    page.drawLine({ start:{x:M,y}, end:{x:RX,y}, thickness:0.5, color:LINEA });
    y -= 16;
  };
  fila('PACIENTE', rec.paciente_nombre || '—');
  fila('RUT', rec.paciente_rut || '—');
  fila('FECHA', rec.fecha_larga);
  fila('PROGRAMA', (rec.detalle && rec.detalle.nombre_pack) || 'Pack');
  fila('MEDIO DE PAGO', rec.medio || '—');
  y -= 8;

  // Detalle de tratamientos (el componente de esta empresa)
  const items = (rec.detalle && Array.isArray(rec.detalle.items)) ? rec.detalle.items : [];
  page.drawText('DETALLE DEL PROGRAMA', { x:M, y, size:7.5, font:R, color:TENUE });
  y -= 18;
  items.forEach((it, i) => {
    const valor = Number(it.valor_total) || 0;
    const hon = Number(it.honorario_total) || 0;
    const monto = componente === 'insumos' ? (valor - hon) : hon;
    page.drawText(String(i+1), { x:M, y, size:8, font:R, color:TENUE });
    page.drawText((it.nombre || 'Tratamiento') + ' · ' + (it.sesiones || 1) + ' sesión(es)', { x:M+16, y, size:10.5, font:B, color:TINTA });
    const m = clp(monto);
    page.drawText(m, { x:RX - B.widthOfTextAtSize(m,11), y, size:11, font:B, color:TINTA });
    y -= 17;
  });
  y -= 2;
  page.drawLine({ start:{x:M,y}, end:{x:RX,y}, thickness:0.5, color:LINEA });
  y -= 18;
  page.drawText('TOTAL RECIBIDO A CUENTA', { x:M, y, size:8, font:R, color:SUAVE });
  const tot = clp(rec.monto);
  page.drawText(tot, { x:RX - B.widthOfTextAtSize(tot,13), y, size:13, font:B, color:TINTA });
  y -= 30;

  // Bloque legal
  const legal = 'Este recibo no constituye boleta ni factura. Los documentos tributarios se emiten al momento de realizarse cada prestación, según corresponda a cada empresa. Las sesiones no realizadas mantienen su saldo a favor del paciente. La autenticidad de este recibo puede verificarse escaneando el código QR o ingresando a drgonzalopantoja.cl con el código de validación.';
  wrap(legal, R, 8, RX-M).forEach(l => { page.drawText(l, { x:M, y, size:8, font:R, color:SUAVE }); y -= 11; });

  // Firma
  const lineY = 152;
  if (firmaBytes){
    try {
      const firma = await pdf.embedPng(firmaBytes);
      const fw = 150, fh = fw * (firma.height/firma.width);
      page.drawImage(firma, { x:cx-fw/2, y:lineY - fh/5, width:fw, height:fh });
    } catch (e) { /* sin firma, el recibo igual se emite */ }
  }
  page.drawLine({ start:{x:cx-95, y:lineY}, end:{x:cx+95, y:lineY}, thickness:0.7, color:rgb(0.3,0.3,0.3) });
  const nm = String(razon).toUpperCase();
  page.drawText(nm, { x:cx - B.widthOfTextAtSize(nm,9)/2, y:lineY-36, size:9, font:B, color:TINTA });
  const su = 'DR. GONZALO PANTOJA ACKERMANN · GP DERMATOLOGÍA';
  page.drawText(su, { x:cx - R.widthOfTextAtSize(su,7)/2, y:lineY-47, size:7, font:R, color:SUAVE });

  // Pie
  const pie1 = 'Emitido en Santiago, ' + rec.fecha_larga + ' · Documento generado electrónicamente';
  page.drawText(pie1, { x:cx - R.widthOfTextAtSize(pie1,6.5)/2, y:70, size:6.5, font:R, color:TENUE });
  const pie2 = 'Código de validación: ' + rec.codigo;
  page.drawText(pie2, { x:cx - R.widthOfTextAtSize(pie2,6.5)/2, y:61, size:6.5, font:R, color:TENUE });

  return await pdf.save();
}

async function pdfSimple(titulo, texto){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const R = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(titulo, { x:54, y:760, size:18, font:B, color:TINTA });
  page.drawText(texto, { x:54, y:732, size:11, font:R, color:SUAVE });
  return await pdf.save();
}

module.exports = async (req, res) => {
  const codigo = String((req.query && (req.query.r || req.query.codigo)) || '').trim().toUpperCase();
  if (!codigo){
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(400).send('Falta el codigo del recibo (?r=GPR-XXXX-XXXX).');
  }
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/recibos_pack?codigo=eq.'
      + encodeURIComponent(codigo) + '&select=*', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
    });
    const arr = await r.json().catch(function(){ return []; });
    const rec = Array.isArray(arr) && arr[0] ? arr[0] : null;

    if (!rec){
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('No se encontro un recibo con ese codigo.');
    }

    if (rec.detalle && typeof rec.detalle === 'string'){
      try { rec.detalle = JSON.parse(rec.detalle); } catch(e){ rec.detalle = {}; }
    }
    rec.fecha_larga = fechaLarga(rec.created_at || null);

    // Empresa emisora (razón social y RUT si están cargados)
    let emp = null;
    try {
      const er = await fetch(SUPABASE_URL + '/rest/v1/empresas?id=eq.' + rec.empresa_id + '&select=*', {
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
      });
      const earr = await er.json().catch(function(){ return []; });
      emp = Array.isArray(earr) && earr[0] ? earr[0] : null;
    } catch (e) { /* seguimos sin empresa */ }

    let bytes;
    if (rec.anulado){
      bytes = await pdfSimple('Recibo anulado',
        'Este recibo (' + codigo + ') fue anulado y no representa saldo vigente.');
    } else {
      let firmaBytes = null;
      try {
        const fr = await fetch(FIRMA_URL);
        if (fr.ok) firmaBytes = new Uint8Array(await fr.arrayBuffer());
      } catch (e) { /* sin firma, el recibo igual se emite */ }
      bytes = await buildPdf(rec, emp, firmaBytes);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Recibo-' + codigo + '.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(bytes));
  } catch (e){
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).send('No se pudo generar el recibo. Intenta nuevamente.');
  }
};
