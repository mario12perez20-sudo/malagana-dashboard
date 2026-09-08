# Guía de instalación — Facturas automáticas a Drive
## Malagana Rooftop

---

## ¿Qué hace este script?
Revisa el Gmail de Malagana cada hora, detecta correos con facturas adjuntas (PDF, ZIP, XML) y los sube automáticamente a Google Drive en esta estructura:

```
Malagana Rooftop/
└── Facturas/
    └── 2026/
        ├── Junio/
        ├── Julio/
        └── ...
```

---

## Instalación (una sola vez)

### Paso 1 — Abrir Google Apps Script
1. Ve a **script.google.com**
2. Inicia sesión con la cuenta **malaganarooftop@gmail.com**
3. Haz clic en **"Nuevo proyecto"**

### Paso 2 — Pegar el script
1. Borra todo el código que aparece por defecto
2. Abre el archivo `facturas_a_drive.gs` y copia todo su contenido
3. Pégalo en el editor de Apps Script
4. Haz clic en el ícono de guardar 💾 (o Ctrl+S)
5. Ponle un nombre al proyecto: **"Facturas Malagana"**

### Paso 3 — Correr por primera vez (importar últimos 10 días)
1. En el menú desplegable de funciones, selecciona **`procesarUltimos10Dias`**
2. Haz clic en **"Ejecutar"** ▶
3. Google te pedirá que autorices los permisos — acéptalos todos
   - Acceso a Gmail ✓
   - Acceso a Drive ✓
4. Espera a que termine — revisa el log abajo para ver qué subió

### Paso 4 — Activar la automatización
1. En el menú desplegable, selecciona **`configurarTriggerAutomatico`**
2. Haz clic en **"Ejecutar"** ▶
3. Listo — el script correrá solo cada hora de ahora en adelante

---

## ¿Cómo sé que está funcionando?
- En Gmail aparecerá una etiqueta llamada **`factura-procesada`** en los correos procesados
- En Drive verás la carpeta **Malagana Rooftop → Facturas → 2026 → [mes]** con los archivos
- En Apps Script puedes ver el historial en **"Ejecuciones"** (menú izquierdo)

---

## Notas importantes
- El script **no borra** los correos de Gmail, solo los etiqueta
- Si un archivo ya existe en Drive, **no lo duplica**
- Procesa PDFs, ZIPs (facturas electrónicas DIAN) y XMLs
- **Costo: $0** — Google Apps Script es completamente gratuito

---

## ¿Problemas?
Si el script falla, revisa el log en Apps Script → Ejecuciones. El error más común es no haber aceptado todos los permisos en el Paso 3.
