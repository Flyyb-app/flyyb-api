// booking.js — bookings, addons catalog, credits
// Routes: ?action=create-intent | ?action=webhook | ?action=addons | ?action=credits
var pg=require('pg'),Stripe=require('stripe'),auth=require('../lib/auth'),creditsLib=require('../lib/credits');
var pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});

async function sendEmail(to,subject,html){
  var k=process.env.BREVO_SMTP_KEY,f=process.env.BREVO_FROM_EMAIL;
  if(!k||!f){console.log('=== EMAIL to '+to+' ===');return;}
  try{await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'Content-Type':'application/json','api-key':k},body:JSON.stringify({sender:{name:'FLYYB',email:f},to:[{email:to}],subject,htmlContent:html})});}
  catch(e){console.error('Email:',e.message);}
}

function confirmationHtml(b){
  return '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0a0a0f;color:#f5f0e8;padding:32px;border-radius:8px"><h1 style="font-size:24px;letter-spacing:4px;margin-bottom:4px">FLY<span style="color:#d4a843">YB</span></h1><p style="color:rgba(245,240,232,.5);font-size:12px;margin-bottom:28px">fly with vibe</p><h2 style="color:#5daa72;font-size:20px;margin-bottom:8px">Booking Confirmed</h2><p style="color:rgba(245,240,232,.7);font-size:14px;margin-bottom:24px">Your flight is confirmed! Here are your booking details.</p><div style="background:rgba(255,255,255,.04);border:1px solid rgba(212,168,67,.2);border-radius:6px;padding:20px;margin-bottom:20px"><div style="text-align:center;margin-bottom:16px"><span style="font-family:monospace;font-size:22px;letter-spacing:4px;color:#d4a843">'+b.ref+'</span><div style="font-size:11px;color:rgba(245,240,232,.4);margin-top:4px;letter-spacing:.15em">BOOKING REFERENCE</div></div><hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:16px 0"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:rgba(245,240,232,.5);font-size:13px">Route</span><span>'+b.origin+' to '+b.dest+'</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:rgba(245,240,232,.5);font-size:13px">Date</span><span>'+b.date+'</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:rgba(245,240,232,.5);font-size:13px">Departure</span><span>'+b.dep+'</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:rgba(245,240,232,.5);font-size:13px">Arrival</span><span>'+b.arr+'</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:rgba(245,240,232,.5);font-size:13px">Flight</span><span>'+b.flight+'</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:rgba(245,240,232,.5);font-size:13px">Cabin</span><span>'+b.cabin+'</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="color:rgba(245,240,232,.5);font-size:13px">Passengers</span><span>'+b.adults+'</span></div><hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:16px 0"><div style="display:flex;justify-content:space-between"><span style="color:rgba(245,240,232,.5);font-size:13px">Total Paid</span><span style="color:#d4a843;font-weight:600;font-size:16px">$'+b.total+'</span></div>'+(b.creditsEarned?'<div style="display:flex;justify-content:space-between;margin-top:8px"><span style="color:rgba(245,240,232,.5);font-size:13px">Credits Earned</span><span style="color:#5daa72">+$'+b.creditsEarned+'</span></div>':'')+'</div><p style="color:rgba(245,240,232,.4);font-size:12px;text-align:center">Thank you for booking with FLYYB. Visit flyyb.vercel.app to manage your trips.</p></div>';
}

// -- ADDONS ----------------------------------------------------
async function handleAddons(req,res){
  var airline=req.query.airline||null;
  var client;
  try{
    client=await pool.connect();
    var r=await client.query('SELECT id,code,category,name,description,price_usd,icon,airline_code FROM addons_catalog WHERE is_active=TRUE AND (airline_code IS NULL OR airline_code=$1) ORDER BY category,price_usd',[airline]);
    var grouped=r.rows.reduce(function(acc,a){
      if(!acc[a.category])acc[a.category]=[];
      acc[a.category].push({id:a.id,code:a.code,name:a.name,description:a.description,price:parseFloat(a.price_usd),icon:a.icon,airlineOnly:a.airline_code});
      return acc;
    },{});
    res.json({addons:grouped});
  }catch(err){console.error('Addons:',err);res.status(500).json({error:'Failed to fetch add-ons'});}
  finally{if(client)client.release();}
}

