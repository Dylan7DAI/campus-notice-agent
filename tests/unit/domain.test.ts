import { describe, expect, it } from 'vitest';
import { DueSchema } from '../../src/domain/due';
import { validateEvidence } from '../../src/domain/evidence';
import { assertAcyclic } from '../../src/domain/preparation';
describe('M1 domain validation',()=>{ it('validates due precision',()=>expect(DueSchema.parse({kind:'date',value:'2026-09-27',timezone:'Asia/Shanghai',boundary:'inclusive'}).kind).toBe('date')); it('rejects mismatched evidence',()=>expect(()=>validateEvidence('abc',0,2,'ac')).toThrow('EVIDENCE_INVALID')); });
describe('preparation dependencies',()=>{ it('rejects cycles',()=>expect(()=>assertAcyclic({a:['b'],b:['a']})).toThrow('PREPARATION_DEPENDENCY_CYCLE')); });
