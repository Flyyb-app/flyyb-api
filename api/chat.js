var auth=require('../lib/auth');
var SYSTEM='You are FLYYBs friendly travel assistant. FLYYB is a flight search and booking platform. Help users with: flight searches, booking guidance, baggage allowances, check-in, cancellations, credits and rewards. FLYYB Policies: free cancellation up to 24h before departure, reschedule up to 48h before, earn 5% of booking as credits, credits pay up to 20% of future bookings. Keep responses concise, friendly and helpful. Never make up prices or availability.';

module.exports=function(req,res){
  if(auth.cors(req,res))return;
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  var b=req.body||{};
  if(!b.message)return res.status(400).json({error:'Message required'});

  var apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey){console.error('GEMINI_API_KEY not set');return res.status(500).json({error:'Chat not configured'});}

  // Build contents - Gemini requires strict user/model alternation
  var contents=[];
  var history=(b.history||[]).slice(-10);

  // Sanitize history - ensure strict alternation starting with user
  var sanitized=[];
  var lastRole=null;
  history.forEach(function(m){
    var role=m.role==='assistant'?'model':'user';
    if(role!==lastRole){
      sanitized.push({role:role,parts:[{text:m.content||''}]});
      lastRole=role;
    }
  });

  // Must start with user role - drop leading model messages
  while(sanitized.length&&sanitized[0].role==='model'){
    sanitized.shift();
  }

  // Add all sanitized history
  sanitized.forEach(function(m){contents.push(m);});

  // Ensure last message before new one is not user (would make two user in a row)
  if(contents.length&&contents[contents.length-1].role==='user'){
    contents.pop();
  }

  // Add current user message
  contents.push({role:'user',parts:[{text:b.message}]});

  var url='https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key='+apiKey;

  return fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      systemInstruction:{parts:[{text:SYSTEM}]},
      contents:contents,
      generationConfig:{maxOutputTokens:400,temperature:0.7}
    })
  }).then(function(r){
    return r.json();
  }).then(function(d){
    if(d.error){
      console.error('Gemini error:',JSON.stringify(d.error));
      return res.status(500).json({error:'Chat unavailable: '+d.error.message});
    }
    var reply=d.candidates
      &&d.candidates[0]
      &&d.candidates[0].content
      &&d.candidates[0].content.parts
      &&d.candidates[0].content.parts[0]
      &&d.candidates[0].content.parts[0].text;
    if(!reply){
      console.error('Gemini no reply:',JSON.stringify(d).slice(0,300));
      return res.json({reply:'Sorry, I could not process that. Please try again.'});
    }
    res.json({reply:reply});
  }).catch(function(err){
    console.error('Chat fetch error:',err.message);
    res.status(500).json({error:'Chat unavailable'});
  });
};
