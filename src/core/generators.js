/**
 * 程序化点云生成工具，用于在没有外部数据时快速验证渲染效果。
 */

/** 起伏球面点云：闭合曲面，适合演示曲面重建 */
export function generateBlob(count = 30000, radius = 1) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = 2 * Math.PI * Math.random();
    const phi = Math.acos(2 * Math.random() - 1);
    const sx = Math.sin(phi) * Math.cos(theta);
    const sy = Math.cos(phi);
    const sz = Math.sin(phi) * Math.sin(theta);

    // 半径随方向起伏，保持星形闭合
    const r =
      radius *
      (1 +
        0.22 * Math.sin(3 * theta) * Math.sin(2 * phi) +
        0.12 * Math.cos(5 * phi));

    positions[i * 3] = r * sx;
    positions[i * 3 + 1] = r * sy;
    positions[i * 3 + 2] = r * sz;
  }
  return positions;
}
