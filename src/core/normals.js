/**
 * 点云法向估计：共享的邻域检索 + 多种法向提取算法。
 *
 * method 可选值：
 *  - 'pca'      经典邻域 PCA：邻域协方差最小特征值对应的特征向量
 *  - 'ransac'   随机采样 3 点拟合平面，取内点最多的平面，再用内点集做 PCA
 *  - 'mcd'      ROBPCA / MCD：稳健协方差，用 C-step 迭代剔除外点
 *  - 'hough'    Hough 变换：邻域点对的候选法向在高斯球累加器上投票
 *  - 'adaptive' 邻域自适应：按平面残差自动挑选邻域点数
 *  - 'shift'    漂移邻域（Shift Neighbor）：把邻域中心迭代平移到局部平面上
 *
 * 所有方法统一把法向翻转到 +Y 半球；曲率统一取全邻域 PCA 的 λ0/(λ0+λ1+λ2)。
 */

/** 供示例面板使用的算法清单 */
export const NORMAL_METHODS = [
  { id: 'pca', label: 'PCA 经典邻域' },
  { id: 'ransac', label: 'RANSAC' },
  { id: 'mcd', label: 'ROBPCA / MCD' },
  { id: 'hough', label: 'Hough 变换' },
  { id: 'adaptive', label: '邻域自适应' },
  { id: 'shift', label: '漂移邻域 Shift' },
];

const ADAPTIVE_MIN_K = 6; // 自适应邻域最小点数
const ADAPTIVE_MAX_K = 32; // 自适应邻域最大点数
const ADAPTIVE_STEP = 2; // 自适应邻域的搜索步长
const ADAPTIVE_COS = 0.99985; // 法向稳定阈值：相邻两档邻域法向夹角 < 1° 即认为收敛

const RANSAC_ITERS = 24; // RANSAC 采样次数
const RANSAC_THRESH = 0.2; // 内点距离阈值（相对邻域平均点间距）

const MCD_ITERS = 3; // MCD 的 C-step 迭代次数
const MCD_RATIO = 0.7; // MCD 子集占邻域的比例

const SHIFT_ITERS = 3; // 漂移邻域最大迭代次数
const SHIFT_EPS = 1e-3; // 漂移收敛阈值（相对邻域平均点间距）

const HOUGH_AZ_BINS = 48; // Hough 累加器方位角分箱数
const HOUGH_EL_BINS = 24; // Hough 累加器高度角分箱数
const HOUGH_PAIRS = 48; // 每个点参与投票的邻域采样次数上限

// 特征分解内部缓冲（非重入：一次分解完成后再继续使用）
const EIG_A = new Float64Array(9);
const EIG_V = new Float64Array(9);

/**
 * 对称 3x3 矩阵特征分解（Jacobi 迭代），结果写入调用方缓冲，避免每次分配。
 * @param {Float64Array|number[]} m 行主序的 9 个元素
 * @param {Float64Array} values 输出，长度 3，特征值升序
 * @param {Float64Array} vectors 输出，长度 9，按列存放对应特征向量
 */
export function eigenInto(m, values, vectors) {
  const a = EIG_A;
  const v = EIG_V;
  a.set(m);
  v.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const pairs = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];

  for (let sweep = 0; sweep < 8; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-12) break;

    for (let s = 0; s < pairs.length; s++) {
      const p = pairs[s][0];
      const q = pairs[s][1];
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-15) continue;

      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t =
        (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const sn = t * c;

      // A ← JᵀAJ：先左乘后右乘
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p];
        const akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - sn * akq;
        a[k * 3 + q] = sn * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k];
        const aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - sn * aqk;
        a[q * 3 + k] = sn * apk + c * aqk;
      }
      // 累积特征向量
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - sn * vkq;
        v[k * 3 + q] = sn * vkp + c * vkq;
      }
    }
  }

  // 升序排序后按列输出
  const idx = [0, 1, 2].sort((i, j) => a[i * 3 + i] - a[j * 3 + j]);
  for (let c = 0; c < 3; c++) {
    const i = idx[c];
    values[c] = a[i * 3 + i];
    vectors[c * 3] = v[i];
    vectors[c * 3 + 1] = v[3 + i];
    vectors[c * 3 + 2] = v[6 + i];
  }
}

