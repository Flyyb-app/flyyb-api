var auth = require('../lib/auth');

var AIRA_SYSTEM = 'You are AIRA (AI Reservations Assistant), FLYYBs premium AI flight concierge. You are warm, efficient and feel like a knowledgeable air hostess who knows the passenger personally. Speak in short clear sentences. Use the users first name naturally. Never ask for info you already have. When a user asks to search flights or mentions a route, always respond with ONLY this exact JSON on one line and nothing else: {"action":"search","from":"CITY","to":"CITY","date":"DATE_AS_SPOKEN","cabin":"economy"}. For all other questions respond normally as AIRA. FLYYB Policies: free cancellation up to 24h before departure, rescheduling up to 48h before, earn 5% credits on every booking, credits pay up to 20% of any booking. Baggage: economy 23kg checked + 7kg cabin, business 32kg checked + 10kg cabin. Online check-in opens 24h before departure.';

var COUNTRY_CURRENCY = {US:'USD',GB:'GBP',IN:'INR',AU:'AUD',CA:'CAD',SG:'SGD',AE:'AED',JP:'JPY',DE:'EUR',FR:'EUR',NZ:'NZD',MY:'MYR',TH:'THB',PH:'PHP',ID:'IDR',VN:'VND',KR:'KRW',CN:'CNY',HK:'HKD',TW:'TWD',PK:'PKR',BD:'BDT',LK:'LKR',NP:'NPR',QA:'QAR',SA:'SAR'};
var CURR_SYMBOLS = {USD:'$',EUR:'\u20ac',GBP:'\u00a3',INR:'\u20b9',JPY:'\u00a5',AUD:'A$',CAD:'C$',SGD:'S$',AED:'AED',CHF:'CHF',CNY:'\u00a5',HKD:'HK$',KRW:'\u20a9',MYR:'RM',THB:'\u0e3f',IDR:'Rp',PHP:'\u20b1',VND:'\u20ab',TWD:'NT$',NZD:'NZ$',BRL:'R$',MXN:'MX$',ZAR:'R',TRY:'\u20ba',SEK:'kr',NOK:'kr',DKK:'kr',PKR:'\u20a8',BDT:'\u09f3',LKR:'\u20a8',NPR:'\u20a8',QAR:'QAR',SAR:'SAR'};

var _pool = null;
function getPool(){
if(!_pool){var pg=require('pg');_pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});}
return _pool;
}

var ratesCache=null,ratesCacheTime=0;
async function getRates(client){
if(ratesCache&&Date.now()-ratesCacheTime<3600000)return ratesCache;
try{
var r=await client.query('SELECT code,rate_usd,symbol FROM currencies');
ratesCache={};
r.rows.forEach(function(c){ratesCache[c.code]={rate:parseFloat(c.rate_usd),symbol:c.symbol};});
ratesCacheTime=Date.now();
return ratesCache;
}catch(e){return {USD:{rate:1,symbol:'$'}};}
}

function convertPrice(usd,currency,rates){
if(!currency||currency==='USD')return{amount:usd,symbol:'$',code:'USD'};
var r=rates[currency];
if(!r)return{amount:usd,symbol:'$',code:'USD'};
return{amount:Math.round(usd*r.rate),symbol:r.symbol||CURR_SYMBOLS[currency]||'$',code:currency};
}

