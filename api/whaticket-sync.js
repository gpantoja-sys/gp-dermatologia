// api/whaticket-sync.js
// Vercel Serverless Function — Cron Job cada 15 minutos
// Consulta Whaticket por tickets nuevos y crea leads en Supabase

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';
const WHATICKET_URL = 'https://api.whaticket.com/api/v1';
const WHATICKET_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJJzY29wZSI6WyJjcmVhdGU6bWVzc2FnZXMi';

// Clarita es la secretaria principal. Andrea es el backup.
const AGENTES = {
  // 'whaticket_user_id': 'Clarita' o 'Andrea'
  // Se obtienen desde Whaticket → Equipo
};

function nombreAgente(userId) {
  // Por defecto Clarita atiende todo
  return AGENTES[String(userId)] || 'Clarita';
}

function formatTel(numero) {
  if (!numero) return null;
  const n = String(numero).replace(/\D/g, '');
  if (n.startsWith('56') && n.length === 11) {
    return `+${n.slice(0,2)} ${n.slice(2,3)} ${n.slice(3,7)} ${n.slice(7)}`;
  }
  return `+${n}`;
}

async function getTicketsNuevos(desde) {
  try {
    const url = `${WHATICKET_URL}/tickets?status=pending&pageNumber=1&limit=50`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${WHATICKET_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) {
      console.error('Error Whaticket API:', res.status, await res.text());
      return [];
    }
    const data = await res.json();
    const tickets = data.tickets || data || [];
    // Filtrar solo los creados desde la última sync
    return tickets.filter(t => {
      const creado = new Date(t.createdAt || t.created_at);
      return creado >= new Date(desde);
    });
  } catch (e) {
    console.error('Error consultando Whaticket:', e);
    return [];
  }
}

module.exports = async function handler(req, res) {
  // Verificar que es llamada autorizada (cron de Vercel o manual)
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET || 'gp-dermatologia-cron-2026';
  
  if (req.method === 'GET' && authHeader !== `Bearer ${cronSecret}`) {
    // Permitir llamada manual sin auth para testing
    if (req.query.test !== 'true') {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // Obtener timestamp de última sync desde medilink_sync_log
    const { data: ultimaSync } = await sb
      .from('medilink_sync_log')
      .select('created_at')
      .eq('tipo', 'whaticket_polling')
      .eq('estado', 'ok')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Si no hay sync previa, usar hace 20 minutos
    const desde = ultimaSync?.created_at 
      ? ultimaSync.created_at 
      : new Date(Date.now() - 20 * 60 * 1000).toISOString();

    console.log('Consultando tickets desde:', desde);

    // Obtener tickets nuevos de Whaticket
    const tickets = await getTicketsNuevos(desde);
    console.log(`Tickets encontrados: ${tickets.length}`);

    let creados = 0;
    let duplicados = 0;
    let errores = 0;

    for (const ticket of tickets) {
      try {
        const contacto = ticket.contact || {};
        const nombre = contacto.name || 'Sin nombre';
        const telefono = formatTel(contacto.number);
        const userId = ticket.userId;
        const ticketId = ticket.id;

        if (!telefono) { errores++; continue; }

        // Verificar si ya existe por teléfono
        const telLimpio = telefono.replace(/\D/g, '');
        const { data: pacExistente } = await sb
          .from('pacientes')
          .select('id')
          .ilike('tel', `%${telLimpio.slice(-9)}%`)
          .maybeSingle();

        if (pacExistente) {
          // Verificar si ya tiene pipeline activo
          const { data: pipeActivo } = await sb
            .from('pipeline_registros')
            .select('id')
            .eq('paciente_id', pacExistente.id)
            .eq('activo', true)
            .maybeSingle();

          if (pipeActivo) {
            duplicados++;
            continue;
          }

          // Paciente existe pero sin pipeline activo → crear pipeline
          const { data: estadoInicial } = await sb
            .from('estados')
            .select('id')
            .eq('pipeline_id', 1)
            .eq('nombre', 'Nuevo lead')
            .single();

          await sb.from('pipeline_registros').insert({
            paciente_id: pacExistente.id,
            pipeline_id: 1,
            estado_id: estadoInicial?.id || null,
            proxima_accion: 'Responder consulta WhatsApp',
            fecha_seguimiento: new Date().toISOString().split('T')[0],
            activo: true,
            notas: `Ticket Whaticket #${ticketId}`
          });

          creados++;
          continue;
        }

        // Paciente nuevo — crear paciente y pipeline
        const nombreParts = nombre.trim().split(' ');
        const primerNombre = nombreParts[0] || nombre;
        const apellido = nombreParts.slice(1).join(' ') || '';

        // Detectar canal de origen según datos del ticket
        const canal = ticket.channel || ticket.whatsapp?.channel || '';
        const origenDetectado = 
          canal === 'instagram' ? 'Instagram' :
          canal === 'facebook'  ? 'Facebook' :
          canal === 'telegram'  ? 'Telegram' :
          'WhatsApp'; // default

        const { data: nuevoPac, error: errPac } = await sb
          .from('pacientes')
          .insert({
            nombre: primerNombre,
            apellido,
            tel: telefono,
            origen: origenDetectado,
            tipo_paciente: 'Lead',
            pais: '+56'
          })
          .select('id')
          .single();

        if (errPac) { 
          console.error('Error creando paciente:', errPac.message); 
          errores++; 
          continue; 
        }

        const { data: estadoInicial } = await sb
          .from('estados')
          .select('id')
          .eq('pipeline_id', 1)
          .eq('nombre', 'Nuevo lead')
          .single();

        await sb.from('pipeline_registros').insert({
          paciente_id: nuevoPac.id,
          pipeline_id: 1,
          estado_id: estadoInicial?.id || null,
          proxima_accion: 'Responder consulta WhatsApp',
          fecha_seguimiento: new Date().toISOString().split('T')[0],
          activo: true,
          notas: `Ticket Whaticket #${ticketId}`
        });

        creados++;

      } catch (e) {
        console.error('Error procesando ticket:', e.message);
        errores++;
      }
    }

    // Registrar sync exitosa en log
    await sb.from('medilink_sync_log').insert({
      tipo: 'whaticket_polling',
      estado: 'ok',
      detalle: { tickets_revisados: tickets.length, creados, duplicados, errores },
      pacientes_sync: creados,
      errores
    });

    const resultado = { ok: true, tickets_revisados: tickets.length, creados, duplicados, errores };
    console.log('Sync completada:', resultado);
    return res.status(200).json(resultado);

  } catch (e) {
    console.error('Error en sync:', e);
    await sb.from('medilink_sync_log').insert({
      tipo: 'whaticket_polling',
      estado: 'error',
      detalle: { error: e.message },
      pacientes_sync: 0,
      errores: 1
    });
    return res.status(500).json({ error: e.message });
  }
};