/**
 * 对称 3x3 矩阵特征分解（保持旧接口）。
 * @param {number[]} m 行主序的 9 个元素
 * @returns {{values: number[], vectors: number[]}} 特征值升序，vectors 的列是特征向量
 */
export function symmetricEigen(m) {
  const values = new Float64Array(3);
  const vectors = new Float64Array(9);
  eigenInto(m, values, vectors);
  return { values: Array.from(values), vectors: Array.from(vectors) };
}

/** 线性同余伪随机数：让 RANSAC / Hough 的采样结果可复现 */
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 均匀网格空间索引，用于快速取邻域 */
function buildIndex(positions) {
  const n = positions.length / 3;

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

  // 依据包围盒与点数估算平均点间距，作为网格边长
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const cell = Math.max((extent / Math.cbrt(n)) * 1.6, 1e-6);

  const map = new Map();
  const idx = new Int32Array(n * 3); // 每个点的体素坐标，避免重复取整
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
  return { map, idx, cell };
}

/**
 * 取任意查询位置的 k 近邻（按距离升序）。
 * @returns {number} 实际收集到的邻居数量
 */
function queryNeighbors(index, positions, px, py, pz, k, maxRing, nearest, nearestDist, exclude) {
  const { map, cell } = index;
  const ix = Math.floor(px / cell);
  const iy = Math.floor(py / cell);
  const iz = Math.floor(pz / cell);
  const target = Math.max(k * 2, 16); // 候选点足够多即可停止扩展

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
            if (j === exclude) continue;

            const ddx = positions[j * 3] - px;
            const ddy = positions[j * 3 + 1] - py;
            const ddz = positions[j * 3 + 2] - pz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            found++;

            // 插入式维护 k 近邻（升序）
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
  return filled;
}

/**
 * 计算「查询点 + 给定邻居集合」的质心与协方差矩阵（对称，只填 6 个独立元素）。
 * @param {Int32Array} ids 邻居索引
 * @param {number} count 使用的前 count 个邻居
 * @param {Float64Array} cov 输出，9 个元素
 * @param {Float64Array} cent 输出，质心
 */
function fillCov(positions, px, py, pz, ids, count, cov, cent) {
  let cx = px;
  let cy = py;
  let cz = pz;
  for (let m = 0; m < count; m++) {
    const j = ids[m];
    cx += positions[j * 3];
    cy += positions[j * 3 + 1];
    cz += positions[j * 3 + 2];
  }
  const inv = 1 / (count + 1);
  cx *= inv;
  cy *= inv;
  cz *= inv;
  cent[0] = cx;
  cent[1] = cy;
  cent[2] = cz;

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let m = -1; m < count; m++) {
    const j = m < 0 ? -1 : ids[m];
    const dx = (j < 0 ? px : positions[j * 3]) - cx;
    const dy = (j < 0 ? py : positions[j * 3 + 1]) - cy;
    const dz = (j < 0 ? pz : positions[j * 3 + 2]) - cz;
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
}

/** 归一化并统一朝向 +Y，便于观察 */
function storeNormal(normals, i, nx, ny, nz) {
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) {
    normals[i * 3 + 1] = 1;
    return;
  }
  let x = nx / len;
  let y = ny / len;
  let z = nz / len;
  if (y < 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  normals[i * 3] = x;
  normals[i * 3 + 1] = y;
  normals[i * 3 + 2] = z;
}

/** 由协方差矩阵取最小特征向量（即法向），写入 ctx.out */
function covNormal(ctx) {
  eigenInto(ctx.cov, ctx.evals, ctx.evects);
  ctx.out[0] = ctx.evects[0];
  ctx.out[1] = ctx.evects[1];
  ctx.out[2] = ctx.evects[2];
}

/**
 * RANSAC 平面拟合：随机采样 3 个邻居确定平面，统计内点（点到平面距离 ≤ 阈值），
 * 取内点最多（并列时残差和最小）的平面，最后用内点集重做 PCA 得到平滑法向。
 */
