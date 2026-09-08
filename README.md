# Malagana Rooftop — Dashboard

Dashboard interno de Malagana Rooftop (Palmira, Colombia): compras (facturas DIAN), recetas y costeo, y ventas (POS Loggro) vs. costo de insumo.

**Ver en línea:** una vez publicado con GitHub Pages, el dashboard queda en `https://<usuario>.github.io/<repo>/`.

## Archivos

| Archivo | Qué hace |
|---|---|
| `dashboard.html` | Frontend del dashboard (estático, sin build). Consulta datos en vivo al Web App de Apps Script vía JSONP. |
| `dashboard_api.gs` | Web App (Apps Script) que sirve los datos del Sheet como JSON/JSONP. |
| `facturas_a_drive.gs` | Descarga facturas desde Gmail a Drive (trigger cada 2h). |
| `registrar_facturas_sheets.gs` | Parsea las facturas XML (DIAN UBL 2.1) al Sheet. |
| `loggro_sync.gs` | Integración con Loggro (POS): ventas, consumo teórico, costeo diario. |
| `setup_triggers.gs` | Configura los triggers automáticos. |

## Deploy de cambios en Apps Script

Desde esta carpeta:

```
npm run push     # sube código .gs o dashboard.html (sin tocar doGet)
npm run deploy   # cuando cambia doGet en dashboard_api.gs — genera nueva versión del Web App
```

## Nota de seguridad

Este repo es público mientras el proyecto está en pruebas. `dashboard.html` incluye la URL del Web App de Apps Script — esa URL permite leer los datos del dashboard y, en la pestaña Recetas, escribir cambios (agregar/renombrar/eliminar platos). No incluye credenciales de Loggro ni de Google — esas viven en Script Properties del proyecto de Apps Script, nunca en el código.
