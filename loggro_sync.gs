// ============================================================
// MALAGANA ROOFTOP — Sincronización Loggro Restobar (POS)
// ============================================================
// SETUP (una sola vez, ya hecho el 2026-07-09):
//   configurarLoggro() → guarda usuario/clave en Script Properties.
//
// USO NORMAL (correr desde el desplegable de Apps Script):
//   sincronizarLoggroCompleto(diasAtras)  ← la más completa, corre las dos:
//     1. sincronizarVentasLoggro(diasAtras)     → hoja "Ventas"
//        (platos vendidos por día, trae Bearer token fresco, pagina
//        automático, filtra líneas con status==='Pagada')
//     2. calcularConsumoTeoricoLoggro(diasAtras) → hoja "Consumo_Teorico"
//        (cruza Ventas × Recetas: cuánto insumo "debió" consumirse)
//        + hoja "Platos_Sin_Receta" (lo vendido en Loggro que todavía
//        no tiene receta cargada — agregarlas desde el dashboard con
//        "+ Nuevo plato")
//   Sin argumento usa los últimos 30 días. Ej: sincronizarLoggroCompleto(7)
//
// CLASIFICACIÓN (correr UNA vez, después limpieza opcional):
//   inicializarLoggroProductos() → precarga hoja "Loggro_Productos"
//     con bebidas/combos/adiciones/empaques ya identificados, para
//     que Platos_Sin_Receta deje de mostrarlos (nunca van a tener
//     receta). Lo nuevo que no esté clasificado se sigue mostrando
//     y se auto-agrega en blanco a Loggro_Productos para clasificar
//     a mano con el desplegable de la columna Tipo.
//   ocultarPestanasDebug() → oculta Loggro_Debug y Recetas_Debug
//     (ya cumplieron su función de diagnóstico).
//
// DIAGNÓSTICO (solo si algo se ve raro):
//   diagnosticarPedidosLoggro()   → JSON crudo de /orders en hoja Loggro_Debug
//   diagnosticarProductosLoggro() → JSON crudo de /products
//
// COSTEO (Fase 2, paso 2 — insumo $ vs venta $ por día, iniciado 2026-07-27):
//   generarMapeoCostos()               → arma/refresca hoja "Mapeo_Costos"
//     (un ingrediente de Recetas por fila, ordenado por qué tan seguido se
//     usa). Hay que completar a mano las columnas E y F de esa hoja —no hay
//     forma automática confiable de saber a qué producto de factura
//     corresponde cada ingrediente de receta, ver el comentario largo más
//     abajo en el código para el porqué.
//   autocompletarPresentacionMapeoCostos() → corré esto DESPUÉS de
//     generarMapeoCostos() para que se llenen solas las filas donde se
//     puede resolver sin adivinar (número en el nombre del producto, o
//     compra a granel por peso/volumen) — reduce bastante lo que queda
//     por completar a mano. Marca lo que resolvió con "Auto (revisar)"
//     en la columna G. Segura de re-correr.
//   aplicarCostoManualSubrecetas0709() → llena columna H de Mapeo_Costos
//     con costo $/gr calculado a mano para preparaciones internas
//     (chimichurri, alioli, miel de caña, chuney de piña, cebollitas
//     encurtidas) que nunca van a tener una factura real que promediar.
//     calcularCostoDiarioLoggro ya sabe usar esta columna como fallback.
//   calcularCostoDiarioLoggro(diasAtras) → SOLO después de llenar al menos
//     los ingredientes de mayor frecuencia en Mapeo_Costos. Escribe la hoja
//     "Costo_Diario" (costo teórico de insumo vs ingresos, por día, más un
//     % de cuánto del consumo teórico de ese día alcanzó a valorizar).
//
// NOTA DE API: la documentación de Loggro dice que /orders filtra por
// status=Entregado, pero los datos reales devuelven status:"Pagada".
// Por eso NO filtramos por query param — traemos todo el rango de
// fechas y filtramos status==='Pagada' acá (ver filtrarLineasVendidas).
// Las fechas de Loggro vienen en UTC — se convierten a America/Bogota
// antes de agrupar por día (si no, las ventas de la noche caen en el
// día siguiente).
// ============================================================

const LOGGRO_BASE_URL = 'https://api.pirpos.com';

// ------------------------------------------------------------
// Guarda credenciales en Script Properties. Ya se corrió una vez
// (2026-07-09) y las credenciales reales quedaron guardadas ahí —
// por eso ya NO están en texto plano acá. Si alguna vez hay que
// cambiar la clave: completá LOGGRO_EMAIL/LOGGRO_PASSWORD abajo,
// corré esta función una sola vez, y volvé a borrarlas del código.
// El guard evita que un re-run accidental sin completar los valores
// borre las credenciales que ya están guardadas y funcionando.
// ------------------------------------------------------------
function configurarLoggro() {
  const NUEVO_EMAIL    = '';
  const NUEVO_PASSWORD = '';

  if (!NUEVO_EMAIL || !NUEVO_PASSWORD) {
    const props = PropertiesService.getScriptProperties();
    const yaConfigurado = props.getProperty('LOGGRO_EMAIL') && props.getProperty('LOGGRO_PASSWORD');
    if (yaConfigurado) {
      Logger.log('Ya hay credenciales guardadas en Script Properties — no se tocó nada.');
    } else {
      Logger.log('Completá NUEVO_EMAIL y NUEVO_PASSWORD en el código antes de correr esta función.');
    }
    return;
  }

  PropertiesService.getScriptProperties().setProperties({
    LOGGRO_EMAIL:    NUEVO_EMAIL,
    LOGGRO_PASSWORD: NUEVO_PASSWORD
  });
  Logger.log('Credenciales de Loggro guardadas en Script Properties. Borrá los valores del código ahora.');
}

// ------------------------------------------------------------
// Login → token JWT. Se pide uno nuevo en cada ejecución (el
// token expira rápido y no vale la pena cachearlo/refrescarlo).
// ------------------------------------------------------------
function loginLoggro() {
  const props    = PropertiesService.getScriptProperties();
  const email    = props.getProperty('LOGGRO_EMAIL');
  const password = props.getProperty('LOGGRO_PASSWORD');
  if (!email || !password) {
    throw new Error('Faltan credenciales de Loggro. Corré configurarLoggro() primero.');
  }

  const resp = UrlFetchApp.fetch(LOGGRO_BASE_URL + '/login', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ email: email, password: password }),
    muteHttpExceptions: true
  });

  const status = resp.getResponseCode();
  let data;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { data = {}; }

  if (status !== 200 || !data.tokenCurrent) {
    throw new Error('Login a Loggro falló (' + status + '): ' + resp.getContentText());
  }
  return data.tokenCurrent;
}

