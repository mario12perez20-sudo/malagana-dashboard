// ============================================================
// MALAGANA ROOFTOP — Registro de Facturas en Google Sheets
// Estructura: Detalle | Facturas | Por_Producto | Categorias
// ============================================================

const SHEET_ID = '';
const DRIVE_BASE_FOLDER = 'Automatización Facturas Malagana';
const ALERTA_EMAIL = 'malaganarooftop@gmail.com';

const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';

const UNIDADES = {
  'NIU':'UND','94':'UND','EA':'UND','C62':'UND',
  'KGM':'KG','GRM':'GR','TNE':'TON',
  'LTR':'LT','MLT':'ML',
  'MTR':'MT','CMT':'CM','MMT':'MM',
  'MTK':'M²','MTQ':'M³',
  'HUR':'HORA','DAY':'DÍA','MON':'MES',
  'BX':'CAJA','BO':'BOLSA','PK':'PAQUETE','SET':'KIT'
};

// ============================================================
// CLASIFICACIÓN AUTOMÁTICA POR PALABRAS CLAVE
// Usa términos específicos para evitar falsos positivos.
// Lo que no coincide → "Sin clasificar" para revisión manual.
// ============================================================
const REGLAS_CLASIFICACION = [
  {
    cat: 'Bebidas',
    keys: [
      'AGUARDIENTE','VODKA','WHISKY','WHISKEY','TEQUILA','MEZCAL',
      'CHAMPAÑA','CHAMPAGNE','PROSECCO','BRANDY','COGNAC','BRANDY',
      'BAILEYS','AMARETTO','KAHLUA','TRIPLE SEC','LICOR DE',
      'CERVEZA','HEINEKEN','PILSEN','COSTEÑA','CLUB COLOMBIA','MILLER','CORONA EXTRA',
      'COCA-COLA','COCA COLA','PEPSI','SPRITE','SEVEN UP','7UP','GINGER ALE',
      'RED BULL','MONSTER ENERGY','VIVE 100',
      'AGUA CRISTAL','AGUA MANANTIAL','AGUA CON GAS',
      'GASEOSA','LIMONADA','SODA ITALIANA','JUGO NATURAL','NECTAR',
      'VINO TINTO','VINO BLANCO','VINO ROSADO'
    ]
  },
  {
    cat: 'Alimentos',
    keys: [
      'LOMO DE RES','FILETE DE RES','COSTILLA DE RES','CARNE DE RES','SOBREBARRIGA',
      'PECHUGA DE POLLO','MUSLO DE POLLO','POLLO ENTERO','PECHUGA',
      'CERDO','LOMO DE CERDO','COSTILLA DE CERDO','PERNIL',
      'CHORIZO','JAMON','MORTADELA','SALCHICHA','TOCINO','BACON','CHICHARRON',
      'SALMON','ATUN','CAMARON','LANGOSTINO','TILAPIA','BAGRE','MOJARRA',
      'TOMATE','CEBOLLA CABEZONA','CEBOLLA LARGA','AJO','PAPA','YUCA',
      'PLATANO','ZANAHORIA','PIMENTON','LECHUGA','CILANTRO','PEREJIL',
      'ALBAHACA','ESPINACA','BROCOLI','COLIFLOR','APIO',
      'AGUACATE','LIMON TAHITI','NARANJA','MANGO','MARACUYA','PIÑA','BANANO',
      'ARROZ','PASTA','HARINA','AZUCAR','PANELA','ACEITE','MANTEQUILLA',
      'QUESO','HUEVO','LECHE','CREMA DE LECHE','YOGURT','SUERO',
      'MAYONESA','MOSTAZA','KETCHUP','SALSA BBQ','SALSA NEGRA',
      'PIMIENTA','COMINO','OREGANO','TOMILLO','LAUREL','CURCUMA',
      'FRIJOL','LENTEJA','GARBANZO','MAIZ','AVENA','QUINUA',
      'PAN','TORTILLA','AREPA','WRAP'
    ]
  },
  {
    cat: 'Operativos',
    keys: [
      'DETERGENTE','DESINFECTANTE','JABON LAVAPLATOS','JABÓN LAVAPLATOS',
      'HIPOCLORITO','CLORO','ALCOHOL ANTISEPTICO','ALCOHOL GEL',
      'ESCOBA','TRAPERO','RECOGEDOR','ESTROPAJO','ESPONJA',
      'BOLSA NEGRA','BOLSA BASURA','BOLSA PLASTICA',
      'SERVILLETA','PITILLO','SORBETE','PALILLO','MONDADIENTES',
      'VASO DESECHABLE','PLATO DESECHABLE','CUCHARA DESECHABLE',
      'GUANTE','TAPABOCAS','COFIA','DELANTAL',
      'LIMPIADOR MULTIUSOS','BAYETILLA','PAÑO ABSORBENTE',
      'CARBON VEGETAL','GAS PROPANO','PAPEL ALUMINIO','PAPEL FILM',
      'CAJA DE CARTON','EMPAQUE','EMBALAJE'
    ]
  },
  {
    cat: 'Activos',
    keys: [
      'TELEVISION','TELEVISOR','PANTALLA LED','MONITOR',
      'NEVERA','REFRIGERADOR','CONGELADOR','ENFRIADOR',
      'COMPUTADOR','COMPUTADORA','LAPTOP','TABLET',
      'DATAFONO','DATAFONO','IMPRESORA','CAJA REGISTRADORA',
      'SILLA ERGONOMICA','MESA DE TRABAJO','MUEBLE',
      'LUMINARIA','LAMPARA','LÁMPARA','BOMBILLO LED',
      'DECORACION','CUADRO','PLANTA ARTIFICIAL'
    ]
  }
];

