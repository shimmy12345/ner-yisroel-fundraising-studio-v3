import OpenAI, { toFile } from 'openai';
import { requireUser, json } from './_shared/auth.mjs';
import { refreshGoogleToken, driveFetch } from './_shared/google.mjs';
async function extract(meta,token){
 const exports={'application/vnd.google-apps.document':'text/plain','application/vnd.google-apps.spreadsheet':'text/csv','application/vnd.google-apps.presentation':'text/plain'};
 let r;if(exports[meta.mimeType])r=await driveFetch(`/files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(exports[meta.mimeType])}`,token);else r=await driveFetch(`/files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`,token);
 const buffer=Buffer.from(await r.arrayBuffer());if(buffer.length>20*1024*1024)throw new Error(`${meta.name} exceeds 20 MB.`);
 if(exports[meta.mimeType]||meta.mimeType.startsWith('text/')||['application/json','text/csv'].includes(meta.mimeType))return buffer.toString('utf8');
 const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});let id;try{const f=await client.files.create({file:await toFile(buffer,meta.name,{type:meta.mimeType}),purpose:'user_data'});id=f.id;const out=await client.responses.create({model:process.env.OPENAI_MODEL||'gpt-5-mini',instructions:'Extract accurate plain text for a fundraising knowledge base. Preserve names, dates, statistics, links, quotations, and approved language. Do not invent or interpret.',input:[{role:'user',content:[{type:'input_text',text:'Extract this file.'},{type:'input_file',file_id:id}]}],store:false});return out.output_text||''}finally{if(id)try{await client.files.delete(id)}catch{}}
}
export async function handler(event){
 try{
  const {user,supabase}=await requireUser(event);
  if(event.httpMethod==='DELETE'){await supabase.from('google_connections').delete().eq('user_id',user.id);return json(200,{connected:false})}
  let {data:conn,error}=await supabase.from('google_connections').select('*').eq('user_id',user.id).maybeSingle();if(error)throw error;if(!conn)return json(200,{connected:false,files:[]});conn=await refreshGoogleToken(supabase,conn);
  if(event.httpMethod==='GET'){
   const q=event.queryStringParameters||{};if(q.action==='status')return json(200,{connected:true,email:conn.connected_email});
   const term=String(q.q||'').trim().replace(/'/g,"\\'");const query=["trashed = false",term?`name contains '${term}'`:null].filter(Boolean).join(' and ');const p=new URLSearchParams({q:query,pageSize:'50',orderBy:'modifiedTime desc',fields:'files(id,name,mimeType,modifiedTime,webViewLink,size)',spaces:'drive'});const data=await (await driveFetch(`/files?${p}`,conn.access_token)).json();return json(200,{connected:true,email:conn.connected_email,files:data.files||[]});
  }
  if(event.httpMethod==='POST'){
   const body=JSON.parse(event.body||'{}');const ids=(body.fileIds||[]).slice(0,10);if(!ids.length)return json(400,{error:'Select at least one file.'});const imported=[];
   for(const id of ids){const fields=encodeURIComponent('id,name,mimeType,modifiedTime,webViewLink,size');const meta=await (await driveFetch(`/files/${encodeURIComponent(id)}?fields=${fields}&supportsAllDrives=true`,conn.access_token)).json();const content=await extract(meta,conn.access_token);const {data,error:ie}=await supabase.from('knowledge_documents').upsert({user_id:user.id,title:meta.name,content,source_type:'google_drive',source_id:meta.id,source_url:meta.webViewLink,metadata:{mimeType:meta.mimeType,modifiedTime:meta.modifiedTime}},{onConflict:'user_id,source_id'}).select().single();if(ie)throw ie;imported.push(data)}
   return json(200,{imported});
  }
  return json(405,{error:'Method not allowed.'});
 }catch(e){console.error(e);return json(e.status||500,{error:e.message||'Google Drive operation failed.'})}
}
