function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// codes: string[], subtotal: number, user: {id}|null, paymentMethod: string
// coupons: array of coupon rows already fetched by code, usageCounts: {couponId: {total, perUser}}
async function validateCoupons({ codes, subtotal, user, paymentMethod, securityMode = "normal", supabase }) {
  const result = { accepted: [], rejected: [], discount: 0, freeDelivery: false };
  const normalized = (codes || []).map((code) => String(code).trim().toUpperCase()).filter(Boolean);
  const seen = new Set();

  for (const code of normalized) {
    if (seen.has(code)) {
      result.rejected.push({ code, reason: "Coupon repeated in request" });
      continue;
    }
    seen.add(code);

    const { data: coupon } = await supabase.from("coupons").select("*").eq("code", code).maybeSingle();
    if (!coupon || !coupon.active) {
      result.rejected.push({ code, reason: "Coupon is inactive or unknown" });
      continue;
    }
    if (coupon.first_order_only && user) {
      const { data: priorOrders, error } = await supabase.from("orders").select("id,status").eq("user_id", user.id);
      if (error) {
        result.rejected.push({ code, reason: "Unable to verify first order eligibility" });
        continue;
      }
      if ((priorOrders || []).some((order) => !["CANCELLED", "REJECTED"].includes(order.status))) {
        result.rejected.push({ code, reason: "Coupon is for first orders only" });
        continue;
      }
    }
    const now = new Date();
    if (coupon.expires_at && new Date(coupon.expires_at) < now) {
      result.rejected.push({ code, reason: "Coupon expired" });
      continue;
    }
    if (subtotal < Number(coupon.minimum_order)) {
      result.rejected.push({ code, reason: "Minimum order value not met" });
      continue;
    }
    const allowedMethods = Array.isArray(coupon.allowed_payment_methods) ? coupon.allowed_payment_methods : [];
    if (allowedMethods.length && !allowedMethods.includes(paymentMethod)) {
      result.rejected.push({ code, reason: `Coupon is not valid for ${paymentMethod}` });
      continue;
    }
    if (coupon.discount_type === "PERCENTAGE" && result.accepted.some((item) => item.discountType === "PERCENTAGE")) {
      result.rejected.push({ code, reason: "Only one percentage coupon can be used" });
      continue;
    }
    if (coupon.usage_limit) {
      const { count } = await supabase.from("coupon_usages").select("id", { count: "exact", head: true }).eq("coupon_id", coupon.id);
      if ((count || 0) >= coupon.usage_limit) {
        result.rejected.push({ code, reason: "Coupon usage limit reached" });
        continue;
      }
    }
    if (user && coupon.per_user_limit) {
      const { count } = await supabase.from("coupon_usages").select("id", { count: "exact", head: true }).eq("coupon_id", coupon.id).eq("user_id", user.id);
      if ((count || 0) >= coupon.per_user_limit) {
        result.rejected.push({ code, reason: "Your coupon usage limit was reached" });
        continue;
      }
    }
    if (securityMode !== "research" && result.accepted.length && (!coupon.can_stack || result.accepted.some((item) => !item.canStack))) {
      result.rejected.push({ code, reason: "Coupon cannot be stacked" });
      continue;
    }

    let value;
    if (coupon.free_delivery) result.freeDelivery = true;
    if (coupon.discount_type === "PERCENTAGE") {
      value = (subtotal * Number(coupon.discount_value)) / 100;
      if (coupon.max_discount != null) value = Math.min(value, Number(coupon.max_discount));
    } else if (coupon.discount_type === "FIXED") {
      value = Number(coupon.discount_value);
    } else if (coupon.discount_type === "FREE_DELIVERY") {
      value = 0;
    } else {
      value = 0;
    }
    result.discount = Math.min(subtotal, result.discount + value);
    result.accepted.push({ id: coupon.id, code, discount: round2(value), canStack: coupon.can_stack, discountType: coupon.discount_type });
  }

  result.discount = round2(result.discount);
  return result;
}

async function recordUsage({ result, userId, orderId, supabase }) {
  const couponIds = [...new Set((result.accepted || []).map((coupon) => coupon.id).filter(Boolean))];
  if (!couponIds.length) return { error: null };
  return supabase.rpc("record_coupon_usages", { p_coupon_ids: couponIds, p_user_id: userId, p_order_id: orderId });
}

module.exports = { validateCoupons, recordUsage };