function clasificarProducto(nombre) {
  const n = nombre.toUpperCase();
  for (const { cat, keys } of REGLAS_CLASIFICACION) {
    if (keys.some(k => n.includes(k))) return cat;
  }
  return 'Sin clasificar';
}

// ============================================================
// FUNCIÓN PRINCIPAL
// ============================================================
function registrarFacturasEnSheet() {
  const INICIO    = Date.now();
  const LIMITE_MS = 5 * 60 * 1000;

  const ss           = obtenerOCrearSpreadsheet();
  const hojaDetalle  = obtenerOCrearHoja(ss, 'Detalle');
  const hojaFacturas = obtenerOCrearHoja(ss, 'Facturas');
  const hojaCateg    = obtenerOCrearHoja(ss, 'Categorias');
  const hojaFallos   = obtenerOCrearHoja(ss, 'Fallos');

  inicializarEncabezadosDetalle(hojaDetalle);
  inicializarEncabezadosFacturas(hojaFacturas);
  inicializarEncabezadosCateg(hojaCateg);
  inicializarEncabezadosFallos(hojaFallos);

  const facturasRegistradas = obtenerFacturasRegistradas(hojaFacturas);
  const categMap            = obtenerCategoriasMap(hojaCateg);
  const fallosMap           = obtenerFallosRegistrados(hojaFallos);

  const carpetaBase = obtenerCarpetaPorNombre(DRIVE_BASE_FOLDER);
  if (!carpetaBase) { Logger.log('No se encontró: ' + DRIVE_BASE_FOLDER); return; }

  Logger.log('Ya registradas: ' + facturasRegistradas.size + ' | Fallos conocidos: ' + fallosMap.size);

  let filasDetalle   = [];
  let filasFacturas  = [];
  let nuevasCateg    = [];
  let nuevosFallos   = [];   // Primera vez que fallan → append a hoja
  let actualizFallos = [];   // Ya estaban en hoja → actualizar fila existente
  let resueltos      = [];   // Filas de Fallos que ahora sí funcionaron
  let nuevas         = 0;
  let saltados       = 0;    // Irresolvables ignorados
  let tiempoAgotado  = false;

  function escribirParcial() {
    if (filasDetalle.length > 0) {
      hojaDetalle.getRange(hojaDetalle.getLastRow() + 1, 1, filasDetalle.length, 11).setValues(filasDetalle);
      filasDetalle = [];
    }
    if (filasFacturas.length > 0) {
      hojaFacturas.getRange(hojaFacturas.getLastRow() + 1, 1, filasFacturas.length, 8).setValues(filasFacturas);
      filasFacturas = [];
    }
    if (nuevasCateg.length > 0) {
      hojaCateg.getRange(hojaCateg.getLastRow() + 1, 1, nuevasCateg.length, 2).setValues(nuevasCateg);
      nuevasCateg = [];
    }
    if (nuevosFallos.length > 0) {
      hojaFallos.getRange(hojaFallos.getLastRow() + 1, 1, nuevosFallos.length, 6).setValues(nuevosFallos);
      nuevosFallos = [];
    }
    // Actualizar filas existentes de Fallos (deberían ser pocos)
    actualizFallos.forEach(function(u) {
      const estado = u.intentos >= 3 ? 'Irresolvable' : 'Pendiente';
      hojaFallos.getRange(u.row, 1, 1, 6).setValues([[new Date(), u.nombre, u.url, u.error, u.intentos, estado]]);
    });
    actualizFallos = [];
    // Marcar como resueltos los que antes fallaban y ahora funcionaron
    resueltos.forEach(function(row) {
      hojaFallos.getRange(row, 6).setValue('Resuelto ✅');
    });
    resueltos = [];
  }

  function registrarFallo(nombre, url, error, falloExistente) {
    if (falloExistente) {
      const n = falloExistente.intentos + 1;
      falloExistente.intentos = n;
      actualizFallos.push({ row: falloExistente.row, nombre: nombre, url: url, error: error, intentos: n });
    } else {
      nuevosFallos.push([new Date(), nombre, url, error, 1, 'Pendiente']);
      // Reservar en el mapa para evitar duplicados en la misma corrida
      fallosMap.set(nombre, { row: -1, intentos: 1, estado: 'Pendiente' });
    }
  }

  function procesarArchivo(file) {
    try {
      if (!file.getName().toLowerCase().endsWith('.xml')) return;
      const nombre = file.getName();
      const fallo  = fallosMap.get(nombre);

      // Si ya tiene 3+ intentos fallidos, es irresolvable — saltar
      if (fallo && fallo.intentos >= 3) { saltados++; return; }

      const factura = parsearXMLFactura(file);
      if (!factura) {
        registrarFallo(nombre, file.getUrl(), 'No se pudo parsear (estructura XML no reconocida)', fallo);
        return;
      }

      // Si antes fallaba y ahora funciona, marcar resuelto
      if (fallo && fallo.row > 0) resueltos.push(fallo.row);

      if (facturasRegistradas.has(factura.numero)) return;

      factura.lineas.forEach(function(linea) {
        const prodKey = linea.descripcion.toUpperCase().trim();
        if (prodKey && !categMap.has(prodKey)) {
          const catAuto = clasificarProducto(prodKey);
          categMap.set(prodKey, catAuto);
          nuevasCateg.push([prodKey, catAuto]);
        }
        filasDetalle.push([
          factura.fecha, factura.numero, factura.proveedor, factura.nit,
          linea.descripcion, linea.cantidad, linea.unidad,
          linea.precioUnitario, linea.subtotal, linea.iva, linea.totalLinea
        ]);
      });

      filasFacturas.push([
        factura.fecha, factura.numero, factura.proveedor, factura.nit,
        factura.lineas.length, factura.subtotal, factura.iva, factura.total
      ]);

      facturasRegistradas.add(factura.numero);
      nuevas++;
      if (nuevas % 50 === 0) escribirParcial();

    } catch(e) {
      const nombre = file.getName();
      registrarFallo(nombre, file.getUrl(), e.message, fallosMap.get(nombre));
    }
  }

  outerLoop:
  {
    const añoIter = carpetaBase.getFolders();
    while (añoIter.hasNext()) {
      const añoFolder = añoIter.next();
      const mesIter   = añoFolder.getFolders();
      while (mesIter.hasNext()) {
        const mesFolder = mesIter.next();
        Logger.log('Procesando: ' + añoFolder.getName() + '/' + mesFolder.getName());
        const xmlFolderIter = mesFolder.getFoldersByName('XML');
        if (!xmlFolderIter.hasNext()) continue;
        const xmlFolder = xmlFolderIter.next();
        const archivos = xmlFolder.getFiles();
        while (archivos.hasNext()) {
          if (Date.now() - INICIO > LIMITE_MS) {
            escribirParcial();
            tiempoAgotado = true;
            Logger.log('⏱️ Tiempo límite — ' + nuevas + ' nuevas | ' + saltados + ' irresolvables saltadas. Volvé a correr.');
            break outerLoop;
          }
          procesarArchivo(archivos.next());
        }
      }
    }
  }

  escribirParcial();

  if (!tiempoAgotado) {
    reconstruirPorProducto(ss, hojaDetalle);
    Logger.log('✅ Completo — ' + nuevas + ' nuevas | ' + saltados + ' irresolvables saltadas.');
    Logger.log('Si hay fallos, revisá la hoja "Fallos" y corré reprocesarFallos().');
  } else {
    Logger.log('⚠️ Parcial (' + nuevas + ' nuevas esta corrida). Ejecutá de nuevo.');
  }
}

