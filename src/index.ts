export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  GEMINI_API_KEY: string;
  WEBHOOK_SECRET: string;
}
type TgMessage = {
  message_id:number; date?:number; chat:{id:number|string;type:string};
  from?:{id:number;is_bot?:boolean;first_name?:string};
  text?:string; caption?:string;
  reply_to_message?:TgMessage;
  photo?:Array<{file_id:string;width:number;height:number;file_size?:number}>;
};
type Update = { update_id:number; message?:TgMessage; callback_query?: {
  id:string; from:{id:number}; data?:string; message?:TgMessage
}};
type PollData = {question:string;options:string[];correct_option_id:number;explanation:string;original:{question:string;options:Record<string,string>;correct:string};labels:string[]};
const LABELS=["ক","খ","গ","ঘ","ঙ"];
const TG="https://api.telegram.org";
async function tg(env:Env, method:string, body:Record<string,unknown>) {
  const r=await fetch(`${TG}/bot${env.BOT_TOKEN}/${method}`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
  });
  const data:any=await r.json();
  if(!data.ok) throw new Error(`${method}: ${data.description||r.statusText}`);
  return data.result;
}
async function setting(env:Env,key:string,fallback:string) {
  const r=await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{value:string}>();
  return r?.value ?? fallback;
}
async function isAdmin(env:Env,id:number) {
  return !!(await env.DB.prepare("SELECT user_id FROM admins WHERE user_id=?").bind(String(id)).first());
}
async function reply(env:Env,chat_id:number|string,text:string,extra:Record<string,unknown>={}) {
  return tg(env,"sendMessage",{chat_id,text,...extra});
}
async function inline(env:Env,chat_id:number|string,text:string,rows:string[][]) {
  return reply(env,chat_id,text,{reply_markup:{inline_keyboard:rows.map(row=>row.map(item=>{
    const [label,data]=item.split("|");return {text:label,callback_data:data};
  }))}});
}
async function answerCallback(env:Env,id:string,text="") {
  try { await tg(env,"answerCallbackQuery",{callback_query_id:id,text}); } catch {}
}
async function getFileBytes(env:Env,fileId:string) {
  const meta:any=await tg(env,"getFile",{file_id:fileId});
  const r=await fetch(`${TG}/file/bot${env.BOT_TOKEN}/${meta.file_path}`);
  if(!r.ok) throw new Error("Could not download Telegram image");
  const bytes=new Uint8Array(await r.arrayBuffer());
  let binary=""; for(const b of bytes) binary+=String.fromCharCode(b);
  return {base64:btoa(binary),mime:meta.file_path.endsWith(".png")?"image/png":meta.file_path.endsWith(".webp")?"image/webp":"image/jpeg"};
}
async function extractMcqs(env:Env,fileId:string) {
  const {base64,mime}=await getFileBytes(env,fileId);
  const prompt=`Extract ALL MCQ questions in this image. Output each question exactly as:
প্রশ্ন: question text
ক) first option
খ) second option
গ) third option
ঘ) fourth option
ঙ) fifth option (only if present)
সঠিক উত্তর: ক or খ or গ or ঘ or ঙ
Convert all option labels to Bengali ক, খ, গ, ঘ, ঙ. Preserve equations and English text. Do not skip questions. If correct answer is not clearly shown, do not guess; mark সঠিক উত্তর: অজানা.`;
  const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({contents:[{parts:[{text:prompt},{inline_data:{mime_type:mime,data:base64}}]}],generationConfig:{temperature:0.1}})
  });
  const json:any=await response.json();
  if(!response.ok) throw new Error(json?.error?.message||"Gemini request failed");
  return (json.candidates?.[0]?.content?.parts||[]).map((p:any)=>p.text||"").join("\n");
}
function parseMcqs(text:string) {
  const out:PollData[]=[]; let cur:any=null;
  for(const raw of text.split(/\r?\n/)) {
    const line=raw.trim(); if(!line) continue;
    if(line.startsWith("প্রশ্ন:")) {
      if(cur) out.push(cur);
      cur={question:line.slice(6).trim(),options:{},correct:""};
    } else if(cur && LABELS.includes(line[0]) && /^[).:\-]/.test(line[1]||"")) {
      cur.options[line[0]]=line.slice(2).trim();
    } else if(cur && line.startsWith("সঠিক উত্তর:")) {
      const answer=line.slice(11).trim();
      cur.correct=LABELS.find(x=>answer.includes(x))||"";
    }
  }
  if(cur) out.push(cur);
  return out.filter(b=>b.question && Object.keys(b.options).length>=2 && b.correct && b.options[b.correct])
    .map(b=>{
      const labels=LABELS.filter(x=>b.options[x]);
      return {question:b.question,options:labels.map(x=>b.options[x]),correct_option_id:labels.indexOf(b.correct),
        explanation:"",original:{question:b.question,options:b.options,correct:b.correct},labels} as PollData;
    });
}
async function sendQuiz(env:Env,chatId:number|string,p:PollData,prefix:string,explanation:string) {
  const sent:any=await tg(env,"sendPoll",{chat_id:chatId,question:`${prefix}\n\n${p.question}`.slice(0,300),
    options:p.options.map(x=>x.slice(0,100)),type:"quiz",correct_option_id:p.correct_option_id,
    explanation:explanation.slice(0,200),is_anonymous:true});
  const id=String(sent.message_id);
  await env.DB.prepare(`INSERT OR REPLACE INTO pending_polls
    (id,owner_chat_id,question,options_json,correct_option_id,explanation,original_json)
    VALUES(?,?,?,?,?,?,?)`).bind(id,String(chatId),`${prefix}\n\n${p.question}`,JSON.stringify(p.options),p.correct_option_id,explanation,JSON.stringify(p.original)).run();
  await tg(env,"editMessageReplyMarkup",{chat_id:chatId,message_id:sent.message_id,
    reply_markup:{inline_keyboard:[[{text:"🗑️ Delete",callback_data:`del:${id}`},{text:"✏️ Edit",callback_data:`ed:${id}`}]]}});
}
async function handleMessage(env:Env,m:TgMessage) {
  if(!m.from) return;
  const uid=m.from.id, chat=m.chat.id, text=m.text||"";
  if(text.startsWith("/start")||text.startsWith("/help")) {
    if(!(await isAdmin(env,uid))) return reply(env,chat,"🚫 Unauthorized.");
    return reply(env,chat,"🤖 MCQ Quiz Bot\n\n1. Send an MCQ image.\n2. Reply to it with /mcq.\n3. Use Edit/Delete under a poll.\n4. Use /send to publish pending polls to active channels.\n5. Use /settings to manage channels and poll formatting.");
  }
  if(text.startsWith("/settings")) {
    if(!(await isAdmin(env,uid))) return reply(env,chat,"🚫 Unauthorized.");
    const channels=await env.DB.prepare("SELECT chat_id,active FROM channels").all<any>();
    const prefix=await setting(env,"prefix","[POLL]"), explanation=await setting(env,"explanation","Join t.me/link");
    const rows:string[][]=[["➕ Add Channel|cfg:add"],["🏷️ Set Prefix|cfg:prefix"],["📝 Set Explanation|cfg:explanation"]];
    for(const c of channels.results||[]) rows.push([`${c.active?"✅":"❌"} ${c.chat_id}|chan:toggle:${c.chat_id}`]);
    return inline(env,chat,`⚙️ Settings\nPrefix: ${prefix}\nExplanation: ${explanation}\n\nUse buttons to configure.`,rows);
  }
  if(text.startsWith("/send")) {
    if(!(await isAdmin(env,uid))) return reply(env,chat,"🚫 Unauthorized.");
    const polls=await env.DB.prepare("SELECT * FROM pending_polls").all<any>();
    const channels=await env.DB.prepare("SELECT chat_id FROM channels WHERE active=1").all<any>();
    if(!polls.results?.length) return reply(env,chat,"❌ No pending polls.");
    if(!channels.results?.length) return reply(env,chat,"❌ No active channels. Use /settings first.");
    let report="";
    for(const c of channels.results) {
      let count=0;
      for(const p of polls.results) {
        try { await tg(env,"sendPoll",{chat_id:c.chat_id,question:p.question,options:JSON.parse(p.options_json),
          type:"quiz",correct_option_id:p.correct_option_id,explanation:p.explanation,is_anonymous:true}); count++; }
        catch {}
      }
      report+=`${c.chat_id}: ${count}/${polls.results.length}\n`;
    }
    await env.DB.prepare("DELETE FROM pending_polls").run();
    return reply(env,chat,`✅ Broadcast complete\n${report}`);
  }
  if(text.startsWith("/mcq")) {
    if(!(await isAdmin(env,uid))) return reply(env,chat,"🚫 Unauthorized.");
    const photo=m.reply_to_message?.photo;
    if(!photo?.length) return reply(env,chat,"❌ Reply to an image with /mcq.");
    const status:any=await reply(env,chat,"🔍 Analyzing image…");
    try {
      const extracted=await extractMcqs(env,photo[photo.length-1].file_id);
      const blocks=parseMcqs(extracted);
      const prefix=await setting(env,"prefix","[POLL]"), explanation=await setting(env,"explanation","Join t.me/link");
      let count=0;
      for(const b of blocks) { b.explanation=explanation; await sendQuiz(env,chat,b,prefix,explanation); count++; }
      await tg(env,"editMessageText",{chat_id:chat,message_id:status.message_id,text:`✅ ${count} quiz poll(s) created.\nUse /send to publish them to active channels.`});
    } catch(e:any) {
      await tg(env,"editMessageText",{chat_id:chat,message_id:status.message_id,text:`❌ Error: ${(e?.message||"Unknown error").slice(0,250)}`});
    }
    return;
  }
  if(m.reply_to_message?.text) {
    const pending=await env.DB.prepare("SELECT * FROM edit_requests WHERE prompt_message_id=?").bind(String(m.reply_to_message.message_id)).first<any>();
    if(pending && await isAdmin(env,uid)) {
      const row=await env.DB.prepare("SELECT * FROM pending_polls WHERE id=?").bind(pending.poll_id).first<any>();
      if(!row) return reply(env,chat,"❌ Pending poll not found.");
      const opts:string[]=JSON.parse(row.options_json);
      if(pending.edit_type==="question") {
        await env.DB.prepare("UPDATE pending_polls SET question=? WHERE id=?").bind(text,row.id).run();
      } else if(pending.edit_type==="option" && Number.isInteger(pending.option_index)) {
        opts[pending.option_index]=text;
        await env.DB.prepare("UPDATE pending_polls SET options_json=? WHERE id=?").bind(JSON.stringify(opts),row.id).run();
      }
      await env.DB.prepare("DELETE FROM edit_requests WHERE prompt_message_id=?").bind(String(m.reply_to_message.message_id)).run();
      return reply(env,chat,"✅ Saved the change for the pending record. Note: Telegram polls already sent cannot be edited in place.");
    }
  }
}
async function handleCallback(env:Env,u:NonNullable<Update["callback_query"]>) {
  const data=u.data||"", m=u.message; if(!m) return answerCallback(env,u.id);
  if(!(await isAdmin(env,u.from.id))) return answerCallback(env,u.id,"Unauthorized");
  const [action,id,extra]=data.split(":");
  if(action==="del" && id) {
    await env.DB.prepare("DELETE FROM pending_polls WHERE id=?").bind(id).run();
    try { await tg(env,"deleteMessage",{chat_id:m.chat.id,message_id:m.message_id}); } catch {}
    return answerCallback(env,u.id,"Deleted");
  }
  if(action==="ed" && id) {
    await answerCallback(env,u.id,"Choose an edit action");
    return inline(env,m.chat.id,"Choose what to edit:",[
      [`📝 Edit Question|editq:${id}`],[`🔘 Edit Options|edito:${id}`],[`❌ Cancel|cancel:${id}`]
    ]);
  }
  if(action==="editq" && id) {
    const prompt:any=await reply(env,m.chat.id,"Reply to this message with the new question:");
    await env.DB.prepare("INSERT OR REPLACE INTO edit_requests(prompt_message_id,owner_chat_id,poll_id,edit_type) VALUES(?,?,?,'question')")
      .bind(String(prompt.message_id),String(m.chat.id),id).run();
    return answerCallback(env,u.id);
  }
  if(action==="edito" && id) {
    const row=await env.DB.prepare("SELECT * FROM pending_polls WHERE id=?").bind(id).first<any>();
    if(!row) return answerCallback(env,u.id,"Poll not found");
    const opts:string[]=JSON.parse(row.options_json);
    await answerCallback(env,u.id);
    return inline(env,m.chat.id,"Select option to replace:",opts.map((x,i)=>[`${i+1}. ${x.slice(0,35)}|editopt:${id}:${i}`]));
  }
  if(action==="editopt" && id && extra!==undefined) {
    const prompt:any=await reply(env,m.chat.id,`Reply with the new text for option ${Number(extra)+1}:`);
    await env.DB.prepare("INSERT OR REPLACE INTO edit_requests(prompt_message_id,owner_chat_id,poll_id,edit_type,option_index) VALUES(?,?,?,'option',?)")
      .bind(String(prompt.message_id),String(m.chat.id),id,Number(extra)).run();
    return answerCallback(env,u.id);
  }
  if(action==="cancel") return answerCallback(env,u.id,"Cancelled");
  if(action==="cfg") {
    const kind=id;
    if(kind==="add"||kind==="prefix"||kind==="explanation") {
      const prompt:any=await reply(env,m.chat.id,kind==="add"?"Reply with channel @username or numeric chat ID.":kind==="prefix"?"Reply with the new poll prefix.":"Reply with the new explanation text.");
      await env.DB.prepare("INSERT OR REPLACE INTO edit_requests(prompt_message_id,owner_chat_id,poll_id,edit_type) VALUES(?,?,?,'setting')")
        .bind(String(prompt.message_id),String(m.chat.id),kind).run();
    }
    return answerCallback(env,u.id);
  }
  if(action==="chan" && id==="toggle") {
    const chatId=data.split(":").slice(2).join(":");
    const row=await env.DB.prepare("SELECT active FROM channels WHERE chat_id=?").bind(chatId).first<any>();
    if(row) await env.DB.prepare("UPDATE channels SET active=? WHERE chat_id=?").bind(row.active?0:1,chatId).run();
    return answerCallback(env,u.id,"Updated");
  }
  return answerCallback(env,u.id);
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    const url=new URL(request.url);
    if(request.method==="GET" && url.pathname==="/") return new Response("Medilogy Poll Bot worker is running.");
    if(request.method!=="POST" || url.pathname!==`/webhook/${env.WEBHOOK_SECRET}`) return new Response("Not found",{status:404});
    let update:Update;
    try { update=await request.json() as Update; } catch { return new Response("Bad JSON",{status:400}); }
    try {
      if(update.message) await handleMessage(env,update.message);
      if(update.callback_query) await handleCallback(env,update.callback_query);
    } catch(e) { console.error("Update handling failed",e); }
    return new Response("OK");
  }
};
