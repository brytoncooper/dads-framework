from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

owner = "http://schemas.openxmlformats.org"
relationships = owner + "/officeDocument/2006/relationships"
main = owner + "/spreadsheetml/2006/main"

files = {
    "[Content_Types].xml": f"""<Types xmlns="{owner}/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>""",
    "_rels/.rels": f"""<Relationships xmlns="{owner}/package/2006/relationships">
      <Relationship Id="rId1" Type="{relationships}/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>""",
    "xl/workbook.xml": f"""<workbook xmlns="{main}" xmlns:r="{relationships}">
      <sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets>
    </workbook>""",
    "xl/_rels/workbook.xml.rels": f"""<Relationships xmlns="{owner}/package/2006/relationships">
      <Relationship Id="rId1" Type="{relationships}/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>""",
    "xl/worksheets/sheet1.xml": f"""<worksheet xmlns="{main}">
      <sheetData>
        <row r="1">
          <c r="A1" t="inlineStr"><is><t>SKU</t></is></c>
          <c r="B1" t="inlineStr"><is><t>Count</t></is></c>
          <c r="C1" t="inlineStr"><is><t>Available</t></is></c>
        </row>
        <row r="2">
          <c r="A2" t="inlineStr"><is><t>0023</t></is></c>
          <c r="B2"><f>2*3</f><v>6</v></c>
          <c r="C2" t="b"><v>1</v></c>
        </row>
        <row r="4">
          <c r="A4" t="inlineStr"><is><t>99999999999999999999</t></is></c>
          <c r="C4" t="b"><v>0</v></c>
        </row>
      </sheetData>
    </worksheet>""",
}

destination = Path("test-fixtures") / "external-inventory.xlsx"
with ZipFile(destination, "w") as workbook:
    for name, xml in files.items():
        workbook.writestr(ZipInfo(name), "".join(line.strip() for line in xml.splitlines()), ZIP_DEFLATED)
