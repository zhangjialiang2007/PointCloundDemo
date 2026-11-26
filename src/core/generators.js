import * as THREE from 'three';

/**
 * 程序化点云生成工具，用于在没有外部数据时快速验证渲染效果。
 */

/** 球面点云（近似均匀分布） */
export function generateSphere(count = 50000, radius = 1) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = 2 * Math.PI * Math.random();
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.98 + Math.random() * 0.02);

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  return positions;
}

/** 起伏地形点云：多层正弦叠加模拟地表 */
export function generateTerrain(count = 80000, size = 4) {
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * size;
    const z = (Math.random() - 0.5) * size;
    const y =
      Math.sin(x * 1.6) * Math.cos(z * 1.4) * 0.22 +
      Math.sin(x * 4.1 + z * 2.7) * 0.06 +
      Math.cos(z * 5.3) * 0.03;

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  return positions;
}

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

/**
 * 按高度着色：由低到高取 蓝 → 青 → 绿 → 黄 → 红。
 * @param {Float32Array} positions 顶点坐标
 * @returns {Float32Array} 顶点颜色（0~1）
 */
export function colorByHeight(positions) {
  const count = positions.length / 3;
  const colors = new Float32Array(count * 3);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const y = positions[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = maxY - minY || 1;

  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // t=0 → hue 0.6（蓝），t=1 → hue 0（红）
    const t = (positions[i * 3 + 1] - minY) / span;
    color.setHSL(0.6 * (1 - t), 0.85, 0.55);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  return colors;
}
