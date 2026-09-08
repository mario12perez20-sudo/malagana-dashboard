// ============================================================
// MALAGANA ROOFTOP — Configuración de Triggers
// ============================================================
// Corre configurarTriggers() UNA SOLA VEZ desde Apps Script.
// Elimina todos los triggers existentes y crea nuevos cada 2h.
// ============================================================

// ------------------------------------------------------------
// BARRIDO HISTÓRICO AUTOMÁTICO
// Corre iniciarBarridoHistorico() UNA SOLA VEZ.
// Crea un trigger cada 2 minutos que corre los lotes solo.
// Cuando termina, se autodestruye y corre registrarFacturasEnSheet().
// ------------------------------------------------------------
function iniciarBarridoHistorico() {
  // Limpiar offset anterior por si quedó algo
  PropertiesService.getScriptProperties().deleteProperty('lote_offset');

  // Crear trigger cada 2 minutos
  ScriptApp.newTrigger('loteBarridoHistorico')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('✅ Trigger de barrido iniciado — corre solo cada 2 min hasta terminar.');
}

function loteBarridoHistorico() {
  var props  = PropertiesService.getScriptProperties();
  var offset = parseInt(props.getProperty('lote_offset') || '0');

  // Verificar si ya terminó
  var threads = GmailApp.search('has:attachment after:2026/01/01', offset, 1);
  if (threads.length === 0) {
    // Eliminar este trigger
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'loteBarridoHistorico') ScriptApp.deleteTrigger(t);
    });
    props.deleteProperty('lote_offset');
    Logger.log('✅ Barrido histórico completo — trigger eliminado.');

    // Registrar todo en el Sheet automáticamente
    registrarFacturasEnSheet();
    return;
  }

  // Correr el lote
  reprocesarDesde1Enero();
  Logger.log('Progreso: ' + props.getProperty('lote_offset') + ' correos procesados.');
}

function configurarTriggers() {
  // Eliminar todos los triggers existentes
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 1. Descargar facturas de Gmail a Drive — cada 2 horas
  ScriptApp.newTrigger('procesarFacturas')
    .timeBased()
    .everyHours(2)
    .create();

  // 2. Parsear XMLs y escribir al Sheet — cada 2 horas
  ScriptApp.newTrigger('registrarFacturasEnSheet')
    .timeBased()
    .everyHours(2)
    .create();

  // 3. Auditoría Drive vs Sheet — cada 2 horas (alerta si hay faltantes)
  ScriptApp.newTrigger('auditarXMLsVsSheet')
    .timeBased()
    .everyHours(2)
    .create();

  // 4. Refresco de Ventas/Consumo_Teorico/Costo_Diario — una vez al día
  ScriptApp.newTrigger('refrescoDiarioAutomatico')
    .timeBased()
    .atHour(5)
    .everyDays(1)
    .inTimezone('America/Bogota')
    .create();

  Logger.log('✅ Triggers configurados:');
  ScriptApp.getProjectTriggers().forEach(t => {
    Logger.log('  → ' + t.getHandlerFunction());
  });
}

// ------------------------------------------------------------
// Agregado 2026-09-07 — versión chica que SOLO agrega el trigger
// de refresco de Ventas (refrescoDiarioAutomatico, en loggro_sync.gs)
// sin tocar los 3 triggers de Facturas que ya están corriendo desde
// julio. Usar esta en vez de configurarTriggers() para no arriesgar
// los triggers existentes — configurarTriggers() BORRA TODOS los
// triggers antes de recrearlos, así que solo debería volver a
// correrse si hace falta reconfigurar todo desde cero.
// Corré esta UNA SOLA VEZ.
// ------------------------------------------------------------
function configurarTriggerLoggro() {
  var yaExiste = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'refrescoDiarioAutomatico';
  });
  if (yaExiste) {
    Logger.log('Ya existe un trigger para refrescoDiarioAutomatico — no se creó otro.');
    return;
  }

  ScriptApp.newTrigger('refrescoDiarioAutomatico')
    .timeBased()
    .atHour(5)
    .everyDays(1)
    .inTimezone('America/Bogota')
    .create();

  Logger.log('✅ Trigger creado: refrescoDiarioAutomatico todos los días ~5am (hora Bogotá).');
}
