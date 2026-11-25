/** 官方 tripo-cli 0.11.2 的公开 MCP schema 快照（MIT）；说明已按 Studio 后端修订，见 THIRD_PARTY_NOTICES.md。 */
const unquotedImportConsent = {
  type: 'boolean',
  const: true,
  description:
    'Studio extension: explicitly accept unknown web-account charges for import/apply steps in this processing plan. A current reviewed snapshot must permit the operation. Omit when no such step is present; this is not a zero-cost estimate or a spending cap. Do not combine with max_estimated_credits.',
};
const processingBudget = {
  type: 'number',
  minimum: 0,
  description:
    'Studio extension: maximum reviewed estimate per processing step, not an upstream spending cap. Omit for explicitly accepted unquoted import/apply steps; combining it with that consent is rejected before the chain starts. Lab reference routes retain their separate variable-billing contract.',
};
const unquotedImportOptions = {
  accept_variable_cost: unquotedImportConsent,
  max_estimated_credits: processingBudget,
};

export const fullContract: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  experimental?: boolean;
  [key: string]: unknown;
}[] = [
  {
    name: 'ai_modeling_plan',
    title: 'Plan workflow (confirm before running)',
    description:
      'Draft an advisory Studio workflow without submitting tasks. Generation steps are validated locally; cost_estimate is not_estimated and never implies zero. Actual website pricing is checked at submission. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'what the user wants, in one sentence',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                enum: [
                  'ai_modeling_plan',
                  'ai_modeling_text_to_3d',
                  'ai_modeling_image_to_3d',
                  'ai_modeling_multiview_to_3d',
                  'ai_modeling_image_to_splat',
                  'ai_modeling_upload_image',
                  'ai_modeling_upload_ticket',
                  'ai_modeling_upload_presign',
                  'ai_modeling_import_model',
                  'ai_modeling_generate_image',
                  'ai_modeling_image_to_multiview',
                  'ai_modeling_edit_multiview',
                  'ai_modeling_task_status',
                  'ai_modeling_task_wait',
                  'ai_modeling_task_list',
                  'ai_modeling_texture',
                  'ai_modeling_convert',
                  'ai_modeling_decimate',
                  'ai_modeling_smart_uv',
                  'ai_modeling_segment',
                  'ai_modeling_mesh_complete',
                  'ai_modeling_mesh_edit',
                  'ai_modeling_smart_segment',
                  'ai_modeling_rig_check',
                  'ai_modeling_rig',
                  'ai_modeling_animate',
                  'ai_modeling_balance',
                  'ai_modeling_usage',
                ],
                description: 'ai-modeling tool to call',
              },
              purpose: {
                type: 'string',
                minLength: 1,
                maxLength: 300,
                description: 'what this step does for the user',
              },
              generation: {
                type: 'object',
                properties: {
                  model: {
                    type: 'string',
                    minLength: 1,
                    description:
                      'P2-20260801 (P2, P2.0) is the default 3D generation model (48–50000 tri / 48–25000 quad); v3.1-20260211 (v3.1, H3.1) is the H-series flagship for dense geometry and v3-only options; P1-20260311 (P1, P1.0) is an explicit lower-cost P-series choice (50–20000 faces); v3.0-20250812 / v2.5-20250123 (H3.0 / H2.5) are legacy. Full version IDs and short names are accepted. An explicit model wins; prompt and parameters do not select another model. Explicitly pass the confirmed model from ai_modeling_plan to the generation call. Unsupported Studio parameters are rejected before submission, and P2 face budgets outside its range are rejected; choose v3.1 explicitly when its capabilities are required. P2 lists at 100–130 credits per generation versus 10–50 for v3.1 before add-ons; Studio dry runs validate the request; pricing is checked at submission.',
                  },
                  texture: {
                    type: 'boolean',
                    description: 'generate textures (default true); false = bare geometry',
                  },
                  pbr: {
                    type: 'boolean',
                    description:
                      'PBR materials (implies texture); default false — set true only when the user explicitly asks for PBR',
                  },
                  texture_quality: {
                    type: 'string',
                    enum: ['fast', 'standard', 'detailed', 'extreme'],
                    description:
                      'fast = quickest, same size and credits as standard, needs texture model v3.5 (picked automatically when texture_version is omitted); extreme = 8K, extra credits',
                  },
                  texture_version: {
                    type: 'string',
                    enum: ['v3.5', 'v3.5-20260815', 'v3.0', 'v3.0-20250812', 'v2.5', 'v2.5-20250123'],
                    description:
                      'Independent texture engine: explicit v3.5/full ID uses a native chain with exact operator validation. Older versions have no verified mapping while texturing is enabled. Valid versions are ignored with a warning when texture=false; fast still requires v3.5.',
                  },
                  delight: {
                    type: 'boolean',
                    description:
                      'remove baked-in lighting from the reference before texturing (default true; texture model v3.5 only)',
                  },
                  geometry_quality: {
                    type: 'string',
                    enum: ['standard', 'detailed'],
                    description:
                      'detailed = Ultra mode with finer geometry and up to 2M faces (v3.x only; extra credits)',
                  },
                  face_limit: {
                    type: 'integer',
                    exclusiveMinimum: 0,
                    description:
                      'max face count; P2 accepts 48–50000 triangles or 48–25000 quads; an out-of-range P2 budget is rejected, so choose a compatible model explicitly',
                  },
                  quad: {
                    type: 'boolean',
                    description:
                      'quad topology (P2 or v3.x; output is FBX); does not change the selected model',
                  },
                  smart_low_poly: {
                    type: 'boolean',
                    description: 'game-style low-poly output (v3.x only; face_limit 500–20000)',
                  },
                  generate_parts: {
                    type: 'boolean',
                    description: 'segmented editable parts, bare geometry (v3.x only)',
                  },
                  auto_size: {
                    type: 'boolean',
                    description: 'scale to real-world size in meters (AR/VR, game engines)',
                  },
                  compress: {
                    type: 'string',
                    enum: ['geometry'],
                    description: 'meshopt geometry compression for a smaller file',
                  },
                  export_uv: {
                    type: 'boolean',
                    description:
                      'UV unwrapping during generation (default true); false = faster and smaller, UVs are created when texturing',
                  },
                  model_seed: {
                    type: 'integer',
                    description: 'fixed seed → identical geometry on re-runs',
                  },
                  texture_seed: {
                    type: 'integer',
                    description:
                      'fixed seed → identical textures; keep model_seed and vary this to re-texture the same shape',
                  },
                  export_orientation: {
                    type: 'string',
                    enum: ['+x', '-x', '+y', '-y'],
                    description:
                      'forward axis of this export only; leave unset when the model will be post-processed (texture/rig/convert) and orient in ai_modeling_convert at the end instead',
                  },
                  dry_run: {
                    type: 'boolean',
                    description:
                      'true = validate only, no task and no credits: returns the resolved model, the exact request payload after linkage rules and the adjustment notes; call again without dry_run to submit',
                  },
                  prompt: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 1024,
                  },
                },
                additionalProperties: false,
                description:
                  '3D generation model options; text-to-3D requires its exact prompt. Image/multiview prompt is retained for compatibility but does not select a model and is not sent upstream. Not an executable request; use dry_run for the full payload including image references.',
              },
              params: {
                type: 'string',
                maxLength: 300,
                description: 'key parameters in plain text, e.g. model=P2 quad=true face_limit=5000',
              },
            },
            required: ['tool', 'purpose'],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: 20,
          description: 'intended calls in execution order',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['goal', 'steps'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: {
                type: 'integer',
              },
              tool: {
                type: 'string',
              },
              purpose: {
                type: 'string',
              },
              params: {
                type: 'string',
              },
              billed: {
                type: 'boolean',
              },
              billing_note: {
                type: 'string',
              },
              model: {
                type: 'string',
              },
              cost_estimate: {
                type: 'string',
              },
              notes: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            },
            required: ['step', 'tool', 'purpose', 'billed', 'model', 'cost_estimate', 'notes'],
            additionalProperties: false,
          },
        },
        billed_steps: {
          type: 'integer',
        },
        cost_estimate: {
          type: 'string',
        },
        authorization: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
      },
      required: ['goal', 'steps', 'billed_steps', 'cost_estimate', 'authorization', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ai_modeling_text_to_3d',
    title: 'Text to 3D',
    description:
      'Create a Tripo 3D model from a text prompt (Chinese or English, ≤1024 chars). P1/P2 texture=true runs bare geometry then native texture; pbr=true adds PBR. Multi-step calls wait and return the final task plus chain receipts, with separate website pricing for each step. Single-step calls return task_id for ai_modeling_task_wait. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description: 'what to generate; concrete nouns + style + materials work best',
        },
        negative_prompt: {
          type: 'string',
          maxLength: 255,
        },
        image_seed: {
          type: 'integer',
          description: 'seed of the internal text-to-image stage',
        },
        model: {
          type: 'string',
          minLength: 1,
          description:
            'P2-20260801 (P2, P2.0) is the default 3D generation model (48–50000 tri / 48–25000 quad); v3.1-20260211 (v3.1, H3.1) is the H-series flagship for dense geometry and v3-only options; P1-20260311 (P1, P1.0) is an explicit lower-cost P-series choice (50–20000 faces); v3.0-20250812 / v2.5-20250123 (H3.0 / H2.5) are legacy. Full version IDs and short names are accepted. An explicit model wins; prompt and parameters do not select another model. Explicitly pass the confirmed model from ai_modeling_plan to the generation call. Unsupported Studio parameters are rejected before submission, and P2 face budgets outside its range are rejected; choose v3.1 explicitly when its capabilities are required. P2 lists at 100–130 credits per generation versus 10–50 for v3.1 before add-ons; Studio dry runs validate the request; pricing is checked at submission.',
        },
        texture: {
          type: 'boolean',
          description: 'generate textures (default true); false = bare geometry',
        },
        pbr: {
          type: 'boolean',
          description:
            'PBR materials (implies texture); default false — set true only when the user explicitly asks for PBR',
        },
        texture_quality: {
          type: 'string',
          enum: ['fast', 'standard', 'detailed', 'extreme'],
          description:
            'fast = quickest, same size and credits as standard, needs texture model v3.5 (picked automatically when texture_version is omitted); extreme = 8K, extra credits',
        },
        texture_version: {
          type: 'string',
          enum: ['v3.5', 'v3.5-20260815', 'v3.0', 'v3.0-20250812', 'v2.5', 'v2.5-20250123'],
          description:
            'Independent texture engine: explicit v3.5/full ID uses a native chain with exact operator validation. Older versions have no verified mapping while texturing is enabled. Valid versions are ignored with a warning when texture=false; fast still requires v3.5.',
        },
        delight: {
          type: 'boolean',
          description:
            'remove baked-in lighting from the reference before texturing (default true; texture model v3.5 only)',
        },
        geometry_quality: {
          type: 'string',
          enum: ['standard', 'detailed'],
          description:
            'detailed = Ultra mode with finer geometry and up to 2M faces (v3.x only; extra credits)',
        },
        face_limit: {
          type: 'integer',
          exclusiveMinimum: 0,
          description:
            'max face count; P2 accepts 48–50000 triangles or 48–25000 quads; an out-of-range P2 budget is rejected, so choose a compatible model explicitly',
        },
        quad: {
          type: 'boolean',
          description: 'quad topology (P2 or v3.x; output is FBX); does not change the selected model',
        },
        smart_low_poly: {
          type: 'boolean',
          description: 'game-style low-poly output (v3.x only; face_limit 500–20000)',
        },
        generate_parts: {
          type: 'boolean',
          description: 'segmented editable parts, bare geometry (v3.x only)',
        },
        auto_size: {
          type: 'boolean',
          description: 'scale to real-world size in meters (AR/VR, game engines)',
        },
        compress: {
          type: 'string',
          enum: ['geometry'],
          description: 'meshopt geometry compression for a smaller file',
        },
        export_uv: {
          type: 'boolean',
          description:
            'UV unwrapping during generation (default true); false = faster and smaller, UVs are created when texturing',
        },
        model_seed: {
          type: 'integer',
          description: 'fixed seed → identical geometry on re-runs',
        },
        texture_seed: {
          type: 'integer',
          description:
            'fixed seed → identical textures; keep model_seed and vary this to re-texture the same shape',
        },
        export_orientation: {
          type: 'string',
          enum: ['+x', '-x', '+y', '-y'],
          description:
            'forward axis of this export only; leave unset when the model will be post-processed (texture/rig/convert) and orient in ai_modeling_convert at the end instead',
        },
        dry_run: {
          type: 'boolean',
          description:
            'true = validate only, no task and no credits: returns the resolved model, the exact request payload after linkage rules and the adjustment notes; call again without dry_run to submit',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        dry_run: {
          type: 'boolean',
        },
        model_name: {
          type: 'string',
        },
        cost_estimate: {
          type: 'string',
        },
        authorization: {
          type: 'string',
        },
        endpoint: {
          type: 'string',
        },
        payload: {
          type: 'object',
          additionalProperties: {},
        },
      },
      required: ['next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_upload_image',
    title: 'Re-host image from URL',
    description:
      'Upload an image URL or local path through the Studio uploader. Return a reusable local Studio file_token; it is account-bound and cannot be used with the developer API. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          minLength: 1,
          description: 'http(s) URL of a PNG/JPEG/WebP image, ≤20MB',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['url'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        file_token: {
          type: 'string',
        },
        mime: {
          type: 'string',
        },
        bytes: {
          type: 'integer',
        },
        next: {
          type: 'string',
        },
      },
      required: ['file_token', 'mime', 'bytes', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_import_model',
    title: 'Import model file',
    description:
      'Import an existing 3D model (GLB/GLTF/FBX/OBJ/STL, ≤150MB) into Tripo as a task, so it gets a preview and a task_id reusable across texture/convert/rig/segment steps without re-uploading. input is a file_token (from ai_modeling_upload_ticket with kind=model) or a public model file URL. Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        input: {
          type: 'string',
          minLength: 1,
          description: 'model file_token or public model file URL',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_image_to_3d',
    title: 'Image to 3D',
    description:
      'Create a Tripo 3D model from a reference image. input accepts a public image URL (jpg/png/webp), a Tripo file_token, or an image-producing task_id. Studio P2 single-image face_limit starts at 500; the official smaller range is not supported on this website path. P1/P2 texture=true runs bare geometry then native texture; pbr=true adds PBR. Multi-step calls wait and return the final task plus chain receipts, with separate website pricing for each step. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          minLength: 1,
          description: 'image URL / file_token / task_id',
        },
        prompt: {
          type: 'string',
          maxLength: 1024,
          description:
            'optional compatibility field; does not select the model and is not sent to the image-to-model API',
        },
        enable_image_autofix: {
          type: 'boolean',
          description: 'auto-repair low-quality/blurry/incomplete inputs (slower)',
        },
        orientation: {
          type: 'string',
          enum: ['default', 'align_image'],
          description: 'align_image rotates the model to the input viewpoint (needs texture)',
        },
        texture_alignment: {
          type: 'string',
          enum: ['original_image', 'geometry'],
          description: 'prioritize input colors (default) or generated geometry',
        },
        model: {
          type: 'string',
          minLength: 1,
          description:
            'P2-20260801 (P2, P2.0) is the default 3D generation model (48–50000 tri / 48–25000 quad); v3.1-20260211 (v3.1, H3.1) is the H-series flagship for dense geometry and v3-only options; P1-20260311 (P1, P1.0) is an explicit lower-cost P-series choice (50–20000 faces); v3.0-20250812 / v2.5-20250123 (H3.0 / H2.5) are legacy. Full version IDs and short names are accepted. An explicit model wins; prompt and parameters do not select another model. Explicitly pass the confirmed model from ai_modeling_plan to the generation call. Unsupported Studio parameters are rejected before submission, and P2 face budgets outside its range are rejected; choose v3.1 explicitly when its capabilities are required. P2 lists at 100–130 credits per generation versus 10–50 for v3.1 before add-ons; Studio dry runs validate the request; pricing is checked at submission.',
        },
        texture: {
          type: 'boolean',
          description: 'generate textures (default true); false = bare geometry',
        },
        pbr: {
          type: 'boolean',
          description:
            'PBR materials (implies texture); default false — set true only when the user explicitly asks for PBR',
        },
        texture_quality: {
          type: 'string',
          enum: ['fast', 'standard', 'detailed', 'extreme'],
          description:
            'fast = quickest, same size and credits as standard, needs texture model v3.5 (picked automatically when texture_version is omitted); extreme = 8K, extra credits',
        },
        texture_version: {
          type: 'string',
          enum: ['v3.5', 'v3.5-20260815', 'v3.0', 'v3.0-20250812', 'v2.5', 'v2.5-20250123'],
          description:
            'Independent texture engine: explicit v3.5/full ID uses a native chain with exact operator validation. Older versions have no verified mapping while texturing is enabled. Valid versions are ignored with a warning when texture=false; fast still requires v3.5.',
        },
        delight: {
          type: 'boolean',
          description:
            'remove baked-in lighting from the reference before texturing (default true; texture model v3.5 only)',
        },
        geometry_quality: {
          type: 'string',
          enum: ['standard', 'detailed'],
          description:
            'detailed = Ultra mode with finer geometry and up to 2M faces (v3.x only; extra credits)',
        },
        face_limit: {
          type: 'integer',
          exclusiveMinimum: 0,
          description:
            'max face count; P2 accepts 48–50000 triangles or 48–25000 quads; an out-of-range P2 budget is rejected, so choose a compatible model explicitly',
        },
        quad: {
          type: 'boolean',
          description: 'quad topology (P2 or v3.x; output is FBX); does not change the selected model',
        },
        smart_low_poly: {
          type: 'boolean',
          description: 'game-style low-poly output (v3.x only; face_limit 500–20000)',
        },
        generate_parts: {
          type: 'boolean',
          description: 'segmented editable parts, bare geometry (v3.x only)',
        },
        auto_size: {
          type: 'boolean',
          description: 'scale to real-world size in meters (AR/VR, game engines)',
        },
        compress: {
          type: 'string',
          enum: ['geometry'],
          description: 'meshopt geometry compression for a smaller file',
        },
        export_uv: {
          type: 'boolean',
          description:
            'UV unwrapping during generation (default true); false = faster and smaller, UVs are created when texturing',
        },
        model_seed: {
          type: 'integer',
          description: 'fixed seed → identical geometry on re-runs',
        },
        texture_seed: {
          type: 'integer',
          description:
            'fixed seed → identical textures; keep model_seed and vary this to re-texture the same shape',
        },
        export_orientation: {
          type: 'string',
          enum: ['+x', '-x', '+y', '-y'],
          description:
            'forward axis of this export only; leave unset when the model will be post-processed (texture/rig/convert) and orient in ai_modeling_convert at the end instead',
        },
        dry_run: {
          type: 'boolean',
          description:
            'true = validate only, no task and no credits: returns the resolved model, the exact request payload after linkage rules and the adjustment notes; call again without dry_run to submit',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        dry_run: {
          type: 'boolean',
        },
        model_name: {
          type: 'string',
        },
        cost_estimate: {
          type: 'string',
        },
        authorization: {
          type: 'string',
        },
        endpoint: {
          type: 'string',
        },
        payload: {
          type: 'object',
          additionalProperties: {},
        },
      },
      required: ['next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_multiview_to_3d',
    title: 'Multiview to 3D',
    description:
      'Create a 3D model from 2–4 orthographic views (front required; add left/back/right), or a finished Studio multiview task via multiview_task_id. Each view accepts an image URL / file_token. P1/P2 texture=true runs bare geometry then native texture; pbr=true adds PBR. Multi-step calls wait and return the final task plus chain receipts, with separate website pricing for each step. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          maxLength: 1024,
          description:
            'optional compatibility field; does not select the model and is not sent to the multiview-to-model API',
        },
        front: {
          type: 'string',
          minLength: 1,
          description: 'front view (required unless multiview_task_id is set)',
        },
        left: {
          type: 'string',
          minLength: 1,
        },
        back: {
          type: 'string',
          minLength: 1,
        },
        right: {
          type: 'string',
          minLength: 1,
        },
        multiview_task_id: {
          type: 'string',
          minLength: 1,
          description:
            'a successful ai_modeling_image_to_multiview / ai_modeling_edit_multiview task whose 4 views to use instead of front/left/back/right',
        },
        orientation: {
          type: 'string',
          enum: ['default', 'align_image'],
          description: 'align_image rotates the model to the input viewpoint (needs texture)',
        },
        texture_alignment: {
          type: 'string',
          enum: ['original_image', 'geometry'],
          description: 'prioritize input colors (default) or generated geometry',
        },
        model: {
          type: 'string',
          minLength: 1,
          description:
            'P2-20260801 (P2, P2.0) is the default 3D generation model (48–50000 tri / 48–25000 quad); v3.1-20260211 (v3.1, H3.1) is the H-series flagship for dense geometry and v3-only options; P1-20260311 (P1, P1.0) is an explicit lower-cost P-series choice (50–20000 faces); v3.0-20250812 / v2.5-20250123 (H3.0 / H2.5) are legacy. Full version IDs and short names are accepted. An explicit model wins; prompt and parameters do not select another model. Explicitly pass the confirmed model from ai_modeling_plan to the generation call. Unsupported Studio parameters are rejected before submission, and P2 face budgets outside its range are rejected; choose v3.1 explicitly when its capabilities are required. P2 lists at 100–130 credits per generation versus 10–50 for v3.1 before add-ons; Studio dry runs validate the request; pricing is checked at submission.',
        },
        texture: {
          type: 'boolean',
          description: 'generate textures (default true); false = bare geometry',
        },
        pbr: {
          type: 'boolean',
          description:
            'PBR materials (implies texture); default false — set true only when the user explicitly asks for PBR',
        },
        texture_quality: {
          type: 'string',
          enum: ['fast', 'standard', 'detailed', 'extreme'],
          description:
            'fast = quickest, same size and credits as standard, needs texture model v3.5 (picked automatically when texture_version is omitted); extreme = 8K, extra credits',
        },
        texture_version: {
          type: 'string',
          enum: ['v3.5', 'v3.5-20260815', 'v3.0', 'v3.0-20250812', 'v2.5', 'v2.5-20250123'],
          description:
            'Independent texture engine: explicit v3.5/full ID uses a native chain with exact operator validation. Older versions have no verified mapping while texturing is enabled. Valid versions are ignored with a warning when texture=false; fast still requires v3.5.',
        },
        delight: {
          type: 'boolean',
          description:
            'remove baked-in lighting from the reference before texturing (default true; texture model v3.5 only)',
        },
        geometry_quality: {
          type: 'string',
          enum: ['standard', 'detailed'],
          description:
            'detailed = Ultra mode with finer geometry and up to 2M faces (v3.x only; extra credits)',
        },
        face_limit: {
          type: 'integer',
          exclusiveMinimum: 0,
          description:
            'max face count; P2 accepts 48–50000 triangles or 48–25000 quads; an out-of-range P2 budget is rejected, so choose a compatible model explicitly',
        },
        quad: {
          type: 'boolean',
          description: 'quad topology (P2 or v3.x; output is FBX); does not change the selected model',
        },
        smart_low_poly: {
          type: 'boolean',
          description: 'game-style low-poly output (v3.x only; face_limit 500–20000)',
        },
        generate_parts: {
          type: 'boolean',
          description: 'segmented editable parts, bare geometry (v3.x only)',
        },
        auto_size: {
          type: 'boolean',
          description: 'scale to real-world size in meters (AR/VR, game engines)',
        },
        compress: {
          type: 'string',
          enum: ['geometry'],
          description: 'meshopt geometry compression for a smaller file',
        },
        export_uv: {
          type: 'boolean',
          description:
            'UV unwrapping during generation (default true); false = faster and smaller, UVs are created when texturing',
        },
        model_seed: {
          type: 'integer',
          description: 'fixed seed → identical geometry on re-runs',
        },
        texture_seed: {
          type: 'integer',
          description:
            'fixed seed → identical textures; keep model_seed and vary this to re-texture the same shape',
        },
        export_orientation: {
          type: 'string',
          enum: ['+x', '-x', '+y', '-y'],
          description:
            'forward axis of this export only; leave unset when the model will be post-processed (texture/rig/convert) and orient in ai_modeling_convert at the end instead',
        },
        dry_run: {
          type: 'boolean',
          description:
            'true = validate only, no task and no credits: returns the resolved model, the exact request payload after linkage rules and the adjustment notes; call again without dry_run to submit',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        dry_run: {
          type: 'boolean',
        },
        model_name: {
          type: 'string',
        },
        cost_estimate: {
          type: 'string',
        },
        authorization: {
          type: 'string',
        },
        endpoint: {
          type: 'string',
        },
        payload: {
          type: 'object',
          additionalProperties: {},
        },
      },
      required: ['next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_image_to_splat',
    title: 'Image to Gaussian splat',
    description:
      'Official splat command contract. Unavailable on the reviewed Studio backend: returns STUDIO_CAPABILITY_UNAVAILABLE before submitting or spending credits. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          minLength: 1,
          description: 'image URL / file_token / task_id',
        },
        model_seed: {
          type: 'integer',
          description: 'fixed seed → identical splat on re-runs',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_generate_image',
    title: 'Generate / edit image',
    description:
      'Generate an image from text or reference image(s), using Studio web credits. Default model is GPT Image 2.5 (chat_image_2.5_sunburst); banana/banana2/banana_pro and chat_image_2/2.5_sunburst map to website models. GPT Image 2 and 2.5 Sunburst support 16 total ordered references. aspect_ratio maps to scale except where the official model policy ignores it. Verified WxH mappings use native resolution/ratio controls, freeze the exact requested pixels and check every original result even without downloading; mismatches remain needs_attention with remote success, without resizing or regeneration. Native ratio/tier requests do not promise exact pixels. Nano Banana 2K requests returned 1K and are rejected. Seedream and unmapped API options are rejected. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'up to 1800 characters after trimming',
        },
        negative_prompt: {
          type: 'string',
        },
        image_seed: {
          type: 'integer',
        },
        input: {
          type: 'string',
          minLength: 1,
          description:
            'source image URL / file_token / task_id — set to edit an image, omit for text-to-image',
        },
        inputs: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
          },
          minItems: 1,
          description:
            'ordered reference images for editing/fusion, referred to as image[1], image[2], … in the prompt; Studio supports at most 16 total for chat_image_2/2.5_sunburst and 10 for other mapped models; no primary role is assigned to the first image in this array',
        },
        model: {
          type: 'string',
          enum: [
            'seedream_v4',
            'seedream_v5',
            'banana',
            'banana_pro',
            'banana2',
            'chat_image_1',
            'chat_image_1.5',
            'chat_image_2',
            'chat_image_2.5_flare',
            'chat_image_2.5_sunburst',
            'gemini-2.5-flash',
            'gemini-3-pro',
            'gemini-3.1-flash',
          ],
          description:
            'Studio default: chat_image_2.5_sunburst for text and image editing; Seedream is not mapped; chat_image_2.5_flare = faster tier, chat_image_2.5_sunburst = refined tier that best preserves untouched areas when editing; chat_image_1 is retired (rejected locally since 2026-10-23) and chat_image_1.5 on 2026-12-01; gemini-2.5-flash / gemini-3-pro / gemini-3.1-flash are sent as banana / banana_pro / banana2',
        },
        template: {
          type: 'string',
          enum: ['asset_extraction', 'character_completion', 't_pose', '3d_enhance', 'variants', 'figure'],
        },
        size: {
          type: 'string',
          description:
            'Studio: 1K/4K; Banana supports 1024x1024, 864x1184, 1184x864, 768x1344, 1344x768; Banana Pro supports 1024x1024, 1200x896, 896x1200, 1376x768, 768x1376, 4096x4096; GPT Image 2 and 2.5 Sunburst support 1024x1024, 1536x1152, 1152x1536, 1792x1024, 1024x1792. Exact WxH is verified on original bytes without resampling and retained for get/list/download/redo. Other WxH values are unverified; Banana2 WxH is rejected by the official CLI too. Nano Banana 2K returns 1K and is rejected',
        },
        aspect_ratio: {
          type: 'string',
          description:
            'banana models only (1:1, 3:2, 16:9, …); other models take the shape from size or the prompt',
        },
        output_format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description:
            'Optional local CLI delivery encoding; preserves the original Studio image. This is not a native generation control or a verified webpage format selector.',
        },
        watermark: {
          type: 'boolean',
          description: 'seedream models only: visible AI-content watermark (default false)',
        },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description:
            'chat_image_2 (low/medium/high) and chat_image_2.5 models (also xhigh/max) only; default low; high/xhigh/max cost extra credits',
        },
        background: {
          type: 'string',
          enum: ['auto', 'opaque', 'transparent'],
          description: 'chat_image_2.5 models only; transparent needs output_format png',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_image_to_multiview',
    title: 'Image to multiview sheet',
    description:
      'Generate a consistent 4-view sheet (front/left/back/right) from a single image. The resulting task_id can feed ai_modeling_multiview_to_3d (multiview_task_id) or be revised via ai_modeling_edit_multiview. Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          minLength: 1,
          description: 'image URL / file_token / task_id',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_edit_multiview',
    title: 'Edit multiview sheet',
    description:
      'Edit selected views of a successful Studio four-view task or asset. Each requested view uses a separate native image edit with its own receipt and website charge. A local four-view composition preserves untouched views and its task_id can feed ai_modeling_multiview_to_3d. Arbitrary sheet URL/file-token layouts have no verified mapping. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          minLength: 1,
          description: 'a successful Studio image-to-multiview/edit-multiview task_id or four-view asset',
        },
        prompts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              view: {
                type: 'string',
                enum: ['front', 'left', 'back', 'right'],
              },
              prompt: {
                type: 'string',
                minLength: 1,
                maxLength: 1024,
              },
            },
            required: ['view', 'prompt'],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: 4,
          description: 'e.g. [{"view":"front","prompt":"make the shirt red"}]',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input', 'prompts'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_task_status',
    title: 'Task status',
    description:
      'Get a locally tracked Studio task and optionally its persisted processing steps. IDs belong to this CLI; signed artifact URLs are withheld. Use ai_modeling_download for files. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          minLength: 1,
        },
        steps: {
          type: 'boolean',
          description: 'include the raw per-stage breakdown (server ?step=1)',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        type: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        progress: {
          type: 'number',
        },
        credits_consumed: {
          type: 'number',
        },
        estimated_seconds_left: {
          type: 'number',
        },
        model_url: {
          type: 'string',
        },
        output_urls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
              },
              url: {
                type: 'string',
              },
            },
            required: ['field', 'url'],
            additionalProperties: false,
          },
        },
        note: {
          type: 'string',
        },
        failure_reason: {},
        error_code: {
          type: 'number',
        },
        next: {
          type: 'string',
        },
        riggable: {
          type: 'boolean',
        },
        rig_type: {
          type: 'string',
        },
        normalize_scale: {
          type: 'number',
        },
        raw: {
          type: 'object',
          additionalProperties: {},
        },
      },
      required: ['task_id', 'type', 'status', 'output_urls'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ai_modeling_task_wait',
    title: 'Wait for task',
    description:
      'Poll the original Studio task for up to 55 seconds per call. Return success, failure, or current state with a next action; never re-submit an unfinished task. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          minLength: 1,
        },
        timeout_seconds: {
          type: 'integer',
          minimum: 5,
          maximum: 55,
          description: 'default 50; capped at 55 because MCP clients commonly time tool calls out at 60s',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        type: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        progress: {
          type: 'number',
        },
        credits_consumed: {
          type: 'number',
        },
        estimated_seconds_left: {
          type: 'number',
        },
        model_url: {
          type: 'string',
        },
        output_urls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
              },
              url: {
                type: 'string',
              },
            },
            required: ['field', 'url'],
            additionalProperties: false,
          },
        },
        note: {
          type: 'string',
        },
        failure_reason: {},
        error_code: {
          type: 'number',
        },
        next: {
          type: 'string',
        },
        riggable: {
          type: 'boolean',
        },
        rig_type: {
          type: 'string',
        },
        normalize_scale: {
          type: 'number',
        },
      },
      required: ['task_id', 'type', 'status', 'output_urls'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ai_modeling_task_list',
    title: 'Batch task status',
    description:
      'Get the status and fresh download URLs of up to 100 Tripo tasks in one call (e.g. a batch of generations). Unknown or expired ids are listed under missed. Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
          },
          minItems: 1,
          maxItems: 100,
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['task_ids'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
              },
              type: {
                type: 'string',
              },
              status: {
                type: 'string',
              },
              progress: {
                type: 'number',
              },
              credits_consumed: {
                type: 'number',
              },
              estimated_seconds_left: {
                type: 'number',
              },
              model_url: {
                type: 'string',
              },
              output_urls: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    field: {
                      type: 'string',
                    },
                    url: {
                      type: 'string',
                    },
                  },
                  required: ['field', 'url'],
                  additionalProperties: false,
                },
              },
              note: {
                type: 'string',
              },
              failure_reason: {},
              error_code: {
                type: 'number',
              },
              next: {
                type: 'string',
              },
              riggable: {
                type: 'boolean',
              },
              rig_type: {
                type: 'string',
              },
              normalize_scale: {
                type: 'number',
              },
            },
            required: ['task_id', 'type', 'status', 'output_urls'],
            additionalProperties: false,
          },
        },
        missed: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['tasks', 'missed'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ai_modeling_texture',
    title: 'Texture / retexture',
    description:
      'Re-texture a Studio model using text, image or multiview guidance, an independent style image and optional selected parts. Explicit v3.5 verifies the exact native operator engine; the v3.0 alias selects the current website operation without guaranteeing an older engine. PBR adds a separate task. fast and texture_seed map to native generation; repeated seeds did not reproduce identical textures. Unmapped options are rejected. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        texture_quality: {
          type: 'string',
          enum: ['fast', 'standard', 'detailed', 'extreme'],
          description:
            'fast/standard/detailed/extreme map to native generation quality; fast is not available for PBR/upscale and no speed guarantee is made',
        },
        pbr: {
          type: 'boolean',
          description: 'PBR materials; default false — set true only when the user explicitly asks for PBR',
        },
        texture_alignment: {
          type: 'string',
          enum: ['original_image', 'geometry'],
        },
        model: {
          type: 'string',
          enum: ['v3.5', 'v3.5-20260815', 'v3.0', 'v3.0-20250812', 'v2.5', 'v2.5-20250123'],
          description:
            'v3.5/full ID verifies the exact native operator engine; v3.0/full ID selects the current website operation without pinning an older engine; v2.5 has no verified exact Studio mapping',
        },
        prompt: {
          type: 'string',
          maxLength: 1024,
          description: 'text describing the desired texture style',
        },
        style_image: {
          type: 'string',
          minLength: 1,
          description:
            'independent style reference image URL / local path / Studio file_token; adds website style cost',
        },
        image: {
          type: 'string',
          minLength: 1,
          description:
            'single reference image URL / file_token (re-supply the original reference when retexturing a task)',
        },
        images: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
          },
          minItems: 4,
          maxItems: 4,
          description: 'exactly 4 reference images in order [front, left, back, right]',
        },
        texture_prompt: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
            },
            image: {},
            style_image: {},
            images: {
              type: 'array',
              items: {},
            },
          },
          additionalProperties: true,
          description:
            'native texture guidance; view-key images need front and another view, e.g. {"images":[{"front":"file_front"},{"left":"file_left"}]}',
        },
        texture_seed: {
          type: 'integer',
          description:
            'Native seed 0–2147483647; repeated seeds did not reproduce identical textures in Studio.',
        },
        part_names: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'texture only these parts of a segmented model',
        },
        compress: {
          type: 'string',
          enum: ['geometry'],
        },
        bake: {
          type: 'boolean',
          description: 'bake advanced material effects into base textures (default true)',
        },
        delight: {
          type: 'boolean',
          description:
            'remove baked-in lighting from the reference before texturing (default true; model v3.5 only)',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_rig_check',
    title: 'Rig precheck',
    description:
      'Check whether a model can be rigged before spending credits on ai_modeling_rig. input accepts a model-producing task_id, a file_token, or a model file URL; the finished task output states riggability. Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_rig',
    title: 'Rig model',
    description:
      'Add an animation skeleton to a model (seven named body types, or others). input accepts a model-producing task_id, a file_token, or a model file URL. Required before ai_modeling_animate. Billed separately. Unless model is set, quadruped uses the v2.5 creature rig and every other body type uses the v3.0 rig (on non-biped body types v3.0 matches v2.5 at the same price). Set model=v1.0 up front when the user wants humanoid clips beyond the universal presets (dance, greetings, sports… — the 90+ preset:biped:* clips exist only on v1.0 rigs); the result reports the model used and which preset family ai_modeling_animate must use. Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        rig_type: {
          type: 'string',
          enum: ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic', 'others'],
          description:
            'body type; take it from ai_modeling_rig_check (default biped); others = none of the named topologies (v3.0 only)',
        },
        spec: {
          type: 'string',
          enum: ['tripo', 'mixamo', 'actorcore', 'unity', 'unreal', 'vrm'],
          description:
            'bone naming, biped only: tripo (default) or mixamo; v3.0 also offers actorcore, unity (Unity Humanoid), unreal (UE Mannequin) and vrm (VRM 1.0)',
        },
        out_format: {
          type: 'string',
          enum: ['glb', 'fbx'],
        },
        model: {
          type: 'string',
          enum: [
            'v3.0',
            'v3.0-20260909',
            'v2.5',
            'v2.5-20260210',
            'v1.0',
            'v1.0-20240301',
            'rig-v3.0',
            'rig-v2.5',
            'rig-v2.0',
            'rig-v1.0',
          ],
          description:
            'v3.0-20260909 (v3.0) = recommended humanoid rig, faster and better at the same price, matching v2.5 on other body types; the only model for rig_type=others and the actorcore/unity/unreal/vrm specs. v2.5-20260210 (v2.5) = creature rig for quadruped/hexapod/octopod/avian/serpentine/aquatic. v3.0 and v2.5 share one preset set (generic clips for bipeds, body-type clips for creatures). v1.0-20240301 (v1.0) = legacy humanoid rig and server default, the only one with the 90+ preset:biped:* clips. When omitted, rig_type=quadruped defaults to v2.5 and every other body type to v3.0; an explicit model wins. The CLI names rig-v3.0 / rig-v2.5 / rig-v1.0 are accepted too (rig-v2.0 = v2.5)',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_animate',
    title: 'Animate rigged model',
    description:
      'Apply preset animations to a rig task (input must be a successful ai_modeling_rig task_id). Preset names depend on the rig model and body type reported by ai_modeling_rig: v3.0/v2.5 biped rigs (v3.0 is the default biped rig) take preset:idle, preset:walk, preset:run, preset:dive, preset:climb, preset:jump, preset:slash, preset:shoot, preset:hurt, preset:fall, preset:turn; v3.0/v2.5 creature rigs take only their body-type preset (preset:quadruped:walk, preset:hexapod:walk, preset:octopod:walk, preset:serpentine:march, preset:aquatic:march; avian and others have none); v1.0 humanoid rigs take only the 90+ preset:biped:* clips (preset:biped:idle, preset:biped:walk, preset:biped:run, preset:biped:jump, preset:biped:dance_01, preset:biped:wave_goodbye_01, …). Billed per animation, max 5. Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          minLength: 1,
          description: 'a successful ai_modeling_rig task',
        },
        bake_animation: {
          description: 'Deprecated and ignored; omit this parameter.',
        },
        animation: {
          type: 'string',
          minLength: 1,
          description: 'one animation preset; use animation or animations, not both',
        },
        animations: {
          type: 'array',
          items: {
            type: 'string',
          },
          minItems: 1,
          maxItems: 5,
          description:
            'e.g. ["preset:walk", "preset:idle"] for a v3.0/v2.5 biped rig, ["preset:quadruped:walk"] for a quadruped rig, ["preset:biped:walk", "preset:biped:dance_01"] for a v1.0 humanoid rig',
        },
        out_format: {
          type: 'string',
          enum: ['glb', 'fbx'],
        },
        animate_in_place: {
          type: 'boolean',
          description: 'true when game code drives movement',
        },
        export_with_geometry: {
          type: 'boolean',
          description: 'include the mesh in the export (default true)',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_convert',
    title: 'Convert / export format',
    description:
      'Export a Studio model. GLTF returns self-contained GLB; face_limit/quad add a billed remesh before export. Static part selection and scale use a native copy/metadata/export chain. Explicit bake=false verifies a restricted static native GLB, or explicitly requests animated GLTF with +x/-x/+y/-y, a boolean pivot_to_center_bottom and JPEG 2048 through the pinned Studio frontend engine plus persistent export-lite authorization. These four axes are capabilities of the original webpage engine; the current webpage export panel selects -y. The animated path preserves embedded skeletons/clips and actual existing JPEG 2048 textures; pivot=true additionally requires verified skinned rest bottom-center placement. Saved metallic/roughness follows the webpage is_pbr branch. Separate motions, geometry/display-name edits, import/remesh chains and other combinations remain unsupported. Its file-only transform creates no new model operator. An explicitly static with_animation=false combination with GLTF, one of these axes, a boolean pivot, JPEG/PNG/WEBP and texture_size=1–8192 also uses the verified frontend route. It requires an exact static GLB without skins/clips, verifies supported saved edits and materials, and requires all existing images to already match the requested encoding and square dimensions; zero-texture sources require no image conversion. bake=true remains unavailable. New embedded GLB exports apply the default JPEG encoding only after opaque texture validation, preserving native geometry, skin and animation structures; transparent or unsupported sources keep native encoding with a warning. Explicit JPEG without other local transforms uses the same verified texture-only path and fails for transparent/unsupported textures. Other supported texture encoding, bottom clipping and pivot options use local Blender 4.5+ on download; retries reuse the original export. OBJ/FBX support all texture encodings, GLB PNG/JPEG/WEBP, USDZ PNG. Each step retains its task and cost. Unmapped parameters are rejected. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        format: {
          type: 'string',
          enum: ['GLTF', 'USDZ', 'FBX', 'OBJ', 'STL', '3MF'],
        },
        face_limit: {
          type: 'integer',
          exclusiveMinimum: 0,
        },
        quad: {
          type: 'boolean',
        },
        force_symmetry: {
          type: 'boolean',
          description: 'only applies with quad=true',
        },
        texture_size: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: 'Native size cap 1–8192 pixels; smaller source textures are not upscaled.',
        },
        texture_format: {
          type: 'string',
          enum: ['BMP', 'DPX', 'HDR', 'JPEG', 'OPEN_EXR', 'PNG', 'TARGA', 'TIFF', 'WEBP'],
        },
        bake: {
          type: 'boolean',
          description:
            'Explicit false verifies either a restricted static native GLB or an explicitly selected animated GLTF/JPEG-2048 result from the pinned webpage engine. The native static route requires an existing owned source, default -y orientation, at most 100000 triangles and unchanged part/transform metadata; it freezes original image bytes, basic PBR and UV/color-to-oriented-surface associations before submission, then verifies the actual result without guaranteeing unchanged normals, tangents, skin or animation. The animated route accepts +x/-x/+y/-y and explicit pivot_to_center_bottom=true/false, preserves verified embedded skeletons/clips and existing JPEG-2048 textures, and applies saved PBR factors only in the webpage is_pbr branch. The current webpage panel selects -y although its engine implements all four axes. Geometry/display-name edits and import/remesh chains are excluded from the animated route. The explicit frontend static route requires with_animation=false, GLTF, a supported axis, a boolean pivot and explicit JPEG/PNG/WEBP plus size 1–8192. It validates saved static edits and existing textures at their actual encoding and exact dimensions; no skins/clips are removed and no image is re-encoded. true and general advanced material baking are unavailable.',
        },
        pack_uv: {
          type: 'boolean',
        },
        export_vertex_colors: {
          type: 'boolean',
          description: 'OBJ/GLTF only',
        },
        with_animation: {
          type: 'boolean',
          description:
            'Defaults to preserving a confirmed Studio source skeleton and existing motions without generating new animations. Explicit false requests a static result. Source animation selection and model identity are frozen for recovery; unknown source rig metadata is rejected. Static bake/part-edit combinations require explicit false when the source is rigged. An embedded GLB 65-bone walk sample passed import/export pose comparisons after coordinate normalization and a 1/24-second timeline offset; arbitrary files or rigs are not guaranteed.',
        },
        animate_in_place: {
          type: 'boolean',
        },
        pivot_to_center_bottom: {
          type: 'boolean',
        },
        scale_factor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        auto_size: {
          type: 'boolean',
          description: 'scale to real-world size',
        },
        flatten_bottom: {
          type: 'boolean',
          description: 'for 3D printing stability',
        },
        flatten_bottom_threshold: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'flattening depth used with flatten_bottom (default 0.01)',
        },
        part_names: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'convert only these named parts',
        },
        fbx_preset: {
          type: 'string',
          enum: ['blender', '3dsmax', 'mixamo', 'bake_scale'],
          description:
            'FBX only; blender (default) / 3dsmax / mixamo / bake_scale (bake the scale transform into the geometry)',
        },
        export_orientation: {
          type: 'string',
          enum: ['+x', '-x', '+y', '-y'],
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input', 'format'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_decimate',
    title: 'Decimate to low-poly',
    description:
      'Remesh through the Studio default engine, with face_limit, quad and bake controls. smart_uv executes remesh, UV generation and UV application as separate website tasks with separate pricing. Explicit engine versions other than the Studio default have no verified mapping. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        face_limit: {
          type: 'integer',
          exclusiveMinimum: 0,
        },
        quad: {
          type: 'boolean',
        },
        bake: {
          type: 'boolean',
          description: 'bake textures onto the low-poly (not v1.0)',
        },
        part_names: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'decimate only these named parts (not v1.0)',
        },
        model: {
          type: 'string',
          enum: ['v3.0', 'v2.0', 'v1.0'],
        },
        smart_uv: {
          type: 'boolean',
          description:
            'Studio mapping: run UV generation and application after remeshing; website pricing applies to each step',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_smart_uv',
    title: 'Smart UV unwrap',
    description:
      'Generate and apply a Studio UV candidate as two persistent tasks. Use studio uv-generate and uv-apply to inspect a candidate before applying it. bake=false explicitly permits texture removal; default/true rejects textured sources before submission. compress=geometry adds a native import for static untextured GLB surfaces with 1–64 independent root meshes, at most 64 primitives and 25000 triangles total. Multiple primitives are split through JSON metadata before import; each result verifies native Meshopt and unique per-face oriented geometry/UV/normal/material correspondence. Exact source grouping, coordinate frames and names are restored through JSON without changing native compressed BIN bytes; UV and normals may be quantized. Hierarchies, instances and ambiguous correspondence are rejected. The imported Studio project remains normalized: continue web editing from original_uv_task_id returned in uv_compression_validation. export_orientation adds a native export and cannot combine with compression. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        bake: {
          type: 'boolean',
          description:
            'Studio removes existing textures: false explicitly accepts geometry/UV output; default/true rejects textured sources before submission',
        },
        export_orientation: {
          type: 'string',
          enum: ['+x', '-x', '+y', '-y'],
        },
        compress: {
          type: 'string',
          enum: ['geometry'],
          description: 'meshopt geometry compression for a smaller file',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_segment',
    title: 'Segment mesh into parts',
    description:
      'Split a model into named parts. Native v1.0 is geometry-based; Studio v2.0 adds semantic granularity and text hints. With ref_image, explicit reference_projection and accept_variable_cost=true, a restricted static untextured GLB and an opaque PNG color mask use Studio 3D Lab. This explicit-projection extension assigns each original triangle by its world-centroid pixel, retains all oriented faces, normals and default material, and verifies exact mask groups. It does not infer a camera, select the official v2 engine or provide connectivity splitting. Lab uses variable web-account billing. Explicit model, granularity and connectivity controls have no combined mapping on this route. Model/mask inputs may be local files, HTTP(S) URLs or exact local task references; old API file_token is unsupported on the Lab route. Unknown preparation/submission writes are not repeated. Native segmentation and projected Lab partitioning have separate downstream-source requirements. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        max_estimated_credits: processingBudget,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        model: {
          type: 'string',
          enum: ['v1.0-20250506', 'v2.0-20260430'],
        },
        segmentation_granularity: {
          type: 'string',
          enum: ['simple', 'balanced', 'detailed'],
          description: 'v2.0 only (default balanced)',
        },
        split_by_connectivity: {
          type: 'boolean',
          description: 'v2.0 only: also split by connected components (default true)',
        },
        ref_image: {
          type: 'string',
          minLength: 1,
          description:
            'Reference partition image. The Studio Lab extension requires an opaque PNG with white background and 2–8 exact nonwhite RGB groups, plus explicit reference_projection and accept_variable_cost. Arbitrary semantic masks and inferred camera projection have no verified mapping.',
        },
        reference_projection: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'number' },
          },
          description:
            'Studio extension: two affine rows mapping source world [x,y,z,1] to mask pixel [u,v]. The directional rows must be nonzero, orthogonal and equal in scale. Every original triangle centroid must project to one nonwhite group; pixels use floor(value+0.5). No automatic camera inference.',
        },
        accept_variable_cost: {
          type: 'boolean',
          description:
            'Studio extension: with ref_image, explicitly select variable-cost 3D Lab for projected reference partitioning; this does not select the official v2 engine or cap Lab billing. Without ref_image, true accepts unknown charges for an implicit model import under a current reviewed snapshot. Omit for existing native task inputs without import; unquoted import consent cannot combine with max_estimated_credits.',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_mesh_complete',
    title: 'Complete segmented mesh',
    description:
      'Close/complete the cut surfaces of a segmentation result (input must be a successful ai_modeling_segment task_id). Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          minLength: 1,
          description: 'a successful ai_modeling_segment task',
        },
        completion_mode: {
          type: 'string',
          enum: ['ai_completion', 'quick_cap'],
        },
        part_names: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'complete only these parts (default all)',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_mesh_edit',
    title: 'Edit mesh region (P2)',
    description:
      'Regenerate or refine a model region. Without ref_image, Studio uses the P2 pipeline and compress=geometry verifies native P2 GLB Meshopt even when download is disabled. With ref_image and accept_variable_cost=true, a restricted static untextured GLB and its reference image use Studio 3D Lab. This reference route verifies preserved outside triangles, normals/materials, no new outside geometry and a changed inside region; semantic fidelity is an AI result. It uses variable web-account billing, not the fixed P2 engine or its price. Model/image inputs may be local files, HTTP(S) URLs or exact local task references. Reference editing requires one source node, mesh and primitive with POSITION/NORMAL and default material; explicit face_limit/model/compression, textures, skins and animations have no verified combined mapping. Preparation receipts and the Lab job persist; unknown writes are not repeated. bbox is an axis-aligned region in model coordinates. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        max_estimated_credits: processingBudget,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description: 'model task_id / file_token / model file URL',
        },
        bbox: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'number',
            },
            minItems: 3,
            maxItems: 3,
          },
          minItems: 2,
          maxItems: 2,
          description:
            '[[x1,y1,z1],[x2,y2,z2]] axis-aligned bounding box in model space, e.g. [[-0.5,-0.5,-0.5],[0.5,0.5,0.5]]',
        },
        face_limit: {
          type: 'integer',
          minimum: 100,
          description: 'max face count of the result (≥100; adaptive when omitted)',
        },
        ref_image: {
          type: 'string',
          minLength: 1,
          description:
            'Reference image file, HTTP(S) URL or exact local image-task reference for Studio Lab semantic guidance; requires accept_variable_cost=true.',
        },
        accept_variable_cost: {
          type: 'boolean',
          description:
            'Studio extension: with ref_image, explicitly select variable-cost 3D Lab for reference editing; this does not select the fixed P2 engine or cap Lab billing. Without ref_image, true accepts unknown charges for an implicit model import under a current reviewed snapshot. Omit for existing native task inputs without import; unquoted import consent cannot combine with max_estimated_credits.',
        },
        compress: {
          type: 'string',
          enum: ['geometry'],
          description: 'meshopt geometry compression for a smaller file',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input', 'bbox'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    experimental: true,
  },
  {
    name: 'ai_modeling_smart_segment',
    title: 'Smart segment (prompted)',
    description:
      'Segment a Studio model with coarse/medium/fine granularity and text hints through segmentation v2. Identity is accepted; exact +90 degree Z rotation of static GLB files/URLs keeps the guarded native import then segmentation route. Other verified positive TRS uses identity import (GLB file/URL) or exact-version copy (owned task/project), followed by native metadata and segmentation. Files/URLs require one centered unit-extent static triangle primitive with complete normals/UVs and basic opaque material. Owned task/project references additionally accept independent named roots with the same centered unit extent, complete normals/UVs and opaque scalar or embedded base-color materials; new owned references freeze the verified ordinary segmentation route explicitly after original-byte inspection, including a single entity whose Studio is_segmented flag remains true. Old requests retain their original frozen route. New generic v2 GLB segmentation follows the verified webpage Mesh-entity count after saved deletions: one entity uses ordinary segmentation and multiple entities use resegmentation. Explicit resegment keeps its own contract. All sources require no unapplied geometry edits. Original material metadata is frozen separately from the raw GLB material and preserved through the metadata step. Finite translations, proper orthogonal rotations and positive scales 0.01–100 use the three-step route. New single-axis shear and general positive-determinant affine requests use three native steps: import the unchanged original GLB with a source-derived proper rotation, write the frozen second TRS metadata, and ordinary segmentation. The import normalization and both factors are computed only from the original matrix and source coordinates before submission; each actual factor must satisfy the native positive-scale 0.01–100 and precision checks. This route accepts centered unit-extent static single-primitive GLB sources with complete normals/UVs and basic opaque appearance; an original display rename on the sole source node is mapped to the verified imported node, while stale rename keys for absent nodes are rejected before submission. Original Studio material metadata is preserved separately from raw GLB material values. Every native import must prove B1(P), source normals/UVs/embedded texture bytes and the projected original A(P) before continuing; final output separately proves every original A(P) face and every B2(actual import) face at the unchanged fixed 4e-5 bound, without accumulated tolerance or local vertex edits. Existing seven-step affine requests keep their original import/copy, metadata, segment, merge, copy, metadata and segment layout and receipts; no failed or unknown task switches routes. Each actual result is verified; this does not claim every matrix/source was tested against Studio. Reflection, projection, singular or out-of-range matrices and unresolvable coordinates remain rejected. Complete original source, metadata head and step inputs are frozen; get/list/download expose a verified result only after every native output face uniquely matches the requested transform. Each step retains its own receipt and possible cost. Native segmentation can recompute normals, repack UVs and re-encode per-part textures; multi-root ordinary segmentation can remove UVs and materials entirely. Verification covers transformed geometry, not appearance preservation. Ordinary source-head checks are local; the service provides no atomic compare-and-swap. Image files/URLs without a hint use H3.1 Generate Parts; explicit seg_type=image also accepts successful Studio image-task references or image asset IDs and uses their first output, rejecting model tasks as image sources. Image hints use separately billed H3.1 modeling then v2 segmentation at the selected coarse/medium/fine granularity. Hints and granularity do not guarantee exact part counts or a finer split on every model. Both return segmented GLB and a normalized segmentation-preview PNG without an original-image pixel-alignment guarantee. Semantic part-label text and official internal model/segment task IDs are not available. Image transforms are rejected. Backend: Tripo Studio web account and web credits; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        ...unquotedImportOptions,
        source_representation: {
          type: 'string',
          enum: ['studio_normalized'],
          description:
            'Studio extension: explicitly use the frozen Studio-normalized representation of a verified Lab mesh-edit or projected-segmentation task. Original Lab bytes and proof remain unchanged. The source binding reports centering/scaling, normal quantization and metadata differences; projected sources additionally require every original named face group to remain intact. New selections copy the exact historical operator and verify all copied GLB bytes before processing, with a separate possible cost and waiting required. Existing requests keep their original layout; original Lab coordinate or normal precision is not promised.',
        },
        input: {
          type: 'string',
          minLength: 1,
          description:
            'model/image file or URL; seg_type=image also accepts a successful Studio image task or image asset ID (first output)',
        },
        seg_type: {
          type: 'string',
          enum: ['model', 'image'],
          description:
            'image URLs with a recognized image extension use image; other inputs default to model',
        },
        granularity: {
          type: 'string',
          enum: ['coarse', 'medium', 'fine'],
        },
        hint: {
          type: 'string',
          description: 'which parts to find',
        },
        transform: {
          type: 'array',
          items: {
            type: 'number',
          },
          minItems: 16,
          maxItems: 16,
          description: 'seg_type=model only: 4×4 column-major transform for the model (default identity)',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      required: ['input'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
        },
        status: {
          type: 'string',
        },
        next: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        rig_type: {
          type: 'string',
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['task_id', 'status', 'next'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'ai_modeling_balance',
    title: 'Account balance',
    description:
      'Credit balance of the connected Tripo account, with a link to the informational plans page. Backend: Tripo Studio web account and web credits. Studio mappings and options without verified mappings are reported explicitly; no API-wallet fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        balance: {
          type: 'number',
        },
        frozen: {
          type: 'number',
        },
        plans_url: {
          type: 'string',
        },
      },
      required: ['balance', 'frozen', 'plans_url'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ai_modeling_usage',
    title: 'Credit usage',
    description:
      'Report Studio gross credit charges. With task_ids, resolve unique local jobs and retain missing IDs, per-task errors and unknown costs; no absent charge is treated as free. Without task_ids, read and verify paginated Studio transactions (up to 10000 records), group charge/sub records by remote operator ID and return at most limit entries (1–500). Refunds and credit additions are excluded. total_credits covers returned entries and is null when their costs or requested identities are unconfirmed; truncated and complete disclose partial coverage. task_id_namespace distinguishes local jobs from remote operators. Uses web-account billing only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 50,
          description:
            'return at most this many grouped ledger entries (default 50); task_ids selection ignores this limit',
        },
        task_ids: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
          },
          minItems: 1,
          maxItems: 100,
          description: 'only these tasks, e.g. all task_ids of the workflow just finished',
        },
        request_id: {
          type: 'string',
          description:
            'Studio extension: stable submission intent; reuse when reconciling an uncertain result.',
        },
      },
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    outputSchema: {
      type: 'object',
      properties: {
        total_entries: { type: 'integer', minimum: 0 },
        returned_entries: { type: 'integer', minimum: 0 },
        truncated: { type: 'boolean' },
        total_credits: {
          type: ['number', 'null'],
          description: 'Gross charges over returned entries; null when requested evidence is incomplete.',
        },
        usage: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string' },
              type: { type: 'string' },
              credits_consumed: { type: ['number', 'null'] },
              created_at: { type: ['string', 'null'] },
            },
            required: ['task_id', 'type', 'credits_consumed', 'created_at'],
            additionalProperties: false,
          },
        },
        missed: { type: 'array', items: { type: 'string' } },
        unknown: { type: 'array', items: { type: 'string' } },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string' },
              error: { type: 'object', additionalProperties: true },
            },
            required: ['task_id', 'error'],
            additionalProperties: false,
          },
        },
        complete: { type: 'boolean' },
        task_id_namespace: { type: 'string', enum: ['local_job', 'studio_operator'] },
      },
      required: [
        'total_entries',
        'returned_entries',
        'truncated',
        'total_credits',
        'usage',
        'missed',
        'unknown',
        'errors',
        'complete',
        'task_id_namespace',
      ],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ai_modeling_download',
    description:
      'Save successful task files into a caller-selected directory and return their absolute paths. Uses fresh Studio download links without exposing signed URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          minLength: 1,
        },
        output_dir: {
          type: 'string',
        },
      },
      required: ['task_id'],
    },
  },
];
