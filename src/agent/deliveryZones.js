"use strict";

// Mirrors the Slack bot's classification exactly (Slackbot's src/data/loader.js) —
// zupa-api's `delivery_types` array mixes named delivery zones, Uber/Bolt
// on-demand dispatch tiers, pickup-related rows, and surge variants of
// named zones, distinguished only by a pattern in `name` (never `type`,
// `isActive`, or `price` — the Slack bot never looks at those either).
const RIDE_HAIL_RE = /\buber\b|\bbolt\b/i;
const PICKUP_RE = /\bgtfree\b|\bpick\s*up\b|\bpickup\b/i;
const SURGE_RE = /\bsurge\b/i;

// Pickup orders go through get_pickup_branches + zupa-api's own
// findActiveBranchByText/pickupDeliveryTypeId resolution instead (the exact
// mechanism slack-bot/order/new already uses in production) — pickupRows
// from this source are classified for completeness but intentionally not
// used by any tool here, to avoid two competing pickup-resolution paths.
function classifyDeliveryTypes(deliveryTypes) {
  const namedZones = [];
  const rideHailTiers = [];
  const pickupRows = [];

  for (const dt of deliveryTypes || []) {
    const isSurge = SURGE_RE.test(dt.name);
    const entry = { id: dt.id, name: dt.name, price: dt.price, isSurge };

    if (PICKUP_RE.test(dt.name)) pickupRows.push(entry);
    else if (RIDE_HAIL_RE.test(dt.name)) rideHailTiers.push(entry);
    else namedZones.push(entry);
  }

  return { namedZones, rideHailTiers, pickupRows };
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Simple substring/token-overlap match — good enough for a customer typing
// a neighborhood name conversationally. Not the Slack bot's full fuzzy/alias
// matcher (that backs a live-typeahead UI this chat doesn't have), but the
// same two buckets (namedZones, rideHailTiers), same exclusion of surge
// variants, and the same merged-search shape as the Slack bot's /cities
// search (zones + ride-hail tiers together, pickup rows excluded).
function searchZones({ namedZones, rideHailTiers }, query, limit = 5) {
  const normalizedQuery = normalize(query);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);

  const candidates = [
    ...namedZones.filter((z) => !z.isSurge).map((z) => ({ ...z, kind: "zone" })),
    ...rideHailTiers.map((z) => ({ ...z, kind: "ride_hail" })),
  ];

  const scored = candidates
    .map((z) => {
      const normalizedName = normalize(z.name);
      let score = 0;
      if (normalizedName === normalizedQuery) score = 100;
      else if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) score = 50;
      else score = queryTokens.filter((t) => normalizedName.includes(t)).length * 10;
      return { ...z, score };
    })
    .filter((z) => z.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ score, isSurge, ...rest }) => rest);
}

module.exports = { classifyDeliveryTypes, searchZones };
