/** Lab 下载产物与 Canvas 节点资产是两种身份；下游显式采用网页规范化模型时两者都必须保留。 */
export interface LabModelSourceTarget {
  lab_job_id: string;
  node_id: string;
  artifact_id: string;
  node_asset_id: string;
  project_id: string;
  operator_id: string;
  /** 仅保存去掉临时授权后的完整资源身份哈希，不持久化签名 URL。 */
  resource_identity: string;
  metadata: Record<string, unknown>;
  is_pbr: boolean;
}

/** 签名链接只在进程内部传给下载器，不能作为 CLI/MCP 返回值。 */
export interface LabModelSourceResolution {
  target: LabModelSourceTarget;
  url: string;
}
