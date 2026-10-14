import { z } from 'zod';
export const DueSchema = z.discriminatedUnion('kind', [z.object({kind:z.literal('unknown')}), z.object({kind:z.literal('date'), value:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone:z.string(), boundary:z.enum(['inclusive','exclusive','unspecified'])}), z.object({kind:z.literal('instant'), value:z.string().datetime({offset:true}), timezone:z.string()})]);
export type Due = z.infer<typeof DueSchema>;
