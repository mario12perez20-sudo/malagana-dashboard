"""
Extractor de Facturas Electrónicas DIAN → Excel
Malagana Rooftop

Uso:
    python extractor_facturas.py                  # procesa carpeta actual
    python extractor_facturas.py ./Prueba         # procesa carpeta específica
    python extractor_facturas.py factura.zip      # procesa un ZIP específico

Genera: compras_malagana.xlsx con 3 hojas:
  - Detalle       → cada línea de producto de cada factura
  - Facturas      → resumen por factura (totales)
  - Por_Producto  → agrupado por producto (suma de compras)
"""

import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from collections import defaultdict
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ──────────────────────────────────────────────
# COLORES MALAGANA (negro y dorado)
# ──────────────────────────────────────────────
COLOR_HEADER_BG = "1A1A1A"   # negro
COLOR_HEADER_FG = "D4A017"   # dorado
COLOR_ROW_ALT   = "F5F0E8"   # crema suave para filas alternas
COLOR_TOTAL_BG  = "D4A017"   # dorado para totales
COLOR_TOTAL_FG  = "1A1A1A"   # negro para texto de totales


def find_by_tag(elem, tag):
    """Busca todos los descendientes con ese tag (sin namespace)."""
    return [e for e in elem.iter() if e.tag.split('}')[-1] == tag]


def first_text(elem, tag):
    """Retorna el texto del primer descendiente con ese tag."""
    results = find_by_tag(elem, tag)
    for r in results:
        if r.text and r.text.strip():
            return r.text.strip()
    return ""


def parse_dian_xml(xml_content):
    """
    Parsea el XML DIAN (AttachedDocument que contiene Invoice embebido).
    Retorna un dict con todos los datos de la factura.
    """
    root = ET.fromstring(xml_content)
    root_tag = root.tag.split('}')[-1]

    # El Invoice puede venir directo o embebido en AttachedDocument > Description
    if root_tag == 'AttachedDocument':
        desc_elements = find_by_tag(root, 'Description')
        inner_xml = None
        for d in desc_elements:
            if d.text and '<?xml' in d.text or (d.text and '<Invoice' in d.text):
                inner_xml = d.text
                break
        if inner_xml:
            invoice_root = ET.fromstring(inner_xml)
        else:
            invoice_root = root
    else:
        invoice_root = root

    # ── Datos de cabecera ──
    num_factura  = first_text(invoice_root, 'ID')
    fecha_str    = first_text(invoice_root, 'IssueDate')
    hora_str     = first_text(invoice_root, 'IssueTime')

    try:
        fecha = datetime.strptime(fecha_str, "%Y-%m-%d").date()
    except Exception:
        fecha = fecha_str

    # ── Proveedor ──
    supplier_nodes = find_by_tag(invoice_root, 'AccountingSupplierParty')
    proveedor = nit_proveedor = ""
    if supplier_nodes:
        sp = supplier_nodes[0]
        proveedor     = first_text(sp, 'RegistrationName')
        nit_proveedor = first_text(sp, 'CompanyID')

    # ── Cliente ──
    customer_nodes = find_by_tag(invoice_root, 'AccountingCustomerParty')
    cliente = nit_cliente = ""
    if customer_nodes:
        cp = customer_nodes[0]
        cliente     = first_text(cp, 'RegistrationName')
        nit_cliente = first_text(cp, 'CompanyID')

    # ── Totales ──
    legal_nodes = find_by_tag(invoice_root, 'LegalMonetaryTotal')
    subtotal = iva_total = total = 0.0
    if legal_nodes:
        l = legal_nodes[0]
        subtotal = float(first_text(l, 'LineExtensionAmount') or 0)
        total    = float(first_text(l, 'PayableAmount') or 0)

    # IVA: suma los TaxAmount de nivel factura (TaxTotal directo, no dentro de InvoiceLine)
    invoice_line_tags = find_by_tag(invoice_root, 'InvoiceLine')
    invoice_line_ids = set(id(e) for line in invoice_line_tags for e in line.iter())
    for tt in find_by_tag(invoice_root, 'TaxTotal'):
        # Solo incluir si el TaxTotal NO está dentro de una InvoiceLine
        if id(tt) not in invoice_line_ids:
            ta_elems = find_by_tag(tt, 'TaxAmount')
            for ta in ta_elems:
                if ta.text and id(ta) not in invoice_line_ids:
                    iva_total += float(ta.text.strip())
                    break  # solo el primer TaxAmount de cada TaxTotal

    # ── Líneas de producto ──
    lineas = []
    for line in find_by_tag(invoice_root, 'InvoiceLine'):
        line_id = first_text(line, 'ID')

        qty_elems = find_by_tag(line, 'InvoicedQuantity')
        cantidad = float(qty_elems[0].text.strip()) if qty_elems and qty_elems[0].text else 0
        unidad   = qty_elems[0].attrib.get('unitCode', '') if qty_elems else ''

        descripcion = first_text(line, 'Description') or first_text(line, 'Name')

        price_elems = find_by_tag(line, 'PriceAmount')
        precio_unit = float(price_elems[0].text.strip()) if price_elems and price_elems[0].text else 0

        subtotal_linea = float(first_text(line, 'LineExtensionAmount') or 0)

        # IVA de la línea
        iva_linea = 0.0
        tax_totals_line = find_by_tag(line, 'TaxTotal')
        for tt in tax_totals_line:
            ta = find_by_tag(tt, 'TaxAmount')
            if ta and ta[0].text:
                iva_linea += float(ta[0].text.strip())

        total_linea = subtotal_linea + iva_linea

        # Código de barras / referencia del ítem
        codigo = first_text(line, 'SellersItemIdentification') or \
                 first_text(line, 'StandardItemIdentification') or ""

        lineas.append({
            'fecha':          fecha,
            'num_factura':    num_factura,
            'proveedor':      proveedor,
            'nit_proveedor':  nit_proveedor,
            'linea_id':       line_id,
            'descripcion':    descripcion,
            'cantidad':       cantidad,
            'unidad':         unidad,
            'precio_unit':    precio_unit,
            'subtotal_linea': subtotal_linea,
            'iva_linea':      iva_linea,
            'total_linea':    total_linea,
        })

    return {
        'num_factura':  num_factura,
        'fecha':        fecha,
        'hora':         hora_str,
        'proveedor':    proveedor,
        'nit_proveedor':nit_proveedor,
        'cliente':      cliente,
        'nit_cliente':  nit_cliente,
        'subtotal':     subtotal,
        'iva_total':    iva_total,
        'total':        total,
        'lineas':       lineas,
    }


