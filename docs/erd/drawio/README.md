# RACS system ERD in draw.io

Open [racs-system-erd.drawio](racs-system-erd.drawio) at [app.diagrams.net](https://app.diagrams.net/): **File → Open From → Device**.

[View the offline previews](index.html). The SVG previews were exported through the draw.io editor. The editable diagram is the .drawio file.

The file contains **63 database models**, **5 storage collections**, **3063 schema paths** and **419 reference targets**. Its **81 pages** include a collection map, a full-system ERD, 10 area diagrams and a full field page for each collection. Click collection titles to move between pages. Table rows move together with their table. All shapes and connectors can be edited.

Declared references, application links, embedded item links and file storage links are marked separately. Cardinalities use the current required fields and single-field unique indexes; compound uniqueness does not imply a one-to-one relationship. Missing target models are shown as missing targets. No customer data or secrets are included.

Rebuild: `node scripts/erd/build-drawio.cjs`

Validate: `node scripts/erd/verify-drawio.cjs` (Node.js and Python 3; no database needed).

After rebuilding, SVG previews need to be exported again in draw.io. The schema XML and inventory are the current source of truth.

[Complete schema inventory](schema-inventory.json)
