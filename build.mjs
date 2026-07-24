import fs from 'node:fs';
const url=process.env.SUPABASE_URL||'';
const key=process.env.SUPABASE_ANON_KEY||'';
fs.writeFileSync('public/runtime-config.js',`window.RUNTIME_CONFIG=${JSON.stringify({supabaseUrl:url,supabaseAnonKey:key})};\n`);
console.log('Runtime config generated.');
