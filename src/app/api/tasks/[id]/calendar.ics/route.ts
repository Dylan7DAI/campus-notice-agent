import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {calendarSha256,encodeIcs} from '../../../../../domain/calendar';
import { assertLocalOrigin, DataProtectionError } from '../../../../../application/data-protection';
const db=new PrismaClient();
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){
  try { assertLocalOrigin(req); } catch (error) { return NextResponse.json({ error: { code: error instanceof DataProtectionError ? error.code : 'ORIGIN_FORBIDDEN' } }, { status: 403 }); }
  const {id}=await params;
  const snapshot=await db.$transaction(async tx=>{
    const t=await tx.task.findUnique({where:{id}});
    if(!t)return null;
    const c=await tx.case.findUnique({where:{id:t.caseId},select:{version:true}});
    if(!c)return null;
    if(!t.dueJson)return {error:'DUE_UNKNOWN' as const};
    const due=JSON.parse(t.dueJson) as never;
    const ics=encodeIcs({taskId:t.id,title:t.title,due,sequence:t.calendarSequence,cancelled:t.executionStatus==='cancelled'});
    const sha256=calendarSha256(ics);
    // A changed sequence invalidates older exports. A repeated GET at the
    // same snapshot keeps the same sequence and remains a valid export.
    await tx.calendarExport.updateMany({where:{taskId:t.id,stale:false,NOT:{sequence:t.calendarSequence}},data:{stale:true}});
    await tx.calendarExport.create({data:{id:randomUUID(),taskId:t.id,uid:`${t.id}@campus-notice.local`,sequence:t.calendarSequence,caseVersion:c.version,sha256,stale:false}});
    return {ics,caseVersion:c.version,calendarSequence:t.calendarSequence};
  });
  if(!snapshot)return NextResponse.json({error:{code:'NOT_FOUND',message:'任务不存在'}},{status:404});
  if('error' in snapshot)return NextResponse.json({error:{code:snapshot.error,message:'日期不确定，无法导出日历'}},{status:422});
  return new NextResponse(snapshot.ics,{headers:{'content-type':'text/calendar; charset=utf-8','x-case-version':String(snapshot.caseVersion),'x-calendar-sequence':String(snapshot.calendarSequence)}});
}
