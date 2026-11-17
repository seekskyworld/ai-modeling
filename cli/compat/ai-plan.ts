/** 与官方 producer→specialist 对话结构对齐；模型只提出声明式计划，执行前仍走本机 schema。 */
import { z } from 'zod';
import { makePlan } from './planning.ts';
export const expertPlanSchema = z
  .object({
    prompt: z.string().min(1),
    scenario: z.enum(['game-mobile', 'game-pc', 'film', 'print', 'ar-web', 'anim', 'toy']).optional(),
    model: z.string().optional(),
    then: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export interface PlanningMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export type PlannerChat = (messages: PlanningMessage[]) => Promise<unknown>;
const producerSchema = expertPlanSchema.extend({ question: z.string().min(1).optional() });
const specialists: Record<string, string> = {
  'game-mobile':
    'Mobile game technical artist: prioritize a user-specified polygon budget and compact textures.',
  'game-pc':
    'PC/console technical artist: preserve detail and prepare mesh LOD and engine delivery when requested.',
  film: 'Film artist: subdivision-friendly quads, detailed textures and offline-render delivery.',
  print: '3D printing specialist: prioritize closed geometry and STL; color textures are optional.',
  'ar-web': 'AR/web artist: prioritize compact GLB and USDZ delivery.',
  anim: 'Animation specialist: texture, rig then selected motions; never invent motion asset IDs.',
  toy: 'Toy designer: preserve the requested silhouette, colors and editable topology.',
};
const rules =
  'Return JSON {prompt,scenario?,model?,then?,params?}. Scenarios: game-mobile,game-pc,film,print,ar-web,anim,toy. Studio models: tripo-p2,tripo-p1,tripo-v3.1. Chain steps: texture,rig,retarget:animation=preset:biped:walk,convert:fbx,decimate:face_limit=5000,uv. Generation params: face_limit,texture,pbr,quad,texture_quality,model_seed. Set model and face_limit only when explicitly requested. Do not invent paths, tasks or claim execution. No API wallet parameters.';
export async function buildExpertPlan(
  request: string,
  chat: PlannerChat,
  ask?: (question: string) => Promise<string>,
): Promise<z.infer<typeof expertPlanSchema>> {
  const messages: PlanningMessage[] = [
    {
      role: 'system',
      content:
        'You are the producer/router for Tripo Studio. Extract the creation request and choose a scenario. Optionally add one question only if a missing fact materially changes the plan. ' +
        rules,
    },
    { role: 'user', content: request },
  ];
  let producer = producerSchema.parse(await chat(messages));
  if (producer.question && ask) {
    const answer = await ask(producer.question);
    messages.push(
      { role: 'assistant', content: JSON.stringify(producer) },
      {
        role: 'user',
        content: `Additional information: ${answer}. Return a final plan without another question.`,
      },
    );
    producer = producerSchema.parse(await chat(messages));
  }
  const base = expertPlanSchema.parse(
    Object.fromEntries(Object.entries(producer).filter(([key]) => key !== 'question')),
  );
  const result = await chat([
    {
      role: 'system',
      content:
        (specialists[base.scenario ?? 'game-mobile'] ?? '') + ' Refine only supported fields. ' + rules,
    },
    { role: 'user', content: JSON.stringify({ request, base }) },
  ]);
  const specialist = expertPlanSchema.parse(result);
  const plan = {
    ...base,
    then: specialist.then ?? base.then,
    params: { ...specialist.params, ...base.params },
  };
  // 路由器选择与用户显式面数优先；专家不能偷偷更换算法或注入执行命令。
  makePlan([plan.prompt], { for: plan.scenario, model: plan.model, then: plan.then, param: plan.params });
  return plan;
}