async function searchFlights(from,to,date,cabin,currency){
cabin=cabin||'economy';
var client;
try{
client=await getPool().connect();
var rates=await getRates(client);
var depDate=new Date(date);
var today=new Date();today.setHours(0,0,0,0);
var advanceDays=Math.max(0,Math.floor((depDate-today)/86400000));
var dow=depDate.getDay()===0?7:depDate.getDay();
if(!currency){
var apRes=await client.query('SELECT country FROM airports WHERE iata_code=$1',[from.toUpperCase()]);
currency=apRes.rows.length?(COUNTRY_CURRENCY[apRes.rows[0].country]||'USD'):'USD';
}
var dr=await client.query(
'SELECT fs.flight_number,fs.airline_code,al.name AS airline_name,fs.origin_code,oa.city AS origin_city,fs.dest_code,da.city AS dest_city,fs.dep_time,fs.arr_time,fs.duration_min,fs.aircraft_type,fs.total_seats,r.base_price_usd FROM flight_schedules fs JOIN airlines al ON al.iata_code=fs.airline_code JOIN airports oa ON oa.iata_code=fs.origin_code JOIN airports da ON da.iata_code=fs.dest_code JOIN routes r ON r.origin_code=fs.origin_code AND r.dest_code=fs.dest_code AND r.airline_code=fs.airline_code WHERE fs.origin_code=$1 AND fs.dest_code=$2 AND $3=ANY(fs.days_of_week) AND $4=ANY(fs.cabin_classes) ORDER BY fs.dep_time LIMIT 6',
[from.toUpperCase(),to.toUpperCase(),dow,cabin]
);
var CABIN_MULT={economy:1,premium_economy:1.6,business:3.2,first:5.5};
var mult=CABIN_MULT[cabin]||1;
return dr.rows.map(function(f){
var usdPrice=Math.round(parseFloat(f.base_price_usd)*mult*(advanceDays>=60?0.8:advanceDays>=30?0.9:advanceDays>=7?1.1:1.3)*(0.95+Math.random()*0.1));
var conv=convertPrice(usdPrice,currency,rates);
return{
flightNumber:f.flight_number,
airline:{code:f.airline_code,name:f.airline_name},
origin:{code:f.origin_code,city:f.origin_city},
destination:{code:f.dest_code,city:f.dest_city},
departure:f.dep_time?f.dep_time.slice(0,5):'',
arrival:f.arr_time?f.arr_time.slice(0,5):'',
durationMin:f.duration_min,
duration:Math.floor(f.duration_min/60)+'h '+(f.duration_min%60)+'m',
cabin:cabin,stops:0,via:null,
price:{perPerson:conv.amount,symbol:conv.symbol,currency:conv.code},
seats:{available:Math.max(1,Math.floor(f.total_seats*(advanceDays>30?0.7:0.3))),alert:null},
aircraft:f.aircraft_type
};
});
}catch(e){console.error('AIRA search:',e.message);return [];}
finally{if(client)client.release();}
}

function parseNaturalDate(text){
var now=new Date();
var t=(text||'').toLowerCase();
if(t.includes('tomorrow')){var d=new Date(now);d.setDate(d.getDate()+1);return d.toISOString().split('T')[0];}
var days=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
for(var i=0;i<days.length;i++){
if(t.includes('next '+days[i])||t.includes('this '+days[i])){
var d=new Date(now);var diff=(i-d.getDay()+7)%7||7;
d.setDate(d.getDate()+diff);return d.toISOString().split('T')[0];
}
}
var dm=t.match(/in (\d+) days?/);
if(dm){var d=new Date(now);d.setDate(d.getDate()+parseInt(dm[1]));return d.toISOString().split('T')[0];}
var months=['january','february','march','april','may','june','july','august','september','october','november','december'];
for(var i=0;i<months.length;i++){
if(t.includes(months[i])){
var nm=t.match(/\b(\d{1,2})\b/);
if(nm){var d=new Date(now.getFullYear(),i,parseInt(nm[1]));if(d<now)d.setFullYear(d.getFullYear()+1);return d.toISOString().split('T')[0];}
}
}
var d=new Date(now);d.setDate(d.getDate()+7);return d.toISOString().split('T')[0];
}

async function resolveAirport(city){
if(!city)return null;
var client;
try{
client=await getPool().connect();
var r=await client.query('SELECT iata_code,city,name FROM airports WHERE lower(iata_code)=lower($1) OR lower(city) LIKE lower($2) OR lower(name) LIKE lower($2) ORDER BY is_major DESC LIMIT 1',[city,'%'+city+'%']);
return r.rows[0]||null;
}catch(e){return null;}
finally{if(client)client.release();}
}

function isFlightQuery(message){
var t=message.toLowerCase();
var flightWords=['to ','flight','fly','book','from ','ticket','travel'];
var placeWords=['airport','city','london','dubai','singapore','chennai','mumbai','delhi','new york','paris','tokyo','sydney','bangkok','hong kong','kuala lumpur','jakarta','manila','colombo','karachi','dhaka','kathmandu','doha','riyadh','abu dhabi'];
var hasRoute=/\b(from|to)\s+\w+/.test(t)||/\w+\s+to\s+\w+/.test(t);
var hasFlightWord=flightWords.some(function(w){return t.includes(w);});
return hasRoute||hasFlightWord;
}