// ============================================================
// SETUP DE FILTROS — Agrega columna Categoría + filtro nativo
// Corre UNA SOLA VEZ después de poblarCategoriasDesdeDetalle()
// ============================================================
function configurarFiltrosSheet() {
  const ss          = obtenerOCrearSpreadsheet();
  const hojaDetalle = ss.getSheetByName('Detalle');
  if (!hojaDetalle) { Logger.log('No existe hoja Detalle.'); return; }

  const ultimaFila = hojaDetalle.getLastRow();
  if (ultimaFila < 1) { Logger.log('Detalle está vacía.'); return; }

  // ── Columna 12: Categoría con VLOOKUP desde hoja Categorias ──
  hojaDetalle.getRange(1, 12).setValue('Categoría');
  hojaDetalle.getRange(1, 12).setFontWeight('bold')
    .setBackground('#1a1a2e').setFontColor('#ffffff');

  if (ultimaFila > 1) {
    const formula = '=IFERROR(VLOOKUP(UPPER(E2),Categorias!$A:$B,2,FALSE),"Sin clasificar")';
    hojaDetalle.getRange(2, 12).setFormula(formula);
    if (ultimaFila > 2) {
      hojaDetalle.getRange(2, 12).copyTo(
        hojaDetalle.getRange(3, 12, ultimaFila - 2, 1)
      );
    }
  }

  hojaDetalle.setColumnWidth(12, 130);
  activarFiltroDetalle();

  Logger.log('✅ Columna Categoría y filtro configurados (' + (ultimaFila - 1) + ' filas).');
}

// ============================================================
// DROPDOWN en columna Categoría de la hoja Categorias
// Corre UNA SOLA VEZ — después cada celda tiene lista desplegable
// ============================================================
function configurarDropdownCategorias() {
  const ss        = obtenerOCrearSpreadsheet();
  const hojaCateg = ss.getSheetByName('Categorias');
  if (!hojaCateg) { Logger.log('No existe hoja Categorias.'); return; }

  const ultimaFila = Math.max(hojaCateg.getLastRow(), 2);

  const regla = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Alimentos', 'Bebidas', 'Operativos', 'Activos', 'Sin clasificar'], true)
    .setAllowInvalid(false)
    .setHelpText('Elige una categoría de la lista')
    .build();

  // Aplicar a toda la columna B desde fila 2 hacia abajo (1000 filas de margen)
  hojaCateg.getRange(2, 2, 1000, 1).setDataValidation(regla);

  Logger.log('✅ Dropdown configurado en columna Categoría (' + (ultimaFila - 1) + ' productos).');
}

// Función separada — si el filtro no aparece, corre solo esta
function activarFiltroDetalle() {
  const ss          = obtenerOCrearSpreadsheet();
  const hojaDetalle = ss.getSheetByName('Detalle');
  if (!hojaDetalle) { Logger.log('No existe hoja Detalle.'); return; }

  // Eliminar filtro existente si hay
  const filtroActual = hojaDetalle.getFilter();
  if (filtroActual) {
    filtroActual.remove();
    Logger.log('Filtro anterior eliminado.');
  }

  // Crear filtro sobre toda la data (fila 1 = encabezados)
  const rango = hojaDetalle.getDataRange();
  rango.createFilter();
  Logger.log('✅ Filtro activado — ' + rango.getNumColumns() + ' columnas, ' + rango.getNumRows() + ' filas.');
  Logger.log('Recarga el tab del Sheet si no ves los triángulos ▼.');
}

