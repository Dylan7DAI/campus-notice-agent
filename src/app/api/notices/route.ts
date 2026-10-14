import {NextResponse} from 'next/server';
import {PrismaClient} from '@prisma/client';
const db=new PrismaClient();
export async function GET(){
  const notices=await db.noticeRevision.findMany({orderBy:{createdAt:'asc'}});
  const sources=await db.noticeRelation.findMany();
  return NextResponse.json({notices,sourceRelations:sources});
}
