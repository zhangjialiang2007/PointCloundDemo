/**
 * 泊松方程的网格离散与共轭梯度求解（矩阵自由形式）。
 * 网格索引约定：i = x + dim * (y + dim * z)，dim = R + 1。
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * 将法向散布到网格得到向量场 V，再求散度 ∇·V。
 * @returns {{divergence: Float32Array}} 边界层散度为 0
 */
export function splatNormals(positions, normals, n, origin, size, R) {
  const dim = R + 1;
  const h = size / R;
  const v = new Float32Array(dim * dim * dim * 3);

  for (let i = 0; i < n; i++) {
    const gx = (positions[i * 3] - origin[0]) / h;
    const gy = (positions[i * 3 + 1] - origin[1]) / h;
    const gz = (positions[i * 3 + 2] - origin[2]) / h;

    const x0 = clamp(Math.floor(gx), 0, R - 1);
    const y0 = clamp(Math.floor(gy), 0, R - 1);
    const z0 = clamp(Math.floor(gz), 0, R - 1);
    const tx = clamp(gx - x0, 0, 1);
    const ty = clamp(gy - y0, 0, 1);
    const tz = clamp(gz - z0, 0, 1);

    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];

    // 三线性权重散布到 8 个相邻格点
    for (let dz = 0; dz < 2; dz++) {
      const wz = dz ? tz : 1 - tz;
      for (let dy = 0; dy < 2; dy++) {
        const wy = dy ? ty : 1 - ty;
        for (let dx = 0; dx < 2; dx++) {
          const wx = dx ? tx : 1 - tx;
          const w = wx * wy * wz;
          if (w === 0) continue;
          const idx = x0 + dx + dim * (y0 + dy + dim * (z0 + dz));
          v[idx * 3] += w * nx;
          v[idx * 3 + 1] += w * ny;
          v[idx * 3 + 2] += w * nz;
        }
      }
    }
  }

  // 中心差分求散度，边界层置 0（与 Dirichlet 边界配合）
  const divergence = new Float32Array(dim * dim * dim);
  const inv2h = 1 / (2 * h);
  for (let z = 1; z < R; z++) {
    for (let y = 1; y < R; y++) {
      for (let x = 1; x < R; x++) {
        const idx = x + dim * (y + dim * z);
        const fx = (v[(idx + 1) * 3] - v[(idx - 1) * 3]) * inv2h;
        const fy = (v[(idx + dim) * 3 + 1] - v[(idx - dim) * 3 + 1]) * inv2h;
        const fz = (v[(idx + dim * dim) * 3 + 2] - v[(idx - dim * dim) * 3 + 2]) * inv2h;
        divergence[idx] = fx + fy + fz;
      }
    }
  }

  return { divergence };
}

/**
 * 共轭梯度求解 ∇²χ = b。
 * 内部节点用 7 点拉普拉斯，边界节点强约束 χ = 0。
 * @param {Float32Array} b 右端项（散度）
 * @param {number} R 分辨率
 * @param {number} h 网格边长
 * @param {Float32Array|null} initial 上一级网格解，作为初值
 * @param {number} maxIter 最大迭代次数
 * @returns {Float32Array} 标量场 χ
 */
export function solveCG(b, R, h, initial, maxIter = 200) {
  const dim = R + 1;
  const N = dim * dim * dim;
  const invH2 = 1 / (h * h);

  const x = new Float64Array(N);
  if (initial) x.set(initial);

  const r = new Float64Array(N);
  const p = new Float64Array(N);
  const ap = new Float64Array(N);

  // r = b - A x
  applyLaplacian(x, ap, R, invH2);
  let bNorm = 0;
  for (let i = 0; i < N; i++) {
    r[i] = b[i] - ap[i];
    p[i] = r[i];
    bNorm += b[i] * b[i];
  }
  bNorm = Math.sqrt(bNorm) || 1;

  let rsOld = 0;
  for (let i = 0; i < N; i++) rsOld += r[i] * r[i];

  for (let iter = 0; iter < maxIter; iter++) {
    applyLaplacian(p, ap, R, invH2);

    let pAp = 0;
    for (let i = 0; i < N; i++) pAp += p[i] * ap[i];
    if (Math.abs(pAp) < 1e-30) break;

    const alpha = rsOld / pAp;
    let rsNew = 0;
    for (let i = 0; i < N; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
      rsNew += r[i] * r[i];
    }

    if (Math.sqrt(rsNew) / bNorm < 1e-3) break;

    const beta = rsNew / rsOld;
    for (let i = 0; i < N; i++) p[i] = r[i] + beta * p[i];
    rsOld = rsNew;
  }

  return Float32Array.from(x);
}

