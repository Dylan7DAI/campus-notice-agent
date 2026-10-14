export type RequirementInput={id:string;label:string;active?:boolean};
export type TaskSnapshot={due?:unknown;requirements:RequirementInput[];executionStatus?:string;effectiveOwnerId?:string};
export type TaskChange={kind:'set_due'|'add_requirement'|'retire_requirement'|'set_owner'|'cancel_task'|'restore_task'|'no_change'; requirementId?:string; value?:unknown};
export function diffTask(before:TaskSnapshot, after:TaskSnapshot):TaskChange[]{
 const out:TaskChange[]=[];
 if(JSON.stringify(before.due)!==JSON.stringify(after.due)) out.push({kind:'set_due',value:after.due});
 if(before.effectiveOwnerId!==after.effectiveOwnerId) out.push({kind:'set_owner',value:after.effectiveOwnerId});
 const bm=new Map(before.requirements.map(r=>[r.id,r])); const am=new Map(after.requirements.map(r=>[r.id,r]));
 for(const r of after.requirements) if(!bm.has(r.id)&&r.active!==false) out.push({kind:'add_requirement',requirementId:r.id,value:r.label});
 for(const r of before.requirements) if(r.active!==false&&(!am.has(r.id)||am.get(r.id)?.active===false)) out.push({kind:'retire_requirement',requirementId:r.id});
 if(before.executionStatus!==after.executionStatus){if(after.executionStatus==='cancelled')out.push({kind:'cancel_task'}); else if(before.executionStatus==='cancelled'&&after.executionStatus==='open')out.push({kind:'restore_task'});}
 return out.length?out:[{kind:'no_change'}];
}
