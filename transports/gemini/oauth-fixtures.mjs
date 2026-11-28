import {createHash,randomBytes} from 'node:crypto';
const callback='https://oauth-redirect.googleusercontent.com/r/ldc-c5-test-client';
export async function authorizeInTest(gateway,{callbackUrl=callback,manualClient}={}){
  const client=manualClient??gateway.registerManual(callbackUrl).client;
  gateway.armApproval();
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({
    client_id:client.client_id,redirect_uri:callbackUrl,response_type:'code',
    code_challenge:challenge,code_challenge_method:'S256',resource:gateway.publicResource,
    scope:'ldc:invoke',state:'test-c5'
  });
  const address='http://127.0.0.1:'+gateway.port;
  const res=await fetch(address+'/authorize?'+params,{redirect:'manual'});
  if(res.status!==303)throw Error('AUTHORIZATION_FAILED_'+res.status);
  const code=new URL(res.headers.get('location')).searchParams.get('code');
  const form=new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,
    redirect_uri:callbackUrl,resource:gateway.publicResource});
  const token=await fetch(address+'/token',{
    method:'POST',headers:{Authorization:'Basic '+Buffer.from(client.client_id+':'+client.client_secret).toString('base64')},
    body:form
  });
  if(token.status!==200)throw Error('TOKEN_EXCHANGE_FAILED_'+token.status);
  return {client,credentials:await token.json(),callbackUrl};
}