function ransacPlane(ctx, i, count) {
  const { positions, nearest, nearestDist, sub, cov, cent } = ctx;
  const px = positions[i * 3];
  const py = positions[i * 3 + 1];
  const pz = positions[i * 3 + 2];

  const scale = Math.sqrt(nearestDist[count - 1]) || 1e-6;
  const thresh = RANSAC_THRESH * scale;
  const rng = makeRng(i * 2654435761 + 1);

  let bestHits = -1;
  let bestErr = Infinity;
  let bnx = 0, bny = 1, bnz = 0, bd = 0; // 平面：n·p = d

  for (let it = 0; it < RANSAC_ITERS; it++) {
    const a = nearest[(rng() * count) | 0];
    const b = nearest[(rng() * count) | 0];
    const c = nearest[(rng() * count) | 0];
    if (a === b || b === c || a === c) continue;

    // 两条边向量叉乘得到候选平面法向
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue; // 三点共线
    nx /= len;
    ny /= len;
    nz /= len;
    const d = nx * positions[a * 3] + ny * positions[a * 3 + 1] + nz * positions[a * 3 + 2];

    let hits = 0;
    let err = 0;
    for (let m = 0; m < count; m++) {
      const j = nearest[m];
      const dist = Math.abs(
        nx * positions[j * 3] + ny * positions[j * 3 + 1] + nz * positions[j * 3 + 2] - d,
      );
      if (dist <= thresh) {
        hits++;
        err += dist;
      }
    }
    if (hits > bestHits || (hits === bestHits && err < bestErr)) {
      bestHits = hits;
      bestErr = err;
      bnx = nx;
      bny = ny;
      bnz = nz;
      bd = d;
    }
  }

  // 内点不足则退化为全邻域 PCA（此时 cov 仍是主循环算好的全邻域协方差）
  if (bestHits < 3) {
    covNormal(ctx);
    return;
  }

  let inliers = 0;
  for (let m = 0; m < count; m++) {
    const j = nearest[m];
    const dist = Math.abs(
      bnx * positions[j * 3] + bny * positions[j * 3 + 1] + bnz * positions[j * 3 + 2] - bd,
    );
    if (dist <= thresh) sub[inliers++] = j;
  }
  if (inliers < 3) {
    covNormal(ctx);
    return;
  }

  fillCov(positions, px, py, pz, sub, inliers, cov, cent);
  covNormal(ctx);
}

/**
 * ROBPCA / MCD 稳健估计：以最近的 h 个邻居为初始子集，反复执行 C-step——
 * 用子集协方差计算全部邻域的马氏距离，保留距离最小的 h 个点；
 * 结束后用子集协方差的最小特征向量作为法向，外点被自动排除。
 */
function mcdRobust(ctx, i, count) {
  const { positions, nearest, sub, alt, altDist, subDist, cov, cent, evals, evects } = ctx;
  const px = positions[i * 3];
  const py = positions[i * 3 + 1];
  const pz = positions[i * 3 + 2];

  let h = Math.floor(count * MCD_RATIO);
  if (h < 4) h = 4;
  if (h > count) h = count;

  for (let m = 0; m < h; m++) sub[m] = nearest[m]; // nearest 已按距离升序

  for (let it = 0; it < MCD_ITERS; it++) {
    fillCov(positions, px, py, pz, sub, h, cov, cent);
    eigenInto(cov, evals, evects);
    const cx = cent[0], cy = cent[1], cz = cent[2];

    // 马氏距离平方：d² = Σ_k (v_k·d)² / λ_k，λ_k≈0 的主轴跳过
    for (let m = 0; m < count; m++) {
      const j = nearest[m];
      const dx = positions[j * 3] - cx;
      const dy = positions[j * 3 + 1] - cy;
      const dz = positions[j * 3 + 2] - cz;
      let d2 = 0;
      for (let k = 0; k < 3; k++) {
        const lam = evals[k];
        if (lam <= 1e-12) continue;
        const t = evects[k * 3] * dx + evects[k * 3 + 1] * dy + evects[k * 3 + 2] * dz;
        d2 += (t * t) / lam;
      }
      subDist[m] = d2;
    }

    // 选出距离最小的 h 个点（插入式维护升序，结果暂存 alt / altDist）
    let filled = 0;
    for (let m = 0; m < count; m++) {
      const d2 = subDist[m];
      const j = nearest[m];
      if (filled < h) {
        let ins = filled;
        while (ins > 0 && altDist[ins - 1] > d2) {
          altDist[ins] = altDist[ins - 1];
          alt[ins] = alt[ins - 1];
          ins--;
        }
        altDist[ins] = d2;
        alt[ins] = j;
        filled++;
      } else if (d2 < altDist[h - 1]) {
        let ins = h - 1;
        while (ins > 0 && altDist[ins - 1] > d2) {
          altDist[ins] = altDist[ins - 1];
          alt[ins] = alt[ins - 1];
          ins--;
        }
        altDist[ins] = d2;
        alt[ins] = j;
      }
    }

    for (let m = 0; m < h; m++) sub[m] = alt[m];
  }

  fillCov(positions, px, py, pz, sub, h, cov, cent);
  covNormal(ctx);
}