// ============================================================
// MIGRACIÓN — Poblar Categorias desde el Detalle existente
// Corre UNA SOLA VEZ cuando el Sheet ya tiene datos pero
// la hoja Categorias está vacía.
// ============================================================
function poblarCategoriasDesdeDetalle() {
  const ss          = obtenerOCrearSpreadsheet();
  const hojaDetalle = ss.getSheetByName('Detalle');
  const hojaCateg   = obtenerOCrearHoja(ss, 'Categorias');

  if (!hojaDetalle) { Logger.log('No existe hoja Detalle.'); return; }

  inicializarEncabezadosCateg(hojaCateg);
  const categMap    = obtenerCategoriasMap(hojaCateg); // lo que ya había
  const datos       = hojaDetalle.getDataRange().getValues();
  const nuevasCateg = [];

  // Col 4 (índice 4) = Producto / Descripción
  for (let i = 1; i < datos.length; i++) {
    const prod = String(datos[i][4] || '').trim().toUpperCase();
    if (!prod || categMap.has(prod)) continue;
    const cat = clasificarProducto(prod);
    categMap.set(prod, cat);
    nuevasCateg.push([prod, cat]);
  }

  if (nuevasCateg.length > 0) {
    const startRow = hojaCateg.getLastRow() + 1;
    hojaCateg.getRange(startRow, 1, nuevasCateg.length, 2).setValues(nuevasCateg);
    Logger.log('✅ Categorias pobladas: ' + nuevasCateg.length + ' productos únicos.');
  } else {
    Logger.log('ℹ️ Categorias ya estaba al día — nada nuevo que agregar.');
  }
}

// ============================================================
// AUDITORÍA — Drive vs Sheet (streaming — no pre-carga archivos)
// ============================================================
function auditarXMLsVsSheet() {
  const INICIO    = Date.now();
  const LIMITE_MS = 5 * 60 * 1000;

  const ss           = obtenerOCrearSpreadsheet();
  const hojaFacturas = ss.getSheetByName('Facturas');
  if (!hojaFacturas) { Logger.log('No existe hoja Facturas.'); return; }

  const registradas = obtenerFacturasRegistradas(hojaFacturas);
  const carpetaBase = obtenerCarpetaPorNombre(DRIVE_BASE_FOLDER);
  if (!carpetaBase) { Logger.log('No se encontró carpeta base.'); return; }

  const noRegistrados = [];
  const erroresParseo = [];
  let total = 0, limitado = false;

  outerLoop:
  {
    const añoIter = carpetaBase.getFolders();
    while (añoIter.hasNext()) {
      const añoFolder = añoIter.next();
      const mesIter   = añoFolder.getFolders();
      while (mesIter.hasNext()) {
        const mesFolder = mesIter.next();
        const xmlFolderIter = mesFolder.getFoldersByName('XML');
        if (!xmlFolderIter.hasNext()) continue;
        const xmlFolder = xmlFolderIter.next();
        const archivos = xmlFolder.getFiles();
        while (archivos.hasNext()) {
          if (Date.now() - INICIO > LIMITE_MS) { limitado = true; break outerLoop; }
          const file = archivos.next();
          if (!file.getName().toLowerCase().endsWith('.xml')) continue;
          total++;
          try {
            const factura = parsearXMLFactura(file);
            if (!factura) {
              erroresParseo.push('• ' + file.getName() + ' — no parseable\n  ' + file.getUrl());
            } else if (!registradas.has(factura.numero)) {
              noRegistrados.push('• ' + factura.numero + ' | ' + factura.proveedor + ' | ' + factura.fecha + '\n  ' + file.getUrl());
            }
          } catch(e) {
            erroresParseo.push('• ' + file.getName() + ': ' + e.message + '\n  ' + file.getUrl());
          }
        }
      }
    }
  }

  Logger.log('Auditoría — ' + total + ' XMLs revisados' + (limitado ? ' (parcial, tiempo agotado)' : '') + '.');

  if (noRegistrados.length === 0 && erroresParseo.length === 0) {
    Logger.log('✅ Auditoría OK — todos los XMLs están en el Sheet.');
    return;
  }

  let resumen = '';
  if (noRegistrados.length > 0) resumen += 'SIN REGISTRAR (' + noRegistrados.length + '):\n' + noRegistrados.join('\n') + '\n\n';
  if (erroresParseo.length > 0) resumen += 'ERRORES DE PARSEO (' + erroresParseo.length + '):\n' + erroresParseo.join('\n');
  if (limitado) resumen += '\n⚠️ Auditoría incompleta — revisados solo ' + total + ' XMLs antes del límite de tiempo.';

  Logger.log('⚠️ Resultado:\n' + resumen);
  MailApp.sendEmail({
    to: ALERTA_EMAIL,
    subject: '⚠️ Malagana — Auditoría: ' + (noRegistrados.length + erroresParseo.length) + ' factura(s) con problema',
    body: resumen + '\n\nAcciones:\n- Sin registrar → corre registrarFacturasEnSheet()\n- Errores de parseo → revisá hoja "Fallos" y corré reprocesarFallos()'
  });
}