def collect_invoices(path):
    """
    Recorre path (archivo o directorio) buscando ZIPs o XMLs con facturas DIAN.
    Retorna lista de dicts de facturas.
    """
    facturas = []
    xmls_processed = set()

    def process_xml_bytes(xml_bytes, source_name):
        try:
            data = parse_dian_xml(xml_bytes)
            if data['num_factura'] and data['num_factura'] not in seen_invoices:
                seen_invoices.add(data['num_factura'])
                facturas.append(data)
                print(f"  ✓ {data['num_factura']} | {data['proveedor']} | {data['fecha']} | {len(data['lineas'])} ítems")
            elif data['num_factura'] in seen_invoices:
                print(f"  ~ {data['num_factura']} (duplicado, omitido)")
        except Exception as e:
            print(f"  ✗ Error en {source_name}: {e}")

    targets = []
    if os.path.isfile(path):
        targets = [path]
    else:
        for root_dir, _, files in os.walk(path):
            for f in files:
                if f.lower().endswith(('.zip', '.xml')):
                    targets.append(os.path.join(root_dir, f))

    seen_invoices = set()  # deduplicar por número de factura

    for target in targets:
        if target.lower().endswith('.zip'):
            try:
                with zipfile.ZipFile(target, 'r') as z:
                    for name in z.namelist():
                        if name.lower().endswith('.xml') and name not in xmls_processed:
                            xmls_processed.add(name)
                            xml_bytes = z.read(name)
                            process_xml_bytes(xml_bytes, name)
            except Exception as e:
                print(f"  ✗ Error abriendo ZIP {target}: {e}")
        elif target.lower().endswith('.xml') and target not in xmls_processed:
            xmls_processed.add(target)
            with open(target, 'rb') as f:
                process_xml_bytes(f.read(), target)

    return facturas


# ──────────────────────────────────────────────
# HELPERS DE ESTILO EXCEL
# ──────────────────────────────────────────────

def header_fill():
    return PatternFill("solid", fgColor=COLOR_HEADER_BG)

def total_fill():
    return PatternFill("solid", fgColor=COLOR_TOTAL_BG)

def alt_fill():
    return PatternFill("solid", fgColor=COLOR_ROW_ALT)

def thin_border():
    s = Side(style='thin', color="CCCCCC")
    return Border(left=s, right=s, top=s, bottom=s)

def style_header_row(ws, row, col_count):
    for col in range(1, col_count + 1):
        cell = ws.cell(row=row, column=col)
        cell.font      = Font(bold=True, color=COLOR_HEADER_FG, size=10)
        cell.fill      = header_fill()
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.border    = thin_border()