// -- CREDITS ---------------------------------------------------
async function handleCredits(req,res){
  var payload=auth.requireAuth(req,res);if(!payload)return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  var client;
  try{
    client=await pool.connect();
    var results=await Promise.all([
      client.query('SELECT balance FROM credits WHERE user_id=$1',[payload.sub]),
      client.query('SELECT amount,type,description,booking_ref,created_at FROM credit_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[payload.sub])
    ]);
    var credit=results[0].rows[0];
    res.json({
      balance:parseFloat((credit&&credit.balance)||0),
      transactions:results[1].rows.map(function(t){return{amount:parseFloat(t.amount),type:t.type,description:t.description,bookingRef:t.booking_ref,date:t.created_at};})
    });
  }catch(err){console.error('Credits:',err);res.status(500).json({error:'Failed to fetch credits'});}
  finally{if(client)client.release();}
}

// -- CREATE PAYMENT INTENT ------------------------------------
async function handleCreateIntent(req,res){
  var payload=auth.requireAuth(req,res);if(!payload)return;
  var b=req.body||{};
  if(!b.flightNumber||!b.originCode||!b.destCode||!b.depDate||!b.baseAmount)return res.status(400).json({error:'Missing required fields'});
  var stripe=Stripe(process.env.STRIPE_SECRET_KEY);
  var addons=b.addons||[],passengers=b.passengers||[];
  var addonsTotal=addons.reduce(function(s,a){return s+(a.price*(a.quantity||1));},0);
  var subtotal=parseFloat(b.baseAmount)+addonsTotal;
  var creditsApplied=Math.min(b.creditsToUse||0,creditsLib.calculateMaxRedeemable(subtotal));
  var totalCharge=Math.max(0,subtotal-creditsApplied);
  var bookingRef='FLY'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).substr(2,3).toUpperCase();
  var client,bookingId;
  try{
    client=await pool.connect();
    if(creditsApplied>0){
      var cr=await client.query('SELECT balance FROM credits WHERE user_id=$1',[payload.sub]);
      if(parseFloat((cr.rows[0]&&cr.rows[0].balance)||0)<creditsApplied)throw{status:400,message:'Insufficient credit balance'};
    }
    var br=await client.query('INSERT INTO bookings (booking_ref,user_id,flight_number,airline_code,origin_code,dest_code,dep_date,dep_time,arr_time,cabin,adults,base_amount,credits_used,total_amount,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id',[bookingRef,payload.sub,b.flightNumber.slice(0,20),b.airlineCode,b.originCode,b.destCode,b.depDate,b.depTime,b.arrTime,b.cabin,b.adults||1,subtotal,creditsApplied,totalCharge,'pending']);
    bookingId=br.rows[0].id;
    await Promise.all(
      passengers.map(function(p){return client.query('INSERT INTO booking_passengers (booking_id,first_name,last_name,date_of_birth,passport_no,seat_number) VALUES ($1,$2,$3,$4,$5,$6)',[bookingId,p.firstName,p.lastName,p.dob||null,p.passportNo||null,p.seat||null]);})
      .concat(addons.map(function(a){return client.query('SELECT id,price_usd FROM addons_catalog WHERE code=$1',[a.code]).then(function(r){if(r.rows[0]){var qty=a.quantity||1;return client.query('INSERT INTO booking_addons (booking_id,addon_id,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5)',[bookingId,r.rows[0].id,qty,r.rows[0].price_usd,r.rows[0].price_usd*qty]);}});}))
    );
    var pi=await stripe.paymentIntents.create({amount:Math.round(totalCharge*100),currency:'usd',metadata:{bookingId:bookingId.toString(),bookingRef,userId:payload.sub.toString(),flightNumber:b.flightNumber},description:'FLYYB '+bookingRef+' '+b.originCode+'->'+b.destCode});
    await client.query('INSERT INTO payment_intents (booking_id,stripe_pi_id,amount,credits_applied,status) VALUES ($1,$2,$3,$4,$5)',[bookingId,pi.id,totalCharge,creditsApplied,'pending']);
    res.json({clientSecret:pi.client_secret,bookingRef,bookingId,summary:{baseAmount:parseFloat(b.baseAmount),addonsTotal,subtotal,creditsApplied,totalCharge,creditsToEarn:creditsLib.calculateEarnable(totalCharge)}});
  }catch(err){if(err.status)return res.status(err.status).json({error:err.message});console.error('Intent:',err);res.status(500).json({error:err.message||'Payment setup failed'});}
  finally{if(client)client.release();}
}

