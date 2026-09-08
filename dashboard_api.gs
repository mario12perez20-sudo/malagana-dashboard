// ============================================================
// MALAGANA ROOFTOP — API Dashboard (Apps Script Web App)
// ============================================================
// SETUP (una sola vez):
//   Apps Script → Implementar → Nueva implementación
//   Tipo: Aplicación web
//   Ejecutar como: Yo (mario12perez20@gmail.com)
//   Acceso: Todos
//   → Copia la URL y pégala en dashboard.html  →  API_URL
// ============================================================

function doGet(e) {
  const cb     = e && e.parameter && e.parameter.callback;
  const accion = e && e.parameter && e.parameter.accion;
  try {
    const payload = accion ? ejecutarAccionReceta(accion, e.parameter) : getDashboardData();
    return responderJSON(payload, cb);
  } catch(err) {
    return responderJSON({ error: err.message }, cb);
  }
}

// El dashboard es un HTML local (sin servidor propio), así que todo pasa
// por JSONP (<script src>) para evitar CORS — esto incluye las escrituras
// de Recetas, que van por GET con ?accion=... en vez de un doPost real.
function responderJSON(payload, cb) {
  const json = JSON.stringify(payload);
  const out  = cb ? cb + '(' + json + ')' : json;
  return ContentService.createTextOutput(out)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// Datos agrupados por mes — el cliente elige cuál mostrar
// ------------------------------------------------------------
function getDashboardData() {
  const ss = abrirSheet();

  const hojaDetalle  = ss.getSheetByName('Detalle');
  const hojaFacturas = ss.getSheetByName('Facturas');
  if (!hojaDetalle || !hojaFacturas) throw new Error('Hojas "Detalle" o "Facturas" no encontradas.');

  // ── Leer tabla de categorías (fuente de verdad) ──────────
  const categMap = leerCategorias(ss);

  const dataDetalle  = hojaDetalle.getDataRange().getValues();
  const dataFacturas = hojaFacturas.getDataRange().getValues();

  // Cols Detalle: [0]Fecha [1]#Factura [2]Proveedor [3]NIT [4]Producto
  //               [5]Cantidad [6]Unidad [7]PrecioUnitario [8]Subtotal [9]IVA [10]TotalLinea

  const meses = {}; // clave: "2026-06"

  for (let i = 1; i < dataDetalle.length; i++) {
    const row = dataDetalle[i];
    if (!row[1]) continue;

    const fecha     = formatFecha(row[0]);
    if (!fecha) continue;
    const mesKey    = fecha.slice(0, 7);
    const proveedor = String(row[2] || '').trim();
    const producto  = String(row[4] || '').trim().toUpperCase();
    const cantidad  = Number(row[5]) || 0;
    const unidad    = String(row[6] || '').trim();
    const precioU   = Number(row[7]) || 0;
    const total     = Number(row[10]) || 0;

    // Categoría desde la hoja Categorias (la actualiza el script de registro)
    const categoria = categMap[producto] || 'Sin clasificar';

    if (!meses[mesKey]) meses[mesKey] = crearMes(mesKey);
    const m = meses[mesKey];

    m.gastoPorDia[fecha]       = (m.gastoPorDia[fecha] || 0)       + total;
    m.porProveedor[proveedor]  = (m.porProveedor[proveedor] || 0)  + total;
    m.proveedoresSet.add(proveedor);

    if (!m.productos[producto]) m.productos[producto] = { compras: 0, total: 0, categoria };
    m.productos[producto].compras++;
    m.productos[producto].total += total;

    // Rastrear productos sin clasificar
    if (categoria === 'Sin clasificar') {
      m.sinClasificarSet.add(producto);
    }

    // Detalle por día para drill-down (incluye categoria)
    if (!m.detallesPorDia[fecha]) m.detallesPorDia[fecha] = [];
    m.detallesPorDia[fecha].push({
      factura:    String(row[1] || ''),
      proveedor:  proveedor,
      producto:   producto,
      categoria:  categoria,
      cantidad:   cantidad,
      unidad:     unidad,
      precioUnit: precioU,
      total:      total
    });
  }

  // ── Contar facturas únicas desde hoja Facturas ──────────
  for (let i = 1; i < dataFacturas.length; i++) {
    const row = dataFacturas[i];
    if (!row[1]) continue;
    const fecha  = formatFecha(row[0]);
    const mesKey = fecha ? fecha.slice(0, 7) : '';
    if (mesKey && meses[mesKey]) {
      meses[mesKey].facturasSet.add(String(row[1]));
    }
  }

  // ── Serializar en orden cronológico ─────────────────────
  const resultado = Object.entries(meses)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, m]) => {
      const fechasOrdenadas = Object.keys(m.gastoPorDia).sort();
      const totalGastado    = Object.values(m.gastoPorDia).reduce((a, b) => a + b, 0);
      const gastoDiaArr     = rellenarDias(fechasOrdenadas, m.gastoPorDia);
      const provArr         = Object.entries(m.porProveedor)
                               .sort((a, b) => b[1] - a[1])
                               .map(([nombre, total]) => ({ nombre, total }));
      const prodArr         = Object.entries(m.productos)
                               .sort((a, b) => b[1].total - a[1].total)
                               .slice(0, 10)
                               .map(([nombre, v]) => ({ nombre, compras: v.compras, total: v.total, categoria: v.categoria }));

      // Ordenar ítems de cada día por total desc
      const detallesOrdenados = {};
      Object.entries(m.detallesPorDia).forEach(([f, items]) => {
        detallesOrdenados[f] = items.sort((a, b) => b.total - a.total);
      });

      return {
        key,
        label:               formatMesLabel(key),
        totalGastado,
        cantidadFacturas:    m.facturasSet.size,
        cantidadProveedores: m.proveedoresSet.size,
        cantidadProductos:   Object.keys(m.productos).length,
        periodoDesde:        fechasOrdenadas[0] || '',
        periodoHasta:        fechasOrdenadas[fechasOrdenadas.length - 1] || '',
        gastoPorDia:         gastoDiaArr,
        gastoPorProveedor:   provArr,
        topProductos:        prodArr,
        detallesPorDia:      detallesOrdenados,
        sinClasificar:       Array.from(m.sinClasificarSet)
      };
    });

  const recetas = leerRecetas(ss);
  const fallos  = leerFallos(ss);
  const ventas  = leerVentas(ss);
  return { meses: resultado, recetas, fallos, ventas, generadoEn: new Date().toISOString() };
}

