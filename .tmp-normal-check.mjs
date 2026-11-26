import { symmetricEigen, estimateNormals } from './src/core/normals.js';
import { generateTerrain } from './src/core/generators.js';

// 1) 特征分解正确性
const M = [4, 1, 2, 1, 5, 3, 2, 3, 6];
const { values, vectors } = symmetricEigen(M);
console.log('特征值', values.map((v) => v.toFixed(4)).join(', '));
// 验证 A v = λ v
for (let c = 0; c < 3; c++) {
  const vx = vectors[c * 3], vy = vectors[c * 3 + 1], vz = vectors[c * 3 + 2];
  const ax = M[0] * vx + M[1] * vy + M[2] * vz;
  const ay = M[3] * vx + M[4] * vy + M[5] * vz;
  const az = M[6] * vx + M[7] * vy + M[8] * vz;
  const err = Math.hypot(ax - values[c] * vx, ay - values[c] * vy, az - values[c] * vz);
  console.log(`列${c} 残差 ${err.toExponential(2)} 范数 ${Math.hypot(vx, vy, vz).toFixed(6)}`);
}

// 2) 平面点云：z = 0.5x，法向应垂直于平面（即与平面法线 (0.5,0,-1) 共线）
const N = 5000;
const pos = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  const x = (Math.random() - 0.5) * 10;
  const z = (Math.random() - 0.5) * 10;
  pos[i * 3] = x;
  pos[i * 3 + 1] = 0.5 * x;
  pos[i * 3 + 2] = z;
}
const r = estimateNormals(pos, { k: 16 });
// 平面法线归一化
const pl = Math.hypot(0.5, 0, -1);
const gx = 0.5 / pl, gy = 0 / pl, gz = -1 / pl;
let maxErr = 0;
for (let i = 0; i < N; i++) {
  const d = Math.abs(r.normals[i * 3] * gx + r.normals[i * 3 + 1] * gy + r.normals[i * 3 + 2] * gz);
  maxErr = Math.max(maxErr, 1 - d);
}
console.log('斜面最大角度误差(deg)', (Math.acos(1 - maxErr) * 180 / Math.PI).toFixed(3));

// 3) 地形点云：法向与局部最小二乘平面的垂直性
const terrain = generateTerrain(40000, 4);
const rt = estimateNormals(terrain, { k: 16 });
let sx = 0, sy = 0, sz = 0;
for (let i = 0; i < terrain.length / 3; i++) {
  sx += rt.normals[i * 3]; sy += rt.normals[i * 3 + 1]; sz += rt.normals[i * 3 + 2];
}
const n = terrain.length / 3;
console.log('地形平均法向', (sx / n).toFixed(3), (sy / n).toFixed(3), (sz / n).toFixed(3));
let bad = 0;
for (let i = 0; i < n; i++) {
  const ny = rt.normals[i * 3 + 1];
  if (ny < 0.5) bad++;
}
console.log('法向明显偏斜(ny<0.5)的点占比', (bad / n * 100).toFixed(2), '%');
