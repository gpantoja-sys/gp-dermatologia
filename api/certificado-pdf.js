// api/certificado-pdf.js
// Genera al vuelo el Certificado de Atención para reembolso, en PDF, con la firma
// del Dr. Pantoja y un QR que apunta a la verificación pública (api/verificar?c=CODIGO).
// Diseño formal aprobado. Se sirve como application/pdf.

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

function clp(n){ return '$' + (n||0).toLocaleString('es-CL'); }

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

async function buildPdf(cert, firmaBytes){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const { width } = page.getSize();
  const R = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const M = 54, RX = width - M, cx = width/2;
  let y = 792;

  // Encabezado
  page.drawText('DR. GONZALO PANTOJA ACKERMANN', { x:M, y, size:11.5, font:B, color:TINTA });
  y -= 14;
  ['CIRUG\u00cdA DERMATOL\u00d3GICA \u00b7 L\u00c1SER \u00b7 DERMATOLOG\u00cdA','RUT 9.382.957-3','REG. SUPERINTENDENCIA DE SALUD N\u00b0 85125','REG. COLEGIO M\u00c9DICO 19.192-2']
    .forEach(t => { page.drawText(t, { x:M, y, size:7.5, font:R, color:SUAVE }); y -= 10; });

  // QR arriba derecha
  const qrPng = await pdf.embedPng(await QRCode.toDataURL(BASE + '/api/verificar?c=' + encodeURIComponent(cert.codigo), { margin:1, width:200 }));
  const qs = 62;
  page.drawText('VALIDACI\u00d3N', { x: RX-qs + (qs - B.widthOfTextAtSize('VALIDACI\u00d3N',6))/2, y:792, size:6, font:B, color:TENUE });
  page.drawImage(qrPng, { x:RX-qs, y:792-qs-4, width:qs, height:qs });
  drawSpaced(page, cert.codigo, RX-qs/2, 792-qs-16, 7, B, TINTA, 0.5);

  y -= 14;
  page.drawLine({ start:{x:M,y}, end:{x:RX,y}, thickness:0.8, color:LINEA });
  y -= 30;

  // Título
  drawSpaced(page, 'CERTIFICADO DE ATENCI\u00d3N', cx, y, 15, B, TINTA, 2.2);
  y -= 13;
  drawSpaced(page, 'PARA SOLICITUD DE REEMBOLSO ANTE ISAPRE', cx, y, 6.5, R, TENUE, 1.2);
  y -= 26;

  // Párrafo de certificación
  const parCert = 'El profesional que suscribe certifica haber otorgado atenci\u00f3n m\u00e9dica de especialidad a la persona individualizada a continuaci\u00f3n, en las prestaciones, fechas y valores que se detallan. Las prestaciones consignadas responden a indicaci\u00f3n m\u00e9dica y fueron efectivamente realizadas. Se emite el presente documento a solicitud del interesado, para ser presentado ante su instituci\u00f3n previsional de salud.';
  wrap(parCert, R, 9.5, RX-M).forEach(l => { page.drawText(l, { x:M, y, size:9.5, font:R, color:TINTA }); y -= 14; });
  y -= 16;

  // Tabla de datos
  const fila = (k, v) => {
    page.drawText(k, { x:M, y, size:7.5, font:R, color:TENUE });
    page.drawText(String(v), { x:M+150, y, size:10.5, font:R, color:TINTA });
    y -= 8;
    page.drawLine({ start:{x:M,y}, end:{x:RX,y}, thickness:0.5, color:LINEA });
    y -= 16;
  };
  fila('PACIENTE', cert.paciente_nombre || '\u2014');
  fila('RUT', cert.paciente_rut || '\u2014');
  fila('FECHA DE ATENCI\u00d3N', cert.fecha_larga);
  fila('DOCUMENTO TRIBUTARIO', 'Boleta electr\u00f3nica N\u00b0 ' + (cert.bsale_folio || '\u2014') + ' \u00b7 SkinTouch SpA');
  y -= 8;

  // Prestaciones
  page.drawText('PRESTACIONES REALIZADAS', { x:M, y, size:7.5, font:R, color:TENUE });
  y -= 18;
  (cert.lineas || []).forEach((l, i) => {
    page.drawText(String(i+1), { x:M, y, size:8, font:R, color:TENUE });
    page.drawText((l.nombre || 'Atenci\u00f3n m\u00e9dica'), { x:M+16, y, size:10.5, font:B, color:TINTA });
    const monto = clp(l.monto);
    page.drawText(monto, { x:RX - B.widthOfTextAtSize(monto,11), y, size:11, font:B, color:TINTA });
    y -= 13;
    if (l.codigo_dx || l.glosa_fonasa){
      const g = (l.codigo_dx ? 'FONASA ' + l.codigo_dx + ' \u2014 ' : 'SIN C\u00d3DIGO PROPIO \u2014 ') + (l.glosa_fonasa || '');
      wrap(g.toUpperCase(), R, 6.5, RX-M-16).forEach(gl => { page.drawText(gl, { x:M+16, y, size:6.5, font:R, color:TENUE }); y -= 9; });
    }
    y -= 12;
  });
  y -= 2;
  page.drawLine({ start:{x:M,y}, end:{x:RX,y}, thickness:0.5, color:LINEA });
  y -= 18;
  page.drawText('TOTAL HONORARIOS PROFESIONALES', { x:M, y, size:8, font:R, color:SUAVE });
  const tot = clp(cert.total);
  page.drawText(tot, { x:RX - B.widthOfTextAtSize(tot,13), y, size:13, font:B, color:TINTA });
  y -= 30;

  // Bloque legal
  const legal = 'Los valores indicados corresponden exclusivamente a honorarios profesionales, exentos de IVA conforme a la normativa del Servicio de Impuestos Internos. El derecho de pabell\u00f3n, los insumos quir\u00fargicos y el estudio histopatol\u00f3gico son facturados por separado por el establecimiento donde se realiz\u00f3 el procedimiento. La autenticidad de este certificado puede verificarse ingresando el c\u00f3digo de validaci\u00f3n en drgonzalopantoja.cl/verificar.';
  wrap(legal, R, 8, RX-M).forEach(l => { page.drawText(l, { x:M, y, size:8, font:R, color:SUAVE }); y -= 11; });

  // Firma (si está disponible)
  const lineY = 152;
  if (firmaBytes){
    try {
      const firma = await pdf.embedPng(firmaBytes);
      const fw = 150, fh = fw * (firma.height/firma.width);
      const firmaY = lineY - fh/5;   // 1/5 inferior cruza bajo la línea → apoyada
      page.drawImage(firma, { x:cx-fw/2, y:firmaY, width:fw, height:fh });
    } catch (e) { /* si la firma falla, el certificado igual se emite */ }
  }
  page.drawLine({ start:{x:cx-95, y:lineY}, end:{x:cx+95, y:lineY}, thickness:0.7, color:rgb(0.3,0.3,0.3) });
  const nm = 'DR. GONZALO PANTOJA ACKERMANN';
  page.drawText(nm, { x:cx - B.widthOfTextAtSize(nm,9)/2, y:lineY-36, size:9, font:B, color:TINTA });
  const su = 'M\u00c9DICO DERMAT\u00d3LOGO \u00b7 RUT 9.382.957-3';
  page.drawText(su, { x:cx - R.widthOfTextAtSize(su,7)/2, y:lineY-47, size:7, font:R, color:SUAVE });
  const rg = 'REG. SUPERINTENDENCIA DE SALUD N\u00b0 85125';
  page.drawText(rg, { x:cx - R.widthOfTextAtSize(rg,7)/2, y:lineY-56, size:7, font:R, color:SUAVE });

  // Pie
  const pie1 = 'Emitido en Santiago, ' + cert.fecha_larga + ' \u00b7 Documento generado electr\u00f3nicamente';
  page.drawText(pie1, { x:cx - R.widthOfTextAtSize(pie1,6.5)/2, y:70, size:6.5, font:R, color:TENUE });
  const pie2 = 'Verificaci\u00f3n en drgonzalopantoja.cl/verificar con el c\u00f3digo ' + cert.codigo;
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
  const codigo = String((req.query && (req.query.c || req.query.codigo)) || '').trim().toUpperCase();
  if (!codigo){
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(400).send('Falta el codigo del certificado (?c=GP-XXXX-XXXX).');
  }
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/certificados_reembolso?codigo=eq.'
      + encodeURIComponent(codigo) + '&select=*', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
    });
    const arr = await r.json().catch(function(){ return []; });
    const cert = Array.isArray(arr) && arr[0] ? arr[0] : null;

    if (!cert){
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('No se encontro un certificado con ese codigo.');
    }

    if (cert.lineas && typeof cert.lineas === 'string'){
      try { cert.lineas = JSON.parse(cert.lineas); } catch(e){ cert.lineas = []; }
    }
    if (!Array.isArray(cert.lineas)) cert.lineas = [];
    cert.fecha_larga = fechaLarga(cert.created_at || cert.fecha || cert.emitido_en || null);

    let bytes;
    if (cert.anulado){
      bytes = await pdfSimple('Certificado anulado',
        'Este certificado (' + codigo + ') fue anulado y no es valido para reembolso.');
    } else {
      let firmaBytes = null;
      try {
        const fr = await fetch(FIRMA_URL);
        if (fr.ok) firmaBytes = new Uint8Array(await fr.arrayBuffer());
      } catch (e) { /* sin firma, el certificado igual se emite */ }
      bytes = await buildPdf(cert, firmaBytes);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Certificado-' + codigo + '.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(bytes));
  } catch (e){
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).send('No se pudo generar el certificado. Intenta nuevamente.');
  }
};