// ------------------------------------------------------------
// Ventas — pestaña "Ventas" del dashboard (Fase 2, agregada
// 2026-09-07). Lee las hojas Ventas y Costo_Diario que arma
// loggro_sync.gs. Devuelve null si esas hojas no existen todavía o
// están vacías, para que el dashboard oculte la pestaña sin romper.
// El rango de fechas lo define Costo_Diario (lo que haya calculado
// la última corrida de calcularCostoDiarioLoggro); Top platos se
// agrega desde Ventas restringido a ese mismo rango, para que todo
// hable del mismo período.
// ------------------------------------------------------------
function leerVentas(ss) {
  const hojaCosto  = ss.getSheetByName('Costo_Diario');
  const hojaVentas = ss.getSheetByName('Ventas');
  if (!hojaCosto || !hojaVentas) return null;

  const datosCosto = hojaCosto.getDataRange().getValues();
  if (datosCosto.length <= 1) return null;

  const porDia = [];
  let ingresosTotales = 0, costoTotal = 0, sumaPct = 0, sumaCobertura = 0, n = 0;
  const fechas = [];
  for (let i = 1; i < datosCosto.length; i++) {
    const row = datosCosto[i];
    const fecha = formatFecha(row[0]);
    if (!fecha) continue;
    const costo      = Number(row[1]) || 0;
    const ingresos    = Number(row[2]) || 0;
    const pctCosto    = Number(row[3]) || 0;
    const cobertura   = Number(row[4]) || 0;
    porDia.push({ fecha, ingresos, costo, pctCosto, cobertura });
    ingresosTotales += ingresos;
    costoTotal      += costo;
    sumaPct         += pctCosto;
    sumaCobertura   += cobertura;
    n++;
    fechas.push(fecha);
  }
  if (!fechas.length) return null;
  porDia.sort((a, b) => a.fecha.localeCompare(b.fecha));
  fechas.sort();
  const desde = fechas[0], hasta = fechas[fechas.length - 1];

  // Top platos vendidos en el mismo rango de fechas — se guarda tanto el
  // acumulado global (topPlatos, compatibilidad) como el detalle por día
  // (ventasPorDiaDetalle) para que el dashboard pueda recalcular el top
  // cuando el usuario filtra por mes en vez de ver todo el período.
  const datosVentas = hojaVentas.getDataRange().getValues();
  const platos = {}; // nombre -> { cantidad, ingresos }
  const detallePorDia = {}; // fecha -> { plato: { cantidad, ingresos } }
  for (let i = 1; i < datosVentas.length; i++) {
    const row = datosVentas[i];
    const fecha = formatFecha(row[0]);
    if (!fecha || fecha < desde || fecha > hasta) continue;
    const plato = String(row[1] || '').trim();
    if (!plato) continue;
    const cantidad = Number(row[2]) || 0;
    const ingresos = Number(row[3]) || 0;

    if (!platos[plato]) platos[plato] = { cantidad: 0, ingresos: 0 };
    platos[plato].cantidad += cantidad;
    platos[plato].ingresos += ingresos;

    if (!detallePorDia[fecha]) detallePorDia[fecha] = {};
    if (!detallePorDia[fecha][plato]) detallePorDia[fecha][plato] = { cantidad: 0, ingresos: 0 };
    detallePorDia[fecha][plato].cantidad += cantidad;
    detallePorDia[fecha][plato].ingresos += ingresos;
  }
  const topPlatos = Object.entries(platos)
    .sort((a, b) => b[1].ingresos - a[1].ingresos)
    .slice(0, 10)
    .map(([nombre, v]) => ({ nombre, cantidad: v.cantidad, ingresos: v.ingresos }));

  const ventasPorDiaDetalle = {};
  Object.entries(detallePorDia).forEach(([fecha, mapa]) => {
    ventasPorDiaDetalle[fecha] = Object.entries(mapa)
      .sort((a, b) => b[1].ingresos - a[1].ingresos)
      .map(([nombre, v]) => ({ nombre, cantidad: v.cantidad, ingresos: v.ingresos }));
  });

  return {
    kpis: {
      ingresosTotales:    ingresosTotales,
      costoInsumoTotal:   costoTotal,
      pctCostoPromedio:   n ? sumaPct / n : 0,
      coberturaPromedio:  n ? sumaCobertura / n : 0,
      dias: n
    },
    periodoDesde: desde,
    periodoHasta: hasta,
    porDia: porDia,
    topPlatos: topPlatos,
    ventasPorDiaDetalle: ventasPorDiaDetalle
  };
}

