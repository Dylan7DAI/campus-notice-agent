export type ModelAdapterResult={ok:true;value:unknown}|{ok:false;code:'MODEL_TIMEOUT'|'MODEL_UNAVAILABLE'|'MODEL_INVALID_OUTPUT'|'PROMPT_INJECTION_REJECTED'|'FAKE_EVIDENCE_REJECTED';message:string};
export interface FaultAdapter { run(input:unknown):Promise<ModelAdapterResult> }
export class TimeoutFaultAdapter implements FaultAdapter { async run():Promise<ModelAdapterResult>{return {ok:false,code:'MODEL_TIMEOUT',message:'synthetic timeout'}} }
export class UnavailableFaultAdapter implements FaultAdapter { async run():Promise<ModelAdapterResult>{return {ok:false,code:'MODEL_UNAVAILABLE',message:'synthetic unavailable'}} }
export class InvalidOutputFaultAdapter implements FaultAdapter { async run():Promise<ModelAdapterResult>{return {ok:false,code:'MODEL_INVALID_OUTPUT',message:'synthetic invalid output'}} }
export class PromptInjectionFaultAdapter implements FaultAdapter { async run():Promise<ModelAdapterResult>{return {ok:false,code:'PROMPT_INJECTION_REJECTED',message:'fixture instructions cannot authorize tools or external requests'}} }
export class FakeEvidenceFaultAdapter implements FaultAdapter { async run():Promise<ModelAdapterResult>{return {ok:false,code:'FAKE_EVIDENCE_REJECTED',message:'fixture evidence reference or quote is not verifiable'}} }
