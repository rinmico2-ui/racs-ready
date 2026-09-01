const DELIVERY_TYPES = Object.freeze(["delivery_only", "delivery_installation"]);
const VALID_TYPES = new Set([...DELIVERY_TYPES, "customer_pickup"]);

function orderFulfillmentScopeFilter(group, fulfillmentType) {
  const normalizedGroup = group === "pickup" ? "pickup" : group === "delivery" ? "delivery" : "all";
  const validType = VALID_TYPES.has(fulfillmentType) ? fulfillmentType : "";

  if (normalizedGroup === "pickup") return { fulfillmentType: "customer_pickup" };
  if (normalizedGroup === "delivery") {
    return validType && DELIVERY_TYPES.includes(validType)
      ? { fulfillmentType: validType }
      : { fulfillmentType: { $in: [...DELIVERY_TYPES] } };
  }
  return validType ? { fulfillmentType: validType } : {};
}

module.exports = { DELIVERY_TYPES, orderFulfillmentScopeFilter };
