/** 网页预设动作标识目录；只提取调用参数事实，不执行或复制网页逻辑。快照 2026-11-12，8dd37a49fd2ac927c1af025b81fffb357bbd204008d5c80b5c465ecad534b84d。 */
import { z } from 'zod';
const presets = {
  aquatic: [
    {
      action_type: 'Walk',
      category: 'basic',
      name: 'march',
    },
  ],
  biped: [
    {
      action_type: 'Fear',
      category: 'emotional',
      name: 'afraid',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'agree',
    },
    {
      action_type: 'Anger',
      category: 'emotional',
      name: 'angry_01',
    },
    {
      action_type: 'Anger',
      category: 'emotional',
      name: 'angry_02',
    },
    {
      action_type: 'Anger',
      category: 'emotional',
      name: 'angry_03',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'basketball_shot',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'bow',
    },
    {
      action_type: 'Strike',
      category: 'combat',
      name: 'box_01',
    },
    {
      action_type: 'Strike',
      category: 'combat',
      name: 'box_02',
    },
    {
      action_type: 'Strike',
      category: 'combat',
      name: 'box_03',
    },
    {
      action_type: 'Magic',
      category: 'scene_specific',
      name: 'cast_a_spell',
    },
    {
      action_type: 'Joy',
      category: 'emotional',
      name: 'cheer',
    },
    {
      action_type: 'Work Activities',
      category: 'scene_specific',
      name: 'chop',
    },
    {
      action_type: 'Joy',
      category: 'emotional',
      name: 'clap',
    },
    {
      action_type: 'Climb & Ride',
      category: 'scene_specific',
      name: 'climb',
    },
    {
      action_type: 'Anger',
      category: 'emotional',
      name: 'complain_01',
    },
    {
      action_type: 'Anger',
      category: 'emotional',
      name: 'complain_02',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'crossover_dribble',
    },
    {
      action_type: 'Sadness',
      category: 'emotional',
      name: 'cry',
    },
    {
      action_type: 'Dance',
      category: 'scene_specific',
      name: 'dance_01',
    },
    {
      action_type: 'Dance',
      category: 'scene_specific',
      name: 'dance_02',
    },
    {
      action_type: 'Dance',
      category: 'scene_specific',
      name: 'dance_03',
    },
    {
      action_type: 'Dance',
      category: 'scene_specific',
      name: 'dance_04',
    },
    {
      action_type: 'Dance',
      category: 'scene_specific',
      name: 'dance_05',
    },
    {
      action_type: 'Dance',
      category: 'scene_specific',
      name: 'dance_06',
    },
    {
      action_type: 'Hit Reactions',
      category: 'combat',
      name: 'defeat_02',
    },
    {
      action_type: 'Hit Reactions',
      category: 'combat',
      name: 'defeat_03',
    },
    {
      action_type: 'Sadness',
      category: 'emotional',
      name: 'depressed',
    },
    {
      action_type: 'Work Activities',
      category: 'scene_specific',
      name: 'dig',
    },
    {
      action_type: 'Acrobatics',
      category: 'scene_specific',
      name: 'dive',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'dribble',
    },
    {
      action_type: 'Accident',
      category: 'scene_specific',
      name: 'fall',
    },
    {
      action_type: 'Ranged',
      category: 'combat',
      name: 'fire',
    },
    {
      action_type: 'Fear',
      category: 'emotional',
      name: 'flee_01',
    },
    {
      action_type: 'Fear',
      category: 'emotional',
      name: 'flee_02',
    },
    {
      action_type: 'Acrobatics',
      category: 'scene_specific',
      name: 'flip',
    },
    {
      action_type: 'Idle',
      category: 'basic',
      name: 'fold_arms',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'football_catch',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'football_save',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'football_pass',
    },
    {
      action_type: 'Body Movement',
      category: 'basic',
      name: 'freaky',
    },
    {
      action_type: 'Fear',
      category: 'emotional',
      name: 'frightened',
    },
    {
      action_type: 'Strike',
      category: 'combat',
      name: 'front_kick_01',
    },
    {
      action_type: 'Strike',
      category: 'combat',
      name: 'front_kick_02',
    },
    {
      action_type: 'Anger',
      category: 'emotional',
      name: 'frustrated_01',
    },
    {
      action_type: 'Anger',
      category: 'emotional',
      name: 'frustrated_02',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'greet_01',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'greet_02',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'greet_03',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'greet_04',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'heart_pose',
    },
    {
      action_type: 'Hit Reactions',
      category: 'combat',
      name: 'hit_to_body_01',
    },
    {
      action_type: 'Hit Reactions',
      category: 'combat',
      name: 'hit_to_body_02',
    },
    {
      action_type: 'Hit Reactions',
      category: 'combat',
      name: 'hit_to_head',
    },
    {
      action_type: 'Hit Reactions',
      category: 'combat',
      name: 'hit_to_side',
    },
    {
      action_type: 'Hit Reactions',
      category: 'combat',
      name: 'hit_to_stomach',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'hug',
    },
    {
      action_type: 'Idle',
      category: 'basic',
      name: 'idle',
    },
    {
      action_type: 'Jump',
      category: 'basic',
      name: 'jump_down',
    },
    {
      action_type: 'Jump',
      category: 'basic',
      name: 'jump',
    },
    {
      action_type: 'Fitness',
      category: 'scene_specific',
      name: 'jump_rope_01',
    },
    {
      action_type: 'Fitness',
      category: 'scene_specific',
      name: 'jump_rope_02',
    },
    {
      action_type: 'Joy',
      category: 'emotional',
      name: 'laugh_01',
    },
    {
      action_type: 'Joy',
      category: 'emotional',
      name: 'laugh_02',
    },
    {
      action_type: 'Object Interaction',
      category: 'interactive',
      name: 'lift_heavy',
    },
    {
      action_type: 'Body Movement',
      category: 'basic',
      name: 'look_around',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'make_a_call_01',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'make_a_call_02',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'pitch_baseball',
    },
    {
      action_type: 'Leisure',
      category: 'interactive',
      name: 'play_mobile_game',
    },
    {
      action_type: 'Leisure',
      category: 'interactive',
      name: 'play_video_game',
    },
    {
      action_type: 'Fitness',
      category: 'scene_specific',
      name: 'press-up',
    },
    {
      action_type: 'Run',
      category: 'basic',
      name: 'run_upstairs',
    },
    {
      action_type: 'Run',
      category: 'basic',
      name: 'run',
    },
    {
      action_type: 'Fear',
      category: 'emotional',
      name: 'scared_01',
    },
    {
      action_type: 'Fear',
      category: 'emotional',
      name: 'scared_02',
    },
    {
      action_type: 'Body Movement',
      category: 'basic',
      name: 'scratch',
    },
    {
      action_type: 'Ranged',
      category: 'combat',
      name: 'shoot',
    },
    {
      action_type: 'Work Activities',
      category: 'scene_specific',
      name: 'shovel',
    },
    {
      action_type: 'Play Music',
      category: 'scene_specific',
      name: 'sing_01',
    },
    {
      action_type: 'Play Music',
      category: 'scene_specific',
      name: 'sing_02',
    },
    {
      action_type: 'Play Music',
      category: 'scene_specific',
      name: 'sing_03',
    },
    {
      action_type: 'Play Music',
      category: 'scene_specific',
      name: 'sing_04',
    },
    {
      action_type: 'Sit & Lie',
      category: 'basic',
      name: 'sit',
    },
    {
      action_type: 'Work Activities',
      category: 'scene_specific',
      name: 'slash',
    },
    {
      action_type: 'Sadness',
      category: 'emotional',
      name: 'sob',
    },
    {
      action_type: 'Idle',
      category: 'basic',
      name: 'standing_relax',
    },
    {
      action_type: 'Water Activities',
      category: 'scene_specific',
      name: 'surf',
    },
    {
      action_type: 'Attitude',
      category: 'emotional',
      name: 'swagger',
    },
    {
      action_type: 'Water Activities',
      category: 'scene_specific',
      name: 'swim',
    },
    {
      action_type: 'Turn',
      category: 'basic',
      name: 'turn',
    },
    {
      action_type: 'Ball Sports',
      category: 'scene_specific',
      name: 'volleyball',
    },
    {
      action_type: 'Idle',
      category: 'basic',
      name: 'wait',
    },
    {
      action_type: 'Walk',
      category: 'basic',
      name: 'walk',
    },
    {
      action_type: 'Fitness',
      category: 'scene_specific',
      name: 'warm_up',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'wave_goodbye_01',
    },
    {
      action_type: 'Social',
      category: 'interactive',
      name: 'wave_goodbye_02',
    },
  ],
  hexapod: [
    {
      action_type: 'Walk',
      category: 'basic',
      name: 'walk',
    },
  ],
  octopod: [
    {
      action_type: 'Walk',
      category: 'basic',
      name: 'walk',
    },
  ],
  quadruped: [
    {
      action_type: 'Walk',
      category: 'basic',
      name: 'walk',
    },
  ],
  serpentine: [
    {
      action_type: 'Walk',
      category: 'basic',
      name: 'march',
    },
  ],
};
export const motionPresetSchema = z
  .object({
    rig_type: z
      .enum(['aquatic', 'avian', 'biped', 'hexapod', 'octopod', 'quadruped', 'serpentine'])
      .optional(),
    category: z.enum(['basic', 'interactive', 'scene_specific', 'emotional', 'combat']).optional(),
  })
  .strict();
/** 返回可直接用于 studio animate 的标识；这是网页版本快照，不代表全部动作已逐个验收。 */
export function listMotionPresets(input: unknown): Record<string, unknown> {
  const x = motionPresetSchema.parse(input);
  const items = Object.entries(presets)
    .flatMap(([rig_type, rows]) =>
      rows.map((row) => ({
        rig_type,
        category: row.category,
        action_type: row.action_type,
        name: row.name,
        animation: 'preset:' + rig_type + ':' + row.name,
      })),
    )
    .filter(
      (row) => (!x.rig_type || row.rig_type === x.rig_type) && (!x.category || row.category === x.category),
    );
  return { observed_at: '2026-11-12', source: 'Studio public motion catalogue', total: items.length, items };
}
