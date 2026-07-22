import { adminClient } from './_shared/auth.mjs';
import { callbackUrl } from './_shared/google.mjs';
function redirect(path){return {statusCode:302,headers:{location:path,'cache-control':'no-store'},body:''}}
export async function handler(event){
 const q=event.queryStringParameters||{};const app=process.env.APP_URL||'/';
 if(q.error)return redirect(`${app}?drive=error&message=${encodeURIComponent(q.error)}`);
 if(!q.code||!q.state)return redirect(`${app}?drive=error&message=missing_oauth_response`);
 try{
  const supabase=adminClient();
  const {data:row,error}=await supabase.from('oauth_states').select('*').eq('state',q.state).single();if(error||!row||new Date(row.expires_at)<new Date())throw new Error('OAuth state expired.');
  await supabase.from('oauth_states').delete().eq('state',q.state);
  const body=new URLSearchParams({code:q.code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:callbackUrl(),grant_type:'authorization_code'});
  const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});const tokens=await tr.json();if(!tr.ok)throw new Error(tokens.error_description||tokens.error||'Token exchange failed.');
  let email=null;try{const ur=await fetch('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{authorization:`Bearer ${tokens.access_token}`}});if(ur.ok)email=(await ur.json()).email}catch{}
  const {data:existing}=await supabase.from('google_connections').select('*').eq('user_id',row.user_id).maybeSingle();
  const record={user_id:row.user_id,access_token:tokens.access_token,refresh_token:tokens.refresh_token||existing?.refresh_token,token_type:tokens.token_type,scope:tokens.scope,expires_at:new Date(Date.now()+(tokens.expires_in||3600)*1000).toISOString(),connected_email:email};
  const {error:ue}=await supabase.from('google_connections').upsert(record,{onConflict:'user_id'});if(ue)throw ue;
  return redirect(`${app}?drive=connected`);
 }catch(e){console.error(e);return redirect(`${app}?drive=error&message=${encodeURIComponent(e.message)}`)}
}
