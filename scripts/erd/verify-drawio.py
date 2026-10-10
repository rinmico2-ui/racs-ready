"""Validate the generated draw.io XML and schema coverage using the standard library."""
import json
import pathlib
import sys
import base64
import zlib
import urllib.parse
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parents[2]
output = root / 'docs/erd/drawio'
inventory = json.loads((output / 'schema-inventory.json').read_text(encoding='utf-8'))
document = ET.parse(pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else output / 'racs-system-erd.drawio').getroot()
assert document.tag == 'mxfile'
for diagram in document.findall('diagram'):
    if diagram.find('mxGraphModel') is None:
        diagram.append(ET.fromstring(urllib.parse.unquote(zlib.decompress(base64.b64decode(diagram.text), -15).decode('utf-8'))))
pages = {p.attrib['id']: p for p in document.findall('diagram')}
assert len(pages) == len(inventory['pages'])
assert len(pages) == inventory['models'] + inventory['storageCollections'] + 13
covered_relations = set()
entity_names = {e['name'] for e in inventory['entities']}
for info in inventory['pages']:
    page = pages[info['id']]
    cells = page.findall('./mxGraphModel/root/mxCell')
    objects = page.findall('./mxGraphModel/root/object')
    ids = {c.attrib['id'] for c in cells} | {o.attrib['id'] for o in objects}
    assert len(ids) == len(cells) + len(objects), f"Duplicate IDs on {info['id']}"
    assert {'0', '1'} <= ids
    for obj in objects:
        cell = obj.find('mxCell')
        assert cell is not None
        if cell.attrib.get('edge') == '1':
            assert cell.attrib['source'] in ids and cell.attrib['target'] in ids
            assert 'startArrow=ER' in cell.attrib['style'] and 'endArrow=ER' in cell.attrib['style']
            covered_relations.update(obj.attrib.get('relationshipIds', '').split('|'))
            points = cell.findall('./mxGeometry/Array/mxPoint')
            for a, b in zip(points, points[1:]):
                x1, y1, x2, y2 = float(a.attrib['x']), float(a.attrib['y']), float(b.attrib['x']), float(b.attrib['y'])
                assert x1 == x2 or y1 == y2, 'Non-orthogonal connector'
                for box in info['nodes']:
                    crossing = (x1 == x2 and box['x'] < x1 < box['x']+box['w'] and max(y1,y2) > box['y'] and min(y1,y2) < box['y']+box['h']) or (y1 == y2 and box['y'] < y1 < box['y']+box['h'] and max(x1,x2) > box['x'] and min(x1,x2) < box['x']+box['w'])
                    assert not crossing, f"Connector crosses entity card: {box['name']}"
        link = obj.attrib.get('link', '')
        if link.startswith('data:page/id,'):
            assert link.split(',', 1)[1] in pages, f"Broken page link: {link}"
    # Entity cards must not overlap. Field labels sit inside their card intentionally.
    for i, a in enumerate(info['nodes']):
        for b in info['nodes'][i+1:]:
            overlap = a['x'] < b['x']+b['w'] and b['x'] < a['x']+a['w'] and a['y'] < b['y']+b['h'] and b['y'] < a['y']+a['h']
            assert not overlap, f"Overlapping entity cards: {a['name']}, {b['name']}"
for entity in inventory['entities']:
    page = pages['fields-' + entity['name']]
    objects = page.findall('./mxGraphModel/root/object')
    actual_fields = {o.attrib['fieldPath'] for o in objects if o.attrib.get('entityName') == entity['name'] and 'fieldPath' in o.attrib}
    expected_fields = {f['path'] for f in entity['fields']}
    assert actual_fields == expected_fields, f"Missing fields on {entity['name']}: {expected_fields - actual_fields}"
    actual_links = {o.attrib['relationshipId'] for o in objects if 'relationshipId' in o.attrib}
    expected_links = {r['id'] for r in inventory['relationships'] if r['child'] == entity['name']}
    assert actual_links == expected_links, f"Missing relationship register: {entity['name']}"
expected_relations = {r['id'] for r in inventory['relationships']}
assert covered_relations == expected_relations, f"Missing drawn relationships: {expected_relations - covered_relations}"
assert len(expected_relations) == inventory['referenceTargets']
assert sum(len(e['fields']) for e in inventory['entities']) == inventory['fieldCount']
for relationship in inventory['relationships']:
    assert relationship['child'] in entity_names
    assert relationship['parent'] in entity_names or relationship.get('missingTarget')
assert any(r['path'] == 'rescheduleInvitation.sentBy' and r['child'] == 'Order' for r in inventory['relationships'])
assert any(r['path'] == 'technicianId' and r['child'] == 'TechnicianAttendance' and r['childCard'] == '0..*' for r in inventory['relationships'])
print(f"PASS: {len(pages)} draw.io pages, {len(entity_names)} collections, {inventory['fieldCount']} fields, {len(expected_relations)} reference targets; complete coverage and no broken links or overlapping entity cards.")
