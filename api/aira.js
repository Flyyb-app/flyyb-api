// FLYYB AIRA Knowledge Base
// RAG-style: injected into system prompt at query time
// Add more Q&A pairs, policies and routes as FLYYB grows

var KNOWLEDGE = {

policies: {
cancellation: "Free cancellation up to 24 hours before departure for a full refund. Within 24 hours - non-refundable. Refunds processed in 5-10 business days.",
rescheduling: "Rescheduling allowed up to 48 hours before departure. One reschedule per booking. Price difference charged or refunded. Select new date in My Trips.",
checkin: "Online check-in opens 24 hours before departure and closes 2 hours before. Go to airline website with your booking reference.",
baggage: {
economy: "23kg checked baggage + 7kg cabin bag. Cabin bag max 55x40x20cm.",
business: "32kg checked baggage + 10kg cabin bag. 2 checked bags allowed.",
first: "40kg checked baggage + 10kg cabin bag. Up to 3 checked bags."
},
credits: "Earn 5% of booking total as FLYYB credits on every confirmed booking. Apply up to 20% of any future booking fare using credits. Credits never expire. Non-transferable.",
payment: "Visa, Mastercard, Amex accepted. Payments secured by Stripe. Card data never stored on FLYYB servers.",
refund: "Refunds go back to original payment method. Credits are non-refundable for cash. Allow 5-10 business days.",
infant: "Infants under 2 years travel on lap - contact airline directly. No seat required but booking reference needed.",
passport: "Valid passport required for all international flights. Check visa requirements for your destination before booking.",
},

faq: [
{q:"how do I cancel my booking", a:"Go to My Trips, find your booking and tap Cancel. Free cancellation up to 24h before departure."},
{q:"can I reschedule my flight", a:"Yes! Go to My Trips, find your booking and tap Reschedule. You can change up to 48h before departure."},
{q:"how do credits work", a:"You earn 5% of every booking as credits. Apply them at checkout - up to 20% of any booking fare. They never expire!"},
{q:"how do I check in", a:"Online check-in opens 24h before your flight on the airline's website. Use your booking reference number."},
{q:"what is the baggage allowance", a:"Economy: 23kg checked + 7kg cabin. Business: 32kg checked + 10kg cabin. First: 40kg checked + 10kg cabin."},
{q:"can I carry laptop in cabin", a:"Yes, laptops and tablets allowed in cabin bag. Must be removed for security screening."},
{q:"is my payment secure", a:"Yes - FLYYB uses Stripe for payment processing. Your card details are encrypted and never stored on our servers."},
{q:"how do I get my booking confirmation", a:"Confirmation email is sent to your email address immediately after payment. Also downloadable as PDF from the booking confirmation screen."},
{q:"what if my flight is delayed", a:"Contact the airline directly for delay compensation. FLYYB can help you reschedule if needed - go to My Trips."},
{q:"can I book for someone else", a:"Yes - enter the other passenger's details in the passenger form during booking. Their passport details required."},
{q:"how many passengers can I book", a:"Up to 9 passengers per booking on FLYYB."},
{q:"what is flyybid", a:"Your FLYYB Member ID is your unique identifier. Find it in Profile & Settings. Use it to reference your account with support."},
{q:"how do I change my currency", a:"Go to Profile & Settings, change your default currency. Future searches will show prices in your selected currency."},
{q:"can I book round trip", a:"Yes! Select Round Trip on the search screen, choose your outbound and return flights, then book both together."},
{q:"how do I save passenger details", a:"During booking, tick Save this passenger on the passenger form. Details saved to your profile for faster future bookings."},
{q:"what is aira", a:"I'm AIRA - FLYYB's AI Reservations Assistant! I can search flights, answer questions, check your credits, and help you book - all by conversation."},
{q:"is flyyb safe to book", a:"Yes - FLYYB uses Stripe for secure payments, bank-level encryption, and your data is never sold to third parties."},
{q:"how do I contact support", a:"Chat with me - AIRA - for instant help! For urgent issues email support via flyyb.vercel.app."},
],

bookingFlow: [
"Step 1: Search - enter origin, destination, date, passengers and cabin class",
"Step 2: Select flight - choose from available options by price, time or airline",
"Step 3: Passenger details - enter names, date of birth, passport number and gender",
"Step 4: Seats - choose specific seats or accept random assignment",
"Step 5: Add-ons - extra baggage, meals, lounge access, comfort kits",
"Step 6: Payment - enter card details securely via Stripe, apply credits if available",
"Step 7: Confirmation - receive booking reference and email confirmation instantly"
],

airaPhrases: {
greeting: ["Good morning", "Good afternoon", "Good evening"],
flightFound: ["I found {n} great options for you!", "Here are {n} flights for your trip!", "I've got {n} flights ready for you!"],
noFlight: ["No direct flights on that date - want to try different dates?", "Nothing available then - shall I check nearby dates?"],
bookingHelp: ["Let me open the booking form for you!", "Opening booking now!", "I'll take you straight to checkout!"],
credits: ["You have {amount} credits - that's {pct}% off your next booking!", "Your credits balance is {amount}. Use up to 20% on any booking!"],
farewell: ["Safe travels!", "Have a wonderful trip!", "Bon voyage!"],
}
};

// Get relevant knowledge for a user query
function getRelevantKnowledge(message) {
var t = message.toLowerCase();
var relevant = [];

// Match FAQ
KNOWLEDGE.faq.forEach(function(item) {
var keywords = item.q.split(' ');
var matches = keywords.filter(function(k) { return k.length > 3 && t.includes(k); });
if (matches.length >= 2) {
relevant.push('Q: ' + item.q + '\nA: ' + item.a);
}
});

// Match policies
if (t.includes('cancel')) relevant.push('Cancellation policy: ' + KNOWLEDGE.policies.cancellation);
if (t.includes('reschedule') || t.includes('change') || t.includes('modify')) relevant.push('Rescheduling policy: ' + KNOWLEDGE.policies.rescheduling);
if (t.includes('baggage') || t.includes('luggage') || t.includes('bag') || t.includes('kg')) {
relevant.push('Baggage: Economy: ' + KNOWLEDGE.policies.baggage.economy + ' Business: ' + KNOWLEDGE.policies.baggage.business);
}
if (t.includes('credit') || t.includes('reward') || t.includes('points')) relevant.push('Credits: ' + KNOWLEDGE.policies.credits);
if (t.includes('check in') || t.includes('checkin')) relevant.push('Check-in: ' + KNOWLEDGE.policies.checkin);
if (t.includes('refund') || t.includes('money back')) relevant.push('Refunds: ' + KNOWLEDGE.policies.refund);
if (t.includes('payment') || t.includes('pay') || t.includes('card') || t.includes('secure')) relevant.push('Payment: ' + KNOWLEDGE.policies.payment);
if (t.includes('passport') || t.includes('visa') || t.includes('document')) relevant.push('Documents: ' + KNOWLEDGE.policies.passport);
if (t.includes('how') && (t.includes('book') || t.includes('steps') || t.includes('process'))) {
relevant.push('Booking steps: ' + KNOWLEDGE.bookingFlow.join(' → '));
}

return relevant.slice(0, 3); // max 3 items to keep prompt short
}

module.exports = { KNOWLEDGE, getRelevantKnowledge };