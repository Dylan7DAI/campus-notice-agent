import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import {diffTask, TaskSnapshot} from '../domain/diff';
export class M3Service {
 constructor(private db:PrismaClient){}
 async applyTaskChange(i:{caseId:string;taskId:string;expectedVersion:number;key:string;before:TaskSnapshot;after:TaskSnapshot}){
  const payload=JSON.stringify(i.after), hash=createHash('sha256').update(payload).digest('hex');
  return this.db.$transaction(async tx=>{
   const old=await tx.commandResult.findUnique({where:{scope_idempotencyKey:{scope:'task-change',idempotencyKey:i.key}}}); if(old){if(old.payloadHash!==hash)throw Error('IDEMPOTENCY_KEY_REUSED');return JSON.parse(old.responseJson);}
   const c=await tx.case.findUnique({where:{id:i.caseId}}); if(!c)throw Error('NOT_FOUND'); if(c.version!==i.expectedVersion)throw Error('VERSION_CONFLICT');
   const t=await tx.task.findUnique({where:{id:i.taskId}}); if(!t||t.caseId!==i.caseId)throw Error('NOT_FOUND'); const changes=diffTask(i.before,i.after); if(changes.length===1&&changes[0].kind==='no_change'){const out={code:'NO_CHANGE',caseVersion:c.version};await tx.commandResult.create({data:{id:randomUUID(),scope:'task-change',idempotencyKey:i.key,payloadHash:hash,responseJson:JSON.stringify(out)}});return out;}
   const reqDelta=changes.some(x=>x.kind==='add_requirement'||x.kind==='retire_requirement'); const next=c.version+1;
   for (const ch of changes) { if (ch.kind==='add_requirement' && ch.requirementId) await tx.requirement.create({data:{id:ch.requirementId,taskId:t.id,label:String(ch.value??''),active:true,satisfaction:'missing'}}); if (ch.kind==='retire_requirement' && ch.requirementId) await tx.requirement.update({where:{id:ch.requirementId},data:{active:false}}); }
   await tx.task.update({where:{id:t.id},data:{dueJson:i.after.due===undefined?undefined:JSON.stringify(i.after.due),executionStatus:i.after.executionStatus??t.executionStatus,effectiveOwnerId:i.after.effectiveOwnerId,requirementEpoch:reqDelta?t.requirementEpoch+1:t.requirementEpoch,calendarSequence:changes.some(x=>x.kind==='set_due'||x.kind==='cancel_task'||x.kind==='restore_task')?t.calendarSequence+1:t.calendarSequence,consistencyStatus:reqDelta&&t.executionStatus==='completed'?'needs_review':t.consistencyStatus}});
   await tx.case.update({where:{id:c.id},data:{version:next}}); const cmd=randomUUID(); const out={code:'APPLIED',commandId:cmd,caseVersion:next,changes}; await tx.auditEvent.create({data:{id:randomUUID(),caseId:c.id,caseVersion:next,commandId:cmd,eventType:'task_changed',beforeJson:JSON.stringify(i.before),afterJson:JSON.stringify(i.after)}}); await tx.commandResult.create({data:{id:randomUUID(),scope:'task-change',idempotencyKey:i.key,payloadHash:hash,responseJson:JSON.stringify(out)}}); return out;
  });
 }
}