// ------------------------------------------------------------
// Leer hoja Categorias → mapa {PRODUCTO: categoria}
// ------------------------------------------------------------
function leerCategorias(ss) {
  const mapa = {};
  const hoja = ss.getSheetByName('Categorias');
  if (!hoja) return mapa;
  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    const prod = String(datos[i][0] || '').trim();
    const cat  = String(datos[i][1] || 'Sin clasificar').trim();
    if (prod) mapa[prod] = cat || 'Sin clasificar';
  }
  return mapa;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function crearMes(key) {
  return {
    key,
    gastoPorDia:     {},
    porProveedor:    {},
    productos:       {},
    detallesPorDia:  {},
    facturasSet:     new Set(),
    proveedoresSet:  new Set(),
    sinClasificarSet: new Set()
  };
}

function rellenarDias(fechasOrdenadas, mapa) {
  if (fechasOrdenadas.length === 0) return [];
  const resultado = [];
  const inicio    = new Date(fechasOrdenadas[0] + 'T12:00:00');
  const fin       = new Date(fechasOrdenadas[fechasOrdenadas.length - 1] + 'T12:00:00');
  const cursor    = new Date(inicio);
  while (cursor <= fin) {
    const iso = cursor.toISOString().slice(0, 10);
    resultado.push({ fecha: iso, total: mapa[iso] || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return resultado;
}

function formatFecha(valor) {
  if (!valor) return '';
  if (valor instanceof Date) {
    return valor.getFullYear() + '-' +
           String(valor.getMonth() + 1).padStart(2, '0') + '-' +
           String(valor.getDate()).padStart(2, '0');
  }
  return String(valor).slice(0, 10);
}

function formatMesLabel(key) {
  const NOMBRES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const partes = key.split('-');
  return NOMBRES[parseInt(partes[1]) - 1] + ' ' + partes[0];
}

// ------------------------------------------------------------
// Recetas — agrupa por Categoría → Plato → Ingredientes
// ------------------------------------------------------------
function leerRecetas(ss) {
  const hoja = ss.getSheetByName('Recetas');
  if (!hoja) return {};
  const datos = hoja.getDataRange().getValues();
  const cats  = {};

  for (let i = 1; i < datos.length; i++) {
    const row  = datos[i];
    const cat  = String(row[0] || '').trim();
    const plato = String(row[1] || '').trim();
    const ingr  = String(row[2] || '').trim();
    const cant  = Number(row[3]) || 0;
    const und   = String(row[4] || '').trim();
    if (!cat || !plato || !ingr) continue;
    if (!cats[cat]) cats[cat] = {};
    if (!cats[cat][plato]) cats[cat][plato] = [];
    cats[cat][plato].push({ nombre: ingr, cantidad: cant, unidad: und });
  }

  // Serializar: { Categoría: [ { nombre, ingredientes[] } ] }
  const resultado = {};
  Object.entries(cats).forEach(function([cat, platos]) {
    resultado[cat] = Object.entries(platos).map(function([nombre, ingredientes]) {
      return { nombre, ingredientes };
    });
  });
  return resultado;
}

// ------------------------------------------------------------
// RECETAS — ESCRITURA (edición desde el dashboard)
// Cada acción toma un lock de script para evitar choques si dos
// personas editan al mismo tiempo, y devuelve el árbol de recetas
// ya actualizado para que el dashboard no tenga que recargar todo.
// ------------------------------------------------------------
function ejecutarAccionReceta(accion, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss   = abrirSheet();
    const hoja = ss.getSheetByName('Recetas');
    if (!hoja) throw new Error('Hoja "Recetas" no encontrada.');

    switch (accion) {
      case 'updateIngrediente': accUpdateIngrediente(hoja, p); break;
      case 'addIngrediente':    accAddIngrediente(hoja, p);    break;
      case 'deleteIngrediente': accDeleteIngrediente(hoja, p); break;
      case 'addPlato':          accAddPlato(hoja, p);          break;
      case 'deletePlato':       accDeletePlato(hoja, p);       break;
      case 'renamePlato':       accRenamePlato(hoja, p);       break;
      case 'renameCategoria':   accRenameCategoria(hoja, p);   break;
      default: throw new Error('Acción de receta desconocida: ' + accion);
    }

    return { ok: true, recetas: leerRecetas(ss) };
  } finally {
    lock.releaseLock();
  }
}

function normTxt(v) { return String(v || '').trim(); }

// Filas (1-based, con header) donde Categoría+Plato coinciden
function filasDePlato(datos, categoria, plato) {
  const filas = [];
  for (let i = 1; i < datos.length; i++) {
    if (normTxt(datos[i][0]) === categoria && normTxt(datos[i][1]) === plato) filas.push(i + 1);
  }
  return filas;
}

function accUpdateIngrediente(hoja, p) {
  const categoria    = normTxt(p.categoria);
  const plato        = normTxt(p.plato);
  const ingrOriginal = normTxt(p.ingredienteOriginal);
  const nuevoNombre  = p.ingredienteNuevo !== undefined ? normTxt(p.ingredienteNuevo) : ingrOriginal;
  const cantidad     = Number(p.cantidad) || 0;
  const unidad       = normTxt(p.unidad);

  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (normTxt(datos[i][0]) === categoria && normTxt(datos[i][1]) === plato && normTxt(datos[i][2]) === ingrOriginal) {
      hoja.getRange(i + 1, 3, 1, 3).setValues([[nuevoNombre, cantidad, unidad]]);
      return;
    }
  }
  throw new Error('Ingrediente no encontrado: ' + ingrOriginal + ' (en ' + plato + ')');
}

function accAddIngrediente(hoja, p) {
  const categoria   = normTxt(p.categoria);
  const plato       = normTxt(p.plato);
  const ingrediente = normTxt(p.ingrediente);
  const cantidad    = Number(p.cantidad) || 0;
  const unidad      = normTxt(p.unidad);
  if (!categoria || !plato || !ingrediente) throw new Error('Faltan datos para agregar el ingrediente.');

  const datos = hoja.getDataRange().getValues();
  const yaExiste = datos.some((row, i) => i > 0 &&
    normTxt(row[0]) === categoria && normTxt(row[1]) === plato && normTxt(row[2]) === ingrediente);
  if (yaExiste) throw new Error('Ese ingrediente ya está en la receta.');

  hoja.appendRow([categoria, plato, ingrediente, cantidad, unidad]);
}

function accDeleteIngrediente(hoja, p) {
  const categoria   = normTxt(p.categoria);
  const plato       = normTxt(p.plato);
  const ingrediente = normTxt(p.ingrediente);

  const datos = hoja.getDataRange().getValues();
  for (let i = datos.length - 1; i >= 1; i--) {
    if (normTxt(datos[i][0]) === categoria && normTxt(datos[i][1]) === plato && normTxt(datos[i][2]) === ingrediente) {
      hoja.deleteRow(i + 1);
      return;
    }
  }
  throw new Error('Ingrediente no encontrado: ' + ingrediente);
}

function accAddPlato(hoja, p) {
  const categoria = normTxt(p.categoria);
  const plato     = normTxt(p.plato);
  if (!categoria || !plato) throw new Error('Categoría y nombre del plato son obligatorios.');

  let ingredientes;
  try { ingredientes = JSON.parse(p.ingredientes || '[]'); } catch (err) { throw new Error('Ingredientes inválidos.'); }
  if (!Array.isArray(ingredientes) || ingredientes.length === 0) {
    throw new Error('El plato necesita al menos un ingrediente.');
  }

  const datos = hoja.getDataRange().getValues();
  const yaExiste = datos.some((row, i) => i > 0 && normTxt(row[0]) === categoria && normTxt(row[1]) === plato);
  if (yaExiste) throw new Error('Ya existe un plato "' + plato + '" en esa categoría.');

  const filas = ingredientes.map(function(ing) {
    return [categoria, plato, normTxt(ing.nombre), Number(ing.cantidad) || 0, normTxt(ing.unidad)];
  });
  hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, 5).setValues(filas);
}

