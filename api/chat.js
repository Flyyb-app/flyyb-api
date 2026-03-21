var auth=require('../lib/auth');
var SYSTEM='You are FLYYBs friendly travel assistant. FLYYB is a flight search and booking platform. Help users with: flight searches, booking guidance, baggage allowances, check-in, cancellations, credits and rewards. FLYYB Policies: free cancellation up to 24h before departure, reschedule up to 48h before, earn 5% of booking as credits, credits pay up to 20% of future bookings. Keep responses concise, friendly and helpful. Never make up prices or availability.';
module.exports=function(req,res){
  if(auth.cors(req,res))return;
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  var b=req.body||{};
  if(!b.message)return res.status(400).json({error:'Message required'});
  var apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey)return res.status(500).json({error:'Chat not configured'});
  var history=(b.history||[]).slice(-10);
  var contents=[],lastRole=null;
  history.forEach(function(m){
    var role=m.role==='assistant'?'model':'user';
    if(role!==lastRole){contents.push({role:role,parts:[{text:m.content||''}]});lastRole=role;}
  });
  while(contents.length&&contents[0].role==='model')contents.shift();
  if(contents.length&&contents[contents.length-1].role==='user')contents.pop();
  contents.push({role:'user',parts:[{text:b.message}]});
  var url='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key='+apiKey;
  return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:SYSTEM}]},contents:contents,generationConfig:{maxOutputTokens:400,temperature:0.7}})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.error){console.error('Gemini:',JSON.stringify(d.error));return res.status(500).json({error:'Chat unavailable'});}
    var reply=d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts&&d.candidates[0].content.parts[0]&&d.candidates[0].content.parts[0].text;
    res.json({reply:reply||'Sorry, could not process that.'});
  }).catch(function(e){console.error('Chat:',e.message);res.status(500).json({error:'Chat unavailable'});});
};