async function handleAira(message,history,context,apiKey,res){
try{
var url='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+apiKey;


// Build conversation history
var contents=[],lastRole=null;
history.forEach(function(m){
  var role=m.role==='assistant'?'model':'user';
  if(role!==lastRole){contents.push({role:role,parts:[{text:m.content||''}]});lastRole=role;}
});
while(contents.length&&contents[0].role==='model')contents.shift();
if(contents.length&&contents[contents.length-1].role==='user')contents.pop();

var userMsg=context?('[User context: '+context+']\n\n'+message):message;
contents.push({role:'user',parts:[{text:userMsg}]});

// Call Gemini
var r=await fetch(url,{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    systemInstruction:{parts:[{text:AIRA_SYSTEM}]},
    contents:contents,
    generationConfig:{maxOutputTokens:300,temperature:0.7}
  })
});
var d=await r.json();
if(d.error){console.error('Gemini:',d.error.message);return res.status(500).json({error:'Chat unavailable'});}

var reply=d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts&&d.candidates[0].content.parts[0]&&d.candidates[0].content.parts[0].text;
if(!reply)return res.json({reply:'I am not sure about that. Could you rephrase?'});

reply=reply.trim();

// Check if Gemini returned a search action JSON
var actionMatch=reply.match(/\{"action"\s*:\s*"search"[^}]+\}/);
if(actionMatch){
  try{
    var intent=JSON.parse(actionMatch[0]);
    if(intent.from&&intent.to){
      var fromAP=await resolveAirport(intent.from);
      var toAP=await resolveAirport(intent.to);
      if(fromAP&&toAP){
        var dateStr=intent.date?parseNaturalDate(intent.date):parseNaturalDate('next week');
        var cabin=intent.cabin||'economy';
        var currMatch=context.match(/Currency: ([A-Z]{3})/);
        var currency=currMatch?currMatch[1]:'USD';
        var flights=await searchFlights(fromAP.iata_code,toAP.iata_code,dateStr,cabin,currency);
        if(flights.length){
          var dateDisp=new Date(dateStr).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
          return res.json({action:'show_flights',flights:flights,from:fromAP.city,to:toAP.city,date:dateDisp,reply:'Found '+flights.length+' flights!'});
        }
        return res.json({reply:'No flights found from '+fromAP.city+' to '+toAP.city+' on that date. Try different dates?'});
      }
      if(!fromAP)return res.json({reply:'Could not find "'+intent.from+'" airport. Try using the airport code e.g. SIN, MAA, DEL?'});
      if(!toAP)return res.json({reply:'Could not find "'+intent.to+'" airport. Try using the airport code?'});
    }
  }catch(e){console.error('Intent parse error:',e.message);}
}

// Also catch if Gemini described flights in text despite instructions - do direct search
if(isFlightQuery(message)&&!actionMatch){
  // Try direct keyword extraction as fallback
  var words=message.toLowerCase().split(/\s+/);
  var toIdx=words.indexOf('to');
  var fromIdx=words.indexOf('from');
  var fromCity=fromIdx>=0?words.slice(fromIdx+1,toIdx>=0?toIdx:fromIdx+3).join(' '):null;
  var toCity=toIdx>=0?words.slice(toIdx+1,toIdx+3).join(' '):null;
  if(fromCity&&toCity){
    var fromAP=await resolveAirport(fromCity);
    var toAP=await resolveAirport(toCity);
    if(fromAP&&toAP){
      var dateStr=parseNaturalDate(message);
      var currMatch=context.match(/Currency: ([A-Z]{3})/);
      var currency=currMatch?currMatch[1]:'USD';
      var flights=await searchFlights(fromAP.iata_code,toAP.iata_code,dateStr,'economy',currency);
      if(flights.length){
        var dateDisp=new Date(dateStr).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
        return res.json({action:'show_flights',flights:flights,from:fromAP.city,to:toAP.city,date:dateDisp,reply:'Found '+flights.length+' flights!'});
      }
    }
  }
}

// Regular conversational reply
res.json({reply:reply});


}catch(err){
console.error('AIRA error:',err.message);
res.status(500).json({error:'Chat unavailable'});
}
}

module.exports=function(req,res){
if(auth.cors(req,res))return;
if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
var b=req.body||{};
if(!b.message)return res.status(400).json({error:'Message required'});
var apiKey=process.env.GEMINI_API_KEY;
if(!apiKey)return res.status(500).json({error:'Chat not configured'});
handleAira(b.message,(b.history||[]).slice(-12),b.context||'',apiKey,res);
};
