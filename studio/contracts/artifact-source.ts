/** 下载来源只在进程内传递 URL；公开回执只带素材身份和已验证的文件信息。 */
export interface ArtifactContentHint {
  kind?: 'video' | 'file';
  byte_size?: number;
}
export interface ExistingArtifactSource {
  url: string;
  format: string;
  source_id: string;
  operator_id?: string;
  project_id?: string;
  canvas_id?: string;
  template_id?: string;
  node_id?: string;
  job_id?: string;
  representation?: 'input_preview';
  input_metadata_scope?: 'current_project' | 'not_in_current_project';
  content_hint?: ArtifactContentHint;
}
