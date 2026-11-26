import { marchingTetrahedra } from './marching-tet.js';
import { sampleField, solveCG, splatNormals, upsample } from './poisson-solver.js';

/**
 * 简化版泊松曲面重建（Poisson Surface Reconstruction）。
 *
 * 流程：
 * 1. 定向点云的法向按三线性权重散布到规则网格，得到向量场 V；
 * 2. 求散度 f = ∇·V；
 * 3. 求解泊松方程 ∇²χ = f（共轭梯度，由粗到细逐级作为初值）；
 * 4. 以原始点处 χ 的均值作为等值面，用行进四面体提取三角网格。
 *
 * 注意：教学用简化实现，没有 screened Poisson、八叉树自适应与多重网格加速，
 * 稀疏点云或高分辨率下的质量与速度都弱于 Open3D / CGAL 等成熟实现。
 *
 * @param {Float32Array} positions 点坐标
 * @param {Float32Array} normals 单位法向，需外向一致
 * @param {{resolution?: number}} options resolution: 体素网格分辨率
 * @returns {{positions: Float32Array, indices: Uint32Array, triangles: number, iso: number, resolution: number}}
 */
export function poissonReconstruct(positions, normals, { resolution = 48 } = {}) {
  const n = positions.length / 3;
  if (n < 16) throw new Error('点数过少，无法重建');

  // ---- 包围盒 + 余量，保证等值面位于网格内部 ----
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const pad = extent * 0.12; // 边界留白，避免曲面贴到 χ=0 的边界
  const origin = [minX - pad, minY - pad, minZ - pad];
  const size = extent + pad * 2;

  // ---- 由粗到细求解：粗网格解插值后作为细网格初值，加速收敛 ----
  const levels = resolution <= 24 ? [resolution] : [16, Math.round(resolution / 2), resolution];
  let field = null;
  let prevR = 0;

  for (const R of levels) {
    const { divergence } = splatNormals(positions, normals, n, origin, size, R);
    const initial = prevR ? upsample(field, prevR, R) : null;
    // 迭代次数随分辨率增加，兼顾精度与耗时
    const maxIter = Math.min(300, Math.round(R * 2.5));
    field = solveCG(divergence, R, size / R, initial, maxIter);
    prevR = R;
  }

  // ---- 等值面：取原始点处 χ 的均值 ----
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += sampleField(
      field,
      resolution,
      origin,
      size,
      positions[i * 3],
      positions[i * 3 + 1],
      positions[i * 3 + 2],
    );
  }
  const iso = sum / n;

  // 行进四面体输出已索引化且统一朝外，可直接沿用其顶点与索引
  const mesh = marchingTetrahedra(field, resolution, origin, size, iso);
  return { positions: mesh.positions, indices: mesh.indices, triangles: mesh.triangles, iso, resolution };
}
