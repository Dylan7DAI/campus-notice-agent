import {z} from 'zod';
const schema=z.object({HOST:z.string().default('127.0.0.1'),PORT:z.coerce.number().int().min(1).max(65535).default(3000),MODEL_PROVIDER:z.enum(['mock','glm']).default('mock'),MODEL_API_KEY:z.string().optional(),MODEL_BASE_URL:z.string().default('https://open.bigmodel.cn/api/paas/v4'),MODEL_NAME:z.string().default('glm-4.5-flash'),MODEL_VISION_NAME:z.string().default('glm-4.5v'),MODEL_THINKING:z.enum(['enabled','disabled']).optional(),MODEL_VISION_THINKING:z.enum(['enabled','disabled']).optional()});
export function getConfig(){const p=schema.safeParse(process.env);if(!p.success)throw Error(`配置无效：${p.error.message}`);const c=p.data;if(c.MODEL_PROVIDER!=='mock'&&!c.MODEL_API_KEY)throw Error('配置无效：启用真实模型时必须提供 MODEL_API_KEY');return {...c,host:c.HOST,port:c.PORT,modelProvider:c.MODEL_PROVIDER};}


