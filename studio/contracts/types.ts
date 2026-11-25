/** 核心领域对象不依赖 MCP 或网页返回形状；凭证及签名 URL 不进入任务记录。 */
export type Operation =
  | 'export_lite'
  | 'refine_submit'
  | 'canvas_turn'
  | 'canvas_continue'
  | 'canvas_lab'
  | 'canvas_node_stop'
  | 'canvas_node_retry'
  | 'canvas_run'
  | 'image'
  | 'model'
  | 'texture'
  | 'rig'
  | 'animate'
  | 'export'
  | 'export_batch'
  | 'remesh'
  | 'segment'
  | 'resegment'
  | 'project_edit'
  | 'complete'
  | 'local_edit'
  | 'import_model'
  | 'uv_generate'
  | 'uv_commit'
  | 'retexture'
  | 'retexture_apply'
  | 'motion'
  | 'copy'
  | 'image_process'
  | 'modification'
  | 'retry';
export type JobState =
  | 'prepared'
  | 'submitting'
  | 'submitted'
  | 'running'
  | 'waiting_input'
  | 'succeeded'
  | 'failed'
  | 'requires_login'
  | 'outcome_unknown';
export interface Quote {
  variable?: boolean;
  known: boolean;
  credits?: number;
  source: string;
  observed_at: string;
  expires_at: string;
  explanation: string;
  hard_limit: false;
}
export interface RemoteIds {
  refinement?: { payment_required: boolean; request_received: true; delivery_pending: true };
  models?: ModelReceipt[];
  batch?: { project_id: string; operator_id?: string; code: number }[];
  task_id?: string;
  /** Stop receipts may identify the original run rather than a new control turn. */
  node_execution_receipt?: 'accepted_run' | 'turn';
  asset_id?: string;
  project_id?: string;
  operator_id?: string;
}
/** 多结果身份按回执顺序保存；不把上游未提供的来源映射推断为输入图片次序。 */
export interface ModelReceipt {
  project_id?: string;
  operator_id?: string;
  accepted: boolean | null;
  face_limit?: number;
  code?: number;
}
export interface ObservedCost {
  credits: number;
  source: 'studio_transaction' | 'studio_lab';
  status: string;
  observed_at: string;
}
/** 前端产物只复用已登记的发布位置；内容相同不代表另一现存文件获得发布授权。 */
export interface FrontendDeliveryLocation {
  identity: string;
  path: string;
  sha256: string;
  bytes: number;
  device: string;
  inode: string;
  parent_device: string;
  parent_inode: string;
}
export interface Artifact {
  artifact_id: string;
  kind: 'image' | 'model' | 'animation';
  format: string;
  index: number;
  local_path?: string;
  sha256?: string;
  bytes?: number;
  processing?: string;
  source_sha256?: string;
  canvas_result?: CanvasResultBinding;
  frontend_deliveries?: FrontendDeliveryLocation[];
  image_background?: {
    identity: string;
    background: 'opaque';
    width: number;
    height: number;
    nonopaque_pixels: number;
    source_format: 'png' | 'jpeg' | 'webp';
    source_sha256: string;
    source_bytes: number;
    source_cache_path: string;
    checked_at: string;
  };
  image_size?: {
    identity: string;
    expected_width: number;
    expected_height: number;
    width: number;
    height: number;
    source_format: 'png' | 'jpeg' | 'webp';
    source_sha256: string;
    source_bytes: number;
    source_cache_path: string;
    checked_at: string;
  };
  image_output?: {
    target_format: 'png' | 'jpeg';
    source_format: 'png' | 'jpeg' | 'webp';
    source_sha256: string;
    source_cache_path: string;
    source_bytes: number;
    cache_path: string;
    sha256: string;
    bytes: number;
    identity: string;
    width: number;
    height: number;
    processing: string;
  };
  native_validation?: {
    geometry_compression: 'meshopt';
    identity: string;
    sha256: string;
    bytes: number;
    checked_at: string;
    compressed_buffer_views: number;
    geometry_accessors: number;
  };
}
/** Canvas 分割封口属于同次运行的第二个操作；完整身份只在首次唯一取证后冻结。 */
export interface CanvasResultBinding {
  version: 1;
  stage: 'segmentation_quick_cap';
  job_id: string;
  account_ref: string;
  input_hash: string;
  canvas_id: string;
  run_id: string;
  node_id: string;
  step_id: string;
  task_id: string;
  asset_id: string;
  project_id: string;
  segment_operator_id: string;
  final_operator_id: string;
}
export interface Job {
  job_id: string;
  account_ref: string;
  request_id: string;
  input_hash: string;
  operation: Operation;
  input: Record<string, unknown>;
  contract_version: string;
  state: JobState;
  remote_ids: RemoteIds;
  quote: Quote;
  progress: number;
  error?: Record<string, unknown>;
  artifacts: Artifact[];
  observed_cost?: ObservedCost;
  created_at: string;
  updated_at: string;
  lease_until: number;
}
export interface RemoteStatus {
  remote_ids?: RemoteIds;
  state: 'submitted' | 'running' | 'waiting_input' | 'requires_login' | 'succeeded' | 'failed';
  progress: number;
  artifacts: Artifact[];
  error?: Record<string, unknown>;
}