/**
 * Hough 变换：在邻域内随机取 3 点张成候选平面（叉乘得候选法向），
 * 候选法向定向后在高斯球累加器（方位角 × 高度角分箱）上投票，
 * 得票最高分箱内候选法向的归一化平均即 Hough 结果，
 * 再用与该平面一致的邻域点做两轮 PCA 精化。
 */
function houghNormal(ctx, i, count) {
  const { positions, nearest, votes, voteSum, touched, out } = ctx;
  const px = positions[i * 3];
  const py = positions[i * 3 + 1];
  const pz = positions[i * 3 + 2];

  // 只记录并清零被投票过的分箱，避免每点全量清空累加器
  let touchedCount = 0;
  const rng = makeRng(i * 2246822519 + 7);

  for (let p = 0; p < HOUGH_PAIRS; p++) {
    // 随机取 3 个互不相同的邻域点确定候选平面（不锚定查询点，避免其噪声造成系统性偏移）
    const a = nearest[(rng() * count) | 0];
    const b = nearest[(rng() * count) | 0];
    const c = nearest[(rng() * count) | 0];
    if (a === b || b === c || a === c) continue;

    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    // 定向到 +Y 半球，否则相反方向会分裂成两个分箱
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    const az = Math.atan2(nz, nx);
    let ib = Math.floor(((az + Math.PI) / (2 * Math.PI)) * HOUGH_AZ_BINS);
    if (ib < 0) ib = 0;
    else if (ib >= HOUGH_AZ_BINS) ib = HOUGH_AZ_BINS - 1;
    let jb = Math.floor(ny * HOUGH_EL_BINS);
    if (jb >= HOUGH_EL_BINS) jb = HOUGH_EL_BINS - 1;

    const bin = jb * HOUGH_AZ_BINS + ib;
    if (votes[bin] === 0) touched[touchedCount++] = bin;
    votes[bin] += 1;
    voteSum[bin * 3] += nx;
    voteSum[bin * 3 + 1] += ny;
    voteSum[bin * 3 + 2] += nz;
  }

  let best = -1;
  let bestVote = 0;
  for (let t = 0; t < touchedCount; t++) {
    const b = touched[t];
    if (votes[b] > bestVote) {
      bestVote = votes[b];
      best = b;
    }
  }

  // 峰值分箱内候选法向的平均，作为 Hough 原始结果
  let vx = 0;
  let vy = 0;
  let vz = 0;
  if (best >= 0) {
    vx = voteSum[best * 3];
    vy = voteSum[best * 3 + 1];
    vz = voteSum[best * 3 + 2];
  }

  // 结果取出后按记录逐项清零，供下一个点复用累加器
  for (let t = 0; t < touchedCount; t++) {
    const b = touched[t];
    votes[b] = 0;
    voteSum[b * 3] = 0;
    voteSum[b * 3 + 1] = 0;
    voteSum[b * 3 + 2] = 0;
  }

  const vlen = Math.hypot(vx, vy, vz);
  if (best < 0 || vlen < 1e-12) {
    covNormal(ctx);
    return;
  }
  vx /= vlen;
  vy /= vlen;
  vz /= vlen;

  // 二次精化：用与峰值平面一致的邻域点做两轮 PCA，消除分箱量化误差
  const { nearestDist, sub, cent, cov, evals, evects } = ctx;
  const scale = Math.sqrt(nearestDist[count - 1]) || 1e-6;
  const thresh = RANSAC_THRESH * scale;

  let nx = vx;
  let ny = vy;
  let nz = vz;
  for (let round = 0; round < 2; round++) {
    let d = 0;
    for (let m = 0; m < count; m++) {
      const j = nearest[m];
      d += nx * positions[j * 3] + ny * positions[j * 3 + 1] + nz * positions[j * 3 + 2];
    }
    d /= count;

    let inliers = 0;
    for (let m = 0; m < count; m++) {
      const j = nearest[m];
      const dist = Math.abs(
        nx * positions[j * 3] + ny * positions[j * 3 + 1] + nz * positions[j * 3 + 2] - d,
      );
      if (dist <= thresh) sub[inliers++] = j;
    }
    if (inliers < 3) break;

    fillCov(positions, px, py, pz, sub, inliers, cov, cent);
    eigenInto(cov, evals, evects);
    nx = evects[0];
    ny = evects[1];
    nz = evects[2];
  }

  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
}

