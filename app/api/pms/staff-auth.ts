/** Server-only Supabase Auth administration for hotel staff accounts. */

export class StaffAuthError extends Error {
  constructor(readonly status:number, message:string){super(message);this.name="StaffAuthError";}
}

function configuration(){
  const url=process.env.SUPABASE_URL?.replace(/\/$/u,"");
  const secret=process.env.SUPABASE_SECRET_KEY;
  if(!url||!secret)throw new StaffAuthError(503,"직원 계정 서비스를 사용할 수 없습니다.");
  return {url,secret};
}

async function adminRequest(path:string,init:RequestInit){
  const {url,secret}=configuration();
  const response=await fetch(`${url}/auth/v1/admin${path}`,{
    ...init,
    headers:{apikey:secret,authorization:`Bearer ${secret}`,"content-type":"application/json","x-client-info":"aurora-pms/1.0",...(init.headers||{})},
    cache:"no-store",
  });
  if(response.ok)return response;
  let detail="";
  try{const body=await response.json() as {message?:string;msg?:string};detail=body.message||body.msg||"";}catch{/* Never expose an HTML or proxy body. */}
  if(response.status===422||response.status===409)throw new StaffAuthError(409,detail.includes("registered")?"이미 가입된 이메일입니다.":"계정 정보가 정책과 일치하지 않습니다.");
  throw new StaffAuthError(response.status>=500?503:response.status,"직원 계정 처리에 실패했습니다.");
}

export async function createStaffAuthUser(email:string,password:string,displayName:string){
  const response=await adminRequest("/users",{method:"POST",body:JSON.stringify({email,password,email_confirm:true,user_metadata:{display_name:displayName}})});
  const user=await response.json() as {id?:string};
  if(!user.id)throw new StaffAuthError(502,"생성된 계정 식별자를 확인하지 못했습니다.");
  return user.id;
}

export async function updateStaffAuthUser(userId:string,changes:{password?:string;displayName?:string}){
  const body:Record<string,unknown>={};
  if(changes.password)body.password=changes.password;
  if(changes.displayName)body.user_metadata={display_name:changes.displayName};
  await adminRequest(`/users/${encodeURIComponent(userId)}`,{method:"PUT",body:JSON.stringify(body)});
}

export async function deleteStaffAuthUser(userId:string){
  try{await adminRequest(`/users/${encodeURIComponent(userId)}`,{method:"DELETE"});}
  catch(error){console.error("[AURORA_STAFF_AUTH_ROLLBACK]",{userId,error:error instanceof Error?error.name:"UnknownError"});}
}
