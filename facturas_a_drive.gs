// ============================================================
// MALAGANA ROOFTOP — Facturas automáticas a Google Drive
// Descomprime ZIPs, separa PDF y XML, omite correos de Bold
// Estructura: Automatización Facturas Malagana / 2026 / Junio / PDF|XML
// ============================================================

var CARPETA_RAIZ = 'Automatización Facturas Malagana';
var ETIQUETA = 'factura-procesada';

// Remitentes a ignorar (no son facturas de proveedor)
var REMITENTES_EXCLUIDOS = [
  'soporte@bold.co',
  'no-responder@bold.co',
  'notificaciones@boldcf.co',
  'no-reply@bold.co'
];

// ------------------------------------------------------------
// FUNCIÓN PRINCIPAL — corre automáticamente cada 2 horas
// ------------------------------------------------------------
function procesarFacturas() {
  var label = obtenerOCrearEtiqueta(ETIQUETA);
  var threads = GmailApp.search('has:attachment -label:' + ETIQUETA + ' newer_than:60d');

  if (threads.length === 0) {
    Logger.log('No hay facturas nuevas para procesar.');
    return;
  }

  Logger.log('Correos encontrados: ' + threads.length);

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var tieneFactura = false;

    messages.forEach(function(msg) {
      if (esRemitenteExcluido(msg.getFrom())) {
        Logger.log('Omitido (remitente excluido): ' + msg.getFrom());
        return;
      }

      var adjuntos = msg.getAttachments();
      if (adjuntos.length === 0) return;

      var fecha = msg.getDate();
      var año   = fecha.getFullYear().toString();
      var mes   = obtenerNombreMes(fecha.getMonth());

      var carpetaPDF = obtenerOCrearCarpeta(CARPETA_RAIZ + '/' + año + '/' + mes + '/PDF');
      var carpetaXML = obtenerOCrearCarpeta(CARPETA_RAIZ + '/' + año + '/' + mes + '/XML');

      adjuntos.forEach(function(att) {
        var tipo   = att.getContentType();
        var nombre = att.getName().toLowerCase();

        if (tipo === 'application/zip' || nombre.endsWith('.zip')) {
          procesarZip(att, carpetaPDF, carpetaXML);
          tieneFactura = true;
        } else if (tipo === 'application/pdf' || nombre.endsWith('.pdf')) {
          subirSiNoExiste(att, carpetaPDF);
          tieneFactura = true;
        } else if (tipo === 'application/xml' || tipo === 'text/xml' || nombre.endsWith('.xml')) {
          subirSiNoExiste(att, carpetaXML);
          tieneFactura = true;
        }
      });
    });

    // Solo etiquetar si realmente contenía una factura válida
    if (tieneFactura) {
      thread.addLabel(label);
      Logger.log('Etiquetado: ' + thread.getFirstMessageSubject());
    }
  });

  Logger.log('Procesamiento completado.');
}

// ------------------------------------------------------------
// REPROCESAR DESDE 1 DE ENERO — en lotes de 40 correos
// Guarda el progreso automáticamente. Corre varias veces hasta
// que el log diga "✅ Barrido histórico completo".
// Luego corre registrarFacturasEnSheet() en registrar_facturas_sheets.gs
// ------------------------------------------------------------
function reprocesarDesde1Enero() {
  var props      = PropertiesService.getScriptProperties();
  var inicio     = parseInt(props.getProperty('lote_offset') || '0');
  var LOTE       = 40;
  var label      = obtenerOCrearEtiqueta(ETIQUETA);

  var threads = GmailApp.search('has:attachment after:2026/01/01', inicio, LOTE);

  Logger.log('Lote desde ' + inicio + ' — correos en este lote: ' + threads.length);

  if (threads.length === 0) {
    props.deleteProperty('lote_offset');
    Logger.log('✅ Barrido histórico completo. Ahora corre registrarFacturasEnSheet().');
    return;
  }

  var totalSubidos = 0;

  threads.forEach(function(thread) {
    var messages     = thread.getMessages();
    var tieneFactura = false;

    messages.forEach(function(msg) {
      if (esRemitenteExcluido(msg.getFrom())) return;

      var adjuntos = msg.getAttachments();
      if (adjuntos.length === 0) return;

      var fecha = msg.getDate();
      var año   = fecha.getFullYear().toString();
      var mes   = obtenerNombreMes(fecha.getMonth());

      var carpetaPDF = obtenerOCrearCarpeta(CARPETA_RAIZ + '/' + año + '/' + mes + '/PDF');
      var carpetaXML = obtenerOCrearCarpeta(CARPETA_RAIZ + '/' + año + '/' + mes + '/XML');

      adjuntos.forEach(function(att) {
        var tipo   = att.getContentType();
        var nombre = att.getName().toLowerCase();

        if (tipo === 'application/zip' || nombre.endsWith('.zip')) {
          procesarZip(att, carpetaPDF, carpetaXML);
          tieneFactura = true; totalSubidos++;
        } else if (tipo === 'application/pdf' || nombre.endsWith('.pdf')) {
          subirSiNoExiste(att, carpetaPDF);
          tieneFactura = true; totalSubidos++;
        } else if (tipo === 'application/xml' || tipo === 'text/xml' || nombre.endsWith('.xml')) {
          subirSiNoExiste(att, carpetaXML);
          tieneFactura = true; totalSubidos++;
        }
      });
    });

    if (tieneFactura) thread.addLabel(label);
  });

  // Guardar progreso para el próximo lote
  props.setProperty('lote_offset', String(inicio + threads.length));
  Logger.log('Lote OK — ' + totalSubidos + ' archivos subidos. Progreso: ' + (inicio + threads.length) + ' correos procesados.');
  Logger.log('▶ Vuelve a correr reprocesarDesde1Enero() para el siguiente lote.');
}