function accDeletePlato(hoja, p) {
  const categoria = normTxt(p.categoria);
  const plato     = normTxt(p.plato);

  const datos = hoja.getDataRange().getValues();
  const filas = filasDePlato(datos, categoria, plato);
  if (!filas.length) throw new Error('Plato no encontrado: ' + plato);
  filas.sort((a, b) => b - a).forEach(f => hoja.deleteRow(f));
}

function accRenamePlato(hoja, p) {
  const categoria = normTxt(p.categoria);
  const original  = normTxt(p.platoOriginal);
  const nuevo     = normTxt(p.platoNuevo);
  if (!nuevo) throw new Error('El nuevo nombre no puede estar vacío.');

  const datos = hoja.getDataRange().getValues();
  const yaExiste = datos.some((row, i) => i > 0 && normTxt(row[0]) === categoria && normTxt(row[1]) === nuevo);
  if (yaExiste) throw new Error('Ya existe un plato "' + nuevo + '" en esa categoría.');

  const filas = filasDePlato(datos, categoria, original);
  if (!filas.length) throw new Error('Plato no encontrado: ' + original);
  filas.forEach(f => hoja.getRange(f, 2).setValue(nuevo));
}

function accRenameCategoria(hoja, p) {
  const original = normTxt(p.categoriaOriginal);
  const nueva    = normTxt(p.categoriaNueva);
  if (!nueva) throw new Error('El nuevo nombre no puede estar vacío.');

  const datos = hoja.getDataRange().getValues();
  let encontrado = false;
  for (let i = 1; i < datos.length; i++) {
    if (normTxt(datos[i][0]) === original) {
      hoja.getRange(i + 1, 1).setValue(nueva);
      encontrado = true;
    }
  }
  if (!encontrado) throw new Error('Categoría no encontrada: ' + original);
}

