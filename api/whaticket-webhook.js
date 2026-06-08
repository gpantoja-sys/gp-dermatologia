// api/whaticket-webhook.js
// Vercel Serverless Function
// Recibe webhooks de Whaticket cuando llega una conversación nueva
// y crea automáticamente el lead en Supabase CRM

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pcnhremtmY2N0ZGlndnVhcHVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDY5MTUsImV4cCI6MjA5NTEyMjkxNX0.iGTkHTRgdsEDoUsvS9ApQtSRAJV52z-_IASlFBmPqDM';

// Mapeo de userId de Whaticket a nombre de secretaria en el CRM
// Actualizar con los IDs reales del equipo en Whaticket
const AGENTES = {
  // 'whaticket_user_id': 'nombre_en_crm'
  // Ejemplo: '12': 'Caro', '15': 'Paz', '18': 'Valentina'
  // Se completa con los IDs reales de Equipo en Whaticket
};

function nombreAgente(userId) {
  if (!userId) return 'Sin asignar';
  return AGENTES[String(userId)] || 'Sin asignar';
}

function formatTel(numero) {
  if (!numero) return null;
  const n = String(numero).replace(/\D/g, '');
  // Whaticket envía el número sin +, ej: 56912345678
  if (n.startsWith('56') && n.length === 11) {
    return `+${n.slice(0,2)} ${n.slice(2,3)} ${n.slice(3,7)} ${n.slice(7)}`;
  }
  return `+${n}`;
}

module.exports = async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const payload = req.body;
    console.log('Webhook Whaticket recibido:', JSON.stringify(payload));

    // Ignorar mensajes salientes (fromMe: true)
    if (payload.fromMe === true) {
      return res.status(200).json({ ok: true, skipped: 'mensaje saliente' });
    }

    // Solo procesar tickets nuevos o pendientes
    const ticketStatus = payload.ticketdata?.status;
    if (ticketStatus && ticketStatus !== 'pending' && ticketStatus !== 'open') {
      return res.status(200).json({ ok: true, skipped: `estado ${ticketStatus}` });
    }

    // Extraer datos del contacto
    const nombre    = payload.name || payload.ticketdata?.contact?.name || 'Sin nombre';
    const telefono  = formatTel(payload.sender || payload.ticketdata?.contact?.number);
    const userId    = payload.ticketdata?.userid;
    const agente    = nombreAgente(userId);
    const ticketId  = payload.ticketdata?.id || payload.chamadoid;

    if (!telefono) {
      console.warn('Webhook sin teléfono, ignorando');
      return res.status(200).json({ ok: true, skipped: 'sin teléfono' });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Verificar si el paciente ya existe por teléfono
    const telLimpio = telefono.replace(/\D/g, '');
    const { data: pacExistente } = await sb
      .from('pacientes')
      .select('id, nombre, tel')
      .or(`tel.ilike.%${telLimpio.slice(-9)}%`)
      .maybeSingle();

    let pacienteId;

    if (pacExistente) {
      // Paciente ya existe — verificar si ya tiene pipeline activo
      pacienteId = pacExistente.id;
      console.log('Paciente existente encontrado:', pacExistente.id);

      const { data: pipeActivo } = await sb
        .from('pipeline_registros')
        .select('id')
        .eq('paciente_id', pacienteId)
        .eq('activo', true)
        .maybeSingle();

      if (pipeActivo) {
        // Ya tiene pipeline activo — no crear duplicado
        console.log('Pipeline activo existente, no se crea duplicado');
        return res.status(200).json({ 
          ok: true, 
          skipped: 'paciente con pipeline activo',
          paciente_id: pacienteId
        });
      }
    } else {
      // Crear paciente nuevo
      const nombreParts = nombre.trim().split(' ');
      const primerNombre = nombreParts[0] || nombre;
      const apellido = nombreParts.slice(1).join(' ') || '';

      const { data: nuevoPac, error: errPac } = await sb
        .from('pacientes')
        .insert({
          nombre: primerNombre,
          apellido: apellido,
          tel: telefono,
          origen: 'WhatsApp',
          tipo_paciente: 'Lead',
          pais: '+56'
        })
        .select('id')
        .single();

      if (errPac) {
        console.error('Error creando paciente:', errPac);
        return res.status(500).json({ error: errPac.message });
      }

      pacienteId = nuevoPac.id;
      console.log('Nuevo paciente creado:', pacienteId);
    }

    // Obtener estado inicial "Nuevo lead" del Pipeline 1
    const { data: estadoInicial } = await sb
      .from('estados')
      .select('id')
      .eq('pipeline_id', 1)
      .eq('nombre', 'Nuevo lead')
      .single();

    // Crear registro en pipeline
    const { data: pipeline, error: errPipe } = await sb
      .from('pipeline_registros')
      .insert({
        paciente_id: pacienteId,
        pipeline_id: 1,
        estado_id: estadoInicial?.id || null,
        proxima_accion: 'Responder consulta WhatsApp',
        fecha_seguimiento: new Date().toISOString().split('T')[0],
        activo: true,
        notas: ticketId ? `Ticket Whaticket #${ticketId}` : null
      })
      .select('id')
      .single();

    if (errPipe) {
      console.error('Error creando pipeline:', errPipe);
      return res.status(500).json({ error: errPipe.message });
    }

    console.log('Lead creado exitosamente:', pipeline.id);
    return res.status(200).json({ 
      ok: true, 
      lead_creado: true,
      pipeline_id: pipeline.id,
      paciente_id: pacienteId,
      nombre,
      telefono,
      agente
    });

  } catch (err) {
    console.error('Error en webhook:', err);
    // Siempre responder 200 a Whaticket para no interrumpir la conexión
    return res.status(200).json({ ok: false, error: err.message });
  }
};
