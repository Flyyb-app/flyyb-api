// search.js — airports, flight search, health check
// Routes: ?action=airports | ?action=flights | ?action=health
var pg=require('pg'),auth=require('../lib/auth'),pricing=require('../lib/pricing');
var pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});

// Currency rates cache
var ratesCache=null,ratesCacheTime=0;
var COUNTRY_CURRENCY={US:'USD',GB:'GBP',FR:'EUR',DE:'EUR',NL:'EUR',ES:'EUR',IT:'EUR',CH:'CHF',JP:'JPY',AU:'AUD',CA:'CAD',CN:'CNY',HK:'HKD',SG:'SGD',IN:'INR',KR:'KRW',MY:'MYR',TH:'THB',ID:'IDR',PH:'PHP',VN:'VND',TW:'TWD',NZ:'NZD',AE:'AED',QA:'QAR',SA:'SAR',BR:'BRL',MX:'MXN',ZA:'ZAR',TR:'TRY',SE:'SEK',NO:'NOK',DK:'DKK',PK:'PKR',BD:'BDT',LK:'LKR',NP:'NPR',OM:'AED',KW:'AED'};

async function getRates(client){
  if(ratesCache&&Date.now()-ratesCacheTime<3600000)return ratesCache;
  try{
    var r=await client.query('SELECT code,rate_usd,symbol FROM currencies');
    ratesCache={};
    r.rows.forEach(function(c){ratesCache[c.code]={rate:parseFloat(c.rate_usd),symbol:c.symbol};});
    ratesCacheTime=Date.now();
    return ratesCache;
  }catch(e){return{USD:{rate:1,symbol:'$'}};}
}

function convertPrice(usd,currency,rates){
  if(!currency||currency==='USD')return{amount:usd,symbol:'$',code:'USD'};
  var r=rates[currency];
  if(!r)return{amount:usd,symbol:'$',code:'USD'};
  return{amount:Math.round(usd*r.rate),symbol:r.symbol,code:currency};
}

function buildFlight(f,cabin,advanceDays,date,stops,via,currency,rates){
  var seats=pricing.generateSeatAvailability(f.total_seats,advanceDays);
  var usdPrice=pricing.calculatePrice(f.base_price_usd,cabin,advanceDays,seats.fraction);
  var conv=convertPrice(usdPrice,currency,rates);
  return{id:f.flight_number+'-'+date,flightNumber:f.flight_number,airline:{code:f.airline_code,name:f.airline_name},origin:{code:f.origin_code,city:f.origin_city,country:f.origin_country||''},destination:{code:f.dest_code,city:f.dest_city,country:f.dest_country||''},departure:f.dep_time?f.dep_time.slice(0,5):'',arrival:f.arr_time?f.arr_time.slice(0,5):'',durationMin:f.duration_min,duration:pricing.formatDuration(f.duration_min),aircraft:f.aircraft_type,stops:stops,via:via,cabin:cabin,price:{perPerson:conv.amount,perPersonUSD:usdPrice,total:conv.amount,symbol:conv.symbol,currency:conv.code},seats:{available:seats.available,alert:seats.showAlert},date:date};
}

// -- AIRPORTS --------------------------------------------------
async function handleAirports(req,res){
  var q=(req.query.q||'').trim();
  var limit=Math.min(parseInt(req.query.limit||'8'),20);
  if(!q)return res.json([]);
  var client;
  try{
    client=await pool.connect();
    var r=await client.query(
      'SELECT iata_code AS code,name,city,country,is_major FROM airports WHERE lower(iata_code)=lower($1) OR lower(city) LIKE lower($2) OR lower(name) LIKE lower($2) ORDER BY CASE WHEN lower(iata_code)=lower($1) THEN 0 ELSE 1 END,is_major DESC,city LIMIT $3',
      [q,'%'+q+'%',limit]
    );
    res.json(r.rows);
  }catch(err){console.error('Airport search:',err.message);res.status(500).json({error:'Airport search failed'});}
  finally{if(client)client.release();}
}

