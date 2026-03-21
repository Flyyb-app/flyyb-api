var pg=require('pg'),Stripe=require('stripe'),auth=require('../lib/auth');
var pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});

async function sendEmail(to,subject,html){
  var k=process.env.BREVO_SMTP_KEY,f=process.env.BREVO_FROM_EMAIL;
  if(!k||!f){console.log('=== EMAIL to '+to+' ===');return;}
  try{await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'Content-Type':'application/json','api-key':k},body:JSON.stringify({sender:{name:'FLYYB',email:f},to:[{email:to}],subject,htmlContent:html})});}
  catch(e){console.error('Email error:',e.message);}
}

function tripEmailHtml(type,b){
  var color=type==='cancel'?'#e8836a':'#4a7fa8';
  var title=type==='cancel'?'Booking Cancelled':'Booking Rescheduled';
  var msg=type==='cancel'?'Your booking has been cancelled. Refund will appear in 5-10 business days.':'Your booking has been rescheduled to the new date below.';
  return '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0a0a0f;color:#f5f0e8;padding:32px;border-radius:8px">'
    +'<h1 style="font-size:24px;letter-spacing:4px;margin-bottom:4px">FLY<span style="color:#d4a843">YB</span></h1>'
    +'<p style="color:rgba(245,240,232,.5);font-size:12px;margin-bottom:28px">fly with vibe</p>'
    +'<h2 style="color:'+color+';font-size:20px;margin-bottom:8px">'+title+'</h2>'
    +'<p style="color:rgba(245,240,232,.7);font-size:14px;margin-bottom:24px">'+msg+'</p>'
    +'<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:20px;margin-bottom:20px">'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:rgba(245,240,232,.5);font-size:13px">Booking Ref</span><span style="font-family:monospace;color:#d4a843">'+b.ref+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:rgba(245,240,232,.5);font-size:13px">Route</span><span>'+b.origin+' → '+b.dest+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:rgba(245,240,232,.5);font-size:13px">Date</span><span>'+b.date+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:rgba(245,240,232,.5);font-size:13px">Flight</span><span>'+b.flight+'</span></div>'
    +(b.total?'<div style="display:flex;justify-content:space-between"><span style="color:rgba(245,240,232,.5);font-size:13px">Amount</span><span>$'+b.total+'</span></div>':'')
    +'</div>'
    +'<p style="color:rgba(245,240,232,.4);font-size:12px;text-align:center">Thank you for flying with FLYYB ✈</p></div>';
}

