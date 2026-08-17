import { Keypair, TransactionBuilder, Networks } from '@stellar/stellar-sdk'
const API='http://127.0.0.1:8901'
const C='0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ulid=()=>{let t=Date.now(),s='';for(let i=9;i>=0;i--){s=C[t%32]+s;t=Math.floor(t/32)}for(let i=0;i<16;i++)s+=C[Math.floor(Math.random()*32)];return s}
const kp=Keypair.fromSecret(process.argv[2] || Keypair.random().secret())
const post=async(p,b,h={})=>{const r=await fetch(API+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b)});return{s:r.status,b:await r.json().catch(()=>null)}}
const ch=await post('/v1/auth/challenge',{address:kp.publicKey()})
const tx=TransactionBuilder.fromXDR(ch.b.transaction,Networks.TESTNET);tx.sign(kp)
const v=await post('/v1/auth/verify',{address:kp.publicKey(),transaction:tx.toEnvelope().toXDR('base64')})
const H={authorization:`Bearer ${v.b.token}`,'x-dwell-client-version':'0.1.0'}
const ad=await(await fetch(`${API}/v1/ads/next`,{method:'POST',headers:H})).json()
await post('/v1/impressions',{events:[{id:ulid(),campaignId:ad.campaignId,nonce:ad.nonce,sessionId:'s',surface:'statusline',durationMs:15000,clientTs:Date.now(),projectKey:'a'.repeat(64),clientVersion:'0.1.0',os:'darwin',arch:'arm64'}]},H)
console.log('TOKEN='+v.b.token)
console.log('SECRET='+kp.secret())
