(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./appliance-services'));
  else root.BookingEditorServices = factory(root.ApplianceServices);
})(typeof window !== 'undefined' ? window : globalThis, function (A) {
  'use strict';
  const identity = row => String(row.id || row._id || '');
  const coreGroup = row => row.applianceGroupId || identity(row);

  function groups(rows) {
    return A.applianceGroups(rows);
  }

  // Keep each saved service identity at most once when one older quantity
  // group becomes several individually configured appliances.
  function replaceCore(rows, added, editingId) {
    const previous = editingId ? rows.filter(row => row.type !== 'repair' && coreGroup(row) === String(editingId)) : [];
    if (editingId && !previous.length) throw new Error('This appliance has changed. Reopen the booking before editing it.');
    const used = new Set(), groupIds = new Map();
    const updated = added.map(row => {
      if (row.type !== 'core') throw new Error('Choose a Core service for this appliance.');
      const prior = previous.find(item => !used.has(item) && String(item.serviceId) === String(row.serviceId));
      if (prior) used.add(prior);
      const { _id: ignored, ...details } = row;
      if (previous[0]?.applianceGroupId && row.applianceGroupId && !groupIds.has(row.applianceGroupId)) {
        groupIds.set(row.applianceGroupId, groupIds.size ? row.applianceGroupId : previous[0].applianceGroupId);
      }
      return { ...(prior || {}), ...details,
        ...(prior?._id ? { _id: prior._id } : {}),
        ...(groupIds.has(row.applianceGroupId) ? { applianceGroupId: groupIds.get(row.applianceGroupId) } : {}),
      };
    });
    const next = previous.length
      ? rows.flatMap(row => row === previous[0] ? updated : previous.includes(row) ? [] : [row])
      : rows.concat(updated);
    A.unitCount(next); A.assertServiceTypes(next); A.assertStandaloneServices(next);
    const ids = next.map(row => row._id && String(row._id)).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error('Each saved service can belong to only one appliance.');
    rows.splice(0, rows.length, ...next);
  }

  return { groups, replaceCore };
});