// ------------------------------------------------------------
// GET genérico contra la API de Loggro con el token ya obtenido
// ------------------------------------------------------------
function loggroFetch(path, token) {
  const resp = UrlFetchApp.fetch(LOGGRO_BASE_URL + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const status = resp.getResponseCode();
  if (status !== 200) {
    throw new Error('Error Loggro GET ' + path + ' (' + status + '): ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText());
}

// ------------------------------------------------------------
// Trae TODAS las líneas de pedido en un rango de fechas, paginando
// automáticamente. OJO: no filtramos por ?status= en la consulta —
// la documentación dice que el valor válido es "Entregado", pero
// los datos reales devuelven status:"Pagada". Para no arriesgarnos
// a que la API rechace o ignore un valor no documentado, traemos
// todo el rango y filtramos status==='Pagada' del lado de acá
// (ver filtrarLineasVendidas).
// ------------------------------------------------------------
function traerPedidosLoggro(token, dateInitISO, dateEndISO) {
  const pedidos = [];
  const limit   = 500;
  let page      = 0;

  while (true) {
    const qs = '/orders?pagination=true&limit=' + limit + '&page=' + page +
      '&dateInit=' + encodeURIComponent(dateInitISO) +
      '&dateEnd='  + encodeURIComponent(dateEndISO);
    const data = loggroFetch(qs, token);
    const lote = Array.isArray(data) ? data : (data.data || []);
    pedidos.push.apply(pedidos, lote);
    if (lote.length < limit) break;
    page++;
    if (page > 80) break; // tope de seguridad (~40k líneas)
  }
  return pedidos;
}

// Solo las líneas que representan una venta real y consumada
function filtrarLineasVendidas(pedidos) {
  return pedidos.filter(function(p) {
    return p.status === 'Pagada' && !p.deleted && p.product && p.product.name;
  });
}

// ============================================================
// SINCRONIZACIÓN — Ventas (platos vendidos por día)
// ============================================================

// Función principal para uso manual o trigger. Por defecto trae
// los últimos 30 días; se puede pasar otro rango en días.
function sincronizarVentasLoggro(diasAtras) {
  diasAtras = diasAtras || 30;
  const token = loginLoggro();
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - diasAtras * 24 * 60 * 60 * 1000);

  const pedidos  = traerPedidosLoggro(token, desde.toISOString(), ahora.toISOString());
  const vendidas = filtrarLineasVendidas(pedidos);

  // Agrupar por Fecha (hora Bogotá) + Plato
  const porDia = {}; // { 'YYYY-MM-DD': { 'NOMBRE PLATO': {cantidad, ingresos} } }

  vendidas.forEach(function(p) {
    const fecha    = Utilities.formatDate(new Date(p.createdOn), 'America/Bogota', 'yyyy-MM-dd');
    const plato    = String(p.product.name).trim();
    const cantidad = Number(p.quantity) || 0;
    const ingresos = Number(p.total) || 0;

    if (!porDia[fecha]) porDia[fecha] = {};
    if (!porDia[fecha][plato]) porDia[fecha][plato] = { cantidad: 0, ingresos: 0 };
    porDia[fecha][plato].cantidad += cantidad;
    porDia[fecha][plato].ingresos += ingresos;
  });

  const desdeStr = Utilities.formatDate(desde, 'America/Bogota', 'yyyy-MM-dd');
  const hastaStr = Utilities.formatDate(ahora, 'America/Bogota', 'yyyy-MM-dd');
  escribirHojaVentas(porDia, desdeStr, hastaStr);

  Logger.log('Ventas sincronizadas: ' + vendidas.length + ' líneas, ' + Object.keys(porDia).length + ' día(s).');
}

// Escribe/reemplaza la hoja Ventas para el rango sincronizado
// (borra las filas de ese rango antes de reescribir, así se puede
// re-correr sin duplicar).
//
// NOTA DE RENDIMIENTO (arreglado 2026-07-27): antes esto borraba fila
// por fila con hoja.deleteRow() dentro de un loop — cada deleteRow es
// una llamada a la API de Sheets, y con cientos/miles de filas eso
// agota el límite de 6 minutos de Apps Script (pasó corriendo
// recalcularConsumoTeorico30dias() con la hoja ya en ~1000 filas).
// Ahora se arma el resultado completo en memoria y se escribe de una
// sola vez con clearContents() + setValues(), sin importar cuántas
// filas haya.
function escribirHojaVentas(porDia, desdeStr, hastaStr) {
  const ss = abrirSheet();
  let hoja = ss.getSheetByName('Ventas');
  if (!hoja) {
    hoja = ss.insertSheet('Ventas');
    hoja.appendRow(['Fecha', 'Plato', 'Cantidad', 'Ingresos']);
  }

  const datos = hoja.getDataRange().getValues();
  const encabezado = datos.length ? datos[0] : ['Fecha', 'Plato', 'Cantidad', 'Ingresos'];
  const filasFuera = [];
  for (let i = 1; i < datos.length; i++) {
    const fecha = formatFecha(datos[i][0]);
    if (!(fecha >= desdeStr && fecha <= hastaStr)) filasFuera.push(datos[i]);
  }

  const filasNuevas = [];
  Object.keys(porDia).sort().forEach(function(fecha) {
    Object.keys(porDia[fecha]).sort().forEach(function(plato) {
      const v = porDia[fecha][plato];
      filasNuevas.push([fecha, plato, v.cantidad, v.ingresos]);
    });
  });

  const todas = filasFuera.concat(filasNuevas);
  hoja.clearContents();
  hoja.getRange(1, 1, 1, encabezado.length).setValues([encabezado]);
  if (todas.length) {
    hoja.getRange(2, 1, todas.length, encabezado.length).setValues(todas);
  }
}

// ============================================================
// CRUCE — Consumo teórico de ingredientes (Ventas × Recetas)
// ============================================================

// Requiere que la hoja Ventas ya tenga datos (correr
// sincronizarVentasLoggro primero). Calcula, por día, cuánto de
// cada ingrediente "debió" consumirse según lo vendido y la
// receta de cada plato.
function calcularConsumoTeoricoLoggro(diasAtras) {
  diasAtras = diasAtras || 30;
  const ss = abrirSheet();
  const hojaVentas = ss.getSheetByName('Ventas');
  if (!hojaVentas) throw new Error('No existe la hoja Ventas. Corré sincronizarVentasLoggro() primero.');

  const ahora = new Date();
  const desde = new Date(ahora.getTime() - diasAtras * 24 * 60 * 60 * 1000);
  const desdeStr = Utilities.formatDate(desde, 'America/Bogota', 'yyyy-MM-dd');
  const hastaStr = Utilities.formatDate(ahora, 'America/Bogota', 'yyyy-MM-dd');

  const datosVentas = hojaVentas.getDataRange().getValues();
  const recetasPorPlato = leerRecetasPorPlato(ss);

  const consumo = {};          // { fecha: { 'ingrediente||unidad': {nombre, unidad, cantidad} } }
  const platosSinReceta = {};  // { 'NOMBRE PLATO': vecesVendido }

  for (let i = 1; i < datosVentas.length; i++) {
    const fila = datosVentas[i];
    const fecha = formatFecha(fila[0]);
    if (!fecha || fecha < desdeStr || fecha > hastaStr) continue;

    const plato          = normTxt(fila[1]);
    const cantidadVendida = Number(fila[2]) || 0;
    const platoNorm       = normalizarNombrePlato(plato);

    const ingredientes = recetasPorPlato[platoNorm];
    if (!ingredientes) {
      platosSinReceta[plato] = (platosSinReceta[plato] || 0) + cantidadVendida;
      continue;
    }

    if (!consumo[fecha]) consumo[fecha] = {};
    ingredientes.forEach(function(ing) {
      const key = ing.nombre + '||' + ing.unidad;
      if (!consumo[fecha][key]) consumo[fecha][key] = { nombre: ing.nombre, unidad: ing.unidad, cantidad: 0 };
      consumo[fecha][key].cantidad += ing.cantidad * cantidadVendida;
    });
  }

  escribirHojaConsumoTeorico(consumo, desdeStr, hastaStr);
  escribirHojaPlatosSinReceta(platosSinReceta);

  Logger.log('Consumo teórico calculado. Platos sin receta: ' + Object.keys(platosSinReceta).length);
}

// { 'NOMBRE PLATO EN MAYÚSCULAS': [{nombre, cantidad, unidad}] }
function leerRecetasPorPlato(ss) {
  const hoja = ss.getSheetByName('Recetas');
  if (!hoja) throw new Error('Hoja "Recetas" no encontrada.');
  const datos = hoja.getDataRange().getValues();
  const mapa = {};
  for (let i = 1; i < datos.length; i++) {
    const plato = normalizarNombrePlato(datos[i][1]);
    const ingr  = normTxt(datos[i][2]);
    const cant  = Number(datos[i][3]) || 0;
    const und   = normTxt(datos[i][4]);
    if (!plato || !ingr) continue;
    if (!mapa[plato]) mapa[plato] = [];
    mapa[plato].push({ nombre: ingr, cantidad: cant, unidad: und });
  }
  return mapa;
}

// Alias para casos donde el nombre de Loggro es mucho más largo o
// distinto del nombre corto que usamos en Recetas, y no tiene
// sentido renombrar Recetas a un párrafo entero. Clave = nombre de
// Loggro ya normalizado (mayúsculas), valor = nombre exacto en Recetas.
const ALIAS_PLATOS_LOGGRO = {
  'POLLO DORADO SOBRE CAMA DE MADURO Y VEGETALES CON SALSA ARTESANAL DE TOMATE': 'POLLO DORADO',
  // agregados 2026-08-18, detectados en Platos_Sin_Receta con volumen alto:
  'PLATOS RESERVA HERBALIFE  POLLO A LA NARANJA': 'POLLO A LA NARANJA',
  'PASTA AL FREDO': 'PASTA ALFREDO'
};

// Normaliza un nombre de plato para poder comparar Loggro vs Recetas:
// mayúsculas + sin espacios sobrantes + sin el prefijo "CUPON - " que
// Loggro le pone a la versión con cupón/promo del mismo plato, y
// aplicando alias para nombres largos (ver ALIAS_PLATOS_LOGGRO).
function normalizarNombrePlato(nombre) {
  let n = normTxt(nombre).toUpperCase();
  n = n.replace(/^CUP[OÓ]N\s*-\s*/, '');
  n = n.trim();
  if (ALIAS_PLATOS_LOGGRO[n]) n = ALIAS_PLATOS_LOGGRO[n];
  return n;
}

// NOTA DE RENDIMIENTO (arreglado 2026-07-27): mismo fix que
// escribirHojaVentas — antes borraba fila por fila con deleteRow()
// en loop (esto fue justo lo que agotó los 6 minutos de Apps Script
// al correr recalcularConsumoTeorico30dias() con la hoja en ~1000
// filas). Ahora arma todo en memoria y escribe de una sola vez.
function escribirHojaConsumoTeorico(consumo, desdeStr, hastaStr) {
  const ss = abrirSheet();
  let hoja = ss.getSheetByName('Consumo_Teorico');
  if (!hoja) {
    hoja = ss.insertSheet('Consumo_Teorico');
    hoja.appendRow(['Fecha', 'Ingrediente', 'Unidad', 'Cantidad teórica']);
  }

  const datos = hoja.getDataRange().getValues();
  const encabezado = datos.length ? datos[0] : ['Fecha', 'Ingrediente', 'Unidad', 'Cantidad teórica'];
  const filasFuera = [];
  for (let i = 1; i < datos.length; i++) {
    const fecha = formatFecha(datos[i][0]);
    if (!(fecha >= desdeStr && fecha <= hastaStr)) filasFuera.push(datos[i]);
  }

  const filasNuevas = [];
  Object.keys(consumo).sort().forEach(function(fecha) {
    Object.keys(consumo[fecha]).sort().forEach(function(key) {
      const v = consumo[fecha][key];
      filasNuevas.push([fecha, v.nombre, v.unidad, v.cantidad]);
    });
  });

  const todas = filasFuera.concat(filasNuevas);
  hoja.clearContents();
  hoja.getRange(1, 1, 1, encabezado.length).setValues([encabezado]);
  if (todas.length) {
    hoja.getRange(2, 1, todas.length, encabezado.length).setValues(todas);
  }
}

// ============================================================
// CLASIFICACIÓN — Loggro_Productos (qué es plato, qué es bebida,
// combo, adición o empaque). Mismo patrón que la hoja Categorias
// para las compras: producto → tipo, con "Sin clasificar" (blanco)
// por defecto para lo nuevo que aparece.
// ============================================================
const TIPOS_LOGGRO_VALIDOS = ['Plato con receta', 'Bebida', 'Combo', 'Adición', 'Empaque', 'Otro'];

function aplicarValidacionTipoLoggro(hoja) {
  const regla = SpreadsheetApp.newDataValidation()
    .requireValueInList(TIPOS_LOGGRO_VALIDOS, true)
    .setAllowInvalid(true)
    .build();
  hoja.getRange(2, 2, 1000, 1).setDataValidation(regla);
}

function leerLoggroProductos(ss) {
  let hoja = ss.getSheetByName('Loggro_Productos');
  if (!hoja) {
    hoja = ss.insertSheet('Loggro_Productos');
    hoja.appendRow(['Producto (nombre en Loggro)', 'Tipo']);
    aplicarValidacionTipoLoggro(hoja);
  }
  const datos = hoja.getDataRange().getValues();
  const mapa = {};
  for (let i = 1; i < datos.length; i++) {
    const producto = normTxt(datos[i][0]);
    const tipo = normTxt(datos[i][1]);
    if (producto) mapa[producto.toUpperCase()] = tipo;
  }
  return { hoja: hoja, mapa: mapa };
}

// Corré esto UNA vez (o cada vez que agregue más productos al SEED):
// precarga Loggro_Productos con todo lo que ya identificamos como
// bebida/combo/adición/empaque (no come, no necesita receta). Es
// seguro re-correrlo — no pisa clasificaciones que ya hayas puesto a
// mano, pero SÍ completa filas que quedaron en blanco (auto-agregadas
// cuando un producto nuevo apareció sin clasificar).
function inicializarLoggroProductos() {
  const ss = abrirSheet();
  const clasif = leerLoggroProductos(ss);

  // Filas existentes con Tipo en blanco → mapa PRODUCTO_MAYUS: número de fila
  const datosHoja = clasif.hoja.getDataRange().getValues();
  const filasEnBlanco = {};
  for (let i = 1; i < datosHoja.length; i++) {
    const producto = normTxt(datosHoja[i][0]);
    const tipo = normTxt(datosHoja[i][1]);
    if (producto && !tipo) filasEnBlanco[producto.toUpperCase()] = i + 1;
  }

  const SEED = {
    'Bebida': [
      'CLUB DORADA','CORONA','STELLA','COCA COLA','COCA COLA ZERO SIN AZUCAR','SODA','GINGER',
      'LIMONADA','LIMONADA DE CEREZA','Limonada de Mango Viche','LIMONADA DE COCO','LIMONADA DE CHONTADURO',
      'LIMONADA DE FRESA','LIMONADA DE HIERBABUENA','Limonada de Vino','Jarra de limonada',
      'Soda Italiana de Fresa y Leechy','Soda Italiana de Maracuya','Soda Italiana de Piña Albahaca y Coco',
      'Soda italiana de lulo','Soda italiana frutos rojos','Soda Italiana de Mora Picante','Soda italiana de sandia',
      'Vaso Michelado Sal','Vaso Michelado Tajin','BOTELLA DE AGUA','JUGO EN AGUA','JUGO EN LECHE',
      'REDBULL','GATORADE','ELECTROLIT','BOTELLA DE AGUARDIENTE AZUL','BOTELLA DE AGUARDIENTE ORIGEN AZUL',
      'BOTELLA DE AGUARDIENTE ORIGEN AMARILLO','CANECA DE AGUARDIENTE AZUL','CANECA DE RON ESENCIAL',
      'Jarra de agua','PIÑA COLADO','Diablo','Paloma','Margarita Tradicional','Mojito Tradicional',
      'Mojito de Fresa','Mojito de Maracuya','Moscow Mule','Cacique de fuego','Guardian de la noche',
      'Malicia indigena','Daiquiri (Fresa)','Gin Tonic Tradicional','Gin Tonic Frutos Rojos','Aperol Spritz',
      'Negroni','Leechy Martini','Dry Martini','Amarú','Lluvia de oro','Copa de sangria (Tinta)',
      'Jarra de sangria (Tinta)','Nectar Ancestral','TAZA CAFE','COPA DE VINO'
    ],
    'Combo': [
      'COMBO PICADA MUNDIAL 4 CERVEZAS','COMBO PICADA MUNDIAL 4 SODAS ITALIANAS','COMBO NACHOS Y 4 CERVEZA',
      'COMBO NACHOS  4 SODAS ITALIANAS','COMBO NACHOS Y BOTELLA DE AGUARDIENTE',
      'COMBO PICADA MUNDIAL Y BOTELLA DE AGUARDIENTE','PICADA MUNDIAL',
      'PROMO DE AGUARIDENTE CON 4 CERVEZAS MUNDIAL','2 NACHOS Y SODAS ITALIANAS',
      'HAMBURGUESA PROMOCION','BOTELLA FIESTA DESCUENTO'
    ],
    'Adición': [
      'Adicion de papas','ADICION DE ARROZ','ADICION DE POLLO EN SALSA DE CILATRO','Adicion de salsa',
      'adicion frijoles','ADICION DE BOLOÑESA','ADICION DE CARNE HAMBURGUESA','ADICION DE CHORIZO',
      'ADICION DE RES','ADICION DE QUESO','ADICION DE CHULETA MILANESA'
    ],
    'Empaque': ['DESECHABLES PLATOS', 'EMPAQUE'],
    'Otro': ['VALOR - CREMA VERDURAS', 'CELEBRACION CUMPLE POSTRE', 'CELEBRACION CUMPLEAÑOS AGURDIENTE', 'VELA VOLCAN']
  };

  const filasNuevas = [];
  let completadas = 0;
  Object.keys(SEED).forEach(function(tipo) {
    SEED[tipo].forEach(function(producto) {
      const clave = producto.toUpperCase();
      if (filasEnBlanco.hasOwnProperty(clave)) {
        // Ya existía la fila (auto-agregada) pero sin Tipo → completarla
        clasif.hoja.getRange(filasEnBlanco[clave], 2).setValue(tipo);
        completadas++;
      } else if (!clasif.mapa.hasOwnProperty(clave)) {
        filasNuevas.push([producto, tipo]);
      }
      // si ya existe con un Tipo no-blanco, no se toca (respeta clasificación manual)
    });
  });

  if (filasNuevas.length) {
    clasif.hoja.getRange(clasif.hoja.getLastRow() + 1, 1, filasNuevas.length, 2).setValues(filasNuevas);
  }
  aplicarValidacionTipoLoggro(clasif.hoja);

  Logger.log('Loggro_Productos: ' + filasNuevas.length + ' fila(s) nueva(s), ' + completadas + ' fila(s) en blanco completadas.');
}

// Platos que se vendieron en Loggro pero no tienen receta cargada
// en la hoja Recetas — para saber qué falta agregar desde el
// dashboard (botón "+ Nuevo plato"). Filtra lo que ya está
// clasificado en Loggro_Productos como algo que no es comida
// (bebida, combo, adición, empaque, otro) y de paso registra ahí
// cualquier producto nuevo que todavía no esté clasificado.
function escribirHojaPlatosSinReceta(platosSinReceta) {
  const ss = abrirSheet();
  const clasif = leerLoggroProductos(ss);

  const nuevos = Object.keys(platosSinReceta).filter(function(p) {
    return !clasif.mapa.hasOwnProperty(p.toUpperCase());
  });
  if (nuevos.length) {
    const filasNuevas = nuevos.map(function(p) { return [p, '']; });
    clasif.hoja.getRange(clasif.hoja.getLastRow() + 1, 1, filasNuevas.length, 2).setValues(filasNuevas);
  }

  const filtrados = {};
  Object.keys(platosSinReceta).forEach(function(p) {
    const tipo = clasif.mapa[p.toUpperCase()] || '';
    if (tipo === '' || tipo === 'Plato con receta') {
      filtrados[p] = platosSinReceta[p];
    }
  });

  let hoja = ss.getSheetByName('Platos_Sin_Receta');
  if (!hoja) hoja = ss.insertSheet('Platos_Sin_Receta');
  hoja.clear();
  hoja.appendRow(['Plato (nombre en Loggro)', 'Veces vendido en el período sincronizado']);

  const filas = Object.keys(filtrados)
    .sort(function(a, b) { return filtrados[b] - filtrados[a]; })
    .map(function(plato) { return [plato, filtrados[plato]]; });

  if (filas.length) {
    hoja.getRange(2, 1, filas.length, 2).setValues(filas);
  }
}

// ============================================================
// MIGRACIÓN PUNTUAL — renombres/borrados de plato ya confirmados
// con Sebastián (2026-07-09). Llama directo a las funciones de
// dashboard_api.gs (accRenamePlato / accDeletePlato) sin pasar por
// HTTP, así que no hace falta "npm run deploy" para esto — con
// "npm run push" y correr esta función alcanza.
// Segura de re-correr: si una línea ya se aplicó antes, esa línea
// puntual tira error en el log pero las demás igual se ejecutan.
// ============================================================
function aplicarRenombresPendientes() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Recetas');
  if (!hoja) throw new Error('Hoja "Recetas" no encontrada.');

  const acciones = [
    { fn: 'rename', categoria: 'Pizzas',  platoOriginal: 'CARNES',               platoNuevo: 'Pizza de carne' },
    { fn: 'rename', categoria: 'Pastas',  platoOriginal: 'PASTA AMATRICIANA',    platoNuevo: 'Fettuchine Amatricciana' },
    { fn: 'delete', categoria: 'Postres', plato: 'PASTA AMATRICIANA' },
    { fn: 'rename', categoria: 'Cortes',  platoOriginal: 'PUNTA DE ANCA',        platoNuevo: 'Punta de anca de res' },
    { fn: 'rename', categoria: 'Platos',  platoOriginal: 'ENSALADA DE BONDIOLA', platoNuevo: 'Ensalada de bondiola acaramelada' },
    { fn: 'rename', categoria: 'Entradas', platoOriginal: 'ENSALADA FRESCA',     platoNuevo: 'ENSALADA MALAGANA' },
    { fn: 'rename', categoria: 'Tardeo',   platoOriginal: 'PERRO MALAGANA',      platoNuevo: 'PERRO FOOD STAR' },
    { fn: 'rename', categoria: 'Platos',   platoOriginal: 'CHICHARON OREADO',    platoNuevo: 'Chicharron Oreado' }
  ];

  const resultados = [];
  acciones.forEach(function(a) {
    try {
      if (a.fn === 'rename') {
        accRenamePlato(hoja, { categoria: a.categoria, platoOriginal: a.platoOriginal, platoNuevo: a.platoNuevo });
        resultados.push('OK  rename: ' + a.categoria + ' / ' + a.platoOriginal + ' -> ' + a.platoNuevo);
      } else {
        accDeletePlato(hoja, { categoria: a.categoria, plato: a.plato });
        resultados.push('OK  delete: ' + a.categoria + ' / ' + a.plato);
      }
    } catch (err) {
      resultados.push('ERROR ' + a.fn + ': ' + a.categoria + ' / ' + (a.platoOriginal || a.plato) + ' -> ' + err.message);
    }
  });

  Logger.log(resultados.join('\n'));
}

// ============================================================
// NUEVAS RECETAS — cargadas de los costeos que mandó Sebastián
// (2026-07-16): Hamburguesa Cacique y Perro Malagana. Igual que
// aplicarRenombresPendientes, llama directo a accAddPlato() de
// dashboard_api.gs sin pasar por HTTP — no hace falta deploy.
// ============================================================
function agregarRecetasNuevas() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Recetas');
  if (!hoja) throw new Error('Hoja "Recetas" no encontrada.');

  const platosNuevos = [
    {
      categoria: 'Tardeo',
      plato: 'HAMBURGUESA CACIQUE',
      ingredientes: [
        { nombre: 'pan ajonjoli', cantidad: 1, unidad: 'und' },
        { nombre: 'carne angus', cantidad: 150, unidad: 'gr' },
        { nombre: 'queso philadelphia', cantidad: 50, unidad: 'gr' },
        { nombre: 'tocineta', cantidad: 35, unidad: 'gr' },
        { nombre: 'lechuga', cantidad: 20, unidad: 'gr' },
        { nombre: 'tomate', cantidad: 20, unidad: 'gr' },
        { nombre: 'miel de caña', cantidad: 20, unidad: 'ml' },
        { nombre: 'salsa alioli', cantidad: 50, unidad: 'ml' },
        { nombre: 'aros de cebolla', cantidad: 2, unidad: 'und' },
        { nombre: 'papas a la francesa', cantidad: 120, unidad: 'gr' },
        { nombre: 'paprika', cantidad: 5, unidad: 'gr' },
        { nombre: 'sal', cantidad: 5, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 5, unidad: 'gr' },
        { nombre: 'palo brocheta', cantidad: 1, unidad: 'und' }
      ]
    },
    {
      categoria: 'Tardeo',
      plato: 'PERRO MALAGANA',
      ingredientes: [
        { nombre: 'pan brioche perro', cantidad: 1, unidad: 'und' },
        { nombre: 'salchicha new yorker', cantidad: 1, unidad: 'und' },
        { nombre: 'queso doble crema', cantidad: 2, unidad: 'und' },
        { nombre: 'tocineta', cantidad: 20, unidad: 'gr' },
        { nombre: 'cebolla puerro', cantidad: 40, unidad: 'und' },
        { nombre: 'salsa maiz dulce', cantidad: 20, unidad: 'ml' },
        { nombre: 'miel de caña', cantidad: 40, unidad: 'ml' },
        { nombre: 'cubos de pollo', cantidad: 100, unidad: 'gr' },
        { nombre: 'fecula', cantidad: 20, unidad: 'gr' },
        { nombre: 'harina', cantidad: 50, unidad: 'gr' },
        { nombre: 'paprika', cantidad: 5, unidad: 'gr' },
        { nombre: 'sal', cantidad: 5, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 2, unidad: 'gr' },
        { nombre: 'huevo', cantidad: 15, unidad: 'gr' },
        { nombre: 'oregano', cantidad: 3, unidad: 'gr' },
        { nombre: 'leche', cantidad: 10, unidad: 'und' }
      ]
    }
  ];

  const resultados = [];
  platosNuevos.forEach(function(p) {
    try {
      accAddPlato(hoja, {
        categoria: p.categoria,
        plato: p.plato,
        ingredientes: JSON.stringify(p.ingredientes)
      });
      resultados.push('OK  addPlato: ' + p.categoria + ' / ' + p.plato + ' (' + p.ingredientes.length + ' ingredientes)');
    } catch (err) {
      resultados.push('ERROR addPlato: ' + p.categoria + ' / ' + p.plato + ' -> ' + err.message);
    }
  });

  Logger.log(resultados.join('\n'));
}