module.exports=async function(req,res){
  if(auth.cors(req,res))return;
  var payload=auth.requireAuth(req,res);
  if(!payload)return;
  var client;
  try{
    client=await pool.connect();

    // GET trips
    if(req.method==='GET'){
      var status=req.query.status||'all';
      var q='SELECT b.id,b.booking_ref,b.flight_number,b.airline_code,al.name AS airline_name,b.origin_code,oa.city AS origin_city,b.dest_code,da.city AS dest_city,b.dep_date,b.dep_time,b.arr_time,b.cabin,b.adults,b.total_amount,b.credits_used,b.status,b.created_at FROM bookings b JOIN airlines al ON al.iata_code=b.airline_code JOIN airports oa ON oa.iata_code=b.origin_code JOIN airports da ON da.iata_code=b.dest_code WHERE b.user_id=$1';
      var p=[payload.sub];
      if(status!=='all'){q+=' AND b.status=$2';p.push(status);}
      q+=' ORDER BY b.dep_date DESC';
      var r=await client.query(q,p);
      return res.json(r.rows.map(function(b){return{id:b.id,bookingRef:b.booking_ref,flight:{number:b.flight_number,airline:{code:b.airline_code,name:b.airline_name}},origin:{code:b.origin_code,city:b.origin_city},destination:{code:b.dest_code,city:b.dest_city},date:b.dep_date,departure:b.dep_time?b.dep_time.slice(0,5):'',arrival:b.arr_time?b.arr_time.slice(0,5):'',cabin:b.cabin,adults:b.adults,total:parseFloat(b.total_amount),creditsUsed:parseFloat(b.credits_used||0),status:b.status,bookedAt:b.created_at};}));
    }

    // CANCEL
    if(req.method==='POST'&&req.query.action==='cancel'){
      var ref=(req.body||{}).bookingRef;
      if(!ref)return res.status(400).json({error:'Booking ref required'});
      var br=await client.query('SELECT b.id,b.status,b.dep_date,b.total_amount,b.payment_ref,b.flight_number,b.origin_code,b.dest_code,u.email,u.name FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.booking_ref=$1 AND b.user_id=$2',[ref,payload.sub]);
      var bk=br.rows[0];
      if(!bk)return res.status(404).json({error:'Booking not found'});
      if(bk.status==='cancelled')return res.status(400).json({error:'Already cancelled'});
      if((new Date(bk.dep_date)-Date.now())/3600000<24)return res.status(400).json({error:'Cannot cancel within 24 hours of departure'});
      var stripe=Stripe(process.env.STRIPE_SECRET_KEY);
      var refund=null;
      if(bk.payment_ref){try{refund=await stripe.refunds.create({payment_intent:bk.payment_ref,reason:'requested_by_customer'});}catch(e){console.error('Refund:',e.message);}}
      await client.query('UPDATE bookings SET status=$1,updated_at=NOW() WHERE id=$2',['cancelled',bk.id]);
      var rev=parseFloat(bk.total_amount)*0.05;
      await client.query('UPDATE credits SET balance=GREATEST(0,balance-$1),updated_at=NOW() WHERE user_id=$2',[rev,payload.sub]);
      await client.query('INSERT INTO credit_transactions (user_id,amount,type,description,booking_ref) VALUES ($1,$2,$3,$4,$5)',[payload.sub,-rev,'refund','Credits reversed for cancellation of '+ref,ref]);
      if(bk.email){
        await sendEmail(bk.email,'FLYYB Booking Cancelled - '+ref,tripEmailHtml('cancel',{ref,origin:bk.origin_code,dest:bk.dest_code,date:new Date(bk.dep_date).toDateString(),flight:bk.flight_number,total:parseFloat(bk.total_amount).toFixed(2)}));
      }
      return res.json({message:'Booking cancelled',refundId:refund?refund.id:null});
    }

    // RESCHEDULE
    if(req.method==='POST'&&req.query.action==='reschedule'){
      var body=req.body||{};
      if(!body.bookingRef||!body.newDate)return res.status(400).json({error:'Booking ref and new date required'});
      var br=await client.query('SELECT b.id,b.status,b.dep_date,b.flight_number,b.origin_code,b.dest_code,u.email,u.name FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.booking_ref=$1 AND b.user_id=$2',[body.bookingRef,payload.sub]);
      var bk=br.rows[0];
      if(!bk)return res.status(404).json({error:'Booking not found'});
      if(bk.status!=='confirmed')return res.status(400).json({error:'Only confirmed bookings can be rescheduled'});
      if((new Date(bk.dep_date)-Date.now())/3600000<48)return res.status(400).json({error:'Cannot reschedule within 48 hours'});
      await client.query('UPDATE bookings SET dep_date=$1,status=$2,updated_at=NOW() WHERE id=$3',[body.newDate,'rescheduled',bk.id]);
      if(bk.email){
        await sendEmail(bk.email,'FLYYB Booking Rescheduled - '+body.bookingRef,tripEmailHtml('reschedule',{ref:body.bookingRef,origin:bk.origin_code,dest:bk.dest_code,date:new Date(body.newDate).toDateString(),flight:bk.flight_number,total:null}));
      }
      return res.json({message:'Rescheduled successfully'});
    }

    res.status(405).json({error:'Method not allowed'});
  }catch(err){
    if(err.status)return res.status(err.status).json({error:err.message});
    console.error('Trips error:',err);
    res.status(500).json({error:'Operation failed'});
  }finally{if(client)client.release();}
};