// ============================================================
// RECUPERAR ARCHIVOS ESPECÍFICOS — procesa directamente por File ID
// Usar cuando se conocen los archivos que fallaron (ej: desde emails de alerta)
// ============================================================
function procesarArchivosEspecificos() {
  // IDs extraídos de los emails de alerta (⚠️ actualizar si hay más)
  const FILE_IDS = [
    '1XhyvGigMk_0tNIBagyH6LvL4I2Qw4xrd',  // ad08110198800602600303854.xml — 8 jul 2026
    '1bFUH_17RUpM6V9mrLC7ExRCPC95MD2O3'    // ad090027696202126G6J830979.xml — 27 jun 2026
  ];

  const ss           = obtenerOCrearSpreadsheet();
  const hojaDetalle  = obtenerOCrearHoja(ss, 'Detalle');
  const hojaFacturas = obtenerOCrearHoja(ss, 'Facturas');
  const hojaCateg    = obtenerOCrearHoja(ss, 'Categorias');
  const hojaFallos   = obtenerOCrearHoja(ss, 'Fallos');

  inicializarEncabezadosFallos(hojaFallos);

  const facturasRegistradas = obtenerFacturasRegistradas(hojaFacturas);
  const categMap            = obtenerCategoriasMap(hojaCateg);

  let filasDetalle  = [];
  let filasFacturas = [];
  let nuevasCateg   = [];
  let resueltos     = 0;

  FILE_IDS.forEach(function(id) {
    let file;
    try {
      file = DriveApp.getFileById(id);
    } catch(e) {
      Logger.log('❌ Archivo no encontrado en Drive: ' + id + ' — ' + e.message);
      return;
    }

    try {
      const factura = parsearXMLFactura(file);
      if (!factura) {
        Logger.log('⚠️ Sigue sin parsear: ' + file.getName());
        hojaFallos.getRange(hojaFallos.getLastRow() + 1, 1, 1, 6).setValues([[
          new Date(), file.getName(), file.getUrl(), 'No se pudo parsear (estructura no reconocida)', 1, 'Pendiente'
        ]]);
        return;
      }

      if (facturasRegistradas.has(factura.numero)) {
        Logger.log('ℹ️ Ya estaba registrada: ' + factura.numero);
        return;
      }

      factura.lineas.forEach(function(linea) {
        const prodKey = linea.descripcion.toUpperCase().trim();
        if (prodKey && !categMap.has(prodKey)) {
          const catAuto = clasificarProducto(prodKey);
          categMap.set(prodKey, catAuto);
          nuevasCateg.push([prodKey, catAuto]);
        }
        filasDetalle.push([
          factura.fecha, factura.numero, factura.proveedor, factura.nit,
          linea.descripcion, linea.cantidad, linea.unidad,
          linea.precioUnitario, linea.subtotal, linea.iva, linea.totalLinea
        ]);
      });

      filasFacturas.push([
        factura.fecha, factura.numero, factura.proveedor, factura.nit,
        factura.lineas.length, factura.subtotal, factura.iva, factura.total
      ]);

      facturasRegistradas.add(factura.numero);
      resueltos++;
      Logger.log('✅ Registrada: ' + factura.numero + ' | ' + factura.proveedor + ' | ' + factura.fecha + ' | Total: $' + factura.total);

    } catch(e) {
      Logger.log('❌ Error procesando ' + file.getName() + ': ' + e.message);
      hojaFallos.getRange(hojaFallos.getLastRow() + 1, 1, 1, 6).setValues([[
        new Date(), file.getName(), file.getUrl(), e.message, 1, 'Pendiente'
      ]]);
    }
  });

  if (filasDetalle.length > 0) {
    hojaDetalle.getRange(hojaDetalle.getLastRow() + 1, 1, filasDetalle.length, 11).setValues(filasDetalle);
  }
  if (filasFacturas.length > 0) {
    hojaFacturas.getRange(hojaFacturas.getLastRow() + 1, 1, filasFacturas.length, 8).setValues(filasFacturas);
  }
  if (nuevasCateg.length > 0) {
    hojaCateg.getRange(hojaCateg.getLastRow() + 1, 1, nuevasCateg.length, 2).setValues(nuevasCateg);
  }

  if (resueltos > 0) {
    reconstruirPorProducto(ss, hojaDetalle);
    Logger.log('✅ ' + resueltos + ' factura(s) recuperadas y registradas. Por_Producto reconstruido.');
  } else {
    Logger.log('ℹ️ Nada nuevo que registrar — revisá los logs de arriba.');
  }
}