// ============================================================
// NUEVAS RECETAS (2026-07-23) — 13 platos de los costeos de
// Sebastián en la carpeta Resetas/. 7 son recetas simples
// (mismo formato de Hamburguesa Cacique/Perro), 6 vienen de
// "Almuerzos y costilla.xlsx" (Costilla Sous Vide, Pasta Alfredo,
// Pasta Boloñesa, Pollo a la Naranja, Frijolada, Lasaña) — ese
// archivo trae cada plato con sub-recetas anidadas (ej. Lasaña =
// pasta + boloñesa + bechamel, cada una con su propia lista de
// ingredientes comprables). Se aplanaron a ingredientes base
// (escalando cada sub-receta por la proporción realmente usada
// en el plato final) porque la hoja Precios solo tiene insumos
// comprables reales — "Bechamel" o "Boloñesa" sueltos no cruzan
// contra facturas. Bondiola (Ensalada de bondiola acaramelada) y
// Ensalada Malagana NO se tocan acá — ya existían cargadas en
// Recetas antes de esta sesión, con ingredientes muy similares.
// Igual que agregarRecetasNuevas(), llama directo a accAddPlato()
// de dashboard_api.gs sin pasar por HTTP — no hace falta deploy.
// ============================================================
function agregarRecetasSebastian2607() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Recetas');
  if (!hoja) throw new Error('Hoja "Recetas" no encontrada.');

  const platosNuevos = [
    {
      categoria: 'Tardeo',
      plato: 'HAMBURGUESA DE LA CASA',
      ingredientes: [
        { nombre: 'pan liso', cantidad: 1, unidad: 'und' },
        { nombre: 'carne nacional', cantidad: 150, unidad: 'gr' },
        { nombre: 'queso mozzarella', cantidad: 1, unidad: 'und' },
        { nombre: 'tocineta', cantidad: 35, unidad: 'gr' },
        { nombre: 'lechuga', cantidad: 20, unidad: 'gr' },
        { nombre: 'tomate', cantidad: 20, unidad: 'gr' },
        { nombre: 'miel de caña', cantidad: 40, unidad: 'ml' },
        { nombre: 'salsa alioli', cantidad: 50, unidad: 'ml' },
        { nombre: 'cebolla caramelizada', cantidad: 35, unidad: 'gr' },
        { nombre: 'papas a la francesa', cantidad: 120, unidad: 'gr' },
        { nombre: 'paprika', cantidad: 5, unidad: 'gr' },
        { nombre: 'sal', cantidad: 5, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 5, unidad: 'gr' },
        { nombre: 'palo brocheta', cantidad: 1, unidad: 'und' }
      ]
    },
    {
      categoria: 'Tardeo',
      plato: 'HAMBURGUESA LIGERA CON COCA-COLA',
      ingredientes: [
        { nombre: 'pan liso', cantidad: 1, unidad: 'und' },
        { nombre: 'carne nacional', cantidad: 150, unidad: 'gr' },
        { nombre: 'queso mozzarella', cantidad: 1, unidad: 'und' },
        { nombre: 'lechuga', cantidad: 20, unidad: 'gr' },
        { nombre: 'tomate', cantidad: 20, unidad: 'gr' },
        { nombre: 'miel de caña', cantidad: 40, unidad: 'ml' },
        { nombre: 'salsa alioli', cantidad: 30, unidad: 'ml' },
        { nombre: 'cebolla caramelizada', cantidad: 35, unidad: 'gr' },
        { nombre: 'sal', cantidad: 5, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 5, unidad: 'gr' },
        { nombre: 'palo brocheta', cantidad: 1, unidad: 'und' }
      ]
    },
    {
      categoria: 'Arroces',
      plato: 'ARROZ CON CAMARON',
      ingredientes: [
        { nombre: 'arroz blanco cocido', cantidad: 240, unidad: 'gr' },
        { nombre: 'camaron pre cocido', cantidad: 180, unidad: 'gr' },
        { nombre: 'laminas platano verde', cantidad: 100, unidad: 'gr' },
        { nombre: 'paprika', cantidad: 20, unidad: 'gr' },
        { nombre: 'cebolla', cantidad: 30, unidad: 'gr' },
        { nombre: 'perejil', cantidad: 15, unidad: 'gr' },
        { nombre: 'pimenton', cantidad: 30, unidad: 'gr' },
        { nombre: 'aceite', cantidad: 20, unidad: 'ml' },
        { nombre: 'sal', cantidad: 5, unidad: 'gr' },
        { nombre: 'ajo pasta', cantidad: 5, unidad: 'gr' }
      ]
    },
    {
      categoria: 'Platos',
      plato: 'CAZUELA DE MARISCOS',
      ingredientes: [
        { nombre: 'crema de leche', cantidad: 300, unidad: 'gr' },
        { nombre: 'mix mariscos', cantidad: 250, unidad: 'gr' },
        { nombre: 'laminas platano verde', cantidad: 100, unidad: 'gr' },
        { nombre: 'paprika', cantidad: 20, unidad: 'gr' },
        { nombre: 'cebolla', cantidad: 40, unidad: 'gr' },
        { nombre: 'perejil', cantidad: 15, unidad: 'gr' },
        { nombre: 'pimenton', cantidad: 30, unidad: 'gr' },
        { nombre: 'aceite', cantidad: 20, unidad: 'ml' },
        { nombre: 'sal', cantidad: 5, unidad: 'gr' },
        { nombre: 'ajo pasta', cantidad: 5, unidad: 'gr' },
        { nombre: 'esencia de coco', cantidad: 3, unidad: 'ml' }
      ]
    },
    {
      categoria: 'Postres',
      plato: 'COPA DE HELADO Y FRUTAS',
      ingredientes: [
        { nombre: 'helado', cantidad: 180, unidad: 'gr' },
        { nombre: 'fresa', cantidad: 20, unidad: 'gr' },
        { nombre: 'manzana verde', cantidad: 40, unidad: 'gr' },
        { nombre: 'cereza', cantidad: 1, unidad: 'ml' }
      ]
    },
    {
      categoria: 'Tardeo',
      plato: 'NACHOS',
      ingredientes: [
        { nombre: 'paquete nachos', cantidad: 1, unidad: 'und' },
        { nombre: 'carne molida', cantidad: 300, unidad: 'gr' },
        { nombre: 'salsa cheddar', cantidad: 40, unidad: 'ml' },
        { nombre: 'pico de gallo', cantidad: 80, unidad: 'gr' },
        { nombre: 'queso en lonchas', cantidad: 2, unidad: 'und' },
        { nombre: 'alioli', cantidad: 40, unidad: 'gr' },
        { nombre: 'sal', cantidad: 8, unidad: 'gr' },
        { nombre: 'salsa de tomate', cantidad: 100, unidad: 'ml' }
      ]
    },
    {
      categoria: 'Tardeo',
      plato: 'NUGGETS DE POLLO',
      ingredientes: [
        { nombre: 'nuggets', cantidad: 120, unidad: 'gr' },
        { nombre: 'lechuga', cantidad: 10, unidad: 'gr' },
        { nombre: 'alioli', cantidad: 40, unidad: 'ml' },
        { nombre: 'papas a la francesa', cantidad: 120, unidad: 'gr' },
        { nombre: 'paprika', cantidad: 5, unidad: 'gr' }
      ]
    },
    {
      categoria: 'Platos',
      plato: 'COSTILLA SOUS VIDE',
      ingredientes: [
        { nombre: 'costilla tipo llanera', cantidad: 500, unidad: 'gr' },
        { nombre: 'pasta de ajo', cantidad: 11.25, unidad: 'gr' },
        { nombre: 'cebolla', cantidad: 20, unidad: 'gr' },
        { nombre: 'tomillo', cantidad: 1.25, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 1.25, unidad: 'gr' },
        { nombre: 'naranja', cantidad: 15, unidad: 'gr' },
        { nombre: 'paprika', cantidad: 0.6, unidad: 'gr' },
        { nombre: 'vinagre de manzana', cantidad: 15, unidad: 'gr' },
        { nombre: 'comino', cantidad: 1.25, unidad: 'gr' },
        { nombre: 'sal', cantidad: 7.25, unidad: 'gr' },
        { nombre: 'lechuga', cantidad: 15, unidad: 'gr' },
        { nombre: 'tomate cherry', cantidad: 25, unidad: 'gr' },
        { nombre: 'cebolla roja', cantidad: 15, unidad: 'gr' },
        { nombre: 'zumo limon', cantidad: 5, unidad: 'ml' },
        { nombre: 'papas amarillas en casco', cantidad: 140, unidad: 'gr' },
        { nombre: 'alioli de cilantro', cantidad: 40, unidad: 'gr' }
      ]
    },
    {
      categoria: 'Pastas',
      plato: 'PASTA ALFREDO',
      ingredientes: [
        { nombre: 'mantequilla', cantidad: 11.9, unidad: 'gr' },
        { nombre: 'crema de leche', cantidad: 74.2, unidad: 'gr' },
        { nombre: 'pasta de ajo', cantidad: 1.0, unidad: 'gr' },
        { nombre: 'parmesano', cantidad: 19.8, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 0.2, unidad: 'gr' },
        { nombre: 'nuez moscada', cantidad: 0.1, unidad: 'gr' },
        { nombre: 'sal', cantidad: 2.5, unidad: 'gr' },
        { nombre: 'pasta fetuccine', cantidad: 11.9, unidad: 'gr' },
        { nombre: 'lechuga', cantidad: 22.1, unidad: 'gr' },
        { nombre: 'tomate cherry', cantidad: 36.9, unidad: 'gr' },
        { nombre: 'cebolla roja', cantidad: 22.1, unidad: 'gr' },
        { nombre: 'zumo limon', cantidad: 7.4, unidad: 'ml' },
        { nombre: 'miel de caña', cantidad: 15, unidad: 'ml' },
        { nombre: 'cremas champiñones', cantidad: 225, unidad: 'gr' },
        { nombre: 'aguapanela', cantidad: 2, unidad: 'und' }
      ]
    },
    {
      categoria: 'Pastas',
      plato: 'PASTA BOLOÑESA',
      ingredientes: [
        { nombre: 'carne molida', cantidad: 104.2, unidad: 'gr' },
        { nombre: 'cebolla cabezona', cantidad: 41.7, unidad: 'gr' },
        { nombre: 'ajo', cantidad: 6.2, unidad: 'gr' },
        { nombre: 'zanahoria', cantidad: 20.8, unidad: 'gr' },
        { nombre: 'apio', cantidad: 10.4, unidad: 'gr' },
        { nombre: 'tomate triturado', cantidad: 83.3, unidad: 'gr' },
        { nombre: 'aceite de oliva', cantidad: 14.6, unidad: 'gr' },
        { nombre: 'sal', cantidad: 3.6, unidad: 'gr' },
        { nombre: 'oregano seco', cantidad: 1.0, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 1.0, unidad: 'gr' },
        { nombre: 'laurel', cantidad: 1.0, unidad: 'gr' },
        { nombre: 'pasta fetuccine', cantidad: 114.6, unidad: 'gr' },
        { nombre: 'pan frances', cantidad: 3, unidad: 'gr' },
        { nombre: 'mantequilla', cantidad: 10, unidad: 'gr' },
        { nombre: 'oregano', cantidad: 1, unidad: 'gr' },
        { nombre: 'lechuga', cantidad: 22.1, unidad: 'gr' },
        { nombre: 'tomate cherry', cantidad: 36.9, unidad: 'gr' },
        { nombre: 'cebolla roja', cantidad: 22.1, unidad: 'gr' },
        { nombre: 'zumo limon', cantidad: 7.4, unidad: 'ml' },
        { nombre: 'cremas champiñones', cantidad: 225, unidad: 'gr' },
        { nombre: 'aguapanela', cantidad: 2, unidad: 'und' }
      ]
    },
    {
      categoria: 'Almuerzos',
      plato: 'POLLO A LA NARANJA',
      ingredientes: [
        { nombre: 'pollo', cantidad: 80.9, unidad: 'gr' },
        { nombre: 'zumo de naranja', cantidad: 54.0, unidad: 'gr' },
        { nombre: 'ralladura de limon', cantidad: 0.5, unidad: 'gr' },
        { nombre: 'salsa soya', cantidad: 2.7, unidad: 'gr' },
        { nombre: 'azucar', cantidad: 3.2, unidad: 'gr' },
        { nombre: 'vinagre', cantidad: 2.7, unidad: 'gr' },
        { nombre: 'fecula', cantidad: 2.7, unidad: 'gr' },
        { nombre: 'aceite', cantidad: 2.7, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 0.5, unidad: 'gr' },
        { nombre: 'arroz', cantidad: 120, unidad: 'gr' },
        { nombre: 'lechuga', cantidad: 22.1, unidad: 'gr' },
        { nombre: 'tomate cherry', cantidad: 36.9, unidad: 'gr' },
        { nombre: 'cebolla roja', cantidad: 22.1, unidad: 'gr' },
        { nombre: 'zumo limon', cantidad: 7.4, unidad: 'ml' },
        { nombre: 'sal', cantidad: 1.5, unidad: 'gr' },
        { nombre: 'aguapanela', cantidad: 2, unidad: 'und' },
        { nombre: 'cremas champiñones', cantidad: 225, unidad: 'gr' }
      ]
    },
    {
      categoria: 'Almuerzos',
      plato: 'FRIJOLADA',
      ingredientes: [
        { nombre: 'frijol', cantidad: 85.7, unidad: 'gr' },
        { nombre: 'zanahoria', cantidad: 70.5, unidad: 'gr' },
        { nombre: 'cebolla larga', cantidad: 32.1, unidad: 'gr' },
        { nombre: 'papa', cantidad: 10.7, unidad: 'gr' },
        { nombre: 'zapallo', cantidad: 21.4, unidad: 'gr' },
        { nombre: 'tomate chonto', cantidad: 21.4, unidad: 'gr' },
        { nombre: 'chicharron', cantidad: 120, unidad: 'gr' },
        { nombre: 'arroz', cantidad: 120, unidad: 'gr' },
        { nombre: 'remolacha', cantidad: 45.0, unidad: 'gr' },
        { nombre: 'mayonesa', cantidad: 28.1, unidad: 'gr' },
        { nombre: 'maduro', cantidad: 70, unidad: 'gr' },
        { nombre: 'aguapanela', cantidad: 2, unidad: 'und' }
      ]
    },
    {
      categoria: 'Pastas',
      plato: 'LASAÑA',
      ingredientes: [
        { nombre: 'pasta lamina', cantidad: 1.5, unidad: 'und' },
        { nombre: 'carne molida', cantidad: 186.5, unidad: 'gr' },
        { nombre: 'cebolla cabezona', cantidad: 34.6, unidad: 'gr' },
        { nombre: 'ajo', cantidad: 5.3, unidad: 'gr' },
        { nombre: 'zanahoria', cantidad: 17.3, unidad: 'gr' },
        { nombre: 'apio', cantidad: 8.7, unidad: 'gr' },
        { nombre: 'tomate triturado', cantidad: 69.2, unidad: 'gr' },
        { nombre: 'pasta de tomate', cantidad: 13.0, unidad: 'gr' },
        { nombre: 'aceite de oliva', cantidad: 12.1, unidad: 'gr' },
        { nombre: 'sal', cantidad: 1.7, unidad: 'gr' },
        { nombre: 'oregano seco', cantidad: 0.9, unidad: 'gr' },
        { nombre: 'pimienta', cantidad: 1.0, unidad: 'gr' },
        { nombre: 'laurel', cantidad: 0.9, unidad: 'gr' },
        { nombre: 'harina de trigo', cantidad: 11.0, unidad: 'gr' },
        { nombre: 'mantequilla', cantidad: 21.0, unidad: 'gr' },
        { nombre: 'nuez moscada', cantidad: 0.1, unidad: 'gr' },
        { nombre: 'leche', cantidad: 137.7, unidad: 'ml' },
        { nombre: 'pan frances', cantidad: 3, unidad: 'gr' },
        { nombre: 'oregano', cantidad: 1, unidad: 'gr' },
        { nombre: 'molde', cantidad: 1, unidad: 'und' }
      ]
    }
  ];

  const resultados = [];
  platosNuevos.forEach(function(p) {
    try {
      accAddPlato(hoja, {
        categoria: p.categoria,
        plato: p.plato,
        ingredientes: JSON.stringify(p.ingredientes)
      });
      resultados.push('OK  addPlato: ' + p.categoria + ' / ' + p.plato + ' (' + p.ingredientes.length + ' ingredientes)');
    } catch (err) {
      resultados.push('ERROR addPlato: ' + p.categoria + ' / ' + p.plato + ' -> ' + err.message);
    }
  });

  Logger.log(resultados.join('\n'));
}

