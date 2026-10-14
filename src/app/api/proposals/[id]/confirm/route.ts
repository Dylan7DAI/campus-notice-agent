import {NextResponse} from 'next/server';
import {PrismaClient} from '@prisma/client';
import {ProposalService} from '../../../../../application/proposal-service';
import { assertLocalOrigin, DataProtectionError } from '../../../../../application/data-protection';
const db=new PrismaClient();
function failure(error:unknown){const code=(error as {code?:string})?.code??(error as Error)?.message??'COMMAND_FAILED';const status=code==='VERSION_CONFLICT'||code==='IDEMPOTENCY_KEY_REUSED'?409:code==='PROPOSAL_ALREADY_APPLIED'?409:422;return NextResponse.json({error:{code,request_id:(error as {requestId?:string})?.requestId,command_id:undefined}},{status});}
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){try{assertLocalOrigin(req);const {id}=await params;const body=await req.json();if(body.confirmation!==true)return NextResponse.json({error:{code:'CONFIRMATION_REQUIRED'}},{status:400});if(!body.idempotencyKey)return NextResponse.json({error:{code:'IDEMPOTENCY_KEY_REQUIRED'}},{status:400});const out=await new ProposalService(db).apply({proposalId:id,expectedVersion:body.expectedCaseVersion,key:body.idempotencyKey,payload:body.payload??JSON.stringify(body)});return NextResponse.json(out);}catch(error){if(error instanceof DataProtectionError)return NextResponse.json({error:{code:error.code}},{status:403});return failure(error);}}
