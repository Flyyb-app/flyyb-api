// lib/pricing.js — FLYYB flight pricing and availability helpers

var CABIN_MULTIPLIERS = {
  economy:          1.0,
  premium_economy:  1.6,
  business:         3.2,
  first:            5.5,
};

// Dynamic pricing based on advance days and seat availability
function calculatePrice(basePriceUsd, cabin, advanceDays, seatFraction) {
  var cabinMult = CABIN_MULTIPLIERS[cabin] || 1.0;

  // Advance purchase discount/premium
  var advanceMult;
  if      (advanceDays >= 60) advanceMult = 0.80;
  else if (advanceDays >= 30) advanceMult = 0.90;
  else if (advanceDays >= 14) advanceMult = 1.00;
  else if (advanceDays >= 7)  advanceMult = 1.15;
  else if (advanceDays >= 3)  advanceMult = 1.30;
  else                        advanceMult = 1.50;

  // Demand multiplier from seat fill
  var demandMult = 1.0 + (seatFraction * 0.40); // up to 40% premium when nearly full

  // Small random variation so prices look real
  var jitter = 0.95 + Math.random() * 0.10;

  return Math.round(parseFloat(basePriceUsd) * cabinMult * advanceMult * demandMult * jitter);
}

// Generate seat availability info
function generateSeatAvailability(totalSeats, advanceDays) {
  var total = parseInt(totalSeats) || 180;
  // More seats available further in advance
  var fillPct;
  if      (advanceDays >= 60) fillPct = 0.20 + Math.random() * 0.20;
  else if (advanceDays >= 30) fillPct = 0.40 + Math.random() * 0.20;
  else if (advanceDays >= 14) fillPct = 0.60 + Math.random() * 0.15;
  else if (advanceDays >= 7)  fillPct = 0.75 + Math.random() * 0.15;
  else                        fillPct = 0.85 + Math.random() * 0.12;

  var taken     = Math.floor(total * fillPct);
  var available = Math.max(1, total - taken);
  var fraction  = taken / total;

  return {
    available:  available,
    fraction:   fraction,
    showAlert:  available <= 9 ? available + ' seats left' : null,
  };
}

function formatDuration(minutes) {
  var m = parseInt(minutes) || 0;
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

module.exports = { calculatePrice, generateSeatAvailability, formatDuration, CABIN_MULTIPLIERS };