// ============================================================
// CARPACCIO DE BONDIOLA (2026-07-23) — confirmado con Sebastián:
// es la MISMA receta que "Ensalada de bondiola acaramelada" (ya
// cargada, categoría Platos) pero servida como entrada, en 1/3
// de la porción del plato fuerte. Se agrega como plato aparte en
// Recetas (categoría Entradas) para que Loggro deje de mostrarlo
// en Platos_Sin_Receta. Ingredientes = los de Ensalada de bondiola
// acaramelada × 1/3. Llama accAddPlato() directo, sin deploy.
//
// NOTA 2026-09-07: esta función quedó SUPERADA — nunca llegó a
// aplicarse (Recetas no tiene ningún "Carpaccio" a esta fecha, pese
// a que la nota vieja decía que Mario lo había cargado desde el
// dashboard) y además el nombre de plato de acá ("CARPACCIO DE
// BONDIOLA", sin "ACARAMELADA") no calza con el nombre real de venta
// en Loggro ("Carpaccio de bondiola acaramelada"), así que aunque se
// hubiera cargado, nunca habría enganchado. Usar en su lugar
// `agregarCarpaccioYMiniBaos0709()` más abajo, que trae la receta
// real desde "Costo total recetas .xlsx" (pestaña ENTRADAS (2)) en
// vez de esta composición armada por escalamiento. NO CORRER ESTA.
// ============================================================
function agregarCarpaccioBondiola() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Recetas');
  if (!hoja) throw new Error('Hoja "Recetas" no encontrada.');

  const ingredientes = [
    { nombre: 'Jamón de Bondiola Acaramelada', cantidad: 33.3, unidad: 'gr' },
    { nombre: 'Mix de Lechugas', cantidad: 33.3, unidad: 'gr' },
    { nombre: 'Cebolla Encurtida', cantidad: 13.3, unidad: 'gr' },
    { nombre: 'Miel de Caña', cantidad: 3.3, unidad: 'gr' },
    { nombre: 'chuney de piña', cantidad: 3.3, unidad: 'gr' },
    { nombre: 'queso costeño', cantidad: 6.7, unidad: 'gr' },
    { nombre: 'almendras rebanadas', cantidad: 3.3, unidad: 'gr' },
    { nombre: 'tomate cherry', cantidad: 10, unidad: 'gr' },
    { nombre: 'uchuva', cantidad: 10, unidad: 'gr' }
  ];

  try {
    accAddPlato(hoja, {
      categoria: 'Entradas',
      plato: 'CARPACCIO DE BONDIOLA',
      ingredientes: JSON.stringify(ingredientes)
    });
    Logger.log('OK  addPlato: Entradas / CARPACCIO DE BONDIOLA (' + ingredientes.length + ' ingredientes)');
  } catch (err) {
    Logger.log('ERROR addPlato: Entradas / CARPACCIO DE BONDIOLA -> ' + err.message);
  }
}

