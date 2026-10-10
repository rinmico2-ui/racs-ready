const { orderItemCost } = require('./enterpriseRevenue');
const { netLineValue } = require('./transactionDiscounts');

// Pass orders completed within the reporting window, rather than open orders
// or a cohort based on the date an order was first placed.
function buildAirconProductSales(orders = [], inventoryItems = []) {
  const costs = new Map(inventoryItems.map(item => [String(item._id), item.costPrice]));
  const productMap = Object.create(null), brands = Object.create(null), capacities = Object.create(null);
  for (const order of orders.filter(order => order.status === 'completed')) {
    for (const item of order.items || []) {
      const name = item.modelLine || item.brand || 'Unknown Unit';
      const brand = item.brand || 'Unknown Brand';
      const capacity = item.capacity ? `${item.capacity}${item.capacityUnit || 'HP'}` : 'N/A';
      const channel = order.salesChannel === 'walk_in' ? 'walk_in_order' : 'order';
      const key = [channel, brand, name, capacity].join(':');
      const row = productMap[key] ||= { name, brand, capacity, channel, quantity: 0, revenue: 0, cost: 0, profit: 0, costedUnits: 0, orders: 0 };
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const revenue = netLineValue(order, item);
      const cost = orderItemCost(item, costs);
      row.quantity += quantity;
      row.revenue += revenue;
      row.cost += cost * quantity;
      if (cost > 0) row.costedUnits += quantity;
      row.profit = row.revenue - row.cost;
      row.costComplete = row.costedUnits >= row.quantity;
      row.avgUnitPrice = row.quantity > 0 ? row.revenue / row.quantity : 0;
      row.orders++;
      const brandRow = brands[brand] ||= { brand, quantity: 0, revenue: 0, models: new Set() };
      brandRow.quantity += quantity;
      brandRow.revenue += revenue;
      brandRow.models.add(name);
      const capacityRow = capacities[capacity] ||= { capacity, quantity: 0, revenue: 0, orders: 0 };
      capacityRow.quantity += quantity;
      capacityRow.revenue += revenue;
      capacityRow.orders++;
    }
  }
  return {
    productMap,
    topProducts: Object.values(productMap).sort((a,b) => b.revenue - a.revenue).slice(0,15),
    brands: Object.values(brands).map(row => ({ ...row, models: row.models.size })).sort((a,b) => b.revenue - a.revenue),
    capacities: Object.values(capacities).sort((a,b) => b.revenue - a.revenue),
  };
}

module.exports = { buildAirconProductSales };