// ------------------------------------------------------------
// REPROCESAR ÚLTIMOS N DÍAS (ejecución manual de recuperación)
// Corrige el bug: solo etiqueta si tiene factura y excluye Bold
// ------------------------------------------------------------
function procesarUltimos10Dias() {
  var label   = obtenerOCrearEtiqueta(ETIQUETA);
  var threads = GmailApp.search('has:attachment newer_than:10d');

  Logger.log('Correos con adjuntos (últimos 10 días): ' + threads.length);

  threads.forEach(function(thread) {
    var messages     = thread.getMessages();
    var tieneFactura = false;

    messages.forEach(function(msg) {
      if (esRemitenteExcluido(msg.getFrom())) {
        Logger.log('Omitido (remitente excluido): ' + msg.getFrom());
        return;
      }

      var adjuntos = msg.getAttachments();
      if (adjuntos.length === 0) return;

      var fecha = msg.getDate();
      var año   = fecha.getFullYear().toString();
      var mes   = obtenerNombreMes(fecha.getMonth());

      var carpetaPDF = obtenerOCrearCarpeta(CARPETA_RAIZ + '/' + año + '/' + mes + '/PDF');
      var carpetaXML = obtenerOCrearCarpeta(CARPETA_RAIZ + '/' + año + '/' + mes + '/XML');

      adjuntos.forEach(function(att) {
        var tipo   = att.getContentType();
        var nombre = att.getName().toLowerCase();

        if (tipo === 'application/zip' || nombre.endsWith('.zip')) {
          procesarZip(att, carpetaPDF, carpetaXML);
          tieneFactura = true;
        } else if (tipo === 'application/pdf' || nombre.endsWith('.pdf')) {
          subirSiNoExiste(att, carpetaPDF);
          tieneFactura = true;
        } else if (tipo === 'application/xml' || tipo === 'text/xml' || nombre.endsWith('.xml')) {
          subirSiNoExiste(att, carpetaXML);
          tieneFactura = true;
        }
      });
    });

    // Solo etiquetar si realmente contenía una factura válida
    if (tieneFactura) {
      thread.addLabel(label);
      Logger.log('Etiquetado: ' + thread.getFirstMessageSubject());
    }
  });

  Logger.log('Listo. Revisa Drive en: ' + CARPETA_RAIZ);
}

// ------------------------------------------------------------
// UTILIDADES
// ------------------------------------------------------------
function procesarZip(att, carpetaPDF, carpetaXML) {
  try {
    var blob     = att.copyBlob();
    var archivos = Utilities.unzip(blob);

    archivos.forEach(function(archivo) {
      var nombreArchivo = archivo.getName().toLowerCase();

      if (nombreArchivo.endsWith('.pdf')) {
        subirBlobSiNoExiste(archivo, carpetaPDF);
        Logger.log('PDF extraído del ZIP: ' + archivo.getName());
      } else if (nombreArchivo.endsWith('.xml')) {
        subirBlobSiNoExiste(archivo, carpetaXML);
        Logger.log('XML extraído del ZIP: ' + archivo.getName());
      }
    });
  } catch(e) {
    Logger.log('Error al descomprimir ZIP: ' + e.message);
  }
}

function subirSiNoExiste(att, carpeta) {
  var nombre     = att.getName();
  var existentes = carpeta.getFilesByName(nombre);
  if (!existentes.hasNext()) {
    carpeta.createFile(att);
    Logger.log('Subido: ' + nombre);
  } else {
    Logger.log('Ya existe, omitido: ' + nombre);
  }
}

function subirBlobSiNoExiste(blob, carpeta) {
  var nombre     = blob.getName();
  var existentes = carpeta.getFilesByName(nombre);
  if (!existentes.hasNext()) {
    carpeta.createFile(blob);
    Logger.log('Subido: ' + nombre);
  } else {
    Logger.log('Ya existe, omitido: ' + nombre);
  }
}

function esRemitenteExcluido(from) {
  var fromLower = from.toLowerCase();
  return REMITENTES_EXCLUIDOS.some(function(excluido) {
    return fromLower.indexOf(excluido) !== -1;
  });
}

function obtenerOCrearCarpeta(ruta) {
  var partes  = ruta.split('/');
  var carpeta = DriveApp.getRootFolder();

  partes.forEach(function(parte) {
    var subcarpetas = carpeta.getFoldersByName(parte);
    if (subcarpetas.hasNext()) {
      carpeta = subcarpetas.next();
    } else {
      carpeta = carpeta.createFolder(parte);
      Logger.log('Carpeta creada: ' + parte);
    }
  });

  return carpeta;
}

function obtenerOCrearEtiqueta(nombre) {
  var label = GmailApp.getUserLabelByName(nombre);
  if (!label) {
    label = GmailApp.createLabel(nombre);
    Logger.log('Etiqueta creada: ' + nombre);
  }
  return label;
}

function obtenerNombreMes(indice) {
  var meses = [
    'Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
  ];
  return meses[indice];
}