// ============================================================
// MIGRACIÓN PUNTUAL 2026-09-07 — Carpaccio de Bondiola Acaramelada
// y Mini Baos Rellenos con cerdo agridulce, los dos únicos de
// Platos_Sin_Receta que encontré con receta real ya escrita en
// "Costo total recetas .xlsx" (pestaña "ENTRADAS (2)", filas 23-29),
// un libro maestro de costeo que no se había revisado a fondo antes
// (tiene 24 pestañas). Nombres de plato puestos EXACTOS como
// aparecen en Loggro (ver Platos_Sin_Receta) para que el alias
// enganche sin necesitar ALIAS_PLATOS_LOGGRO.
//
// OJO — "Mini baos" (el ingrediente, no el plato) está en la fuente
// como cantidad 3 en unidad "gr", lo cual no tiene sentido para "3
// bollitos" — lo dejé tal cual viene del archivo porque así es como
// el propio archivo calcula su costo interno, pero vale la pena que
// Sebastián confirme si esa cantidad debería ser otra cosa.
//
// Ambas recetas usan ingredientes compuestos (Bondiola acaramelada,
// Jamón de Bondiola Acaramelada, Salsa agridulce, Alioli de cilantro)
// que no están en la hoja Precios como insumo comprable — mismo tipo
// de deuda técnica que Bechamel/Boloñesa (ver nota de arquitectura
// en Precios, sección Fase 2 arriba). Quedan cargadas así por ahora
// para que Loggro deje de marcarlas sin receta; aplanarlas a insumos
// base es un paso aparte, no bloqueante.
function agregarCarpaccioYMiniBaos0709() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Recetas');
  if (!hoja) throw new Error('Hoja "Recetas" no encontrada.');

  const platos = [
    {
      categoria: 'Entradas',
      plato: 'Carpaccio de bondiola acaramelada',
      ingredientes: [
        { nombre: 'Bondiola acaramelada', cantidad: 80, unidad: 'gr' },
        { nombre: 'Rugula', cantidad: 20, unidad: 'gr' },
        { nombre: 'Cebolla encurtida', cantidad: 15, unidad: 'gr' },
        { nombre: 'Miel de caña', cantidad: 15, unidad: 'gr' },
        { nombre: 'Aceite de oliva', cantidad: 10, unidad: 'gr' }
      ]
    },
    {
      categoria: 'Entradas',
      plato: 'Mini Baos Rellenos con cerdo agridulce',
      ingredientes: [
        { nombre: 'Mini baos', cantidad: 3, unidad: 'gr' },
        { nombre: 'Jamón de Bondiola Acaramelada', cantidad: 100, unidad: 'gr' },
        { nombre: 'Salsa agridulce', cantidad: 50, unidad: 'gr' },
        { nombre: 'Lechuga', cantidad: 10, unidad: 'gr' },
        { nombre: 'Alioli de cilantro', cantidad: 10, unidad: 'gr' }
      ]
    }
  ];

  platos.forEach(function(p) {
    try {
      accAddPlato(hoja, {
        categoria: p.categoria,
        plato: p.plato,
        ingredientes: JSON.stringify(p.ingredientes)
      });
      Logger.log('OK  addPlato: ' + p.categoria + ' / ' + p.plato + ' (' + p.ingredientes.length + ' ingredientes)');
    } catch (err) {
      Logger.log('ERROR addPlato: ' + p.categoria + ' / ' + p.plato + ' -> ' + err.message);
    }
  });
}

// Oculta las pestañas de diagnóstico (ya cumplieron su función) sin
// borrar los datos, por si hacen falta de nuevo más adelante.
function ocultarPestanasDebug() {
  const ss = abrirSheet();
  ['Loggro_Debug', 'Recetas_Debug'].forEach(function(nombre) {
    const hoja = ss.getSheetByName(nombre);
    if (hoja) hoja.hideSheet();
  });
  Logger.log('Pestañas de diagnóstico ocultas.');
}

// Borra directamente las pestañas de diagnóstico. Son fotos
// congeladas de un momento puntual (no se actualizan solas) — una
// vez que ya se usaron para lo que hacían falta, no tiene sentido
// dejarlas ni ocultas, para que nadie las confunda con datos vigentes.
function borrarPestanasDebug() {
  const ss = abrirSheet();
  ['Loggro_Debug', 'Recetas_Debug'].forEach(function(nombre) {
    const hoja = ss.getSheetByName(nombre);
    if (hoja) ss.deleteSheet(hoja);
  });
  Logger.log('Pestañas de diagnóstico borradas.');
}

// Corre todo en orden: ventas → consumo teórico
function sincronizarLoggroCompleto(diasAtras) {
  sincronizarVentasLoggro(diasAtras);
  calcularConsumoTeoricoLoggro(diasAtras);
}

// Versión chica para correr desde el desplegable sin pasar argumentos
// (Apps Script no deja pasar parámetros desde el botón Ejecutar).
// Usar esta mientras probamos, para no chocar con el límite de 6
// minutos de ejecución que tiene Apps Script en cuentas normales.
function sincronizarLoggroCompleto7dias() {
  sincronizarLoggroCompleto(7);
}

// ------------------------------------------------------------
// Refresco automático diario (agregado 2026-09-07, ver
// configurarTriggerLoggro() en setup_triggers.gs) — pensado para
// correr solo por trigger, sin que nadie tenga que acordarse de
// ejecutar los 3 pasos a mano. Trae ventas de los últimos 7 días
// (suficiente margen aunque el trigger falle un día puntual) y
// refresca Costo_Diario sobre los últimos 30. No corre
// generarMapeoCostos() ni los pasos de mapeo — esos siguen siendo
// manuales porque necesitan criterio humano.
function refrescoDiarioAutomatico() {
  sincronizarLoggroCompleto(7);
  calcularCostoDiarioLoggro(30);
  Logger.log('Refresco automático diario completo.');
}

// Recalcula SOLO el cruce Ventas × Recetas (Consumo_Teorico +
// Platos_Sin_Receta) sobre los últimos 30 días de Ventas que YA
// están guardados en el Sheet — no vuelve a pedirle nada a Loggro,
// así que es rápido y no choca con el límite de 6 minutos. Usar
// esta después de agregar/renombrar recetas para refrescar el
// reporte sin tener que re-sincronizar ventas.
function recalcularConsumoTeorico30dias() {
  calcularConsumoTeoricoLoggro(30);
}

// ------------------------------------------------------------
// DIAGNÓSTICO — lista todos los platos de la hoja Recetas para
// comparar a ojo contra los nombres que vienen de Loggro (ver
// hoja Platos_Sin_Receta). Se escribe en la columna C de
// Loggro_Debug para tenerlo todo junto.
// ------------------------------------------------------------
function listarPlatosRecetas() {
  const ss = abrirSheet();
  const recetasPorPlato = leerRecetasPorPlato(ss); // ya normaliza a MAYÚSCULAS

  let hoja = ss.getSheetByName('Loggro_Debug');
  if (!hoja) hoja = ss.insertSheet('Loggro_Debug');

  const platos = Object.keys(recetasPorPlato).sort();
  hoja.getRange(1, 3).setValue('Platos que YA existen en Recetas (' + platos.length + '):');
  const filas = platos.map(function(p) { return [p]; });
  if (filas.length) {
    hoja.getRange(2, 3, filas.length, 1).setValues(filas);
  }
  hoja.setColumnWidth(3, 350);

  Logger.log('Listo. ' + platos.length + ' platos listados en Loggro_Debug, columna C.');
}

// ------------------------------------------------------------
// DIAGNÓSTICO — vuelca la hoja Recetas completa (Categoría, Plato,
// Ingrediente, Cantidad, Unidad) en una hoja nueva "Recetas_Debug",
// para poder revisar ingredientes reales y no solo nombres de plato
// (útil para confirmar si un plato "sin receta" en realidad ya
// existe con otro nombre, ej. una hamburguesa guardada con nombre
// de autor).
// ------------------------------------------------------------
function volcarRecetasCompleto() {
  const ss = abrirSheet();
  const hojaRecetas = ss.getSheetByName('Recetas');
  if (!hojaRecetas) throw new Error('Hoja "Recetas" no encontrada.');
  const datos = hojaRecetas.getDataRange().getValues();

  let hoja = ss.getSheetByName('Recetas_Debug');
  if (!hoja) hoja = ss.insertSheet('Recetas_Debug');
  hoja.clear();
  hoja.getRange(1, 1, datos.length, datos[0].length).setValues(datos);

  Logger.log('Listo. ' + (datos.length - 1) + ' filas volcadas en Recetas_Debug.');
}

// ------------------------------------------------------------
// DIAGNÓSTICO — trae una muestra chica de pedidos reales y la
// vuelca en la hoja "Loggro_Debug" para poder ver la forma real
// del JSON (nombres de campo de producto/cantidad/fecha) antes
// de construir el parseo definitivo de Ventas.
// ------------------------------------------------------------
function diagnosticarPedidosLoggro() {
  const token = loginLoggro();
  const ahora   = new Date();
  const desde   = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);

  const data = loggroFetch(
    '/orders?pagination=true&limit=3&page=0' +
    '&dateInit=' + encodeURIComponent(desde.toISOString()) +
    '&dateEnd='  + encodeURIComponent(ahora.toISOString()),
    token
  );

  const ss = abrirSheet();
  let hoja = ss.getSheetByName('Loggro_Debug');
  if (!hoja) hoja = ss.insertSheet('Loggro_Debug');
  hoja.clear();
  hoja.getRange(1, 1).setValue('Copiá TODO el contenido de la celda de abajo y pegalo en el chat con Claude:');
  hoja.getRange(2, 1).setValue(JSON.stringify(data, null, 2));
  hoja.setColumnWidth(1, 900);
  hoja.getRange(2, 1).setWrap(true);

  Logger.log('Listo. Revisá la hoja "Loggro_Debug".');
}

