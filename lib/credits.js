/**
 * FLYYB Credits Service
 * 5% of booking total = credits earned
 * Credits can be applied to future bookings (up to 20% of booking value)
 */

const EARN_RATE    = 0.05;  // 5% of booking value
const MAX_REDEEM   = 0.20;  // max 20% of booking value can be paid with credits

async function earnCredits(client, userId, bookingRef, bookingAmount) {
  const earned = Math.round(bookingAmount * EARN_RATE * 100) / 100;
  if (earned <= 0) return 0;

  await client.query(`
    INSERT INTO credits (user_id, balance) VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET balance = credits.balance + $2, updated_at = NOW()
  `, [userId, earned]);

  await client.query(`
    INSERT INTO credit_transactions (user_id, amount, type, description, booking_ref)
    VALUES ($1, $2, 'earn', $3, $4)
  `, [userId, earned, `5% reward on booking ${bookingRef}`, bookingRef]);

  return earned;
}

async function redeemCredits(client, userId, bookingRef, bookingAmount, requestedAmount) {
  // Cap at MAX_REDEEM % of booking value
  const maxAllowed = Math.round(bookingAmount * MAX_REDEEM * 100) / 100;
  const toRedeem   = Math.min(requestedAmount, maxAllowed);

  // Check user has enough balance
  const { rows: [credit] } = await client.query(
    'SELECT balance FROM credits WHERE user_id=$1 FOR UPDATE', [userId]
  );
  const balance = parseFloat(credit?.balance || 0);
  if (balance < toRedeem) throw new Error('Insufficient credit balance');

  await client.query(
    'UPDATE credits SET balance = balance - $1, updated_at = NOW() WHERE user_id=$2',
    [toRedeem, userId]
  );

  await client.query(`
    INSERT INTO credit_transactions (user_id, amount, type, description, booking_ref)
    VALUES ($1, $2, 'redeem', $3, $4)
  `, [userId, -toRedeem, `Credits applied to booking ${bookingRef}`, bookingRef]);

  return toRedeem;
}

function calculateEarnable(amount) {
  return Math.round(amount * EARN_RATE * 100) / 100;
}

function calculateMaxRedeemable(amount) {
  return Math.round(amount * MAX_REDEEM * 100) / 100;
}

module.exports = { earnCredits, redeemCredits, calculateEarnable, calculateMaxRedeemable, EARN_RATE, MAX_REDEEM };
