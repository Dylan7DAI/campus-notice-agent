import {NextResponse} from 'next/server';
import {PrismaClient} from '@prisma/client';
import {TaskCommands} from '../../../application/task-commands';
import { assertLocalOrigin, DataProtectionError } from '../../../application/data-protection';
const db=new PrismaClient();
function failure(error:unknown){const code=(error as {code?:string})?.code??(error as Error)?.message??'COMMAND_FAILED';const status=code==='VERSION_CONFLICT'||code==='IDEMPOTENCY_KEY_REUSED'||code==='HANDOFF_ALREADY_PENDING'?409:code==='COMPLETION_BLOCKED'||code.startsWith('PREPARATION_')||code.startsWith('HANDOFF_TARGET')||code==='REQUIREMENT_NOT_FOUND'?422:404;return NextResponse.json({error:{code,request_id:(error as {requestId?:string})?.requestId}}, {status});}
export async function POST(req:Request){try{assertLocalOrigin(req);const b=await req.json();const c=new TaskCommands(db);let out:unknown;
 if(b.action==='set_requirement_status')out=await c.setRequirementStatus(b);
 else if(b.action==='record_completion')out=await c.recordCompletion(b);
 else if(b.action==='save_preparation')out=await c.savePreparation({id:b.id,taskId:b.taskId,title:b.title,dependencies:b.dependencies??[],requirementIds:b.requirementIds, start:b.start,end:b.end,durationMinutes:b.durationMinutes,expectedCaseVersion:b.expectedCaseVersion,idempotencyKey:b.idempotencyKey});
 else if(b.action==='request_handoff')out=await c.requestHandoff(b);
 else if(b.action==='record_handoff_acceptance')out=await c.resolveHandoff({...b,status:'accepted_reported',actor:'local_user'});
 else if(b.action==='record_handoff_declined')out=await c.resolveHandoff({...b,status:'declined',actor:'local_user'});
 else if(b.action==='record_handoff_cancelled')out=await c.resolveHandoff({...b,status:'cancelled',actor:'local_user'});
 else if(b.action==='record_local_reminder_display')out=await c.recordReminder(b.taskId,b.displayedAt,b.id);
 else return NextResponse.json({error:{code:'UNKNOWN_ACTION'}},{status:400});
 return NextResponse.json({code:'APPLIED',result:out});
}catch(error){if(error instanceof DataProtectionError)return NextResponse.json({error:{code:error.code}},{status:403});return failure(error);}}
