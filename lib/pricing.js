const CABIN_MULTIPLIERS = {
  economy:         1.00,
  premium_economy: 1.60,
  business:        3.20,
  first:           5.50,
};

function calculatePrice(basePrice, cabin, advanceDays, seatsFraction = 0.5) {
  let price = basePrice * (CABIN_MULTIPLIERS[cabin] || 1.0);

  if      (advanceDays >= 60) price *= 0.80;
  else if (advanceDays >= 30) price *= 0.90;
  else if (advanceDays >= 14) price *= 1.00;
  else if (advanceDays >= 7)  price *= 1.10;
  else if (advanceDays >= 3)  price *= 1.25;
  else                        price *= 1.45;

  if      (seatsFraction < 0.10) price *= 1.30;
  else if (seatsFraction < 0.25) price *= 1.15;
  else if (seatsFraction < 0.50) price *= 1.05;

  price *= (0.95 + Math.random() * 0.10);
  return Math.round(price);
}

function generateSeatAvailability(totalSeats, advanceDays) {
  let occupancyRate;
  if      (advanceDays >= 60) occupancyRate = 0.10 + Math.random() * 0.30;
  else if (advanceDays >= 30) occupancyRate = 0.30 + Math.random() * 0.30;
  else if (advanceDays >= 14) occupancyRate = 0.50 + Math.random() * 0.25;
  else if (advanceDays >= 7)  occupancyRate = 0.65 + Math.random() * 0.20;
  else                        occupancyRate = 0.80 + Math.random() * 0.18;

  const available = Math.max(1, Math.floor(totalSeats * (1 - occupancyRate)));
  return {
    available,
    fraction:  available / totalSeats,
    showAlert: available <= 9 ? available : null,
  };
}

function formatDuration(minutes) {
  return '${Math.floor(minutes / 60)}h ${minutes % 60}m';
}

module.exports = { calculatePrice, generateSeatAvailability, formatDuration };
