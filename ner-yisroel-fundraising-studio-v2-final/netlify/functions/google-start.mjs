import crypto from 'node:crypto';
import { requireUser, json } from './_shared/auth.mjs';
import { callbackUrl } from './_shared/google.mjs';
export async function handler(event){
 if(event.httpMethod!=='POST')return json(405,{error:'Method not allowed.'});
 try{
  const {user,supabase}=await requireUser(event);
  if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)throw new Error('Google OAuth variables are not configured.');
  const state=crypto.randomBytes(32).toString('hex');
  const {error}=await supabase.from('oauth_states').insert({state,user_id:user.id,expires_at:new Date(Date.now()+10*60*1000).toISOString()});if(error)throw error;
  const p=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:callbackUrl(),response_type:'code',scope:'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email',access_type:'offline',include_granted_scopes:'true',prompt:'consent',state});
  return json(200,{authUrl:`https://accounts.google.com/o/oauth2/v2/auth?${p}`});
 }catch(e){return json(e.status||500,{error:e.message})}
}