// ============================================================
// REPROCESAR FALLOS — reintenta XMLs de la hoja Fallos
// Corre manualmente cuando hay fallos pendientes en la hoja
// ============================================================
function reprocesarFallos() {
  const ss           = obtenerOCrearSpreadsheet();
  const hojaDetalle  = obtenerOCrearHoja(ss, 'Detalle');
  const hojaFacturas = obtenerOCrearHoja(ss, 'Facturas');
  const hojaCateg    = obtenerOCrearHoja(ss, 'Categorias');
  const hojaFallos   = obtenerOCrearHoja(ss, 'Fallos');

  const datos = hojaFallos.getDataRange().getValues();
  if (datos.length <= 1) { Logger.log('No hay fallos registrados en la hoja Fallos.'); return; }

  const facturasRegistradas = obtenerFacturasRegistradas(hojaFacturas);
  const categMap            = obtenerCategoriasMap(hojaCateg);

  let filasDetalle  = [];
  let filasFacturas = [];
  let nuevasCateg   = [];
  let resueltos = 0, sigueRoto = 0, ignorados = 0;

  for (let i = 1; i < datos.length; i++) {
    const row      = datos[i];
    const nombre   = String(row[1] || '').trim();
    const url      = String(row[2] || '').trim();
    const intentos = Number(row[4]) || 0;
    const estado   = String(row[5] || '').trim();

    if (!url || estado === 'Resuelto ✅') { ignorados++; continue; }

    // Extraer File ID de la URL de Drive: https://drive.google.com/file/d/FILE_ID/view
    let file;
    try {
      const match = url.match(/\/d\/([^/]+)/);
      if (!match) throw new Error('No se pudo extraer el ID del archivo de: ' + url);
      file = DriveApp.getFileById(match[1]);
    } catch(e) {
      sigueRoto++;
      const n = intentos + 1;
      hojaFallos.getRange(i + 1, 1, 1, 6).setValues([[
        new Date(), nombre, url, 'Archivo no encontrado en Drive: ' + e.message, n, n >= 3 ? 'Irresolvable' : 'Pendiente'
      ]]);
      Logger.log('⚠️ No encontrado en Drive: ' + nombre);
      continue;
    }

    try {
      const factura = parsearXMLFactura(file);
      if (!factura) {
        sigueRoto++;
        const n = intentos + 1;
        hojaFallos.getRange(i + 1, 1, 1, 6).setValues([[
          new Date(), nombre, url, 'Sigue sin parsear (estructura no reconocida)', n, n >= 3 ? 'Irresolvable' : 'Pendiente'
        ]]);
        Logger.log('⚠️ Sigue sin parsear: ' + nombre);
        continue;
      }

      // ¡Funciona! Agregar al Sheet si no estaba
      if (!facturasRegistradas.has(factura.numero)) {
        factura.lineas.forEach(function(linea) {
          const prodKey = linea.descripcion.toUpperCase().trim();
          if (prodKey && !categMap.has(prodKey)) {
            const catAuto = clasificarProducto(prodKey);
            categMap.set(prodKey, catAuto);
            nuevasCateg.push([prodKey, catAuto]);
          }
          filasDetalle.push([
            factura.fecha, factura.numero, factura.proveedor, factura.nit,
            linea.descripcion, linea.cantidad, linea.unidad,
            linea.precioUnitario, linea.subtotal, linea.iva, linea.totalLinea
          ]);
        });
        filasFacturas.push([
          factura.fecha, factura.numero, factura.proveedor, factura.nit,
          factura.lineas.length, factura.subtotal, factura.iva, factura.total
        ]);
        facturasRegistradas.add(factura.numero);
      }

      hojaFallos.getRange(i + 1, 1, 1, 6).setValues([[
        new Date(), nombre, url, 'Resuelto al reprocesar', intentos + 1, 'Resuelto ✅'
      ]]);
      resueltos++;
      Logger.log('✅ Resuelto: ' + nombre);

    } catch(e) {
      sigueRoto++;
      const n = intentos + 1;
      hojaFallos.getRange(i + 1, 1, 1, 6).setValues([[
        new Date(), nombre, url, e.message, n, n >= 3 ? 'Irresolvable' : 'Pendiente'
      ]]);
      Logger.log('⚠️ Error al reprocesar ' + nombre + ': ' + e.message);
    }
  }

  if (filasDetalle.length > 0) {
    hojaDetalle.getRange(hojaDetalle.getLastRow() + 1, 1, filasDetalle.length, 11).setValues(filasDetalle);
  }
  if (filasFacturas.length > 0) {
    hojaFacturas.getRange(hojaFacturas.getLastRow() + 1, 1, filasFacturas.length, 8).setValues(filasFacturas);
  }
  if (nuevasCateg.length > 0) {
    hojaCateg.getRange(hojaCateg.getLastRow() + 1, 1, nuevasCateg.length, 2).setValues(nuevasCateg);
  }

  if (resueltos > 0) {
    reconstruirPorProducto(ss, hojaDetalle);
    Logger.log('✅ Por_Producto reconstruido con los datos recuperados.');
  }

  Logger.log('Reproceso fallos — ✅ resueltos: ' + resueltos + ' | ⚠️ siguen rotos: ' + sigueRoto + ' | ignorados/ya OK: ' + ignorados);
}

// ============================================================
// ALERTA de fallos
// ============================================================
function enviarAlertaFallos(fallos) {
  const detalles = fallos.map(f => '• ' + f.nombre + '\n  ' + f.error + '\n  ' + f.url).join('\n\n');
  MailApp.sendEmail({
    to: ALERTA_EMAIL,
    subject: '⚠️ Malagana — ' + fallos.length + ' factura(s) no se pudieron registrar',
    body: 'Facturas en Drive que NO entraron al Sheet:\n\n' + detalles + '\n\nCorre registrarFacturasEnSheet() de nuevo.'
  });
  Logger.log('⚠️ Alerta enviada: ' + fallos.length + ' fallo(s).');
}