// -- FLIGHTS ---------------------------------------------------
async function handleFlights(req,res){
  var from=req.query.from,to=req.query.to,date=req.query.date;
  var cabin=req.query.cabin||'economy',nonstop=req.query.nonstop||'false',sort=req.query.sort||'price',adults=req.query.adults||'1';
  var currency=(req.query.currency||'').toUpperCase();
  if(!from||!to||!date)return res.status(400).json({error:'from, to, date required'});
  var depDate=new Date(date);
  if(isNaN(depDate.getTime()))return res.status(400).json({error:'Invalid date'});
  var today=new Date();today.setHours(0,0,0,0);
  var advanceDays=Math.max(0,Math.floor((depDate-today)/86400000));
  var dow=depDate.getDay()===0?7:depDate.getDay();
  var origin=from.toUpperCase(),dest=to.toUpperCase();
  var client;
  try{
    client=await pool.connect();
    var rates=await getRates(client);
    if(!currency){
      var apRes=await client.query('SELECT country FROM airports WHERE iata_code=$1',[origin]);
      currency=apRes.rows.length?(COUNTRY_CURRENCY[apRes.rows[0].country]||'USD'):'USD';
    }
    var dr=await client.query(
      'SELECT fs.flight_number,fs.airline_code,al.name AS airline_name,fs.origin_code,oa.city AS origin_city,oa.country AS origin_country,fs.dest_code,da.city AS dest_city,da.country AS dest_country,fs.dep_time,fs.arr_time,fs.duration_min,fs.aircraft_type,fs.total_seats,r.base_price_usd FROM flight_schedules fs JOIN airlines al ON al.iata_code=fs.airline_code JOIN airports oa ON oa.iata_code=fs.origin_code JOIN airports da ON da.iata_code=fs.dest_code JOIN routes r ON r.origin_code=fs.origin_code AND r.dest_code=fs.dest_code AND r.airline_code=fs.airline_code WHERE fs.origin_code=$1 AND fs.dest_code=$2 AND $3=ANY(fs.days_of_week) AND $4=ANY(fs.cabin_classes) ORDER BY fs.dep_time LIMIT 10',
      [origin,dest,dow,cabin]
    );
    var results=dr.rows.map(function(f){return buildFlight(f,cabin,advanceDays,date,0,null,currency,rates);});
    if(nonstop!=='true'&&results.length<4){
      var cr=await client.query(
        'SELECT f1.flight_number AS fn1,f1.airline_code AS al1,al1.name AS al1_name,f1.origin_code,oa.city AS origin_city,oa.country AS origin_country,f1.dest_code AS via_code,va.city AS via_city,f1.arr_time AS via_arr,f2.dep_time AS via_dep,f2.flight_number AS fn2,f2.dest_code,da.city AS dest_city,da.country AS dest_country,f2.arr_time,(f1.duration_min+f2.duration_min+90) AS duration_min,f1.dep_time,f1.aircraft_type,f1.total_seats,(r1.base_price_usd+r2.base_price_usd) AS base_price_usd FROM flight_schedules f1 JOIN flight_schedules f2 ON f2.origin_code=f1.dest_code AND f2.dest_code=$2 AND $3=ANY(f2.days_of_week) AND $4=ANY(f2.cabin_classes) AND f2.dep_time>f1.arr_time JOIN airlines al1 ON al1.iata_code=f1.airline_code JOIN airports oa ON oa.iata_code=f1.origin_code JOIN airports va ON va.iata_code=f1.dest_code JOIN airports da ON da.iata_code=f2.dest_code JOIN routes r1 ON r1.origin_code=f1.origin_code AND r1.dest_code=f1.dest_code AND r1.airline_code=f1.airline_code JOIN routes r2 ON r2.origin_code=f2.origin_code AND r2.dest_code=f2.dest_code AND r2.airline_code=f2.airline_code WHERE f1.origin_code=$1 AND f1.dest_code!=$2 AND $3=ANY(f1.days_of_week) AND $4=ANY(f1.cabin_classes) ORDER BY f1.dep_time LIMIT 6',
        [origin,dest,dow,cabin]
      );
      cr.rows.forEach(function(f){
        var via={code:f.via_code,city:f.via_city,arr:f.via_arr?f.via_arr.slice(0,5):'',dep:f.via_dep?f.via_dep.slice(0,5):''};
        results.push(buildFlight(Object.assign({},f,{flight_number:f.fn1+'+'+f.fn2,airline_code:f.al1,airline_name:f.al1_name,origin_code:origin,dest_code:dest}),cabin,advanceDays,date,1,via,currency,rates));
      });
    }
    if(sort==='price')results.sort(function(a,b){return a.price.perPerson-b.price.perPerson;});
    else if(sort==='duration')results.sort(function(a,b){return a.durationMin-b.durationMin;});
    else results.sort(function(a,b){return a.departure.localeCompare(b.departure);});
    if(results.length)results[0].bestValue=true;
    res.json({results:results,meta:{origin,destination:dest,date,adults:parseInt(adults),cabin,count:results.length,advanceDays,currency}});
  }catch(err){console.error('Search error:',err);res.status(500).json({error:err.message});}
  finally{if(client)client.release();}
}

// -- HEALTH ----------------------------------------------------
async function handleHealth(req,res){
  var client;
  try{
    client=await pool.connect();
    await client.query('SELECT 1');
    res.json({status:'ok',database:'connected',timestamp:new Date().toISOString(),version:'2.0.0'});
  }catch(err){res.status(503).json({status:'error',message:err.message});}
  finally{if(client)client.release();}
}

// -- ROUTER ----------------------------------------------------
module.exports=function(req,res){
  if(auth.cors(req,res))return;
  var action=req.query.action||req.path;
  if(action==='airports')return handleAirports(req,res);
  if(action==='flights') return handleFlights(req,res);
  if(action==='health')  return handleHealth(req,res);
  // Legacy URL support (old separate endpoints)
  var url=req.url||'';
  if(url.includes('/airports'))return handleAirports(req,res);
  if(url.includes('/flights')) return handleFlights(req,res);
  if(url.includes('/health'))  return handleHealth(req,res);
  return res.status(400).json({error:'Missing action. Use ?action=airports|flights|health'});
};
