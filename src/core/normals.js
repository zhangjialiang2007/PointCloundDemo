/**
 * 基于 PCA（主成分分析）的邻域法向估计。
 *
 * 思路：对每个点取其 k 近邻，计算邻域协方差矩阵，做特征分解，
 * 最小特征值对应的特征向量即该点法向；曲率 = λ0 / (λ0 + λ1 + λ2)。
 */

/**
 * 对称 3x3 矩阵特征分解（Jacobi 迭代）。
 * @param {number[]} m 行主序的 9 个元素
 * @returns {{values: number[], vectors: number[]}} 特征值升序，vectors 的列是特征向量
 */
export function symmetricEigen(m) {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pairs = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];

  for (let sweep = 0; sweep < 8; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-12) break;

    for (const [p, q] of pairs) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-15) continue;

      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t =
        (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;

      // A ← JᵀAJ：先左乘后右乘
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p];
        const akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k];
        const aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      // 累积特征向量
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }

  // 升序排序
  const idx = [0, 1, 2].sort((i, j) => a[i * 3 + i] - a[j * 3 + j]);
  const values = idx.map((i) => a[i * 3 + i]);
  const vectors = [];
  for (const i of idx) {
    vectors.push(v[i], v[3 + i], v[6 + i]);
  }
  return { values, vectors };
}

/** 均匀网格空间索引，用于快速取邻域 */
function buildGrid(positions, n, cell) {
  const map = new Map();
  const idx = new Float32Array(n * 3); // 每个点的坐标索引，避免重复取整

  for (let i = 0; i < n; i++) {
    const ix = Math.floor(positions[i * 3] / cell);
    const iy = Math.floor(positions[i * 3 + 1] / cell);
    const iz = Math.floor(positions[i * 3 + 2] / cell);
    idx[i * 3] = ix;
    idx[i * 3 + 1] = iy;
    idx[i * 3 + 2] = iz;

    const key = `${ix},${iy},${iz}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(i);
    else map.set(key, [i]);
  }
  return { map, idx };
}

/**
 * 估计法向。
 * @param {Float32Array} positions 顶点坐标
 * @param {object} options k: 邻域点数；maxRing: 网格向外扩展的最大环数
 * @returns {{normals: Float32Array, curvatures: Float32Array, k: number}}
 */
export function estimateNormals(positions, { k = 16, maxRing = 4 } = {}) {
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  const curvatures = new Float32Array(n);
  const result = { normals, curvatures, k };

  if (n === 0) return result;

  // 依据包围盒与点数估算平均点间距，作为网格边长
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
  const cell = Math.max((extent / Math.cbrt(n)) * 1.6, 1e-6);

  const { map, idx } = buildGrid(positions, n, cell);

  // 复用缓冲区，减少 GC 压力
  const cov = new Float64Array(9);
  const nearest = new Int32Array(k);
  const nearestDist = new Float64Array(k);
  const target = Math.max(k * 2, 16); // 候选点足够多即可停止扩展，避免大范围扫描

  for (let i = 0; i < n; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const ix = idx[i * 3];
    const iy = idx[i * 3 + 1];
    const iz = idx[i * 3 + 2];

    // ---- 1. 从中心向外逐环收集候选点 ----
    let filled = 0; // nearest 中有效数量
    let found = 0; // 候选点总数（用于决定是否继续扩展）
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dz = -ring; dz <= ring; dz++) {
            // 只处理外壳层，避免重复遍历内部体素
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const bucket = map.get(`${ix + dx},${iy + dy},${iz + dz}`);
            if (!bucket) continue;

            for (let b = 0; b < bucket.length; b++) {
              const j = bucket[b];
              if (j === i) continue;

              const ddx = positions[j * 3] - px;
              const ddy = positions[j * 3 + 1] - py;
              const ddz = positions[j * 3 + 2] - pz;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              found++;

              // 插入式维护 k 近邻
              if (filled < k) {
                let pos = filled;
                while (pos > 0 && nearestDist[pos - 1] > d2) {
                  nearestDist[pos] = nearestDist[pos - 1];
                  nearest[pos] = nearest[pos - 1];
                  pos--;
                }
                nearestDist[pos] = d2;
                nearest[pos] = j;
                filled++;
              } else if (d2 < nearestDist[k - 1]) {
                let pos = k - 1;
                while (pos > 0 && nearestDist[pos - 1] > d2) {
                  nearestDist[pos] = nearestDist[pos - 1];
                  nearest[pos] = nearest[pos - 1];
                  pos--;
                }
                nearestDist[pos] = d2;
                nearest[pos] = j;
              }
            }
          }
        }
      }
      // 候选足够则提前结束
      if (found >= target && filled >= k) break;
    }

    const count = filled; // 实际使用的近邻数（不含自身）
    if (count < 3) {
      // 邻域不足，退化为朝上法向
      normals[i * 3 + 1] = 1;
      continue;
    }

    // ---- 2. 邻域质心 ----
    let cx = px;
    let cy = py;
    let cz = pz;
    for (let m = 0; m < count; m++) {
      const j = nearest[m];
      cx += positions[j * 3];
      cy += positions[j * 3 + 1];
      cz += positions[j * 3 + 2];
    }
    const inv = 1 / (count + 1);
    cx *= inv;
    cy *= inv;
    cz *= inv;

    // ---- 3. 协方差矩阵（对称，只需 6 个元素） ----
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let m = -1; m < count; m++) {
      const j = m < 0 ? i : nearest[m];
      const dx = positions[j * 3] - cx;
      const dy = positions[j * 3 + 1] - cy;
      const dz = positions[j * 3 + 2] - cz;
      xx += dx * dx;
      xy += dx * dy;
      xz += dx * dz;
      yy += dy * dy;
      yz += dy * dz;
      zz += dz * dz;
    }
    xx *= inv;
    xy *= inv;
    xz *= inv;
    yy *= inv;
    yz *= inv;
    zz *= inv;

    cov[0] = xx; cov[1] = xy; cov[2] = xz;
    cov[3] = xy; cov[4] = yy; cov[5] = yz;
    cov[6] = xz; cov[7] = yz; cov[8] = zz;

    // ---- 4. 特征分解，最小特征向量的方向即法向 ----
    const { values, vectors } = symmetricEigen(cov);
    let nx = vectors[0];
    let ny = vectors[1];
    let nz = vectors[2];

    // 统一朝向：与 +Y 同向，便于观察
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    normals[i * 3] = nx;
    normals[i * 3 + 1] = ny;
    normals[i * 3 + 2] = nz;

    const sum = values[0] + values[1] + values[2];
    curvatures[i] = sum > 0 ? values[0] / sum : 0;
  }

  return result;
}