// ------------------------------------------------------------
// DIAGNÓSTICO — lo mismo pero para /products, útil para revisar
// si los nombres de plato de Loggro calzan con los de nuestra
// hoja Recetas (mayúsculas, tildes, etc.)
// ------------------------------------------------------------
function diagnosticarProductosLoggro() {
  const token = loginLoggro();
  const data  = loggroFetch('/products?pagination=true&limit=15&page=0', token);

  const ss = abrirSheet();
  let hoja = ss.getSheetByName('Loggro_Debug');
  if (!hoja) hoja = ss.insertSheet('Loggro_Debug');
  hoja.getRange(4, 1).setValue('Productos (para comparar nombres con la hoja Recetas):');
  hoja.getRange(5, 1).setValue(JSON.stringify(data, null, 2));
  hoja.getRange(5, 1).setWrap(true);

  Logger.log('Listo. Revisá la hoja "Loggro_Debug" (filas 4-5).');
}

// ============================================================
// COSTEO — Fase 2, paso 2: valorizar Consumo_Teorico en pesos y
// cruzarlo contra Ingresos (Ventas) por día.
//
// PROBLEMA REAL (encontrado 2026-07-27 leyendo el Sheet): los
// nombres de Recetas.Ingrediente son lenguaje de cocina ("churrasco
// (res)", "papa", "ajo", "ensalada") y NO calzan con los nombres
// comerciales de Detalle/Precios ("LOMO VICHE ESPECIAL", "PAPA
// AMARILLA X 40KG"). Se probó matching automático (texto/fuzzy) y
// da falsos positivos peligrosos para plata real (ej. "sal" →
// "SALSA DE AGRAS", "paprika" → "PAPA AMARILLA"). No hay atajo
// confiable: hace falta que una persona confirme, UNA vez por
// ingrediente (no por receta ni por venta), qué producto de compra
// real le corresponde.
//
// Por eso el costeo se hace en dos funciones separadas:
//   1. generarMapeoCostos()      → arma/actualiza la hoja de trabajo
//      Mapeo_Costos, con sugerencias de referencia y priorizada por
//      qué ingrediente más se usa en las recetas. Mario/Sebastián
//      completan las columnas E y F (ver detalle abajo). Segura de
//      re-correr: nunca pisa lo que ya esté completado a mano.
//   2. calcularCostoDiarioLoggro(diasAtras) → usa SOLO lo que ya
//      esté confirmado en Mapeo_Costos para valorizar Consumo_Teorico
//      y compararlo contra Ventas.Ingresos por día, e informa qué
//      % del consumo teórico quedó cubierto (para no leer el número
//      como si fuera 100% del costo real cuando falte mapeo).
// ============================================================

// ------------------------------------------------------------
// Arma/actualiza la hoja "Mapeo_Costos": un renglón por cada
// ingrediente distinto que aparece en Recetas, ordenado por
// frecuencia de uso (prioridad de a cuál completar primero).
//
// Columnas:
//   A Ingrediente               — tal cual aparece en Recetas
//   B Unidad receta             — gr/ml/und (de Recetas)
//   C Frecuencia                — en cuántas líneas de Recetas aparece
//   D Sugerencia (verificar)    — mejor match de texto contra los
//                                 nombres reales de Detalle. Es SOLO
//                                 referencia para ahorrar tipeo, NO
//                                 confiar ciego (ver nota arriba).
//   E Producto de compra confirmado — llenar a mano con el nombre
//                                 EXACTO como aparece en Detalle,
//                                 columna "Producto / Descripción".
//                                 Mientras esté vacío, ese ingrediente
//                                 no entra al cálculo de costo diario.
//   F Presentación               — cuánto trae 1 unidad comprada, EN
//                                 LA MISMA UNIDAD que la columna B.
//                                 Ej.: si E = "PAPA AMARILLA X 40KG" y
//                                 B = "gr", acá va 40000.
//
// Re-correr esto es seguro (ej. después de agregar una receta nueva):
// solo agrega ingredientes que todavía no estén en la hoja, nunca
// toca una fila que ya tenga algo en E o F.
function generarMapeoCostos() {
  const ss = abrirSheet();

  const hojaRecetas = ss.getSheetByName('Recetas');
  if (!hojaRecetas) throw new Error('Hoja "Recetas" no encontrada.');
  const datosRecetas = hojaRecetas.getDataRange().getValues();
  const freq = {}; // ingrediente -> { unidad, count }
  for (let i = 1; i < datosRecetas.length; i++) {
    const ing = normTxt(datosRecetas[i][2]);
    const und = normTxt(datosRecetas[i][4]);
    if (!ing) continue;
    if (!freq[ing]) freq[ing] = { unidad: und, count: 0 };
    freq[ing].count++;
  }

  const hojaDetalle = ss.getSheetByName('Detalle');
  if (!hojaDetalle) throw new Error('Hoja "Detalle" no encontrada.');
  const datosDetalle = hojaDetalle.getDataRange().getValues();
  const productosDetalle = {}; // PRODUCTO_MAYUSCULAS -> nombre original tal cual en Detalle
  for (let i = 1; i < datosDetalle.length; i++) {
    const prod = normTxt(datosDetalle[i][4]);
    if (prod) productosDetalle[prod.toUpperCase()] = prod;
  }
  const listaProductos = Object.keys(productosDetalle);

  let hoja = ss.getSheetByName('Mapeo_Costos');
  const existentes = {}; // ingrediente -> true (ya está en la hoja, no pisar)
  if (!hoja) {
    hoja = ss.insertSheet('Mapeo_Costos');
    hoja.appendRow(['Ingrediente', 'Unidad receta', 'Frecuencia', 'Sugerencia (verificar)', 'Producto de compra confirmado', 'Presentación (cantidad por unidad comprada)']);
    hoja.getRange(1, 1, 1, 6).setFontWeight('bold');
    hoja.setColumnWidth(1, 220);
    hoja.setColumnWidth(4, 260);
    hoja.setColumnWidth(5, 260);
  } else {
    const datosHoja = hoja.getDataRange().getValues();
    for (let i = 1; i < datosHoja.length; i++) {
      const ing = normTxt(datosHoja[i][0]);
      if (ing) existentes[ing] = true;
    }
  }

  const filasNuevas = [];
  Object.keys(freq).forEach(function(ing) {
    if (existentes[ing]) return;
    const sugerencia = sugerirProductoCompra(ing, listaProductos, productosDetalle);
    filasNuevas.push([ing, freq[ing].unidad, freq[ing].count, sugerencia, '', '']);
  });
  filasNuevas.sort(function(a, b) { return b[2] - a[2]; });

  if (filasNuevas.length) {
    hoja.getRange(hoja.getLastRow() + 1, 1, filasNuevas.length, 6).setValues(filasNuevas);
  }

  Logger.log('Mapeo_Costos: ' + filasNuevas.length + ' ingredientes nuevos agregados (frecuencia ya calculada). Total ingredientes distintos en Recetas: ' + Object.keys(freq).length + '.');
}

// Sugerencia de texto simple (cuenta palabras de 4+ letras del
// ingrediente que aparecen dentro del nombre del producto de
// Detalle). Es deliberadamente ingenua — cualquier heurística más
// "inteligente" (fuzzy/similarity) probamos y dio falsos positivos
// con plata real de por medio. Devuelve '' si no hay ningún candidato.
function sugerirProductoCompra(ingrediente, listaProductos, productosDetalle) {
  const ingNorm = ingrediente.toUpperCase().replace(/[()]/g, '').trim();
  const palabras = ingNorm.split(/\s+/).filter(function(p) { return p.length >= 4; });
  if (!palabras.length) return '';

  let mejor = '';
  let mejorScore = 0;
  listaProductos.forEach(function(prodMayus) {
    let score = 0;
    palabras.forEach(function(palabra) {
      if (prodMayus.indexOf(palabra) !== -1) score++;
    });
    if (score > mejorScore) {
      mejorScore = score;
      mejor = productosDetalle[prodMayus];
    }
  });
  return mejorScore > 0 ? mejor : '';
}

// ------------------------------------------------------------
// Autocompleta E y F en Mapeo_Costos donde se puede resolver SIN
// adivinar (agregado 2026-07-27 porque completar las ~194 filas a
// mano era demasiado trabajo):
//   Regla 1 — el nombre del producto en Sugerencia ya trae el tamaño
//   (ej. "LECHUGA BIOFRESCOS*160g" → Presentación 160).
//   Regla 2 — el producto se compra "a granel" por peso/volumen: si
//   Detalle dice que ESE producto exacto se compra en KG/LB (para
//   ingredientes en gr) o L/ML (para ingredientes en ml), la
//   Presentación sale de la conversión fija (1 KG = 1000 gr, etc.),
//   no hace falta leer el nombre.
//
// Deja SIN tocar (alguien tiene que decidir a mano): ingredientes en
// "und" (una unidad comprada puede traer cualquier cantidad — bolsa
// de brochetas, caja de huevos, no hay forma de saberlo solo), sin
// Sugerencia, o donde la Sugerencia no calza con ninguna regla.
//
// Cada fila que resuelve así queda marcada "Auto (revisar)" en la
// columna G, para distinguirla de una confirmada a mano — no es lo
// mismo el script adivinando que una persona mirando la factura, así
// que en algún momento vale la pena una pasada de ojo rápida, pero
// esto no bloquea seguir adelante con el costeo mientras tanto.
//
// Segura de re-correr: nunca pisa una fila que ya tenga algo en E o F.
function autocompletarPresentacionMapeoCostos() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Mapeo_Costos');
  if (!hoja) throw new Error('No existe la hoja Mapeo_Costos. Corré generarMapeoCostos() primero.');

  const hojaDetalle = ss.getSheetByName('Detalle');
  const datosDetalle = hojaDetalle.getDataRange().getValues();
  const conteoUnidad = {}; // PRODUCTO_MAYUS -> { UND_COMPRA: count }
  for (let i = 1; i < datosDetalle.length; i++) {
    const prod = normTxt(datosDetalle[i][4]).toUpperCase();
    const und = normTxt(datosDetalle[i][6]).toUpperCase();
    if (!prod || !und) continue;
    if (!conteoUnidad[prod]) conteoUnidad[prod] = {};
    conteoUnidad[prod][und] = (conteoUnidad[prod][und] || 0) + 1;
  }
  function unidadMasComun(prod) {
    const c = conteoUnidad[prod.toUpperCase()];
    if (!c) return null;
    let mejor = null, mejorN = 0;
    Object.keys(c).forEach(function(u) { if (c[u] > mejorN) { mejorN = c[u]; mejor = u; } });
    return mejor;
  }

  const CONV_GR = { KG: 1000, GR: 1, G: 1, LB: 453.592, OZ: 28.3495 };
  const CONV_ML = { L: 1000, LT: 1000, ML: 1 };
  const patronNumero = /(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ml|lb|oz)\b/i;

  const datos = hoja.getDataRange().getValues();
  const encabezado = datos[0].slice();
  while (encabezado.length < 7) encabezado.push('');
  encabezado[6] = 'Origen';

  let completadas = 0;
  const pendientes = [];
  const filas = [];

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i].slice();
    while (fila.length < 7) fila.push('');

    const ingrediente = normTxt(fila[0]);
    const unidadReceta = normTxt(fila[1]).toLowerCase();
    const sugerencia = normTxt(fila[3]);
    const yaProdCompra = normTxt(fila[4]);
    const yaPresentacion = fila[5];

    if (ingrediente && !yaProdCompra && !yaPresentacion) {
      let resuelto = false;

      if ((unidadReceta === 'gr' || unidadReceta === 'ml') && sugerencia) {
        // Regla 1: número en el nombre del producto
        const m = sugerencia.match(patronNumero);
        if (m) {
          let cantidad = parseFloat(m[1].replace(',', '.'));
          let unidadProd = m[2].toLowerCase();
          if (unidadProd === 'g') unidadProd = 'gr';
          if (unidadReceta === 'gr' && (unidadProd === 'gr' || unidadProd === 'kg' || unidadProd === 'lb' || unidadProd === 'oz')) {
            if (unidadProd === 'kg') cantidad *= 1000;
            else if (unidadProd === 'lb') cantidad *= 453.592;
            else if (unidadProd === 'oz') cantidad *= 28.3495;
            resuelto = true;
          } else if (unidadReceta === 'ml' && unidadProd === 'ml') {
            resuelto = true;
          }
          if (resuelto) {
            fila[4] = sugerencia;
            fila[5] = Math.round(cantidad * 100) / 100;
            fila[6] = 'Auto (revisar)';
          }
        }

        // Regla 2: se compra a granel por peso/volumen (Detalle dice KG/LB/L/ML)
        if (!resuelto) {
          const umc = unidadMasComun(sugerencia);
          if (umc) {
            if (unidadReceta === 'gr' && CONV_GR[umc] !== undefined) {
              fila[4] = sugerencia;
              fila[5] = CONV_GR[umc];
              fila[6] = 'Auto (revisar)';
              resuelto = true;
            } else if (unidadReceta === 'ml' && CONV_ML[umc] !== undefined) {
              fila[4] = sugerencia;
              fila[5] = CONV_ML[umc];
              fila[6] = 'Auto (revisar)';
              resuelto = true;
            }
          }
        }
      }

      if (resuelto) completadas++;
      else pendientes.push(ingrediente);
    }

    filas.push(fila);
  }

  hoja.clearContents();
  hoja.getRange(1, 1, 1, 7).setValues([encabezado]);
  if (filas.length) hoja.getRange(2, 1, filas.length, 7).setValues(filas);

  Logger.log('Autocompletadas ' + completadas + ' filas (marcadas "Auto (revisar)" en columna G). Quedan ' + pendientes.length + ' por completar a mano:\n' + pendientes.join(', '));
}