/** 7 点拉普拉斯算子；边界节点取恒等（对应 χ = 0） */
function applyLaplacian(src, dst, R, invH2) {
  const dim = R + 1;
  for (let z = 0; z <= R; z++) {
    for (let y = 0; y <= R; y++) {
      for (let x = 0; x <= R; x++) {
        const idx = x + dim * (y + dim * z);

        if (x === 0 || y === 0 || z === 0 || x === R || y === R || z === R) {
          dst[idx] = src[idx];
          continue;
        }

        const sum =
          src[idx + 1] + src[idx - 1] +
          src[idx + dim] + src[idx - dim] +
          src[idx + dim * dim] + src[idx - dim * dim];

        dst[idx] = (sum - 6 * src[idx]) * invH2;
      }
    }
  }
}

/** 三线性上采样：由粗网格场插值到细网格，作为 CG 初值 */
export function upsample(src, coarseR, fineR) {
  const dimC = coarseR + 1;
  const dimF = fineR + 1;
  const out = new Float32Array(dimF * dimF * dimF);
  const scale = coarseR / fineR;

  for (let z = 0; z < dimF; z++) {
    const cz = z * scale;
    const z0 = Math.min(Math.floor(cz), coarseR - 1);
    const tz = cz - z0;

    for (let y = 0; y < dimF; y++) {
      const cy = y * scale;
      const y0 = Math.min(Math.floor(cy), coarseR - 1);
      const ty = cy - y0;

      for (let x = 0; x < dimF; x++) {
        const cx = x * scale;
        const x0 = Math.min(Math.floor(cx), coarseR - 1);
        const tx = cx - x0;

        // 8 个粗网格点加权
        let value = 0;
        for (let dz = 0; dz < 2; dz++) {
          const wz = dz ? tz : 1 - tz;
          for (let dy = 0; dy < 2; dy++) {
            const wy = dy ? ty : 1 - ty;
            for (let dx = 0; dx < 2; dx++) {
              const wx = dx ? tx : 1 - tx;
              value += wx * wy * wz * src[x0 + dx + dimC * (y0 + dy + dimC * (z0 + dz))];
            }
          }
        }
        out[x + dimF * (y + dimF * z)] = value;
      }
    }
  }

  return out;
}

/** 在任意位置三线性采样标量场 */
export function sampleField(field, R, origin, size, px, py, pz) {
  const dim = R + 1;
  const h = size / R;
  const gx = clamp((px - origin[0]) / h, 0, R);
  const gy = clamp((py - origin[1]) / h, 0, R);
  const gz = clamp((pz - origin[2]) / h, 0, R);

  const x0 = Math.min(Math.floor(gx), R - 1);
  const y0 = Math.min(Math.floor(gy), R - 1);
  const z0 = Math.min(Math.floor(gz), R - 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const tz = gz - z0;

  let value = 0;
  for (let dz = 0; dz < 2; dz++) {
    const wz = dz ? tz : 1 - tz;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy ? ty : 1 - ty;
      for (let dx = 0; dx < 2; dx++) {
        const wx = dx ? tx : 1 - tx;
        value += wx * wy * wz * field[x0 + dx + dim * (y0 + dy + dim * (z0 + dz))];
      }
    }
  }
  return value;
}
