// ============================================================
// api/medilink-sync.js — GP Dermatología
// Sincronización Medilink → Supabase CRM
// Cron: cada 15 minutos (vercel.json)
// ============================================================

import { createClient } from '@supabase/supabase-js';

const MEDILINK_BASE  = 'https://api.medilink.healthatom.com/api/v1';
const MEDILINK_TOKEN = process.env.MEDILINK_TOKEN;
const SUPABASE_URL   = process.env.NEXT_PUBLIC_SUPABASE_URL   || 'https://nirxkzkfcctdigvuapuc.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY  || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ──────────────────────────────────────────────────
async function medilink(endpoint, params = {}) {
  const url = new URL(`${MEDILINK_BASE}/${endpoint}`);
  if (Object.keys(params).length) {
    url.searchParams.set('q', JSON.stringify(params));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Token ${MEDILINK_TOKEN}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Medilink ${endpoint} → ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return json.data || [];
}

function log(msg) {
  console.log(`[medilink-sync] ${new Date().toISOString()} — ${msg}`);
}

// ── MÓDULO 1: Sincronizar datos demográficos de pacientes ────
// Busca pacientes en el CRM que tengan RUT pero les falten
// datos (sexo, comuna, dirección, email) y los completa desde Medilink.
async function syncDatosPacientes() {
  log('Iniciando sync datos demográficos...');

  // Obtener pacientes del CRM que tienen RUT pero faltan datos
  const { data: pacientesCRM, error } = await sb
    .from('pacientes')
    .select('id, rut, sexo, comuna, direccion, email')
    .not('rut', 'is', null)
    .limit(50000);

  if (error) throw new Error(`Supabase pacientes: ${error.message}`);

  const incompletos = (pacientesCRM || []).filter(p =>
    !p.sexo || !p.comuna || !p.direccion || !p.email
  );

  log(`Pacientes con datos incompletos: ${incompletos.length}`);
  let actualizados = 0;

  for (const paciente of incompletos) {
    try {
      // Buscar en Medilink por RUT
      const rutLimpio = paciente.rut.replace(/\./g, '').replace('-', '').toLowerCase();
      const resultados = await medilink('pacientes', {
        numero_documento: { eq: paciente.rut }
      });

      if (!resultados || resultados.length === 0) continue;

      const p = resultados[0];
      const update = {};

      if (!paciente.sexo      && p.sexo)      update.sexo      = p.sexo;
      if (!paciente.comuna    && p.comuna)     update.comuna    = p.comuna;
      if (!paciente.direccion && p.direccion)  update.direccion = p.direccion;
      if (!paciente.email     && p.email)      update.email     = p.email;

      // Guardar id_medilink para cruces futuros
      if (p.id) update.id_medilink = String(p.id);

      if (Object.keys(update).length > 0) {
        const { error: upErr } = await sb
          .from('pacientes')
          .update(update)
          .eq('id', paciente.id);
        if (!upErr) actualizados++;
      }

      // Pequeña pausa para no saturar la API (20 req/min)
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      log(`Error paciente ${paciente.id}: ${e.message}`);
    }
  }

  log(`Datos demográficos actualizados: ${actualizados}`);
  return actualizados;
}

// ── MÓDULO 2: Sincronizar citas recientes de Medilink ────────
// Consulta citas actualizadas en las últimas 2 horas y
// actualiza el estado del lead correspondiente en el CRM.
async function syncCitas() {
  log('Iniciando sync citas...');

  // Calcular ventana de tiempo: últimas 2 horas
  const desde = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const desdeStr = desde.toISOString().replace('T', ' ').substring(0, 19);

  let citas = [];
  try {
    citas = await medilink('citas', {
      fecha_actualizacion: { gte: desdeStr }
    });
  } catch (e) {
    log(`Error obteniendo citas: ${e.message}`);
    return 0;
  }

  log(`Citas actualizadas en Medilink: ${citas.length}`);

  // Mapeo de estados Medilink → estados CRM
  const ESTADO_MAP = {
    'Confirmado':     'Confirmado',
    'No confirmado':  'Agendado',
    'Atendido':       'Asistió',
    'Anulado':        null,   // null = no cambiar estado CRM automáticamente
    'En espera':      'Confirmado',
    'Ausente':        null,
  };

  let actualizados = 0;

  for (const cita of citas) {
    try {
      if (!cita.id_paciente) continue;

      // Buscar paciente en CRM por id_medilink o por RUT
      const { data: pacientes } = await sb
        .from('pacientes')
        .select('id')
        .eq('id_medilink', String(cita.id_paciente))
        .limit(1);

      if (!pacientes || pacientes.length === 0) continue;
      const pacienteId = pacientes[0].id;

      // Buscar registro activo en pipeline
      const { data: registros } = await sb
        .from('pipeline_registros')
        .select('id, estados(nombre)')
        .eq('paciente_id', pacienteId)
        .eq('activo', true)
        .limit(1);

      if (!registros || registros.length === 0) continue;
      const registro = registros[0];

      const nuevoEstadoNombre = ESTADO_MAP[cita.estado_cita];
      if (!nuevoEstadoNombre) continue;

      // Obtener id del nuevo estado
      const { data: estados } = await sb
        .from('estados')
        .select('id')
        .eq('nombre', nuevoEstadoNombre)
        .limit(1);

      if (!estados || estados.length === 0) continue;

      // Actualizar estado del lead
      const { error: upErr } = await sb
        .from('pipeline_registros')
        .update({
          estado_id: estados[0].id,
          updated_at: new Date().toISOString()
        })
        .eq('id', registro.id);

      if (!upErr) {
        // Registrar en historial
        await sb.from('historial_estados').insert({
          pipeline_registro_id: registro.id,
          estado_id: estados[0].id,
          nota: `Sincronizado desde Medilink — cita ${cita.id} (${cita.estado_cita})`,
          created_at: new Date().toISOString()
        });
        actualizados++;
      }

      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      log(`Error cita ${cita.id}: ${e.message}`);
    }
  }

  log(`Estados actualizados desde citas: ${actualizados}`);
  return actualizados;
}

// ── MÓDULO 3: Sincronizar atenciones (ticket acumulado) ──────
// Consulta atenciones recientes en Medilink y actualiza el
// ticket acumulado de los pacientes en el CRM.
async function syncAtenciones() {
  log('Iniciando sync atenciones (ticket)...');

  // Atenciones de los últimos 7 días
  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const desdeStr = desde.toISOString().substring(0, 10);

  let atenciones = [];
  try {
    atenciones = await medilink('atenciones', {
      fecha: { gte: desdeStr },
      finalizado: { eq: 1 }
    });
  } catch (e) {
    log(`Error obteniendo atenciones: ${e.message}`);
    return 0;
  }

  log(`Atenciones finalizadas recientes: ${atenciones.length}`);
  let actualizados = 0;

  // Agrupar por paciente y sumar totales
  const totalPorPaciente = {};
  for (const atencion of atenciones) {
    if (!atencion.id_paciente || !atencion.total_realizado) continue;
    const idM = String(atencion.id_paciente);
    totalPorPaciente[idM] = (totalPorPaciente[idM] || 0) + atencion.total_realizado;
  }

  for (const [idMedilink, totalNuevo] of Object.entries(totalPorPaciente)) {
    try {
      // Buscar paciente en CRM
      const { data: pacientes } = await sb
        .from('pacientes')
        .select('id, ticket_acumulado')
        .eq('id_medilink', idMedilink)
        .limit(1);

      if (!pacientes || pacientes.length === 0) continue;

      const paciente = pacientes[0];
      const ticketActual = paciente.ticket_acumulado || 0;

      // Solo actualizar si el nuevo total es mayor (evitar sobrescribir con datos viejos)
      if (totalNuevo <= ticketActual) continue;

      const { error: upErr } = await sb
        .from('pacientes')
        .update({
          ticket_acumulado: totalNuevo,
          // Si supera umbral Blueprint, marcar candidato
          candidato_blueprint: totalNuevo >= 4000000 ? true : undefined
        })
        .eq('id', paciente.id);

      if (!upErr) {
        actualizados++;
        log(`Ticket actualizado — paciente ${paciente.id}: $${ticketActual.toLocaleString()} → $${totalNuevo.toLocaleString()}`);
      }

      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      log(`Error atencion paciente ${idMedilink}: ${e.message}`);
    }
  }

  log(`Tickets actualizados: ${actualizados}`);
  return actualizados;
}

// ── HANDLER PRINCIPAL ────────────────────────────────────────
export default async function handler(req, res) {
  // Seguridad: solo Vercel Cron o request con header correcto
  const authHeader = req.headers.authorization;
  const cronHeader = req.headers['x-vercel-cron'];

  if (!cronHeader && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!MEDILINK_TOKEN) {
    return res.status(500).json({ error: 'MEDILINK_TOKEN no configurado' });
  }

  const inicio = Date.now();
  log('=== Inicio sincronización Medilink ===');

  const resultados = {
    demograficos: 0,
    citas: 0,
    atenciones: 0,
    errores: []
  };

  try {
    resultados.demograficos = await syncDatosPacientes();
  } catch (e) {
    log(`Error en syncDatosPacientes: ${e.message}`);
    resultados.errores.push(`demograficos: ${e.message}`);
  }

  try {
    resultados.citas = await syncCitas();
  } catch (e) {
    log(`Error en syncCitas: ${e.message}`);
    resultados.errores.push(`citas: ${e.message}`);
  }

  try {
    resultados.atenciones = await syncAtenciones();
  } catch (e) {
    log(`Error en syncAtenciones: ${e.message}`);
    resultados.errores.push(`atenciones: ${e.message}`);
  }

  const duracion = ((Date.now() - inicio) / 1000).toFixed(1);
  log(`=== Sync completado en ${duracion}s ===`);
  log(`Resultados: demográficos=${resultados.demograficos}, citas=${resultados.citas}, atenciones=${resultados.atenciones}`);

  return res.status(200).json({
    ok: true,
    duracion_segundos: parseFloat(duracion),
    ...resultados,
    timestamp: new Date().toISOString()
  });
}