/**
 * 邻域自适应：从小邻域开始逐步扩大，直到相邻两档邻域估出的法向趋于一致（夹角 < 1°）。
 * 平坦区用小邻域保留细节，曲率大或噪声重的区域自动放大邻域提高稳健性。
 */
function adaptiveNormal(ctx, i, count) {
  const { positions, nearest, cov, cent, evals, evects, out } = ctx;
  const px = positions[i * 3];
  const py = positions[i * 3 + 1];
  const pz = positions[i * 3 + 2];

  let prevX = 0;
  let prevY = 0;
  let prevZ = 0;
  let hasPrev = false;

  const start = Math.min(ADAPTIVE_MIN_K, count);
  for (let kc = start; kc <= count; kc = Math.min(kc + ADAPTIVE_STEP, count)) {
    fillCov(positions, px, py, pz, nearest, kc, cov, cent);
    eigenInto(cov, evals, evects);
    const nx = evects[0];
    const ny = evects[1];
    const nz = evects[2];

    // 法向已稳定：当前邻域即可用
    if (hasPrev && Math.abs(nx * prevX + ny * prevY + nz * prevZ) >= ADAPTIVE_COS) break;
    prevX = nx;
    prevY = ny;
    prevZ = nz;
    hasPrev = true;
    if (kc === count) break;
  }

  out[0] = evects[0];
  out[1] = evects[1];
  out[2] = evects[2];
}

/**
 * 漂移邻域（Shift Neighbor）：先估计法向，再把查询点沿法向投影到局部平面上，
 * 以投影点为中心重新取邻域并重算法向，迭代 2~3 次以抑制边缘与密度不均处的法向偏移。
 */
function shiftNormal(ctx, i, count) {
  const { positions, index, nearest, nearestDist, cov, cent, evals, evects, out, k, maxRing } = ctx;
  let px = positions[i * 3];
  let py = positions[i * 3 + 1];
  let pz = positions[i * 3 + 2];

  for (let it = 0; it <= SHIFT_ITERS; it++) {
    fillCov(positions, px, py, pz, nearest, count, cov, cent);
    eigenInto(cov, evals, evects);
    const nx = evects[0];
    const ny = evects[1];
    const nz = evects[2];

    // 到达迭代上限或已收敛/邻域失效时，直接采用当前法向
    const settle = () => {
      out[0] = nx;
      out[1] = ny;
      out[2] = nz;
    };
    if (it === SHIFT_ITERS) {
      settle();
      return;
    }

    // 查询点到局部平面的有符号距离，沿法向投影得到漂移点
    const d = (px - cent[0]) * nx + (py - cent[1]) * ny + (pz - cent[2]) * nz;
    const scale = Math.sqrt(nearestDist[count - 1]) || 1e-6;
    if (Math.abs(d) < SHIFT_EPS * scale) {
      settle();
      return;
    }
    px -= nx * d;
    py -= ny * d;
    pz -= nz * d;

    // 漂移点是虚拟位置，不与任何样本点互斥
    const next = queryNeighbors(index, positions, px, py, pz, k, maxRing, nearest, nearestDist, -1);
    if (next < 3) {
      settle();
      return;
    }
    count = next;
  }
}

/**
 * 估计法向。
 * @param {Float32Array} positions 顶点坐标
 * @param {object} options
 *   k       邻域点数，默认 16
 *   maxRing 网格向外扩展的最大环数，默认 4
 *   method  法向算法，取值见 NORMAL_METHODS，默认 'pca'
 * @returns {{normals: Float32Array, curvatures: Float32Array, k: number, method: string}}
 */