// ============================================================
// PARSEO XML DIAN (UBL 2.1)
// ============================================================
function parsearXMLFactura(file) {
  const content = file.getBlob().getDataAsString('UTF-8');
  const doc     = XmlService.parse(content);
  let root      = doc.getRootElement();

  if (root.getName() === 'AttachedDocument') {
    try {
      const nsCAC       = XmlService.getNamespace(NS_CAC);
      const nsCBC       = XmlService.getNamespace(NS_CBC);
      const descripcion = root.getChild('Attachment', nsCAC).getChild('ExternalReference', nsCAC).getChildText('Description', nsCBC);
      if (descripcion) root = XmlService.parse(descripcion).getRootElement();
    } catch(e) { Logger.log('No se pudo extraer XML interno: ' + file.getName()); return null; }
  }

  const nsCAC = XmlService.getNamespace(NS_CAC);
  const nsCBC = XmlService.getNamespace(NS_CBC);

  const numero = getTextoCBC(root, 'ID') || file.getName().replace('.xml', '');
  const fecha  = getTextoCBC(root, 'IssueDate') || '';

  let proveedor = '', nit = '';
  try {
    const supplier = root.getChild('AccountingSupplierParty', nsCAC).getChild('Party', nsCAC);
    const le = supplier.getChild('PartyLegalEntity', nsCAC);
    if (le) proveedor = le.getChildText('RegistrationName', nsCBC) || '';
    if (!proveedor) { const pn = supplier.getChild('PartyName', nsCAC); if (pn) proveedor = pn.getChildText('Name', nsCBC) || ''; }
    nit = extraerNIT(supplier, nsCAC, nsCBC);
  } catch(e) {}

  let subtotalFactura = 0, ivaFactura = 0, totalFactura = 0;
  try { const m = root.getChild('LegalMonetaryTotal', nsCAC); subtotalFactura = parseNum(m.getChildText('LineExtensionAmount', nsCBC)); totalFactura = parseNum(m.getChildText('PayableAmount', nsCBC)); } catch(e) {}
  try { ivaFactura = parseNum(root.getChild('TaxTotal', nsCAC).getChildText('TaxAmount', nsCBC)); } catch(e) {}

  const lineas = [];
  root.getChildren('InvoiceLine', nsCAC).forEach(function(linea) {
    try {
      const cantEl   = linea.getChild('InvoicedQuantity', nsCBC);
      const cantidad = parseNum(cantEl ? cantEl.getText() : '0');
      const uAttr    = cantEl ? cantEl.getAttribute('unitCode') : null;
      const unidad   = UNIDADES[uAttr ? uAttr.getValue() : ''] || (uAttr ? uAttr.getValue() : '');
      const subtotal = parseNum(linea.getChildText('LineExtensionAmount', nsCBC));

      let descripcion = '';
      try { descripcion = linea.getChild('Item', nsCAC).getChildText('Description', nsCBC) || ''; } catch(e) {}

      let precioUnitario = 0;
      try { precioUnitario = parseNum(linea.getChild('Price', nsCAC).getChildText('PriceAmount', nsCBC)); } catch(e) {}

      let ivaLinea = 0;
      try { ivaLinea = parseNum(linea.getChild('TaxTotal', nsCAC).getChildText('TaxAmount', nsCBC)); } catch(e) {}

      lineas.push({ descripcion, cantidad, unidad, precioUnitario, subtotal, iva: ivaLinea, totalLinea: subtotal + ivaLinea });
    } catch(e) {}
  });

  return { fecha, numero, proveedor, nit, lineas, subtotal: subtotalFactura, iva: ivaFactura, total: totalFactura };
}

function extraerNIT(supplier, nsCAC, nsCBC) {
  try { const id = supplier.getChild('PartyIdentification', nsCAC).getChildText('ID', nsCBC); if (id) return id; } catch(e) {}
  try { const id = supplier.getChild('PartyTaxScheme', nsCAC).getChildText('CompanyID', nsCBC); if (id) return id; } catch(e) {}
  try { const id = supplier.getChild('PartyLegalEntity', nsCAC).getChildText('CompanyID', nsCBC); if (id) return id; } catch(e) {}
  try { const ids = supplier.getChildren('PartyIdentification', nsCAC); for (let i = 0; i < ids.length; i++) { const id = ids[i].getChildText('ID', nsCBC); if (id) return id; } } catch(e) {}
  return '';
}

// ============================================================
// HOJA Por_Producto
// ============================================================
function reconstruirPorProducto(ss, hojaDetalle) {
  let hoja = ss.getSheetByName('Por_Producto');
  if (hoja) ss.deleteSheet(hoja);
  hoja = ss.insertSheet('Por_Producto');

  const enc = ['Producto', '# Compras', 'Cantidad Total', 'Subtotal', 'IVA', 'Total Comprado'];
  hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
  formatearEncabezado(hoja, enc.length);
  hoja.setFrozenRows(1);

  const datos = hojaDetalle.getDataRange().getValues();
  const mapa  = {};
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const prod = String(fila[4]).toUpperCase().trim();
    if (!prod) continue;
    if (!mapa[prod]) mapa[prod] = { compras: 0, cantidad: 0, subtotal: 0, iva: 0, total: 0 };
    mapa[prod].compras++;
    mapa[prod].cantidad  += Number(fila[5])  || 0;
    mapa[prod].subtotal  += Number(fila[8])  || 0;
    mapa[prod].iva       += Number(fila[9])  || 0;
    mapa[prod].total     += Number(fila[10]) || 0;
  }

  const filas = Object.keys(mapa).map(p => { const v = mapa[p]; return [p, v.compras, v.cantidad, v.subtotal, v.iva, v.total]; })
    .sort((a, b) => b[5] - a[5]);

  if (filas.length > 0) {
    hoja.getRange(2, 1, filas.length, 6).setValues(filas);
  }

  hoja.setColumnWidth(1, 300); hoja.setColumnWidth(2, 90); hoja.setColumnWidth(3, 110);
  hoja.setColumnWidth(4, 110); hoja.setColumnWidth(5, 90);  hoja.setColumnWidth(6, 120);
}

