import { createClient } from '@supabase/supabase-js';

export function adminClient(){
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase server variables are not configured.');
  return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
}

export async function requireUser(event){
  const header=event.headers.authorization||event.headers.Authorization||'';
  const token=header.startsWith('Bearer ')?header.slice(7):'';
  if(!token) throw Object.assign(new Error('Sign in required.'),{status:401});
  const supabase=adminClient();
  const {data,error}=await supabase.auth.getUser(token);
  if(error||!data.user) throw Object.assign(new Error('Session expired. Sign in again.'),{status:401});
  return {user:data.user,supabase,token};
}

export function json(statusCode,body){return {statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},body:JSON.stringify(body)}};