export function estimateNormals(positions, { k = 16, maxRing = 4, method = 'pca' } = {}) {
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  const curvatures = new Float32Array(n);
  const result = { normals, curvatures, k, method };

  if (n === 0) return result;

  const index = buildIndex(positions);
  // 自适应邻域需要比 k 更多的候选点
  const gatherK = method === 'adaptive' ? Math.max(k, ADAPTIVE_MAX_K) : k;

  // 复用缓冲区，减少 GC 压力
  const ctx = {
    positions,
    index,
    k: gatherK,
    maxRing,
    nearest: new Int32Array(gatherK),
    nearestDist: new Float64Array(gatherK),
    sub: new Int32Array(gatherK),
    alt: new Int32Array(gatherK),
    subDist: new Float64Array(gatherK),
    altDist: new Float64Array(gatherK),
    cov: new Float64Array(9),
    cent: new Float64Array(3),
    evals: new Float64Array(3),
    evects: new Float64Array(9),
    out: new Float64Array(3),
    votes: new Float64Array(HOUGH_AZ_BINS * HOUGH_EL_BINS),
    voteSum: new Float64Array(HOUGH_AZ_BINS * HOUGH_EL_BINS * 3),
    touched: new Int32Array(HOUGH_AZ_BINS * HOUGH_EL_BINS),
  };

  for (let i = 0; i < n; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    const count = queryNeighbors(
      index,
      positions,
      px,
      py,
      pz,
      gatherK,
      maxRing,
      ctx.nearest,
      ctx.nearestDist,
      i,
    );
    if (count < 3) {
      // 邻域不足，退化为朝上法向
      normals[i * 3 + 1] = 1;
      continue;
    }

    // 全邻域 PCA：给出曲率（着色），也是 PCA 方法本身的法向
    fillCov(positions, px, py, pz, ctx.nearest, count, ctx.cov, ctx.cent);
    eigenInto(ctx.cov, ctx.evals, ctx.evects);
    const sum = ctx.evals[0] + ctx.evals[1] + ctx.evals[2];
    curvatures[i] = sum > 0 ? ctx.evals[0] / sum : 0;

    let nx = ctx.evects[0];
    let ny = ctx.evects[1];
    let nz = ctx.evects[2];

    if (method !== 'pca') {
      if (method === 'ransac') ransacPlane(ctx, i, count);
      else if (method === 'mcd') mcdRobust(ctx, i, count);
      else if (method === 'hough') houghNormal(ctx, i, count);
      else if (method === 'adaptive') adaptiveNormal(ctx, i, count);
      else if (method === 'shift') shiftNormal(ctx, i, count);
      else covNormal(ctx); // 未知方法名时退回 PCA

      nx = ctx.out[0];
      ny = ctx.out[1];
      nz = ctx.out[2];
    }

    storeNormal(normals, i, nx, ny, nz);
  }

  return result;
}

/**
 * 让整片点云的法向方向一致，并按 outward 决定整体朝外还是朝内。原地修改 normals。
 * 做法：在 k 近邻图上按 |dot| 由大到小做 Kruskal 选最大生成森林，
 * 再沿树边传播符号（相邻两点法向点积为负则翻转其一），
 * 最后用「质心 → 点」方向的整体点积符号决定全部朝外还是朝内。
 */
