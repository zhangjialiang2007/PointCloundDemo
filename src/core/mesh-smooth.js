/**
 * 拉普拉斯网格平滑，支持特征约束：
 * - 均匀权重：新位置 = 顶点 + λ × (邻域平均 - 顶点)
 * - 特征点（相邻面片法向夹角大）与边界点默认冻结，避免棱角被磨圆
 * - 可选"切向平滑"：特征点只允许沿切平面移动，保持棱线形状
 */
import { buildVertexNeighbors, computeFaceNormals, computeVertexNormals, edgeKey } from './mesh.js';

/**
 * 标记特征点（折痕）与边界点。
 * @returns {{features: Uint8Array, boundary: Uint8Array}}
 */
export function detectFeatures({ positions, indices }, { featureAngle = 45 } = {}) {
  const V = positions.length / 3;
  const faceNormals = computeFaceNormals(positions, indices);
  const vertexNormals = computeVertexNormals(positions, indices);

  const features = new Uint8Array(V);
  const cosLimit = Math.cos((featureAngle * Math.PI) / 180);

  for (let f = 0; f < indices.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[f * 3 + k] * 3;
      const dot =
        faceNormals[f * 3] * vertexNormals[v] +
        faceNormals[f * 3 + 1] * vertexNormals[v + 1] +
        faceNormals[f * 3 + 2] * vertexNormals[v + 2];
      if (dot < cosLimit) features[indices[f * 3 + k]] = 1;
    }
  }

  // 边界点：只有 1 个关联面的边
  const boundary = new Uint8Array(V);
  const counts = new Map();
  for (let f = 0; f < indices.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const x = indices[f * 3 + k];
      const y = indices[f * 3 + ((k + 1) % 3)];
      const key = edgeKey(x, y);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of counts) {
    if (count !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    boundary[a] = 1;
    boundary[b] = 1;
  }

  return { features, boundary };
}

/**
 * 拉普拉斯平滑。
 * @param {{positions: Float32Array, indices: Uint32Array}} mesh
 * @param {object} options iterations / lambda / featureAngle /
 *   preserveFeatures（是否约束特征点）/ tangential（特征点只做切向移动）/ taubin（交替 λ-μ 抑制收缩）
 * @returns {{positions: Float32Array, featureCount: number, boundaryCount: number}}
 */
export function laplacianSmooth(
  { positions, indices },
  {
    iterations = 5,
    lambda = 0.5,
    featureAngle = 45,
    preserveFeatures = true,
    tangential = true,
    taubin = false,
  } = {},
) {
  const V = positions.length / 3;
  const neighbors = buildVertexNeighbors(indices, V);
  const { features, boundary } = detectFeatures({ positions, indices }, { featureAngle });
  const normals = computeVertexNormals(positions, indices);

  let current = Float32Array.from(positions);

  /** 单次平滑步：amount 可正（收缩）可负（Taubin 回弹） */
  const step = (amount) => {
    const next = Float32Array.from(current);
    for (let i = 0; i < V; i++) {
      const nb = neighbors[i];
      if (nb.size === 0) continue;
      if (boundary[i]) continue; // 边界固定，避免裂缝
      if (features[i] && preserveFeatures && !tangential) continue; // 特征点完全冻结

      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const j of nb) {
        sx += current[j * 3];
        sy += current[j * 3 + 1];
        sz += current[j * 3 + 2];
      }
      const inv = 1 / nb.size;
      let dx = (sx * inv - current[i * 3]) * amount;
      let dy = (sy * inv - current[i * 3 + 1]) * amount;
      let dz = (sz * inv - current[i * 3 + 2]) * amount;

      if (features[i] && preserveFeatures) {
        // 去掉法向分量：只沿棱线方向移动，棱角不会被磨平
        const nx = normals[i * 3];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];
        const d = dx * nx + dy * ny + dz * nz;
        dx -= d * nx;
        dy -= d * ny;
        dz -= d * nz;
      }

      next[i * 3] = current[i * 3] + dx;
      next[i * 3 + 1] = current[i * 3 + 1] + dy;
      next[i * 3 + 2] = current[i * 3 + 2] + dz;
    }
    current = next;
  };

  // Taubin：λ 步后接负系数 μ 步，抵消整体收缩
  const mu = -lambda / (1 - 0.1 * lambda);

  for (let iter = 0; iter < iterations; iter++) {
    step(lambda);
    if (taubin) step(mu);
  }

  let featureCount = 0;
  let boundaryCount = 0;
  for (let i = 0; i < V; i++) {
    if (features[i]) featureCount++;
    if (boundary[i]) boundaryCount++;
  }

  return { positions: current, featureCount, boundaryCount };
}