// ------------------------------------------------------------
// Leer hoja Fallos → resumen de facturas sin registrar
// ------------------------------------------------------------
function leerFallos(ss) {
  const hoja = ss.getSheetByName('Fallos');
  if (!hoja || hoja.getLastRow() <= 1) return { pendientes: 0, irresolvables: 0, items: [] };

  const datos = hoja.getDataRange().getValues();
  let pendientes = 0, irresolvables = 0;
  const items = [];

  for (let i = 1; i < datos.length; i++) {
    const estado = String(datos[i][5] || '').trim();
    if (estado === 'Resuelto ✅') continue;
    if (estado === 'Irresolvable') irresolvables++;
    else pendientes++;
    items.push({
      nombre:   String(datos[i][1] || ''),
      url:      String(datos[i][2] || ''),
      error:    String(datos[i][3] || ''),
      intentos: Number(datos[i][4]) || 0,
      estado:   estado
    });
  }

  return { pendientes: pendientes, irresolvables: irresolvables, items: items };
}

function abrirSheet() {
  const nombre   = 'Registro Facturas - Malagana Rooftop';
  const archivos = DriveApp.getFilesByName(nombre);
  if (!archivos.hasNext()) throw new Error('Sheet no encontrado: ' + nombre);
  return SpreadsheetApp.openById(archivos.next().getId());
}
