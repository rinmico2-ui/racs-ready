'use strict';
const csv = require('csvtojson');
const crypto = require('node:crypto');
const { normalizeProductVariantSerialNumbers } = require('./hvacSerialNumbers');
const columns = ['modelLine', 'brand', 'category', 'type', 'inverter', 'salesChannel', 'capacity', 'capacityUnit', 'btu', 'sellingPrice', 'costPrice', 'quantity', 'minStockLevel', 'sku', 'barcode', 'serialNumbers'];
const types = ['split', 'split_ceiling', 'window_inverter', 'window_non_inverter', 'floor_mounted'];
function csvTemplate() {
  return '\uFEFF' + columns.join(',') + '\r\n' + [
    ['Sample Model', 'Sample Brand', 'Air Conditioner', 'split', 'true', 'both', '1', 'HP', '9000', '20000', '15000', '5', '3', '', '', ''],
    ['Sample Model', 'Sample Brand', 'Air Conditioner', 'split', 'true', 'both', '3', 'HP', '27000', '40000', '30000', '3', '3', '', '', ''],
  ].map(row => row.join(',')).join('\r\n') + '\r\n';
}
async function parseInventoryCsv(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 1024 * 1024) throw Object.assign(new Error('Choose a CSV file up to 1 MB.'), { status: 400 });
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const headers = text.split(/\r?\n/, 1)[0].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
  if (new Set(headers).size !== headers.length || headers.some(h => !columns.includes(h)) || ['modelLine', 'brand', 'category', 'capacity', 'sellingPrice', 'quantity'].some(h => !headers.includes(h))) {
    throw Object.assign(new Error('Use the CSV template headers. Model, brand, category, capacity, selling price, and quantity are required.'), { status: 400 });
  }
  let rows;
  try { rows = await csv({ trim: true, checkColumn: true, maxRowLength: 8192 }).fromString(text); }
  catch (_) { throw Object.assign(new Error('The CSV could not be read. Check its columns and quotation marks.'), { status: 400 }); }
  if (!rows.length || rows.length > 500) throw Object.assign(new Error('Import between 1 and 500 HP variant rows at a time.'), { status: 400 });
  const groups = new Map(), errors = [], skus = new Set(), barcodes = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], rowNumber = index + 2;
    try {
      function plain(key, required = false, fallback = '') {
        const value = String(row[key] || fallback).trim();
        if ((required && !value) || value.length > 120 || /[<>\u0000-\u001f]/.test(value)) throw new Error(`${key}: enter a plain text value up to 120 characters.`);
        return value;
      }
      function numeric(key, fallback, whole = false, positive = false) {
        const raw = row[key] === '' || row[key] === undefined ? fallback : row[key];
        const value = Number(raw);
        if (raw === undefined || !Number.isFinite(value) || value < 0 || value > 10000000 || (whole && !Number.isInteger(value)) || (positive && value <= 0)) throw new Error(`${key}: enter a valid ${whole ? 'whole number' : 'number'} ${positive ? 'greater than zero' : 'of zero or more'}.`);
        return value;
      }
      const modelLine = plain('modelLine', true), brand = plain('brand', true), category = plain('category', true);
      const type = plain('type', false, 'split'), salesChannel = plain('salesChannel', false, 'both');
      if (!types.includes(type)) throw new Error('type: use split, split_ceiling, window_inverter, window_non_inverter, or floor_mounted.');
      if (!['web', 'shop', 'both'].includes(salesChannel)) throw new Error('salesChannel: use web, shop, or both.');
      const inverterValue = plain('inverter', false, 'false').toLowerCase();
      if (!['true', 'false'].includes(inverterValue)) throw new Error('inverter: use true or false.');
      const capacity = numeric('capacity', undefined, false, true);
      const capacityUnit = plain('capacityUnit', false, 'HP').toUpperCase();
      if (capacityUnit !== 'HP') throw new Error('capacityUnit: use HP for aircon variants.');
      const variant = { capacity: String(capacity), capacityUnit, btu: numeric('btu', 0, true), sellingPrice: numeric('sellingPrice', undefined, false, true), costPrice: numeric('costPrice', 0), quantity: numeric('quantity', undefined, true), minStockLevel: numeric('minStockLevel', 3, true) };
      const sku = plain('sku').toUpperCase(), barcode = plain('barcode');
      if (sku) { if (skus.has(sku)) throw new Error('sku: each variant must have a unique SKU.'); variant.sku = sku; }
      if (barcode) { if (barcodes.has(barcode)) throw new Error('barcode: each variant must have a unique barcode.'); variant.barcode = barcode; }
      variant.serialNumbers = String(row.serialNumbers || '').split('|').map(v => v.trim()).filter(Boolean);
      const key = JSON.stringify([modelLine.toLowerCase(), brand.toLowerCase()]);
      const product = groups.get(key) || { modelLine, brand, category, type, inverter: inverterValue === 'true', salesChannel, variants: [], rows: [] };
      if (product.category !== category || product.type !== type || product.salesChannel !== salesChannel || product.inverter !== (inverterValue === 'true')) throw new Error('Product fields must match for all rows of the same model and brand.');
      if (product.variants.some(v => Number(v.capacity) === capacity)) throw new Error('capacity: this model already has an HP variant with that capacity in the CSV.');
      product.variants.push(variant); product.rows.push(rowNumber); groups.set(key, product);
      if (sku) skus.add(sku); if (barcode) barcodes.add(barcode);
    } catch (error) { errors.push({ row: rowNumber, error: error.message }); }
  }
  if (groups.size > 100) throw Object.assign(new Error('Import at most 100 products per file.'), { status: 400 });
  const products = [...groups.values()];
  for (const product of products) {
    try { product.variants = normalizeProductVariantSerialNumbers(product.variants); }
    catch (error) { errors.push({ row: product.rows[0], error: error.message }); }
  }
  const allSerials = products.flatMap(p => p.variants.flatMap(v => v.serialNumbers || []));
  if (new Set(allSerials).size !== allSerials.length) errors.push({ row: 0, error: 'A serial number appears more than once in the CSV.' });
  return { products, errors, rowCount: rows.length, hash: crypto.createHash('sha256').update(buffer).digest('hex') };
}
module.exports = { csvTemplate, parseInventoryCsv };