// ------------------------------------------------------------
// MIGRACIÓN PUNTUAL — respuestas de Sebastián por WhatsApp
// (2026-07-27) sobre qué compran para sal, ajo, crema de leche,
// limón, papas, palo de brocheta y aceite. Completa Mapeo_Costos
// con eso, buscando el producto real más parecido en Detalle.
//
// Quedaron AFUERA a propósito:
//   - Pimienta: "al granel, se compra por libras, no la facturan"
//     → no hay ninguna factura DIAN con "pimienta", así que no hay
//     de dónde sacar el precio automático todavía (compra informal).
//   - Mantequilla: "en bloque, no la facturan" → mismo problema,
//     aunque raro, porque SÍ aparece "MANTEQUILLA" 5 veces en
//     Detalle — puede ser una compra distinta a la del bloque que
//     describe Sebastián. Falta aclarar antes de asumir cuál es.
//   - "La crema se hace" ahí mismo → no es un insumo comprado, es
//     una preparación con otros ingredientes. Para que cuente en el
//     costo hay que desglosarla en Recetas en sus ingredientes reales
//     (mismo problema que Bechamel/Boloñesa, ver nota de arquitectura
//     en Precios más arriba), no algo que resuelva Mapeo_Costos.
//
// OJO — dos respuestas no calzan exacto con lo que hay en las
// facturas reales, usé lo más parecido que encontré y lo dejé
// anotado para confirmar con Sebastián si hace falta:
//   - Ajo: dijo bolsas de 250g: en Detalle solo existe de 150g
//     (AJO*150g MALLA, 22 compras) — usé esa.
//   - Limón: dijo malla de 500g: en Detalle solo existe de 1000g
//     (LIMON*1000g MALLA, 27 compras) — usé esa.
//
// Aplica por ingrediente NORMALIZADO (sal/Sal/SAL reciben la misma
// respuesta) porque Recetas tiene el mismo ingrediente escrito con
// mayúsculas distintas en filas separadas. Segura de re-correr:
// nunca pisa una fila que ya tenga algo en E o F.
function aplicarMapeoCostosSebastian2707() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Mapeo_Costos');
  if (!hoja) throw new Error('No existe la hoja Mapeo_Costos. Corré generarMapeoCostos() primero.');

  const RESPUESTAS = {
    'sal': { producto: 'SAL REFISAL*1000g', presentacion: 1000 },
    'ajo': { producto: 'AJO*150g MALLA', presentacion: 150 },
    'crema de leche': { producto: 'CREMA DE LECHE ALQUERIA*1000g INSTITUCIO', presentacion: 1000 },
    'limon': { producto: 'LIMON*1000g MALLA', presentacion: 1000 },
    'palo brocheta': { producto: 'PALO BOCHETA', presentacion: 100 },
    'papas': { producto: 'PAPA A LA FRANCESA PAQ 2.5 KL', presentacion: 2500 },
    'papas a la francesa': { producto: 'PAPA A LA FRANCESA PAQ 2.5 KL', presentacion: 2500 },
    'papa francesa': { producto: 'PAPA A LA FRANCESA PAQ 2.5 KL', presentacion: 2500 },
    'aceite': { producto: 'ACEITE DONA LUPE*3000ml GIRASOL 100%', presentacion: 3000 }
  };

  function normalizar(s) {
    return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  const datos = hoja.getDataRange().getValues();
  let aplicadas = 0;
  const filas = datos.map(function(fila, i) {
    const f = fila.slice();
    while (f.length < 7) f.push('');
    if (i === 0) { f[6] = f[6] || 'Origen'; return f; }

    const ingNorm = normalizar(f[0]);
    const yaE = normTxt(f[4]);
    const yaF = f[5];
    const respuesta = RESPUESTAS[ingNorm];
    if (!yaE && !yaF && respuesta) {
      f[4] = respuesta.producto;
      f[5] = respuesta.presentacion;
      f[6] = 'Sebastián (confirmado 2026-07-27)';
      aplicadas++;
    }
    return f;
  });

  hoja.clearContents();
  hoja.getRange(1, 1, filas.length, 7).setValues(filas);

  Logger.log('Aplicadas ' + aplicadas + ' filas con las respuestas de Sebastián. Pimienta, mantequilla y "crema" (se hace ahí) quedaron pendientes a propósito — ver comentario de la función.');
}

// ------------------------------------------------------------
// MIGRACIÓN PUNTUAL — segunda pasada (2026-07-27), resuelta por mí
// directo contra Detalle, sin necesidad de preguntarle nada a nadie:
// proteínas que se compran "a granel" por peso (KG confirmado en
// Detalle, misma lógica que tocineta/plátano/cebolla) y productos
// donde el tamaño ya viene en el propio nombre pero la Sugerencia
// automática de la columna D no había enganchado con ese candidato.
// Segura de re-correr: nunca pisa una fila que ya tenga algo en E o F.
function aplicarMapeoCostosSegundaPasada2707() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Mapeo_Costos');
  if (!hoja) throw new Error('No existe la hoja Mapeo_Costos.');

  const RESPUESTAS = {
    'pechuga': { producto: 'PECHUGA CAMPOLLO CAMPO A GRANEL', presentacion: 1000 },
    'pollo': { producto: 'PECHUGA CAMPOLLO CAMPO A GRANEL', presentacion: 1000 },
    'churrasquillo de pollo': { producto: 'PECHUGA CAMPOLLO CAMPO A GRANEL', presentacion: 1000 },
    'cubos de pollo': { producto: 'PECHUGA CAMPOLLO CAMPO A GRANEL', presentacion: 1000 },
    'costilla tipo llanera': { producto: 'COSTILLA CERDO A GRANEL', presentacion: 1000 },
    'naranja': { producto: 'NARANJA DULCE MIEL A GRANEL', presentacion: 1000 },
    'zumo de naranja': { producto: 'ZUMO AGROCITRICOS*1000ml NARANJA', presentacion: 1000 },
    'queso mozarrella': { producto: 'QUESO MOZZARELLA PAMPA CHEESE X KG', presentacion: 1000 },
    'cereza': { producto: 'CEREZAS PASCUALI*1000g D/P', presentacion: 1000 },
    'molde': { producto: 'MOLDE DOMINGO*6und LASANA ALUMINIO', presentacion: 6 },
    'huevos': { producto: 'HUEVO ORO A*30und ROSADO AMARRADO', presentacion: 30 },
    'vinagre': { producto: 'VINAGRE ALFRESCO*4000ml BLANCO', presentacion: 4000 }
  };

  function normalizar(s) {
    return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  const datos = hoja.getDataRange().getValues();
  let aplicadas = 0;
  const filas = datos.map(function(fila, i) {
    const f = fila.slice();
    while (f.length < 7) f.push('');
    if (i === 0) return f;

    const ingNorm = normalizar(f[0]);
    const yaE = normTxt(f[4]);
    const yaF = f[5];
    const respuesta = RESPUESTAS[ingNorm];
    if (!yaE && !yaF && respuesta) {
      f[4] = respuesta.producto;
      f[5] = respuesta.presentacion;
      f[6] = 'Auto (revisar) - 2da pasada';
      aplicadas++;
    }
    return f;
  });

  hoja.clearContents();
  hoja.getRange(1, 1, filas.length, 7).setValues(filas);

  Logger.log('Aplicadas ' + aplicadas + ' filas en la segunda pasada.');
}

