import OpenAI, { toFile } from 'openai';
import { requireUser, json } from './_shared/auth.mjs';

const SYSTEM=`You are the Ner Yisroel Fundraising Communications Strategist. Write and review communications for Yeshivas Ner Yisroel using donor-centered fundraising principles and authentic yeshiva language.
Rules:
- Make the donor or reader an active partner, not a passive audience.
- Lead with concrete human or Torah-centered meaning before institutional detail.
- Use story and emotion honestly; never invent facts, urgency, quotes, donor history, or statistics.
- Use plain, warm language. Avoid generic AI phrasing, corporate jargon, inflated adjectives, and em dashes.
- Maintain kavod and mission alignment. Use Hebrew or yeshivish terms naturally for the audience.
- Keep one primary objective and one clear next action.
- Mark missing facts with visible placeholders.
- Deliver usable copy, not a lecture.`;

const modes={
 review:'Review the submitted letter. Return: Executive assessment; 1-10 scorecard for donor-centeredness, emotional engagement, clarity, authenticity, readability, strength of ask, and overall effectiveness; what works; what should change with examples; strategy recommendation; complete revised letter.',
 writer:'Draft the requested fundraising communication with a strong opening, donor-centered case, one primary action, and natural close.',
 major:'Create a dignified major-gift proposal or solicitation with opportunity, donor alignment, impact, proposed investment or placeholder, and next step.',
 whatsapp:'Create a concise, warm WhatsApp message plus one shorter alternative. Make it mobile-friendly and easy to act on.',
 constant:'Create a Constant Contact email with subject line, two alternatives, preheader, headline, body, button text, and P.S.',
 linkedin:'Create a natural LinkedIn post in Shimmy Goldstein’s professional voice. Use a concrete observation, meaningful takeaway, and genuine engagement ending. Suggest no more than three hashtags.',
 executive:'Create a decision-ready executive summary with key takeaway, highlights, implications, open decisions, risks, and three next actions.'
};

export async function handler(event){
 if(event.httpMethod!=='POST')return json(405,{error:'Method not allowed.'});
 let fileId;
 try{
  const {user,supabase}=await requireUser(event);
  const body=JSON.parse(event.body||'{}');
  const mode=modes[body.mode]?body.mode:'writer';
  const {data:knowledgeRows,error:kerr}=await supabase.from('knowledge_documents').select('title,content').eq('user_id',user.id).order('updated_at',{ascending:false}).limit(100);
  if(kerr)throw kerr;
  const knowledge=(knowledgeRows||[]).map(r=>`## ${r.title}\n${r.content}`).join('\n\n').slice(0,120000);
  const content=[{type:'input_text',text:[modes[mode],body.audience?`Audience: ${body.audience}`:'',body.tone?`Tone: ${body.tone}`:'',body.goal?`Desired outcome: ${body.goal}`:'',body.prompt?`Instructions:\n${body.prompt}`:'',body.sourceText?`Source material:\n${body.sourceText}`:'',knowledge?`Approved knowledge base:\n${knowledge}`:''].filter(Boolean).join('\n\n')}];
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  if(body.file?.base64&&body.file?.name){const buffer=Buffer.from(body.file.base64,'base64');if(buffer.length>12*1024*1024)return json(413,{error:'File is larger than 12 MB.'});const f=await client.files.create({file:await toFile(buffer,body.file.name,{type:body.file.type||'application/octet-stream'}),purpose:'user_data'});fileId=f.id;content.push({type:'input_file',file_id:fileId})}
  const response=await client.responses.create({model:process.env.OPENAI_MODEL||'gpt-5-mini',instructions:SYSTEM,input:[{role:'user',content}],store:false});
  const output=response.output_text||'No text returned.';
  const {data:saved,error:serr}=await supabase.from('generations').insert({user_id:user.id,mode,title:body.title||modes[mode].split('.')[0],prompt:body.prompt||'',source_text:body.sourceText||'',output}).select().single();
  if(serr)throw serr;
  return json(200,{output,generation:saved});
 }catch(e){console.error(e);return json(e.status||500,{error:e.message||'Generation failed.'})}
 finally{if(fileId){try{const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});await client.files.delete(fileId)}catch{}}}
}
