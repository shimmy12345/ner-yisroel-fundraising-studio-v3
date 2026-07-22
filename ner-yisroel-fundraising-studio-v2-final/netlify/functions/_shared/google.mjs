export function callbackUrl(){return process.env.GOOGLE_REDIRECT_URI||`${process.env.APP_URL}/api/google-callback`}
export async function refreshGoogleToken(supabase,connection){
  if(connection.expires_at&&new Date(connection.expires_at).getTime()>Date.now()+60000)return connection;
  if(!connection.refresh_token)throw new Error('Google Drive must be reconnected.');
  const body=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:connection.refresh_token,grant_type:'refresh_token'});
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error_description||data.error||'Google token refresh failed.');
  const updated={...connection,access_token:data.access_token,token_type:data.token_type||connection.token_type,scope:data.scope||connection.scope,expires_at:new Date(Date.now()+(data.expires_in||3600)*1000).toISOString()};
  const {error}=await supabase.from('google_connections').upsert(updated,{onConflict:'user_id'});
  if(error)throw error;
  return updated;
}
export async function driveFetch(path,accessToken,options={}){
  const response=await fetch(`https://www.googleapis.com/drive/v3${path}`,{...options,headers:{authorization:`Bearer ${accessToken}`,...(options.headers||{})}});
  if(!response.ok){let message=`Google Drive returned ${response.status}`;try{const d=await response.json();message=d.error?.message||message}catch{}throw new Error(message)}
  return response;
}