export function orientNormalsConsistently(positions, normals, { k = 16, outward = true, maxRing = 4 } = {}) {
  const n = positions.length / 3;
  if (n < 3) return;

  const index = buildIndex(positions);
  const budget = 4000000; // 边数上限，避免超大点云占用过多内存
  const kk = Math.max(3, Math.min(k, n - 1, Math.floor(budget / n)));

  const nearest = new Int32Array(kk);
  const nearestDist = new Float64Array(kk);
  const edgeA = new Int32Array(n * kk);
  const edgeB = new Int32Array(n * kk);
  const weight = new Uint8Array(n * kk); // |dot| 量化到 0..255
  let edges = 0;

  // 1) 收集 kNN 边（只保留 j > i，去掉重复边）
  for (let i = 0; i < n; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const count = queryNeighbors(index, positions, px, py, pz, kk, maxRing, nearest, nearestDist, i);

    for (let s = 0; s < count; s++) {
      const j = nearest[s];
      if (j <= i) continue;
      const d =
        normals[i * 3] * normals[j * 3] +
        normals[i * 3 + 1] * normals[j * 3 + 1] +
        normals[i * 3 + 2] * normals[j * 3 + 2];
      edgeA[edges] = i;
      edgeB[edges] = j;
      weight[edges] = Math.round(Math.abs(d) * 255);
      edges++;
    }
  }
  if (edges === 0) return;

  // 2) 按 |dot| 降序做基数排序（邻居越平行，方向越可信）
  const bucket = new Int32Array(256);
  for (let e = 0; e < edges; e++) bucket[weight[e]]++;
  const start = new Int32Array(256);
  let acc = 0;
  for (let b = 255; b >= 0; b--) {
    start[b] = acc;
    acc += bucket[b];
  }
  const order = new Int32Array(edges);
  const cursor = Int32Array.from(start);
  for (let e = 0; e < edges; e++) order[cursor[weight[e]]++] = e;

  // 3) Kruskal：选出最大生成森林（并查集）
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const rank = new Uint8Array(n);
  const treeA = new Int32Array(n - 1);
  const treeB = new Int32Array(n - 1);
  let tree = 0;

  for (let oi = 0; oi < edges && tree < n - 1; oi++) {
    const e = order[oi];
    let ra = edgeA[e];
    let rb = edgeB[e];
    while (parent[ra] !== ra) {
      parent[ra] = parent[parent[ra]];
      ra = parent[ra];
    }
    while (parent[rb] !== rb) {
      parent[rb] = parent[parent[rb]];
      rb = parent[rb];
    }
    if (ra === rb) continue;
    if (rank[ra] < rank[rb]) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
    treeA[tree] = edgeA[e];
    treeB[tree] = edgeB[e];
    tree++;
  }

  // 4) 森林转 CSR 邻接表
  const degree = new Int32Array(n);
  for (let t = 0; t < tree; t++) {
    degree[treeA[t]]++;
    degree[treeB[t]]++;
  }
  const adjStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const adj = new Int32Array(tree * 2);
  const fill = Int32Array.from(adjStart.subarray(0, n));
  for (let t = 0; t < tree; t++) {
    adj[fill[treeA[t]]++] = treeB[t];
    adj[fill[treeB[t]]++] = treeA[t];
  }

  // 5) 沿树边传播符号：flip[i]=1 表示该点法向需要取反
  const flip = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let seed = 0; seed < n; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;

    while (head < tail) {
      const cur = queue[head++];
      const cx = normals[cur * 3];
      const cy = normals[cur * 3 + 1];
      const cz = normals[cur * 3 + 2];

      for (let a = adjStart[cur]; a < adjStart[cur + 1]; a++) {
        const nb = adj[a];
        if (visited[nb]) continue;
        const d = cx * normals[nb * 3] + cy * normals[nb * 3 + 1] + cz * normals[nb * 3 + 2];
        flip[nb] = flip[cur] ^ (d < 0 ? 1 : 0);
        visited[nb] = 1;
        queue[tail++] = nb;
      }
    }
  }

  // 6) 整体符号：以质心为参考判断当前是朝外还是朝内
  let gx = 0;
  let gy = 0;
  let gz = 0;
  for (let i = 0; i < n; i++) {
    gx += positions[i * 3];
    gy += positions[i * 3 + 1];
    gz += positions[i * 3 + 2];
  }
  gx /= n;
  gy /= n;
  gz /= n;

  let sum = 0;
  let radSum = 0;
  let upCount = 0;
  for (let i = 0; i < n; i++) {
    const s = flip[i] ? -1 : 1;
    const dx = positions[i * 3] - gx;
    const dy = positions[i * 3 + 1] - gy;
    const dz = positions[i * 3 + 2] - gz;
    sum += s * (normals[i * 3] * dx + normals[i * 3 + 1] * dy + normals[i * 3 + 2] * dz);
    radSum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (s * normals[i * 3 + 1] > 0) upCount++;
  }

  // 质心判据在对称/开放曲面上会正负抵消，此时退化为「多数朝上」判为朝外
  const meanDot = sum / n;
  const meanRad = radSum / n || 1;
  const signedOutward = Math.abs(meanDot) > 0.15 * meanRad ? (meanDot > 0 ? 1 : -1) : upCount * 2 >= n ? 1 : -1;
  const totalFlip = (signedOutward > 0) === outward ? 0 : 1;

  // 7) 落地
  for (let i = 0; i < n; i++) {
    if ((flip[i] ^ totalFlip) === 0) continue;
    normals[i * 3] = -normals[i * 3];
    normals[i * 3 + 1] = -normals[i * 3 + 1];
    normals[i * 3 + 2] = -normals[i * 3 + 2];
  }
}