// -- STRIPE WEBHOOK -------------------------------------------
function getRawBody(req){return new Promise(function(resolve,reject){var d='';req.on('data',function(c){d+=c;});req.on('end',function(){resolve(d);});req.on('error',reject);});}

async function handleWebhook(req,res){
  var stripe=Stripe(process.env.STRIPE_SECRET_KEY);
  try{
    var raw=await getRawBody(req);
    var event=stripe.webhooks.constructEvent(raw,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);
    var client=await pool.connect();
    try{
      if(event.type==='payment_intent.succeeded'){
        var pi=event.data.object,bookingId=parseInt(pi.metadata.bookingId),userId=parseInt(pi.metadata.userId),bookingRef=pi.metadata.bookingRef;
        await client.query('BEGIN');
        var br=await client.query('UPDATE bookings SET status=$1,payment_ref=$2,payment_method=$3,updated_at=NOW() WHERE id=$4 RETURNING total_amount,credits_used,dep_date,dep_time,arr_time,flight_number,airline_code,origin_code,dest_code,cabin,adults',['confirmed',pi.id,'stripe',bookingId]);
        var bk=br.rows[0];
        await client.query('UPDATE payment_intents SET status=$1,updated_at=NOW() WHERE stripe_pi_id=$2',['succeeded',pi.id]);
        if(bk&&parseFloat(bk.credits_used)>0){
          await client.query('UPDATE credits SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2',[bk.credits_used,userId]);
          await client.query('INSERT INTO credit_transactions (user_id,amount,type,description,booking_ref) VALUES ($1,$2,$3,$4,$5)',[userId,-bk.credits_used,'redeem','Credits applied to '+bookingRef,bookingRef]);
        }
        var earned=0;
        if(bk&&userId)earned=await creditsLib.earnCredits(client,userId,bookingRef,parseFloat(bk.total_amount));
        await client.query('COMMIT');
        if(bk){
          var ur=await client.query('SELECT email,name FROM users WHERE id=$1',[userId]);
          var u=ur.rows[0];
          if(u&&u.email){
            var oa=await client.query('SELECT city FROM airports WHERE iata_code=$1',[bk.origin_code]);
            var da=await client.query('SELECT city FROM airports WHERE iata_code=$1',[bk.dest_code]);
            await sendEmail(u.email,'FLYYB Booking Confirmed - '+bookingRef,confirmationHtml({ref:bookingRef,origin:(oa.rows[0]&&oa.rows[0].city)||bk.origin_code,dest:(da.rows[0]&&da.rows[0].city)||bk.dest_code,date:new Date(bk.dep_date).toDateString(),dep:bk.dep_time?bk.dep_time.slice(0,5):'',arr:bk.arr_time?bk.arr_time.slice(0,5):'',flight:bk.flight_number,cabin:bk.cabin.charAt(0).toUpperCase()+bk.cabin.slice(1),adults:bk.adults,total:parseFloat(bk.total_amount).toFixed(2),creditsEarned:earned?parseFloat(earned).toFixed(2):null}));
          }
        }
      }else if(event.type==='payment_intent.payment_failed'){
        await client.query('UPDATE bookings SET status=$1 WHERE id=$2',['payment_failed',parseInt(event.data.object.metadata.bookingId)]);
      }
    }finally{client.release();}
    res.json({received:true});
  }catch(err){console.error('Webhook:',err);res.status(400).json({error:err.message});}
}

// -- ROUTER ----------------------------------------------------
module.exports=function(req,res){
  var action=req.query.action;
  if(action==='webhook')return handleWebhook(req,res);
  auth.cors(req,res);
  if(req.method==='OPTIONS')return;
  if(action==='addons')        return handleAddons(req,res);
  if(action==='credits')       return handleCredits(req,res);
  if(action==='create-intent') return handleCreateIntent(req,res);
  return res.status(400).json({error:'Missing action. Use ?action=addons|credits|create-intent|webhook'});
};