// ============================================================
// CATEGORIAS — helpers
// ============================================================
function obtenerCategoriasMap(hojaCateg) {
  const mapa  = new Map();
  const datos = hojaCateg.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (datos[i][0]) mapa.set(String(datos[i][0]).trim(), String(datos[i][1] || 'Sin clasificar').trim());
  }
  return mapa;
}

function inicializarEncabezadosCateg(hoja) {
  if (hoja.getLastRow() > 0) return;
  const enc = ['Producto', 'Categoría'];
  hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
  formatearEncabezado(hoja, enc.length);
  hoja.setFrozenRows(1);
  hoja.setColumnWidth(1, 320);
  hoja.setColumnWidth(2, 160);
}

// ============================================================
// FALLOS — hoja de seguimiento persistente
// Cols: [0]Fecha intento [1]Nombre archivo [2]URL Drive [3]Error [4]# Intentos [5]Estado
// ============================================================

function inicializarEncabezadosFallos(hoja) {
  if (hoja.getLastRow() > 0) return;
  const enc = ['Fecha intento', 'Nombre archivo', 'URL Drive', 'Error', '# Intentos', 'Estado'];
  hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
  formatearEncabezado(hoja, enc.length);
  hoja.setFrozenRows(1);
  hoja.setColumnWidth(1, 140); hoja.setColumnWidth(2, 260);
  hoja.setColumnWidth(3, 280); hoja.setColumnWidth(4, 340);
  hoja.setColumnWidth(5, 90);  hoja.setColumnWidth(6, 130);
}

// Retorna Map: nombreArchivo → { row (1-based), intentos, estado }
function obtenerFallosRegistrados(hojaFallos) {
  const mapa = new Map();
  const datos = hojaFallos.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    const nombre   = String(datos[i][1] || '').trim();
    const intentos = Number(datos[i][4]) || 0;
    const estado   = String(datos[i][5] || 'Pendiente').trim();
    if (nombre) mapa.set(nombre, { row: i + 1, intentos: intentos, estado: estado });
  }
  return mapa;
}

// ============================================================
// SHEETS — helpers
// ============================================================
function obtenerOCrearSpreadsheet() {
  if (SHEET_ID) { try { return SpreadsheetApp.openById(SHEET_ID); } catch(e) {} }
  const nombre = 'Registro Facturas - Malagana Rooftop';
  const exist  = DriveApp.getFilesByName(nombre);
  if (exist.hasNext()) return SpreadsheetApp.openById(exist.next().getId());
  const ss = SpreadsheetApp.create(nombre);
  Logger.log('Sheet creado: ' + ss.getUrl());
  return ss;
}

function obtenerOCrearHoja(ss, nombre) {
  let hoja = ss.getSheetByName(nombre);
  if (!hoja) hoja = ss.insertSheet(nombre);
  return hoja;
}

function inicializarEncabezadosDetalle(hoja) {
  if (hoja.getLastRow() > 0) return;
  const enc = ['Fecha','# Factura','Proveedor','NIT Proveedor','Producto / Descripción','Cantidad','Unidad','Precio Unitario','Subtotal','IVA','Total Línea'];
  hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
  formatearEncabezado(hoja, enc.length);
  hoja.setFrozenRows(1);
  hoja.setColumnWidth(5, 280);
}

function inicializarEncabezadosFacturas(hoja) {
  if (hoja.getLastRow() > 0) return;
  const enc = ['Fecha','# Factura','Proveedor','NIT Proveedor','Ítems','Subtotal','IVA','Total'];
  hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
  formatearEncabezado(hoja, enc.length);
  hoja.setFrozenRows(1);
}

function formatearEncabezado(hoja, cols) {
  const r = hoja.getRange(1, 1, 1, cols);
  r.setFontWeight('bold'); r.setBackground('#1a1a2e'); r.setFontColor('#ffffff');
}

function obtenerFacturasRegistradas(hojaFacturas) {
  const registradas = new Set();
  const datos = hojaFacturas.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) { if (datos[i][1]) registradas.add(String(datos[i][1])); }
  return registradas;
}

// ============================================================
// UTILIDADES
// ============================================================
function getTextoCBC(element, tag) {
  try { return element.getChildText(tag, XmlService.getNamespace(NS_CBC)); } catch(e) { return ''; }
}

function parseNum(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/,/g, '')) || 0;
}

function obtenerCarpetaPorNombre(nombre) {
  const carpetas = DriveApp.getFoldersByName(nombre);
  return carpetas.hasNext() ? carpetas.next() : null;
}

function buscarXMLsEnCarpeta(carpeta) {
  const lista = [];
  buscarXMLsRecursivo(carpeta, lista);
  return lista;
}

function buscarXMLsRecursivo(carpeta, lista) {
  const archivos = carpeta.getFiles();
  while (archivos.hasNext()) {
    const f = archivos.next();
    if (f.getName().toLowerCase().endsWith('.xml') && !lista.find(x => x.getId() === f.getId())) lista.push(f);
  }
  const subs = carpeta.getFolders();
  while (subs.hasNext()) buscarXMLsRecursivo(subs.next(), lista);
}
