// lib/credits.js — FLYYB credits calculation helpers

var EARN_RATE    = 0.05;   // 5% of total charge earned as credits
var MAX_REDEEM   = 0.20;   // credits can cover up to 20% of booking

function calculateEarnable(totalCharge) {
  return Math.round(parseFloat(totalCharge) * EARN_RATE * 100) / 100;
}

function calculateMaxRedeemable(subtotal) {
  return Math.round(parseFloat(subtotal) * MAX_REDEEM * 100) / 100;
}

// Award credits to a user after a confirmed booking.
// client must be an already-connected pg client (inside a transaction).
async function earnCredits(client, userId, bookingRef, totalAmount) {
  var earned = calculateEarnable(totalAmount);
  if (earned <= 0) return 0;
  await client.query(
    'UPDATE credits SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2',
    [earned, userId]
  );
  await client.query(
    'INSERT INTO credit_transactions (user_id,amount,type,description,booking_ref) VALUES ($1,$2,$3,$4,$5)',
    [userId, earned, 'earn', 'Credits earned from booking ' + bookingRef, bookingRef]
  );
  return earned;
}

module.exports = { calculateEarnable, calculateMaxRedeemable, earnCredits };