// ------------------------------------------------------------
// Valoriza Consumo_Teorico usando SOLO lo que ya esté confirmado
// en Mapeo_Costos (columnas E y F llenas) y lo compara contra
// Ventas.Ingresos, día por día. Escribe la hoja "Costo_Diario":
//   Fecha | Costo Insumo Teórico ($) | Ingresos del día ($) |
//   % Costo Insumo | % Consumo cubierto (cuántas líneas de
//   Consumo_Teorico ese día SÍ tenían mapeo confirmado — para
//   saber qué tan completo está el número, no leerlo como el
//   costo real total mientras falte mapeo)
//
// El costo por unidad de compra sale del PROMEDIO de "Precio
// Unitario" en Detalle para ese "Producto de compra confirmado"
// dentro de los últimos 90 días (para no quedar pegado a un precio
// viejo ni a un solo pico puntual).
//
// COLUMNA H "Costo manual ($/unidad receta)" (agregada 2026-09-07):
// fallback para ingredientes que NUNCA van a tener una factura real
// que promediar — preparaciones internas (salsas, encurtidos) cuyo
// costo se calculó aparte a mano (ver `aplicarCostoManualSubrecetas0709`
// más abajo) o insumos que se compran informalmente sin factura
// (pimienta, mantequilla). Si un ingrediente tiene E y F llenos, se
// usa Detalle como siempre; si no, y tiene H, se usa H directo como
// $/unidad de receta sin pasar por Detalle.
function calcularCostoDiarioLoggro(diasAtras) {
  diasAtras = diasAtras || 30;
  const ss = abrirSheet();

  const hojaMapeo = ss.getSheetByName('Mapeo_Costos');
  if (!hojaMapeo) throw new Error('No existe la hoja Mapeo_Costos. Corré generarMapeoCostos() primero.');
  const datosMapeo = hojaMapeo.getDataRange().getValues();

  const mapeo = {};        // ingrediente -> { productoCompra, presentacion }
  const costoManual = {};  // ingrediente -> $/unidad receta (fallback sin Detalle)
  for (let i = 1; i < datosMapeo.length; i++) {
    const ing = normTxt(datosMapeo[i][0]);
    const productoCompra = normTxt(datosMapeo[i][4]);
    const presentacion = Number(datosMapeo[i][5]) || 0;
    const manual = Number(datosMapeo[i][7]) || 0;
    if (ing && productoCompra && presentacion > 0) {
      mapeo[ing] = { productoCompra: productoCompra, presentacion: presentacion };
    } else if (ing && manual > 0) {
      costoManual[ing] = manual;
    }
  }
  if (!Object.keys(mapeo).length && !Object.keys(costoManual).length) {
    Logger.log('Mapeo_Costos no tiene ninguna fila confirmada todavía (columnas E/F o H vacías). Completá al menos los ingredientes de mayor Frecuencia antes de correr esto.');
    return;
  }

  // Precio unitario promedio (últimos 90 días) por producto de compra, desde Detalle
  const ahora = new Date();
  const desdePrecio = new Date(ahora.getTime() - 90 * 24 * 60 * 60 * 1000);
  const hojaDetalle = ss.getSheetByName('Detalle');
  const datosDetalle = hojaDetalle.getDataRange().getValues();
  const acumPrecio = {}; // producto (normTxt) -> { suma, n }
  for (let i = 1; i < datosDetalle.length; i++) {
    const fecha = datosDetalle[i][0];
    if (!(fecha instanceof Date) || fecha < desdePrecio) continue;
    const prod = normTxt(datosDetalle[i][4]);
    const precioUnit = Number(datosDetalle[i][7]) || 0;
    if (!prod || !precioUnit) continue;
    if (!acumPrecio[prod]) acumPrecio[prod] = { suma: 0, n: 0 };
    acumPrecio[prod].suma += precioUnit;
    acumPrecio[prod].n++;
  }
  const precioPromedio = {}; // producto -> $/unidad comprada
  Object.keys(acumPrecio).forEach(function(prod) {
    precioPromedio[prod] = acumPrecio[prod].suma / acumPrecio[prod].n;
  });

  // Costo por unidad de receta (gr/ml/und) para cada ingrediente mapeado
  const costoPorUnidadReceta = {}; // ingrediente -> $/unidad receta
  const sinPrecioReciente = [];
  Object.keys(mapeo).forEach(function(ing) {
    const m = mapeo[ing];
    const precio = precioPromedio[m.productoCompra];
    if (!precio) { sinPrecioReciente.push(ing + ' (' + m.productoCompra + ')'); return; }
    costoPorUnidadReceta[ing] = precio / m.presentacion;
  });
  // Fallback: ingredientes con costo manual (columna H) y sin Detalle
  Object.keys(costoManual).forEach(function(ing) {
    if (costoPorUnidadReceta[ing] === undefined) costoPorUnidadReceta[ing] = costoManual[ing];
  });

  // Consumo_Teorico → valorizar día por día
  const hojaConsumo = ss.getSheetByName('Consumo_Teorico');
  if (!hojaConsumo) throw new Error('No existe la hoja Consumo_Teorico. Corré calcularConsumoTeoricoLoggro() primero.');
  const datosConsumo = hojaConsumo.getDataRange().getValues();

  const desde = new Date(ahora.getTime() - diasAtras * 24 * 60 * 60 * 1000);
  const desdeStr = Utilities.formatDate(desde, 'America/Bogota', 'yyyy-MM-dd');
  const hastaStr = Utilities.formatDate(ahora, 'America/Bogota', 'yyyy-MM-dd');

  const costoPorDia = {};    // fecha -> $
  const lineasPorDia = {};   // fecha -> { total, cubiertas }
  for (let i = 1; i < datosConsumo.length; i++) {
    const fila = datosConsumo[i];
    const fecha = formatFecha(fila[0]);
    if (!fecha || fecha < desdeStr || fecha > hastaStr) continue;
    const ing = normTxt(fila[1]);
    const cantidad = Number(fila[3]) || 0;

    if (!lineasPorDia[fecha]) lineasPorDia[fecha] = { total: 0, cubiertas: 0 };
    lineasPorDia[fecha].total++;

    const costoUnit = costoPorUnidadReceta[ing];
    if (costoUnit === undefined) continue;
    lineasPorDia[fecha].cubiertas++;
    costoPorDia[fecha] = (costoPorDia[fecha] || 0) + costoUnit * cantidad;
  }

  // Ventas → ingresos por día
  const hojaVentas = ss.getSheetByName('Ventas');
  const datosVentas = hojaVentas.getDataRange().getValues();
  const ingresosPorDia = {};
  for (let i = 1; i < datosVentas.length; i++) {
    const fecha = formatFecha(datosVentas[i][0]);
    if (!fecha || fecha < desdeStr || fecha > hastaStr) continue;
    ingresosPorDia[fecha] = (ingresosPorDia[fecha] || 0) + (Number(datosVentas[i][3]) || 0);
  }

  // Escribir hoja Costo_Diario — MERGE-PRESERVE (cambiado 2026-09-07,
  // mismo patrón que escribirHojaVentas/escribirHojaConsumoTeorico):
  // antes esto hacía hojaSalida.clear() y sólo dejaba los días de la
  // ventana [desdeStr,hastaStr] — cada corrida (incluido el trigger
  // diario, que siempre pide 30 días) borraba los meses anteriores ya
  // calculados. Ahora se preservan las filas de días FUERA de la
  // ventana actual y sólo se reemplazan/agregan los días de adentro.
  let hojaSalida = ss.getSheetByName('Costo_Diario');
  const encabezadoCosto = ['Fecha', 'Costo Insumo Teórico', 'Ingresos', '% Costo Insumo', '% Consumo cubierto por Mapeo_Costos'];
  if (!hojaSalida) hojaSalida = ss.insertSheet('Costo_Diario');

  const datosCostoPrevios = hojaSalida.getDataRange().getValues();
  const filasFueraCosto = [];
  for (let i = 1; i < datosCostoPrevios.length; i++) {
    const fecha = formatFecha(datosCostoPrevios[i][0]);
    if (fecha && !(fecha >= desdeStr && fecha <= hastaStr)) filasFueraCosto.push(datosCostoPrevios[i]);
  }

  const todasFechas = {};
  Object.keys(costoPorDia).forEach(function(f) { todasFechas[f] = true; });
  Object.keys(ingresosPorDia).forEach(function(f) { todasFechas[f] = true; });

  const filasNuevasCosto = Object.keys(todasFechas).sort().map(function(fecha) {
    const costo = costoPorDia[fecha] || 0;
    const ingresos = ingresosPorDia[fecha] || 0;
    const pctCosto = ingresos ? (costo / ingresos) : 0;
    const cobertura = lineasPorDia[fecha] ? (lineasPorDia[fecha].cubiertas / lineasPorDia[fecha].total) : 0;
    return [fecha, costo, ingresos, pctCosto, cobertura];
  });

  const filas = filasFueraCosto.concat(filasNuevasCosto)
    .sort(function(a, b) { return formatFecha(a[0]).localeCompare(formatFecha(b[0])); });

  hojaSalida.clearContents();

  // Reset defensivo (agregado 2026-09-07 tras el error real "No
  // puedes configurar el formato de número de las celdas de una
  // columna con texto"): alguna fila vieja de Costo_Diario quedó con
  // formato de columna "Texto" (probablemente de una edición manual
  // en el Sheet), y eso hace que setNumberFormat() truene más abajo.
  // Se limpia el formato de las columnas B:E a nivel de COLUMNA
  // completa antes de aplicar el formato real — así no importa cuál
  // fila específica tenía el formato de texto pegado.
  try {
    hojaSalida.getRange('B:E').setNumberFormat('General');
  } catch (eReset) {
    Logger.log('Aviso: no se pudo limpiar el formato previo de B:E (' + eReset.message + '), se sigue igual.');
  }

  hojaSalida.getRange(1, 1, 1, encabezadoCosto.length).setValues([encabezadoCosto]);
  hojaSalida.getRange(1, 1, 1, 5).setFontWeight('bold');
  if (filas.length) {
    hojaSalida.getRange(2, 1, filas.length, 5).setValues(filas);
    // Estos try/catch son solo cosmética (cómo se ve el número): si
    // fallan, los datos de arriba ya quedaron bien escritos igual —
    // nunca deben tumbar el cálculo completo.
    try {
      hojaSalida.getRange(2, 4, filas.length, 1).setNumberFormat('0.0%');
      hojaSalida.getRange(2, 5, filas.length, 1).setNumberFormat('0.0%');
      hojaSalida.getRange(2, 2, filas.length, 2).setNumberFormat('$#,##0');
    } catch (eFormat) {
      Logger.log('Aviso: los datos de Costo_Diario se escribieron bien, pero el formato de número falló (' + eFormat.message + '). Los valores son correctos aunque se vean como decimales en vez de %/$.');
    }
  }

  Logger.log('Costo_Diario listo: ' + filasNuevasCosto.length + ' día(s) recalculado(s) en esta corrida, ' + filas.length + ' día(s) en total en la hoja. Ingredientes mapeados sin precio reciente en los últimos 90 días (' + sinPrecioReciente.length + '): ' + sinPrecioReciente.join(', '));
}

// Corrida única 2026-09-07: recalcula Costo_Diario para TODO el
// historial que ya existe en Ventas/Consumo_Teorico (arrancan el
// 2026-06-09, que es cuando empezaron los datos de Loggro — Compras
// sí llega hasta enero, pero Ventas depende del POS y ahí es de
// verdad donde arranca) en vez de sólo los últimos 30 días que trae
// calcularCostoDiarioLoggro() por defecto. Gracias al cambio
// merge-preserve de arriba, después de correr esto UNA VEZ el
// trigger diario (calcularCostoDiarioLoggro(30) vía
// refrescoDiarioAutomatico) ya no vuelve a borrar estos meses —
// sólo refresca los últimos 30 días. Ejecutar una sola vez desde el
// desplegable de Apps Script (archivo loggro_sync.gs).
function calcularCostoDiarioTodoElHistorial() {
  calcularCostoDiarioLoggro(100);
}

// ============================================================
// MIGRACIÓN PUNTUAL 2026-09-07 — costo manual para preparaciones
// internas (salsas/encurtidos que Malagana arma ahí mismo, no las
// compra), usando el costeo por lote que ya estaba calculado en
// "Costo total recetas .xlsx" (pestaña "SUB RESETAS"). Cada sub-
// receta ahí trae su lote total en gramos y su costo total con 10%
// de margen de error ya incluido — dividí uno entre otro para sacar
// el $/gr que se guarda en la columna H de Mapeo_Costos.
//
// Esto no reemplaza aplanar la receta en ingredientes base (ideal a
// futuro), pero desbloquea el costeo YA sin depender de Sebastián ni
// de una factura que nunca va a existir para "chimichurri" o "miel
// de caña" como tales.
//
// Segura de re-correr: nunca pisa una fila que ya tenga algo en E/F
// (esas se resuelven por Detalle, tienen prioridad) ni en H.
function aplicarCostoManualSubrecetas0709() {
  const ss = abrirSheet();
  const hoja = ss.getSheetByName('Mapeo_Costos');
  if (!hoja) throw new Error('No existe la hoja Mapeo_Costos.');

  // ingrediente normalizado -> $/gr (o $/ml), sacado de SUB RESETAS:
  // costo total del lote (con margen 10%) ÷ gramos totales del lote.
  const COSTO_MANUAL = {
    'alioli': 10.8366,               // ALIOLI DE CILANTRO: 7368.9 / 680gr
    'salsa alioli': 10.8366,
    'cebollitas encurtidas': 6.0978, // CEBOLLAS ENCURTIDAS: 3018.4 / 495gr
    'chimichurri': 26.9149,          // CHIMICHURRI ARGENTINO: 26914.92 / 1000gr
    'chimichurri argentino': 26.9149,
    'chimichuri': 26.9149,
    'miel de caña': 8.146,           // MIEL DE CAÑA: 10508.3 / 1290gr
    'miel caña': 8.146,
    'chuney de piña': 8.7999,        // CHUNEY (piña): 33439.89 / 3800gr
    'chuney piña': 8.7999,
    'jardinera': 9.944,              // JARDINERA: 1243 / 125gr
    'chicharron oreado': 26.941986   // CHICHARON OREADO: 7543.756 / 280gr
  };

  function normalizar(s) {
    return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // BUG 2026-09-07: las llaves de COSTO_MANUAL con tilde/\u00f1 (ej. 'miel de ca\u00f1a')
  // nunca hac\u00edan match porque ingNorm s\u00ed se normaliza (quita tildes) pero las
  // llaves del diccionario no. Se arregla normalizando tambi\u00e9n las llaves ac\u00e1.
  const COSTO_MANUAL_NORM = {};
  Object.keys(COSTO_MANUAL).forEach(function(k) {
    COSTO_MANUAL_NORM[normalizar(k)] = COSTO_MANUAL[k];
  });

  const datos = hoja.getDataRange().getValues();
  const encabezado = datos[0].slice();
  while (encabezado.length < 8) encabezado.push('');
  encabezado[7] = 'Costo manual ($/unidad receta)';

  let aplicadas = 0;
  const filas = datos.map(function(fila, i) {
    const f = fila.slice();
    while (f.length < 8) f.push('');
    if (i === 0) return encabezado;

    const ingNorm = normalizar(f[0]);
    const yaE = normTxt(f[4]);
    const yaF = f[5];
    const yaH = f[7];
    if (!yaE && !yaF && !yaH && COSTO_MANUAL_NORM[ingNorm] !== undefined) {
      f[7] = COSTO_MANUAL_NORM[ingNorm];
      f[6] = normTxt(f[6]) || 'Manual (sub-receta interna, ver SUB RESETAS)';
      aplicadas++;
    }
    return f;
  });

  hoja.clearContents();
  hoja.getRange(1, 1, filas.length, 8).setValues(filas);

  Logger.log('Costo manual aplicado a ' + aplicadas + ' filas (chimichurri, alioli, miel de caña, chuney de piña, cebollitas encurtidas, jardinera, chicharrón oreado — todas las variantes de nombre encontradas).');
}
