/**
 * 缺陷注入：在干净网格上人为制造退化面、自交面、翻转法向、非流形边，
 * 供"面片清洗""修复拓扑"示例对比处理前后的效果。
 */
import { computeFaceAreas } from './mesh.js';

/**
 * @param {{positions: Float32Array, indices: Uint32Array}} mesh 干净网格
 * @param {object} options degenerate 退化面数 / crossing 自交面数 / fins 非流形鳍片数 / flippedRatio 翻转比例
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
export function injectDefects(
  { positions, indices },
  { degenerate = 12, crossing = 8, fins = 6, flippedRatio = 0.06 } = {},
) {
  const pos = Array.from(positions);
  const idx = Array.from(indices);
  const faceCount = idx.length / 3;
  const areas = computeFaceAreas(positions, indices);

  const facePoint = (f, k) => {
    const v = idx[f * 3 + k] * 3;
    return [pos[v], pos[v + 1], pos[v + 2]];
  };
  const pushVertex = (x, y, z) => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };

  // ---- 1. 退化面：在一条边上取几乎重合的两点，构造零面积/扁长三角 ----
  for (let k = 0; k < degenerate; k++) {
    const f = Math.floor(Math.random() * faceCount);
    const p0 = facePoint(f, 0);
    const p1 = facePoint(f, 1);
    const t = 0.2 + Math.random() * 0.6;
    const bx = p0[0] + (p1[0] - p0[0]) * t;
    const by = p0[1] + (p1[1] - p0[1]) * t;
    const bz = p0[2] + (p1[2] - p0[2]) * t;

    const a = pushVertex(p0[0], p0[1], p0[2]);
    const b = pushVertex(bx + 1e-5, by, bz);
    const c = pushVertex(bx, by, bz + 1e-5); // 面积远小于平均面积
    idx.push(a, b, c);
  }

  // ---- 2. 自交面：以面片中心为原点、沿法向与切向展开，必然穿过曲面 ----
  for (let k = 0; k < crossing; k++) {
    const f = Math.floor(Math.random() * faceCount);
    const p0 = facePoint(f, 0);
    const p1 = facePoint(f, 1);
    const p2 = facePoint(f, 2);
    const cx = (p0[0] + p1[0] + p2[0]) / 3;
    const cy = (p0[1] + p1[1] + p2[1]) / 3;
    const cz = (p0[2] + p1[2] + p2[2]) / 3;

    // 法向
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;

    const s = Math.sqrt(areas[f]) * 0.8;
    const a = pushVertex(cx + nx * s, cy + ny * s, cz + nz * s);
    const b = pushVertex(cx - nx * s, cy - ny * s, cz - nz * s);
    const c = pushVertex(cx + ux * s, cy + uy * s, cz + uz * s);
    idx.push(a, b, c);
  }

  // ---- 3. 非流形边：在已有边上再挂一个面片，使该边关联 3 个面 ----
  for (let k = 0; k < fins; k++) {
    const f = Math.floor(Math.random() * faceCount);
    const p0 = facePoint(f, 0);
    const p1 = facePoint(f, 1);
    const p2 = facePoint(f, 2);

    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;

    const a = idx[f * 3];
    const b = idx[f * 3 + 1];
    const c = pushVertex(
      (p0[0] + p1[0]) / 2 + nx * 0.12,
      (p0[1] + p1[1]) / 2 + ny * 0.12,
      (p0[2] + p1[2]) / 2 + nz * 0.12,
    );
    idx.push(a, b, c); // 边 a-b 现在被 3 个面共享
  }

  // ---- 4. 翻转部分面片的绕序 ----
  const flipCount = Math.floor(faceCount * flippedRatio);
  for (let k = 0; k < flipCount; k++) {
    const f = Math.floor(Math.random() * faceCount);
    const tmp = idx[f * 3 + 1];
    idx[f * 3 + 1] = idx[f * 3 + 2];
    idx[f * 3 + 2] = tmp;
  }

  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