def style_total_row(ws, row, col_count):
    for col in range(1, col_count + 1):
        cell = ws.cell(row=row, column=col)
        cell.font      = Font(bold=True, color=COLOR_TOTAL_FG, size=10)
        cell.fill      = total_fill()
        cell.alignment = Alignment(horizontal='right', vertical='center')
        cell.border    = thin_border()

def style_data_rows(ws, start_row, end_row, col_count):
    for row in range(start_row, end_row + 1):
        fill = alt_fill() if row % 2 == 0 else None
        for col in range(1, col_count + 1):
            cell = ws.cell(row=row, column=col)
            cell.border    = thin_border()
            cell.alignment = Alignment(vertical='center')
            if fill:
                cell.fill = fill

def fmt_currency(ws, row, col):
    ws.cell(row=row, column=col).number_format = '#,##0'

def set_col_widths(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


# ──────────────────────────────────────────────
# HOJA 1: DETALLE
# ──────────────────────────────────────────────

def build_detalle(wb, all_lines):
    ws = wb.create_sheet("Detalle")
    ws.freeze_panes = "A2"

    headers = [
        "Fecha", "# Factura", "Proveedor", "NIT Proveedor",
        "Producto / Descripción", "Cantidad", "Unidad",
        "Precio Unitario", "Subtotal", "IVA", "Total Línea"
    ]
    widths = [12, 16, 28, 14, 45, 10, 8, 16, 14, 12, 14]

    for col, h in enumerate(headers, 1):
        ws.cell(row=1, column=col, value=h)
    style_header_row(ws, 1, len(headers))
    ws.row_dimensions[1].height = 30

    for i, l in enumerate(all_lines, 2):
        ws.cell(row=i, column=1, value=l['fecha'])
        ws.cell(row=i, column=1).number_format = 'DD/MM/YYYY'
        ws.cell(row=i, column=2, value=l['num_factura'])
        ws.cell(row=i, column=3, value=l['proveedor'])
        ws.cell(row=i, column=4, value=l['nit_proveedor'])
        ws.cell(row=i, column=5, value=l['descripcion'])
        ws.cell(row=i, column=6, value=l['cantidad'])
        ws.cell(row=i, column=6).number_format = '#,##0.###'
        ws.cell(row=i, column=7, value=l['unidad'])
        ws.cell(row=i, column=8, value=l['precio_unit'])
        ws.cell(row=i, column=9, value=l['subtotal_linea'])
        ws.cell(row=i, column=10, value=l['iva_linea'])
        ws.cell(row=i, column=11, value=l['total_linea'])
        for col in [8, 9, 10, 11]:
            fmt_currency(ws, i, col)

    last_row = len(all_lines) + 1
    style_data_rows(ws, 2, last_row, len(headers))

    # Fila TOTAL
    tr = last_row + 1
    ws.cell(row=tr, column=5, value="TOTAL GENERAL")
    ws.cell(row=tr, column=9, value=sum(l['subtotal_linea'] for l in all_lines))
    ws.cell(row=tr, column=10, value=sum(l['iva_linea'] for l in all_lines))
    ws.cell(row=tr, column=11, value=sum(l['total_linea'] for l in all_lines))
    for col in [9, 10, 11]:
        fmt_currency(ws, tr, col)
    style_total_row(ws, tr, len(headers))

    set_col_widths(ws, widths)
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{last_row}"
    return ws


# ──────────────────────────────────────────────
# HOJA 2: FACTURAS (resumen)
# ──────────────────────────────────────────────

def build_facturas(wb, facturas):
    ws = wb.create_sheet("Facturas")
    ws.freeze_panes = "A2"

    headers = [
        "Fecha", "# Factura", "Proveedor", "NIT Proveedor",
        "Ítems", "Subtotal", "IVA", "Total"
    ]
    widths = [12, 16, 30, 14, 8, 16, 14, 16]

    for col, h in enumerate(headers, 1):
        ws.cell(row=1, column=col, value=h)
    style_header_row(ws, 1, len(headers))
    ws.row_dimensions[1].height = 28

    facturas_sorted = sorted(facturas, key=lambda x: str(x['fecha']))
    for i, f in enumerate(facturas_sorted, 2):
        ws.cell(row=i, column=1, value=f['fecha'])
        ws.cell(row=i, column=1).number_format = 'DD/MM/YYYY'
        ws.cell(row=i, column=2, value=f['num_factura'])
        ws.cell(row=i, column=3, value=f['proveedor'])
        ws.cell(row=i, column=4, value=f['nit_proveedor'])
        ws.cell(row=i, column=5, value=len(f['lineas']))
        ws.cell(row=i, column=6, value=f['subtotal'])
        ws.cell(row=i, column=7, value=f['iva_total'])
        ws.cell(row=i, column=8, value=f['total'])
        for col in [6, 7, 8]:
            fmt_currency(ws, i, col)

    last_row = len(facturas_sorted) + 1
    style_data_rows(ws, 2, last_row, len(headers))

    tr = last_row + 1
    ws.cell(row=tr, column=3, value=f"TOTAL ({len(facturas_sorted)} facturas)")
    ws.cell(row=tr, column=6, value=sum(f['subtotal'] for f in facturas_sorted))
    ws.cell(row=tr, column=7, value=sum(f['iva_total'] for f in facturas_sorted))
    ws.cell(row=tr, column=8, value=sum(f['total'] for f in facturas_sorted))
    for col in [6, 7, 8]:
        fmt_currency(ws, tr, col)
    style_total_row(ws, tr, len(headers))

    set_col_widths(ws, widths)
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{last_row}"
    return ws


# ──────────────────────────────────────────────
# HOJA 3: POR PRODUCTO
# ──────────────────────────────────────────────

def build_por_producto(wb, all_lines):
    ws = wb.create_sheet("Por_Producto")
    ws.freeze_panes = "A2"

    # Agrupar por descripción
    productos = defaultdict(lambda: {'cantidad': 0, 'subtotal': 0, 'iva': 0, 'total': 0, 'compras': 0})
    for l in all_lines:
        key = l['descripcion'].upper().strip()
        productos[key]['cantidad'] += l['cantidad']
        productos[key]['subtotal'] += l['subtotal_linea']
        productos[key]['iva']      += l['iva_linea']
        productos[key]['total']    += l['total_linea']
        productos[key]['compras']  += 1

    headers = ["Producto", "# Compras", "Cantidad Total", "Subtotal", "IVA", "Total Comprado"]
    widths = [48, 12, 16, 16, 14, 16]

    for col, h in enumerate(headers, 1):
        ws.cell(row=1, column=col, value=h)
    style_header_row(ws, 1, len(headers))
    ws.row_dimensions[1].height = 28

    sorted_prods = sorted(productos.items(), key=lambda x: -x[1]['total'])
    for i, (nombre, data) in enumerate(sorted_prods, 2):
        ws.cell(row=i, column=1, value=nombre)
        ws.cell(row=i, column=2, value=data['compras'])
        ws.cell(row=i, column=3, value=round(data['cantidad'], 3))
        ws.cell(row=i, column=3).number_format = '#,##0.###'
        ws.cell(row=i, column=4, value=data['subtotal'])
        ws.cell(row=i, column=5, value=data['iva'])
        ws.cell(row=i, column=6, value=data['total'])
        for col in [4, 5, 6]:
            fmt_currency(ws, i, col)

    last_row = len(sorted_prods) + 1
    style_data_rows(ws, 2, last_row, len(headers))

    tr = last_row + 1
    ws.cell(row=tr, column=1, value=f"TOTAL ({len(sorted_prods)} productos únicos)")
    ws.cell(row=tr, column=4, value=sum(d['subtotal'] for d in productos.values()))
    ws.cell(row=tr, column=5, value=sum(d['iva'] for d in productos.values()))
    ws.cell(row=tr, column=6, value=sum(d['total'] for d in productos.values()))
    for col in [4, 5, 6]:
        fmt_currency(ws, tr, col)
    style_total_row(ws, tr, len(headers))

    set_col_widths(ws, widths)
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{last_row}"
    return ws


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

def main():
    # Ruta de entrada
    if len(sys.argv) > 1:
        input_path = sys.argv[1]
    else:
        input_path = os.getcwd()

    # Nombre del archivo de salida
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    output_name = f"compras_malagana_{ts}.xlsx"

    # Si hay un directorio de entrada, guardar en el mismo lugar
    if os.path.isdir(input_path):
        output_path = os.path.join(input_path, output_name)
    else:
        output_path = os.path.join(os.path.dirname(input_path), output_name)

    print(f"\n📂 Procesando: {input_path}")
    print("─" * 60)

    facturas = collect_invoices(input_path)

    if not facturas:
        print("\n⚠️  No se encontraron facturas válidas.")
        return

    all_lines = []
    for f in facturas:
        all_lines.extend(f['lineas'])

    print(f"\n Total: {len(facturas)} factura(s) | {len(all_lines)} lineas de producto")
    print("-" * 60)
    print("Generando Excel...")

    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    build_detalle(wb, all_lines)
    build_facturas(wb, facturas)
    build_por_producto(wb, all_lines)

    wb.save(output_path)
    print(f"Archivo guardado: {output_path}")
    return output_path


if __name__ == '__main__':
    main()
